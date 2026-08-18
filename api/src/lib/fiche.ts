/**
 * Génération de la fiche d'intervention et alerte sécurité.
 *
 * Le Worker n'écrit pas le document lui-même : il pousse un payload vers un
 * web app Google Apps Script qui remplit un template Google Docs et l'exporte.
 * Ce choix suit l'outillage déjà en place sur soscumulus.fr — le formulaire du
 * site passe déjà par Apps Script — et laisse le template éditable par une
 * personne non développeuse, ce qu'un PDF généré en code ne permet pas.
 */

import type { Dossier, PhotoSlot, SafetyFlag } from '../../../shared/types';
import type { Env } from '../env';
import { getPhotoKey, logEvent } from './db';
import { signedImageUrl } from './signing';

/**
 * Les liens photo de la fiche vivent aussi longtemps que le dossier. Apps
 * Script doit embarquer les images dans le document à la génération plutôt que
 * de conserver les liens : passé la purge, les URL ne répondront plus.
 */
const FICHE_LINK_TTL_S = 7 * 86_400;

/**
 * Le secret voyage en paramètre de requête, pas en en-tête : `doPost` d'Apps
 * Script n'expose pas les en-têtes personnalisés. La liaison reste en HTTPS,
 * donc le paramètre n'est pas observable en transit — mais il peut apparaître
 * dans les journaux Google, ce qui impose de le faire tourner comme un secret
 * à part entière et non de le réutiliser ailleurs.
 */
function webhookUrl(env: Env): string {
  const url = new URL(env.FICHE_WEBHOOK_URL);
  url.searchParams.set('secret', env.FICHE_SECRET);
  return url.toString();
}

export async function pushFiche(
  env: Env,
  token: string,
  dossier: Dossier,
): Promise<void> {
  if (!env.FICHE_WEBHOOK_URL) return;

  const photos = await Promise.all(
    ([1, 2, 3] as PhotoSlot[]).map(async (slot) => {
      const key = await getPhotoKey(env, token, slot);
      return {
        slot,
        skipped: dossier.photos[slot].skipped,
        url: key
          ? await signedImageUrl(
              env.SIGNING_KEY,
              env.PUBLIC_API_URL,
              key,
              FICHE_LINK_TTL_S,
            )
          : null,
        analysis: dossier.photos[slot].analysis,
      };
    }),
  );

  try {
    const res = await fetch(webhookUrl(env), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'fiche',
        ref: dossier.ref,
        tel: dossier.tel,
        ville: dossier.ville,
        probleme: dossier.probleme,
        answers: dossier.answers,
        diagnostic: dossier.diagnostic,
        photos,
        createdAt: dossier.createdAt,
      }),
    });
    if (!res.ok) throw new Error(`Apps Script ${res.status}`);
    await logEvent(env, token, 'fiche_generee', dossier.ref);
  } catch (err) {
    // Le diagnostic est déjà en base : la fiche est rejouable depuis le
    // journal sans que le client ait à refaire quoi que ce soit.
    console.error('génération de fiche échouée', err);
    await logEvent(env, token, 'fiche_echec', String(err).slice(0, 200));
  }
}

/**
 * Danger déclaré : eau sur une installation électrique, disjoncteur qui saute,
 * odeur de gaz. Part immédiatement, hors file d'attente.
 */
export async function alertSecurite(
  env: Env,
  ref: string,
  tel: string,
  ville: string | null,
  flags: SafetyFlag[],
): Promise<void> {
  if (!env.FICHE_WEBHOOK_URL) return;
  try {
    await fetch(webhookUrl(env), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'alerte_securite', ref, tel, ville, flags }),
    });
  } catch (err) {
    console.error('alerte sécurité non transmise', err);
  }
}
