import type { Env } from './env';
import { purgeExpired } from './lib/db';
import { handleLead } from './routes/lead';
import { handleGetCase, handleAnswers, handleSubmit } from './routes/case';
import {
  handlePhotoFetch,
  handlePhotoUpload,
  handleSkipPhoto,
} from './routes/photo';
import { handlePanelFrame, handlePanelVideo } from './routes/panel';
import { handleImage } from './routes/image';
import { json, preflight, withCors, ApiHttpError } from './lib/http';

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method === 'OPTIONS') return preflight(env);

    try {
      return withCors(env, await route(req, env, ctx));
    } catch (err) {
      if (err instanceof ApiHttpError) {
        return withCors(env, json({ error: err.code, message: err.message }, err.status));
      }
      // Details stay in the logs: an internal error message returned to the
      // client informs an attacker as much as a developer.
      console.error('unhandled', err);
      return withCors(
        env,
        json({ error: 'internal', message: 'Erreur interne.' }, 500),
      );
    }
  },

  /** Daily GDPR purge — see `[triggers]` in wrangler.toml. */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const n = await purgeExpired(env);
    if (n > 0) console.log(`purge: ${n} expired case(s)`);
  },
};

async function route(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(req.url);
  const seg = url.pathname.split('/').filter(Boolean);
  const method = req.method;

  // GET /i/:token/:filename — signed image, consumed by the vision API.
  // Two segments, never one percent-encoded key: see signedImageUrl.
  if (seg[0] === 'i' && seg.length === 3 && method === 'GET') {
    return handleImage(req, env, `${seg[1]}/${seg[2]}`);
  }

  if (seg[0] !== 'api') return json({ error: 'not_found', message: '' }, 404);

  // POST /api/lead — called by Google Apps Script.
  if (seg[1] === 'lead' && seg.length === 2 && method === 'POST') {
    return handleLead(req, env, ctx);
  }

  if (seg[1] === 'case' && seg[2]) {
    const token = seg[2];

    // GET /api/case/:token
    if (seg.length === 3 && method === 'GET') {
      return handleGetCase(env, token);
    }
    // PATCH /api/case/:token/answers
    if (seg[3] === 'answers' && seg.length === 4 && method === 'PATCH') {
      return handleAnswers(req, env, token);
    }
    // POST /api/case/:token/photo?slot=N
    if (seg[3] === 'photo' && seg.length === 4 && method === 'POST') {
      return handlePhotoUpload(
        req,
        env,
        ctx,
        token,
        url.searchParams.get('slot'),
        url.searchParams.get('q'),
      );
    }
    // GET /api/case/:token/photo/:slot — the client's own photo
    if (seg[3] === 'photo' && seg.length === 5 && method === 'GET') {
      return handlePhotoFetch(env, token, seg[4]);
    }
    // POST /api/case/:token/photo/:slot/skip
    if (seg[3] === 'photo' && seg[5] === 'skip' && method === 'POST') {
      return handleSkipPhoto(env, token, seg[4]);
    }
    // POST /api/case/:token/panel?i=<rank>&n=<total>
    if (seg[3] === 'panel' && seg.length === 4 && method === 'POST') {
      return handlePanelFrame(req, env, ctx, token, url.searchParams);
    }
    // POST /api/case/:token/panel/video
    if (seg[3] === 'panel' && seg[4] === 'video' && method === 'POST') {
      return handlePanelVideo(req, env, token);
    }
    // POST /api/case/:token/submit
    if (seg[3] === 'submit' && seg.length === 4 && method === 'POST') {
      return handleSubmit(req, env, ctx, token);
    }
  }

  return json({ error: 'not_found', message: 'Route inconnue.' }, 404);
}
