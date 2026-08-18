# SOS Diag Express

Diagnostic à distance de chauffe-eau à partir de trois photos prises par le
client depuis son téléphone.

Le client remplit le formulaire de [soscumulus.fr](https://soscumulus.fr),
reçoit un SMS avec un lien personnel, photographie son appareil, et un
diagnostic est produit puis versé dans une fiche d'intervention.

## Architecture

```
Formulaire site → Google Apps Script → Worker /api/lead → SMS
                                            ↓
                              diag.soscumulus.fr (Pages)
                                            ↓
                        R2 (photos) · Claude vision · D1 (dossier)
                                            ↓
                              Fiche d'intervention (Google Docs)
```

| Composant | Emplacement | Hébergement |
|---|---|---|
| Front | `web/` | Cloudflare Pages |
| API | `api/` | Cloudflare Workers |
| Photos | — | R2, purgées à 7 jours |
| Dossiers | — | D1 |
| Fiche + alertes | `scripts/apps-script.gs` | Google Apps Script |

Deux décisions structurantes, détaillées dans les commentaires du code :

- **Aucun octet d'image ne transite par le Worker.** Les photos partent en flux
  vers R2, et l'API vision les récupère via une URL signée à durée courte. Un
  encodage base64 dans le Worker dépasserait à lui seul les 10 ms de CPU du
  plan gratuit.
- **Chaque photo est analysée dès son envoi**, pas à la fin. Le client est
  encore devant son appareil : c'est le seul moment où « rapprochez-vous de
  l'étiquette » sert à quelque chose.
- **Le bandeau de commande se filme, mais la vidéo ne part jamais.** Cinq
  images en sont extraites côté navigateur et analysées ensemble : un code de
  défaut clignotant n'existe que dans l'écart entre deux images. La vidéo
  brute pèse 15 à 25 Mo pour une information que 250 Ko d'images portent
  aussi bien.

## Démarrage

```bash
npm install
```

### Front

```bash
npm run dev
```

Sur `http://localhost:5173/d/<token>`. Créer `web/.env.local` à partir de
`web/.env.example` pour pointer vers l'API locale.

### API

```bash
npm run dev:api
```

Créer `api/.dev.vars` (non versionné) :

```
ANTHROPIC_API_KEY=sk-ant-...
SIGNING_KEY=<32 octets aléatoires>
SMS_API_KEY=<clé Brevo>
LEAD_SECRET=<aléatoire>
FICHE_SECRET=<aléatoire>
```

## Mise en production

```bash
# 1. Ressources Cloudflare
npx wrangler d1 create soscumulus-diag        # reporter l'id dans wrangler.toml
npx wrangler r2 bucket create soscumulus-diag-photos
npm run db:remote --workspace=api

# 2. Secrets
cd api
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put SIGNING_KEY
npx wrangler secret put SMS_API_KEY
npx wrangler secret put LEAD_SECRET
npx wrangler secret put FICHE_SECRET

# 3. Déploiement
npm run deploy:api
npm run build && npx wrangler pages deploy web/dist --project-name=soscumulus-diag
```

Puis, dans `api/wrangler.toml`, renseigner `FICHE_WEBHOOK_URL` avec l'URL du
web app Apps Script et `URGENCE_TEL` avec le numéro d'astreinte.

Le front sert toutes les routes `/d/*` sur `index.html` — configurer la
redirection SPA dans Pages (`web/public/_redirects` : `/* /index.html 200`).

### Côté Google Apps Script

Voir l'en-tête de [`scripts/apps-script.gs`](scripts/apps-script.gs). Le script
existant du formulaire est conservé : on lui ajoute un appel à `/api/lead`.

## Données personnelles

Les photos montrent le domicile du client. Le dispositif en tient compte :

- redimensionnement et ré-encodage côté navigateur, **qui supprime les EXIF**,
  donc les coordonnées GPS, avant tout envoi ;
- bucket R2 privé, accès uniquement par URL signée expirant en 5 minutes ;
- token de dossier aléatoire et opaque — la référence lisible `SC-0024`
  n'apparaît jamais dans une URL ;
- purge automatique à 7 jours (cron quotidien) : photos supprimées, dossier
  vidé de toute donnée personnelle, référence conservée pour la traçabilité.

L'appel au modèle passe par l'API Anthropic sous conditions commerciales, ce
qui fournit le cadre contractuel nécessaire au traitement de ces images.

## Coût

Environ **0,08 € par diagnostic** (Opus 5, trois photos, cache prompt actif).
L'hébergement Cloudflare tient dans les paliers gratuits jusqu'à plusieurs
milliers de dossiers par mois ; le plan Workers à 5 $/mois reste recommandé en
production pour lever le plafond de CPU et le quota journalier.
