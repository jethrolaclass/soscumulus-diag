# CLAUDE.md

## Le produit

Outil de diagnostic à distance de chauffe-eau pour SOS Cumulus. Un client
reçoit un SMS après avoir rempli le formulaire de soscumulus.fr, ouvre un lien
personnel, prend trois photos de son appareil, répond à six questions. Un
diagnostic est produit et versé dans une fiche d'intervention.

Le contexte d'usage commande la plupart des choix techniques : **un
particulier, sur son téléphone, debout dans une cave mal éclairée, en 4G
dégradée.** Toute décision qui alourdit le bundle, ajoute une étape ou bloque
le parcours se paie directement en dossiers abandonnés.

## Invariants

Ces règles ont chacune coûté une analyse ; ne les défaire qu'en connaissance
de cause.

1. **Aucun octet d'image ne transite en mémoire dans le Worker.** Les uploads
   partent en flux vers R2 (`req.body` direct dans `PHOTOS.put`), et l'API
   vision lit les photos via une URL signée. Un `base64` ou un
   `arrayBuffer()` sur une photo dépasse les 10 ms de CPU du plan gratuit.

2. **Le parcours ne bloque jamais le client.** Photo refusée, analyse en
   échec, réseau perdu, délai dépassé : il existe toujours un chemin pour
   avancer. Deux tentatives au maximum sur une photo, ensuite on accepte.

3. **Le contrôle de netteté local n'est qu'un pré-filtre.** L'autorité sur la
   qualité est le vLLM, seul capable de dire « nette mais trop loin pour lire
   l'étiquette ». Ne pas durcir les seuils de `web/src/lib/image.ts` sans les
   avoir recalibrés sur de vraies photos de terrain.

4. **On ne redemande jamais une information déjà connue.** Le formulaire du
   site fournit téléphone, ville et problème. Ils sont rappelés à l'écran,
   jamais ressaisis.

5. **R2 est un tampon, Drive est l'archive.** R2 porte le travail en ligne et
   ne garde rien au-delà de sept jours ; le dossier d'intervention durable vit
   dans Drive, déposé par Apps Script qui y est déjà authentifié. Ne pas
   introduire de compte de service ni de JWT dans le Worker pour rapatrier ce
   rôle — c'est précisément ce que ce découpage évite.

6. **Le token de dossier est opaque et aléatoire.** La référence `SC-0024`
   est un libellé d'affichage. Elle ne doit jamais servir de clé de routage.

7. **Les images du bandeau s'analysent ensemble, jamais séparément.** Un code
   de défaut clignotant n'existe que dans l'écart entre deux images. Un seul
   appel vision porte la séquence entière, et l'espacement des images est
   régulier — ne pas les trier par netteté, ce serait détruire l'information.

8. **L'envoi de la vidéo du bandeau ne bloque rien.** Ni le bouton
   « Continuer », ni la soumission, ni la génération de fiche n'attendent sa
   promesse. Il démarre après l'affichage du verdict, jamais avant : lancé
   plus tôt, vingt mégaoctets concurrenceraient les requêtes de sondage sur le
   même lien montant.

9. **Un danger déclaré interrompt le parcours et alerte l'équipe.** C'est à la
   fois une obligation de prudence et le lead le plus chaud du tunnel.

## Structure

```
shared/types.ts   contrat front ↔ API — toute évolution est une évolution d'API
api/src/lib/      claude, schemas, db, sms, fiche, signing, http
api/src/routes/   lead, dossier, photo, image
web/src/lib/      image (normalisation + netteté), video (extraction), api
web/src/          questions.ts (données), main.ts (état + rendu)
scripts/          pont Google Apps Script
```

`api/src/lib/claude.ts` est le **seul** point de contact avec le modèle.

## Phase de test : les SMS ne partent pas

`SMS_ALLOWLIST` dans `api/wrangler.toml` restreint l'envoi aux seuls numéros
listés. Tout autre numéro — donc tout client réel — voit son dossier créé et
son lien resté valide, mais **ne reçoit aucun SMS**. L'e-mail de lead affiche
alors « SMS non envoyé » pour que l'équipe puisse transmettre le lien à la
main si elle le souhaite.

**Vider cette variable est l'acte de mise en service.** Tant qu'elle est
renseignée, aucun client ne reçoit son lien automatiquement.

## Durées de conservation

Trois durées, à garder cohérentes — le texte de l'écran d'accueil les annonce
au client :

| Où | Durée | Qui purge |
|---|---|---|
| R2 + D1 | 7 jours | cron Worker (`purgeExpired`) |
| Drive | 2 ans | `purgerArchives`, déclencheur mensuel Apps Script |
| URL signée | 5 min (vision) / 7 j (fiche) | expiration de la signature |

Changer l'une de ces durées oblige à changer le texte affiché dans
`welcomeScreen()`. Une promesse fausse à cet endroit est un problème de
conformité, pas une approximation d'interface.

## Conventions

- **Anglais pour tout le code, sans exception** : identifiants, commentaires,
  clés JSON, colonnes SQL, routes d'API, valeurs d'énumération, messages
  d'erreur internes.
- **Français uniquement pour ce que lit un humain hors de l'équipe** : libellés
  d'interface, textes d'e-mail, message SMS, et les prompts envoyés au modèle
  — celui-ci doit rendre au client des consignes en français, et le vocabulaire
  métier (étiquette signalétique, groupe de sécurité, bandeau) n'a pas
  d'équivalent net en anglais.
- Cette documentation reste en français : elle s'adresse à l'équipe.
- Pas de framework front. Le bundle fait ~7 Ko gzip, c'est un objectif, pas un
  accident.
- Les commentaires expliquent **pourquoi**, jamais **quoi**.

## Commandes

```bash
npm run dev            # front
npm run dev:api        # worker
npm run typecheck      # les deux espaces de travail
npm run build          # vérifie aussi les types
```

## Pièges vérifiés

- Les types du SDK Anthropic retardent sur les paramètres beta (`fallbacks`).
  Voir `REFUSAL_FALLBACK` dans `claude.ts` : on élargit un objet isolé plutôt
  que de caster l'appel entier.
- `doPost` d'Apps Script **n'expose pas les en-têtes personnalisés** : le
  secret du webhook passe en paramètre de requête.
- `createImageBitmap(file, { imageOrientation: 'from-image' })` est obligatoire
  — sans lui, une photo iPhone sur deux arrive couchée.
- Le cache prompt ne s'amorce qu'au-delà de 512 tokens de préfixe sur Opus 5 :
  raccourcir `PREAMBLE` coûterait ~10× sur l'entrée.
