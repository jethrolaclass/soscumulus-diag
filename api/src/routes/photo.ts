import type { Env } from '../env';
import type { LocalVerdict, PhotoSlot } from '../../../shared/types';
import { LOCAL_VERDICTS, isAnalyzedSlot } from '../../../shared/types';
import { analyzePhoto, deleteImages, uploadImage } from '../lib/claude';
import {
  getCase,
  getPhotoKey,
  logEvent,
  markSkipped,
  recordUpload,
  saveAnalysis,
} from '../lib/db';
import { badRequest, json, notFound, parseSlot } from '../lib/http';

/**
 * Safety cap. The front end normalises to ~300 KB, or up to ~1 MB for the
 * nameplate, which is sent at 2576 px so the barcode digits resolve. Beyond
 * 8 MB this is either a bypass of the front end or a normalisation bug.
 */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/**
 * The browser's own verdict, carried as a query parameter rather than a header:
 * one fewer entry in the CORS allow-list, and nothing to keep in sync there.
 * Anything unrecognised is dropped — this is client-supplied.
 */
function parseLocalVerdict(raw: string | null): LocalVerdict | null {
  return LOCAL_VERDICTS.find((v) => v === raw) ?? null;
}

export async function handlePhotoUpload(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  token: string,
  slotRaw: string | null,
  localVerdictRaw: string | null,
): Promise<Response> {
  const slot = parseSlot(slotRaw);
  const found = await getCase(env, token);
  if (!found) throw notFound();

  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.startsWith('image/jpeg')) {
    throw badRequest('Le corps doit être un JPEG (image/jpeg).');
  }

  const declaredLength = Number(req.headers.get('content-length') ?? '0');
  if (declaredLength > MAX_UPLOAD_BYTES) {
    throw badRequest('Photo trop volumineuse.', 'payload_too_large');
  }
  if (!req.body) throw badRequest('Corps de requête vide.');

  // The stream goes straight to R2. Nothing is buffered or encoded: that is
  // what keeps the Worker's CPU footprint under the free plan's budget.
  const key = `${token}/${slot}-${Date.now()}.jpg`;
  await env.PHOTOS.put(key, req.body, {
    httpMetadata: { contentType: 'image/jpeg' },
  });

  const analyzed = isAnalyzedSlot(slot);
  const attempt = await recordUpload(
    env,
    token,
    slot,
    key,
    analyzed ? 'pending' : 'done',
    parseLocalVerdict(localVerdictRaw),
  );
  await logEvent(env, token, 'photo_received', `slot=${slot} attempt=${attempt}`);

  // Analysis continues after the response: the client gets an immediate
  // acknowledgement and polls the case for the verdict. This avoids holding
  // the connection open during the vision call, and lets the photo preview
  // appear without waiting.
  if (analyzed) {
    ctx.waitUntil(
      analyzeInBackground(env, token, slot, key, attempt, {
        city: found.city,
        reportedIssue: found.reportedIssue,
      }),
    );
  }

  return json({ slot, accepted: true, analysisStatus: analyzed ? 'pending' : 'done' }, 202);
}

async function analyzeInBackground(
  env: Env,
  token: string,
  slot: PhotoSlot,
  key: string,
  attempt: number,
  context: { city: string | null; reportedIssue: string | null },
): Promise<void> {
  let fileId: string | null = null;
  try {
    fileId = await uploadImage(env, key);
    const analysis = await analyzePhoto(env, slot, fileId, { ...context, attempt });
    await saveAnalysis(env, token, slot, analysis);
    await logEvent(
      env,
      token,
      'photo_analyzed',
      `slot=${slot} usable=${analysis.usable} quality=${analysis.quality}`,
    );
  } catch (err) {
    // A failed analysis must never block the client: the photo is stored and
    // the technician will see it. The front end treats `failed` as a silent
    // acceptance.
    console.error(`photo analysis failed for slot ${slot}`, err);
    await saveAnalysis(env, token, slot, null);
    await logEvent(env, token, 'photo_analysis_failed', `slot=${slot}`);
  } finally {
    // The copy has served its purpose; R2 keeps the original.
    if (fileId) await deleteImages(env, [fileId]);
  }
}

export async function handleSkipPhoto(
  env: Env,
  token: string,
  slotRaw: string,
): Promise<Response> {
  const slot = parseSlot(slotRaw);
  const found = await getCase(env, token);
  if (!found) throw notFound();

  await markSkipped(env, token, slot);
  await logEvent(env, token, 'photo_skipped', `slot=${slot}`);
  return json({ slot, skipped: true });
}

/**
 * Serve the client their own photo back.
 *
 * The preview shown right after a capture is a local object URL, which dies
 * with the page: on reload the journey fell back to the example shot, as if
 * nothing had been sent. The photo itself lives in R2 behind a signed URL the
 * front end never holds.
 *
 * The case token is the credential here — it is already what grants access to
 * everything else in the case, so no second signature is needed. Kept separate
 * from the signed `/i/` route, whose consumer is the vision API and whose URLs
 * expire in five minutes.
 */
export async function handlePhotoFetch(
  env: Env,
  token: string,
  slotRaw: string,
): Promise<Response> {
  const slot = parseSlot(slotRaw);
  const found = await getCase(env, token);
  if (!found) throw notFound();

  const key = await getPhotoKey(env, token, slot);
  if (!key) throw notFound();

  const object = await env.PHOTOS.get(key);
  if (!object) throw notFound();

  return new Response(object.body, {
    headers: {
      'content-type': object.httpMetadata?.contentType ?? 'image/jpeg',
      // Long enough that navigating back and forth does not refetch, short
      // enough that a retake shows the new photo.
      'cache-control': 'private, max-age=60',
    },
  });
}
