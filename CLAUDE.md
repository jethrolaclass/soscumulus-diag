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

1. **Les images vont au modèle par l'API Files, jamais en base64 ni par URL.**
   Les uploads client partent toujours en flux vers R2 (`req.body` direct dans
   `PHOTOS.put`) : ça, ne pas y toucher, un `base64` sur une photo exploserait
   le CPU. En revanche l'envoi au modèle passe par `beta.files.upload` — la
   première version donnait une URL signée à charge pour l'API d'aller la
   chercher, et elle répondait invariablement « Unable to download the file »,
   depuis le domaine propre comme depuis workers.dev, alors que la même URL
   répondait 200 partout ailleurs. Ce blocage nous échappe : on pousse au lieu
   d'attendre d'être tiré. Les fichiers envoyés sont supprimés après analyse.

2. **Le parcours ne bloque jamais le client.** Photo refusée, analyse en
   échec, réseau perdu, délai dépassé : il existe toujours un chemin pour
   avancer. Deux tentatives au maximum sur une photo, ensuite on accepte.

3. **Le contrôle de netteté local n'est qu'un pré-filtre.** L'autorité sur la
   qualité est le vLLM, seul capable de dire « nette mais trop loin pour lire
   l'étiquette ». Ne pas durcir les seuils de `web/src/lib/image.ts` sans les
   avoir recalibrés sur de vraies photos de terrain.

   La netteté se lit **tuile par tuile**, jamais sur un seul recadrage central.
   La variance du laplacien mesure de la haute fréquence, donc de la texture :
   un cumulus est un grand cylindre blanc et mat, et une photo parfaitement
   nette de son flanc n'en contient presque pas. Mesurée au centre, elle était
   déclarée floue — y compris la photo d'exemple montrée au client comme le
   modèle à suivre. Une photo nette a du détail *quelque part* ; une photo
   floue n'en a nulle part.

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

## Les SMS partent — `SMS_ALLOWLIST` est vide

`SMS_ALLOWLIST` dans `api/wrangler.toml` restreint l'envoi aux seuls numéros
listés. Elle est **vide depuis le 4 septembre 2026** : tout client reçoit son
lien automatiquement.

`SMS_ALLOWLIST_VOICE` est la même règle pour les SMS déclenchés par l'agent
vocal, et elle seule. Elle est **remplie** des numéros de l'équipe tant que
l'agent se teste à l'oreille : un testeur qui donnerait un numéro au hasard
mettrait sinon un vrai lien sur le téléphone d'un inconnu. Un numéro bloqué
par cette liste n'est pas une panne — la route de triage renvoie
`smsBlocked: true` et l'agent continue sans transférer.

La remplir de numéros séparés par des virgules referme l'envoi sur eux seuls.
Les autres dossiers restent créés et leur lien valide, mais rien ne part, et
l'e-mail de lead affiche « SMS non envoyé » pour que l'équipe transmette le
lien à la main. C'est le geste à faire pour reprendre des tests sans écrire à
de vrais clients.

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
