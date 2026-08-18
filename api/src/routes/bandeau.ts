import type { Env } from '../env';
import { analyzeBandeau } from '../lib/claude';
import {
  bandeauKey,
  bandeauVideoKey,
  getDossier,
  logEvent,
  recordBandeauFrames,
  recordBandeauVideo,
  saveBandeauAnalysis,
} from '../lib/db';
import { signedImageUrl } from '../lib/signing';
import { badRequest, json, notFound } from '../lib/http';

/**
 * Images du bandeau de commande, extraites côté client depuis une vidéo de dix
 * secondes. Le client les envoie une par une — chacune part en flux vers R2,
 * comme les photos — et l'analyse se déclenche à la réception de la dernière.
 *
 * Un seul appel vision porte la séquence entière : c'est la comparaison entre
 * les images qui révèle un clignotement, donc les analyser séparément
 * détruirait exactement l'information qu'on cherche.
 */

const MAX_FRAMES = 8;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;

export async function handleBandeauFrame(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  token: string,
  params: URLSearchParams,
): Promise<Response> {
  const dossier = await getDossier(env, token);
  if (!dossier) throw notFound();

  const index = Number(params.get('i'));
  const total = Number(params.get('n'));
  if (
    !Number.isInteger(index) ||
    !Number.isInteger(total) ||
    total < 1 ||
    total > MAX_FRAMES ||
    index < 0 ||
    index >= total
  ) {
    throw badRequest('Paramètres `i` et `n` invalides.');
  }

  if (!req.headers.get('content-type')?.startsWith('image/jpeg')) {
    throw badRequest('Le corps doit être un JPEG (image/jpeg).');
  }
  if (Number(req.headers.get('content-length') ?? '0') > MAX_FRAME_BYTES) {
    throw badRequest('Image trop volumineuse.', 'payload_too_large');
  }
  if (!req.body) throw badRequest('Corps de requête vide.');

  await env.PHOTOS.put(bandeauKey(token, index), req.body, {
    httpMetadata: { contentType: 'image/jpeg' },
  });

  const last = index === total - 1;
  if (last) {
    await recordBandeauFrames(env, token, total);
    await logEvent(env, token, 'bandeau_recu', `images=${total}`);
    ctx.waitUntil(analyzeInBackground(env, token, total, dossier.probleme));
  }

  return json(
    { index, total, accepted: true, analysisStatus: last ? 'pending' : 'idle' },
    202,
  );
}

async function analyzeInBackground(
  env: Env,
  token: string,
  total: number,
  probleme: string | null,
): Promise<void> {
  try {
    const urls = await Promise.all(
      Array.from({ length: total }, (_, i) =>
        signedImageUrl(env.SIGNING_KEY, env.PUBLIC_API_URL, bandeauKey(token, i)),
      ),
    );
    const analysis = await analyzeBandeau(env, urls, { probleme });
    await saveBandeauAnalysis(env, token, analysis);
    await logEvent(
      env,
      token,
      'bandeau_analyse',
      `code=${analysis.code ?? '—'} type=${analysis.displayType}`,
    );
  } catch (err) {
    // Comme pour les photos : l'échec n'interrompt jamais le parcours. Les
    // images restent disponibles pour le technicien.
    console.error('analyse du bandeau échouée', err);
    await saveBandeauAnalysis(env, token, null);
    await logEvent(env, token, 'bandeau_analyse_echec', null);
  }
}

/* ------------------------------------------------------------------ */
/* Vidéo source                                                        */
/* ------------------------------------------------------------------ */

/**
 * Plafond dicté par l'aval, pas par le Worker : `UrlFetchApp` d'Apps Script
 * refuse une réponse au-delà de 50 Mo, et c'est lui qui recopie la vidéo dans
 * l'archive Drive. Accepter davantage ici produirait une vidéo bien stockée
 * dans R2 mais silencieusement absente du dossier d'intervention.
 *
 * Dix secondes en 1080p tiennent autour de 20 Mo ; seul un enregistrement en
 * 4K HDR approcherait cette limite.
 */
const MAX_VIDEO_BYTES = 45 * 1024 * 1024;

const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm', 'video/3gpp'];

/**
 * Conserve l'enregistrement d'origine pour vérification humaine.
 *
 * Volontairement hors du chemin critique : le client a déjà pu poursuivre
 * grâce aux images extraites, et cet envoi se déroule pendant qu'il répond aux
 * dernières questions. S'il échoue ou s'interrompt — réseau perdu, onglet
 * fermé — le dossier reste complet et le diagnostic exploitable.
 */
export async function handleBandeauVideo(
  req: Request,
  env: Env,
  token: string,
): Promise<Response> {
  const dossier = await getDossier(env, token);
  if (!dossier) throw notFound();

  const type = (req.headers.get('content-type') ?? '').split(';')[0].trim();
  if (!VIDEO_TYPES.includes(type)) {
    throw badRequest(`Format vidéo non accepté (${type || 'inconnu'}).`);
  }

  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_VIDEO_BYTES) {
    await logEvent(env, token, 'bandeau_video_trop_lourde', String(declared));
    throw badRequest('Vidéo trop volumineuse.', 'payload_too_large');
  }
  if (!req.body) throw badRequest('Corps de requête vide.');

  const key = bandeauVideoKey(token);
  await env.PHOTOS.put(key, req.body, { httpMetadata: { contentType: type } });
  await recordBandeauVideo(env, token, key);
  await logEvent(env, token, 'bandeau_video_recue', `${type} ${declared} octets`);

  return json({ accepted: true }, 201);
}
