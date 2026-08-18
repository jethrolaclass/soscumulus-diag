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
                    Dossier Drive : fiche + photos + vidéo (2 ans)
```

| Composant | Emplacement | Hébergement |
|---|---|---|
| Front | `web/` | Cloudflare Pages |
| API | `api/` | Cloudflare Workers |
| Photos, vidéo | — | R2 (tampon 7 jours) puis Drive (archive 2 ans) |
| Dossiers | — | D1 |
| Fiche, archive, alertes | `scripts/apps-script.gs` | Google Apps Script |

Deux décisions structurantes, détaillées dans les commentaires du code :

- **Aucun octet d'image ne transite par le Worker.** Les photos partent en flux
  vers R2, et l'API vision les récupère via une URL signée à durée courte. Un
  encodage base64 dans le Worker dépasserait à lui seul les 10 ms de CPU du
  plan gratuit.
- **Chaque photo est analysée dès son envoi**, pas à la fin. Le client est
  encore devant son appareil : c'est le seul moment où « rapprochez-vous de
  l'étiquette » sert à quelque chose.
- **Le bandeau de commande se filme.** Cinq images en sont extraites côté
  navigateur et analysées ensemble : un code de défaut clignotant n'existe que
  dans l'écart entre deux images. La vidéo source est conservée pour
  vérification humaine, mais son envoi est **différé et hors du chemin
  critique** — il démarre une fois le verdict affiché et se poursuit pendant
  que le client répond aux dernières questions. Un échec n'a aucune
  conséquence sur le dossier.

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

L'ordre compte : le front a besoin de l'URL de l'API pour être construit, et
l'API a besoin de l'origine du front pour autoriser CORS. On déploie donc le
Worker d'abord.

### 1. Schéma et secrets

Les commandes en `--workspace=` s'exécutent **depuis la racine du dépôt** : les
workspaces n'y sont déclarés que là. Depuis `api/`, appeler les scripts locaux
sans préfixe (`npm run db:remote`, `npm run deploy`).

```bash
npm run db:remote --workspace=api      # crée les tables dans D1

cd api
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put SIGNING_KEY    # openssl rand -base64 32
npx wrangler secret put SMS_API_KEY
npx wrangler secret put LEAD_SECRET
npx wrangler secret put FICHE_SECRET
```

Les secrets vivent sur le Worker, pas dans le build : une fois posés, tous les
déploiements suivants les conservent.

### 2. Worker

```bash
cd .. && npm run deploy:api             # ou, depuis api/ : npm run deploy
```

Noter l'URL renvoyée (`https://soscumulus-diag-api.<compte>.workers.dev`) et la
reporter dans `PUBLIC_API_URL` de `api/wrangler.toml`.

> ⚠️ `PUBLIC_API_URL` n'est pas cosmétique : c'est la base des URL signées que
> l'API vision va chercher pour lire les photos. Fausse, toutes les analyses
> échouent — et silencieusement, puisque le parcours est conçu pour ne jamais
> bloquer le client.

### 3. Front — Cloudflare Pages

**Par la CLI**, pour voir le rendu tout de suite :

```bash
VITE_API_URL=https://<worker>.workers.dev npm run build
npx wrangler pages deploy web/dist --project-name=soscumulus-diag
```

**Par l'intégration Git**, pour un déploiement à chaque push. Dans le tableau
de bord Pages, connecter le dépôt puis :

| Réglage | Valeur |
|---|---|
| Répertoire racine | *(laisser à la racine)* |
| Commande de build | `npm install && npm run build --workspace=web` |
| Répertoire de sortie | `web/dist` |
| Variable d'environnement | `VITE_API_URL` = URL du Worker |

Le répertoire racine reste à la racine du dépôt : c'est là que vivent le
`package.json` des workspaces et le lockfile, dont `npm install` a besoin.

`VITE_API_URL` est lue **au moment du build**, pas à l'exécution. Le build
échoue explicitement si elle manque, plutôt que de produire un front qui
appelle sa propre origine et répond 404 sur tout.

La version de Node est épinglée par `.node-version`, **à la racine du dépôt** —
Pages le cherche dans le répertoire racine configuré, pas dans `web/`. Vite 6
exige Node 20 et l'image par défaut de Pages est plus ancienne.

### 4. Boucler CORS

Reporter l'URL Pages dans `PUBLIC_WEB_URL` de `api/wrangler.toml`, puis
redéployer le Worker. Cette valeur est l'origine unique autorisée : tant
qu'elle ne correspond pas exactement, le navigateur bloque tous les appels.

```bash
npm run deploy:api
```

### 5. Worker en CI/CD (optionnel)

Même principe côté Workers Builds, avec `api` comme répertoire racine et
`npx wrangler deploy` comme commande de déploiement.

### Côté Google Apps Script

Voir l'en-tête de [`scripts/apps-script.gs`](scripts/apps-script.gs). Le script
existant du formulaire est conservé : on lui ajoute un appel à `/api/lead`.

## Stockage et données personnelles

Les photos montrent le domicile du client. Deux étages, deux rôles :

| | R2 | Drive |
|---|---|---|
| Rôle | tampon de travail | dossier d'intervention |
| Durée | 7 jours | 2 ans |
| Purge | cron Worker quotidien | `purgerArchives`, déclencheur mensuel |
| Accès | URL signée, 5 min | dossier partagé de l'équipe |

Ce découpage évite d'introduire un compte de service et un JWT RS256 dans le
Worker : Apps Script est déjà authentifié auprès de Drive et récupère déjà les
photos pour les insérer dans le Doc. Il les dépose au passage comme fichiers.

Autres mesures :

- redimensionnement et ré-encodage côté navigateur, **qui supprime les EXIF**,
  donc les coordonnées GPS, avant tout envoi ;
- bucket R2 privé, jamais public ; accès uniquement par URL signée ;
- token de dossier aléatoire et opaque — la référence lisible `SC-0024`
  n'apparaît jamais dans une URL ;
- la purge R2 vide aussi le dossier D1 de toute donnée personnelle et ne
  conserve que la référence, pour la traçabilité comptable.

> ⚠️ **Le déclencheur mensuel sur `purgerArchives` fait partie du dispositif.**
> Sans lui, la durée de 2 ans annoncée au client dans l'écran d'accueil n'est
> pas tenue et l'archive croît indéfiniment.

L'appel au modèle passe par l'API Anthropic sous conditions commerciales, ce
qui fournit le cadre contractuel nécessaire au traitement de ces images.

## Coût

Environ **0,08 € par diagnostic** (Opus 5, trois photos, cache prompt actif),
plus ~0,03 € sur les dossiers avec bandeau électronique.

L'hébergement Cloudflare tient dans les paliers gratuits : R2 ne conservant
que sept jours, le stock y reste très en dessous des 10 Go offerts quel que
soit le volume. L'archive de deux ans vit sur le quota Workspace déjà payé.
Le plan Workers à 5 $/mois reste recommandé en production pour lever le
plafond de CPU et le quota journalier.
