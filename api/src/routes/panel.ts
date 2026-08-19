import type { Env } from '../env';
import { analyzeControlPanel, deleteImages, uploadImage } from '../lib/claude';
import {
  getCase,
  logEvent,
  panelFrameKey,
  panelVideoKey,
  recordPanelFrames,
  recordPanelVideo,
  savePanelAnalysis,
} from '../lib/db';
import { badRequest, json, notFound } from '../lib/http';

/**
 * Control-panel frames, extracted client-side from a ten-second video. The
 * client sends them one by one — each streams to R2 like a photo — and the
 * analysis fires when the last one lands.
 *
 * A single vision call carries the whole sequence: it is the comparison
 * between frames that reveals a blink, so analysing them separately would
 * destroy exactly the information we are after.
 */

const MAX_FRAMES = 8;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;

export async function handlePanelFrame(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  token: string,
  params: URLSearchParams,
): Promise<Response> {
  const found = await getCase(env, token);
  if (!found) throw notFound();

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

  await env.PHOTOS.put(panelFrameKey(token, index), req.body, {
    httpMetadata: { contentType: 'image/jpeg' },
  });

  const last = index === total - 1;
  if (last) {
    await recordPanelFrames(env, token, total);
    await logEvent(env, token, 'panel_frames_received', `frames=${total}`);
    ctx.waitUntil(analyzeInBackground(env, token, total, found.reportedIssue));
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
  reportedIssue: string | null,
): Promise<void> {
  let fileIds: string[] = [];
  try {
    // Sequential, not parallel: the frames are small and five concurrent
    // uploads inside one invocation buy nothing worth the burst.
    for (let i = 0; i < total; i++) {
      fileIds.push(await uploadImage(env, panelFrameKey(token, i)));
    }
    const analysis = await analyzeControlPanel(env, fileIds, { reportedIssue });
    await savePanelAnalysis(env, token, analysis);
    await logEvent(
      env,
      token,
      'panel_analyzed',
      `code=${analysis.code ?? '—'} display=${analysis.displayType}`,
    );
  } catch (err) {
    // As with photos: a failure never interrupts the journey. The frames stay
    // available to the technician.
    console.error('control panel analysis failed', err);
    await savePanelAnalysis(env, token, null);
    await logEvent(env, token, 'panel_analysis_failed', null);
  } finally {
    if (fileIds.length) await deleteImages(env, fileIds);
  }
}

/* ------------------------------------------------------------------ */
/* Source video                                                        */
/* ------------------------------------------------------------------ */

/**
 * Cap dictated by what comes next, not by the Worker: Apps Script's
 * `UrlFetchApp` refuses a response beyond 50 MB, and it is what copies the
 * video into the Drive archive. Accepting more here would produce a video
 * safely stored in R2 but silently absent from the intervention folder.
 *
 * Ten seconds at 1080p sits around 20 MB; only a 4K HDR recording would come
 * close to this limit.
 */
const MAX_VIDEO_BYTES = 45 * 1024 * 1024;

const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm', 'video/3gpp'];

/**
 * Keep the original recording for human review.
 *
 * Deliberately off the critical path: the client has already been able to move
 * on thanks to the extracted frames, and this upload runs while they answer
 * the last questions. If it fails or is interrupted — network lost, tab closed
 * — the case stays complete and the diagnosis usable.
 */
export async function handlePanelVideo(
  req: Request,
  env: Env,
  token: string,
): Promise<Response> {
  const found = await getCase(env, token);
  if (!found) throw notFound();

  const type = (req.headers.get('content-type') ?? '').split(';')[0].trim();
  if (!VIDEO_TYPES.includes(type)) {
    throw badRequest(`Format vidéo non accepté (${type || 'inconnu'}).`);
  }

  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_VIDEO_BYTES) {
    await logEvent(env, token, 'panel_video_too_large', String(declared));
    throw badRequest('Vidéo trop volumineuse.', 'payload_too_large');
  }
  if (!req.body) throw badRequest('Corps de requête vide.');

  const key = panelVideoKey(token);
  await env.PHOTOS.put(key, req.body, { httpMetadata: { contentType: type } });
  await recordPanelVideo(env, token, key);
  await logEvent(env, token, 'panel_video_received', `${type} ${declared} bytes`);

  return json({ accepted: true }, 201);
}
