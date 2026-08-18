import type { Env } from '../env';
import type { PhotoSlot } from '../../../shared/types';
import { analyzePhoto } from '../lib/claude';
import {
  getDossier,
  logEvent,
  markSkipped,
  recordUpload,
  saveAnalysis,
} from '../lib/db';
import { signedImageUrl } from '../lib/signing';
import { badRequest, json, notFound, parseSlot } from '../lib/http';

/**
 * Plafond de sécurité. Le front normalise à ~300 Ko ; au-delà de 8 Mo il s'agit
 * soit d'un contournement du front, soit d'un bug de normalisation.
 */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

export async function handlePhotoUpload(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  token: string,
  slotRaw: string | null,
): Promise<Response> {
  const slot = parseSlot(slotRaw);
  const dossier = await getDossier(env, token);
  if (!dossier) throw notFound();

  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.startsWith('image/jpeg')) {
    throw badRequest('Le corps doit être un JPEG (image/jpeg).');
  }

  const declaredLength = Number(req.headers.get('content-length') ?? '0');
  if (declaredLength > MAX_UPLOAD_BYTES) {
    throw badRequest('Photo trop volumineuse.', 'payload_too_large');
  }
  if (!req.body) throw badRequest('Corps de requête vide.');

  // Le flux part directement vers R2. Rien n'est mis en mémoire ni encodé :
  // c'est ce qui garde l'empreinte CPU du Worker sous le quota du plan gratuit.
  const key = `${token}/${slot}-${Date.now()}.jpg`;
  await env.PHOTOS.put(key, req.body, {
    httpMetadata: { contentType: 'image/jpeg' },
  });

  const attempt = await recordUpload(env, token, slot, key);
  await logEvent(env, token, 'photo_recue', `slot=${slot} tentative=${attempt}`);

  // L'analyse se poursuit après la réponse : le client reçoit immédiatement un
  // accusé et interroge /api/dossier/:token pour le verdict. Cela évite de
  // maintenir la connexion ouverte pendant l'appel vision, et permet d'afficher
  // l'aperçu de la photo sans attendre.
  ctx.waitUntil(
    analyzeInBackground(env, token, slot, key, attempt, {
      ville: dossier.ville,
      probleme: dossier.probleme,
    }),
  );

  return json({ slot, accepted: true, analysisStatus: 'pending' }, 202);
}

async function analyzeInBackground(
  env: Env,
  token: string,
  slot: PhotoSlot,
  key: string,
  attempt: number,
  ctx: { ville: string | null; probleme: string | null },
): Promise<void> {
  try {
    const url = await signedImageUrl(env.SIGNING_KEY, env.PUBLIC_API_URL, key);
    const analysis = await analyzePhoto(env, slot, url, { ...ctx, attempt });
    await saveAnalysis(env, token, slot, analysis);
    await logEvent(
      env,
      token,
      'photo_analysee',
      `slot=${slot} usable=${analysis.usable} quality=${analysis.quality}`,
    );
  } catch (err) {
    // Une analyse en échec ne doit jamais bloquer le client : la photo est
    // stockée et le technicien la verra. Le front traite `failed` comme une
    // acceptation silencieuse.
    console.error(`analyse slot ${slot} échouée`, err);
    await saveAnalysis(env, token, slot, null);
    await logEvent(env, token, 'photo_analyse_echec', `slot=${slot}`);
  }
}

export async function handleSkipPhoto(
  env: Env,
  token: string,
  slotRaw: string,
): Promise<Response> {
  const slot = parseSlot(slotRaw);
  const dossier = await getDossier(env, token);
  if (!dossier) throw notFound();

  await markSkipped(env, token, slot);
  await logEvent(env, token, 'photo_ignoree', `slot=${slot}`);
  return json({ slot, skipped: true });
}
