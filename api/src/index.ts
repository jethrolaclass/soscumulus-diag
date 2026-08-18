import type { Env } from './env';
import { purgeExpired } from './lib/db';
import { handleLead } from './routes/lead';
import { handleGetDossier, handleAnswers, handleSubmit } from './routes/dossier';
import { handlePhotoUpload, handleSkipPhoto } from './routes/photo';
import { handleImage } from './routes/image';
import { handleBandeauFrame, handleBandeauVideo } from './routes/bandeau';
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
      // Le détail reste dans les logs : un message d'erreur interne renvoyé au
      // client renseigne autant un attaquant qu'un développeur.
      console.error('unhandled', err);
      return withCors(
        env,
        json({ error: 'internal', message: 'Erreur interne.' }, 500),
      );
    }
  },

  /** Purge RGPD quotidienne — cf. `[triggers]` dans wrangler.toml. */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const n = await purgeExpired(env);
    if (n > 0) console.log(`purge: ${n} dossier(s) expiré(s)`);
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

  // GET /i/:key — image signée, consommée par l'API vision.
  if (seg[0] === 'i' && seg.length === 2 && method === 'GET') {
    return handleImage(req, env, decodeURIComponent(seg[1]));
  }

  if (seg[0] !== 'api') return json({ error: 'not_found', message: '' }, 404);

  // POST /api/lead — appelé par Google Apps Script.
  if (seg[1] === 'lead' && seg.length === 2 && method === 'POST') {
    return handleLead(req, env, ctx);
  }

  if (seg[1] === 'dossier' && seg[2]) {
    const token = seg[2];

    // GET /api/dossier/:token
    if (seg.length === 3 && method === 'GET') {
      return handleGetDossier(env, token);
    }
    // PATCH /api/dossier/:token/answers
    if (seg[3] === 'answers' && seg.length === 4 && method === 'PATCH') {
      return handleAnswers(req, env, token);
    }
    // POST /api/dossier/:token/photo?slot=N
    if (seg[3] === 'photo' && seg.length === 4 && method === 'POST') {
      return handlePhotoUpload(req, env, ctx, token, url.searchParams.get('slot'));
    }
    // POST /api/dossier/:token/photo/:slot/skip
    if (seg[3] === 'photo' && seg[5] === 'skip' && method === 'POST') {
      return handleSkipPhoto(env, token, seg[4]);
    }
    // POST /api/dossier/:token/bandeau?i=<rang>&n=<total>
    if (seg[3] === 'bandeau' && seg.length === 4 && method === 'POST') {
      return handleBandeauFrame(req, env, ctx, token, url.searchParams);
    }
    // POST /api/dossier/:token/bandeau/video
    if (seg[3] === 'bandeau' && seg[4] === 'video' && method === 'POST') {
      return handleBandeauVideo(req, env, token);
    }
    // POST /api/dossier/:token/submit
    if (seg[3] === 'submit' && seg.length === 4 && method === 'POST') {
      return handleSubmit(req, env, ctx, token);
    }
  }

  return json({ error: 'not_found', message: 'Route inconnue.' }, 404);
}
