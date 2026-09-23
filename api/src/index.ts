import type { Env } from './env';
import { purgeExpired } from './lib/db';
import { handleLead } from './routes/lead';
import {
  handleGetCase,
  handleAnswers,
  handleSubmit,
  resumeDiagnoses,
} from './routes/case';
import {
  handlePhotoFetch,
  handlePhotoUpload,
  handleSkipPhoto,
} from './routes/photo';
import { handlePanelFrame, handlePanelVideo } from './routes/panel';
import {
  handleVoiceOpen,
  handleVoiceProgress,
  handleVoiceTriage,
  handleVoiceLink,
} from './routes/voice';
import { handleQuote, handleQuoteAccept } from './routes/quote';
import { handleGreeting } from './routes/greeting';
import { handleShortLink, handleYoutrustWebhook } from './routes/signature';
import { resumeQuotes } from './routes/signature';
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
  // Two schedules, one handler. The nightly one is the retention purge; the
  // frequent one finishes the syntheses the platform cut short.
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    if (event.cron === PURGE_CRON) {
      const n = await purgeExpired(env);
      if (n > 0) console.log(`purge: ${n} expired case(s)`);
      return;
    }

    const n = await resumeDiagnoses(env);
    const q = await resumeQuotes(env);
    if (q > 0) console.log(`quotes sent: ${q}`);
    if (n > 0) console.log(`resumed ${n} pending diagnosis(es)`);
  },
};

/** Must match `crons` in wrangler.toml. */
const PURGE_CRON = '17 3 * * *';

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

  // GET /s/:short — the link the quote SMS carries, bounced to the signing page.
  if (seg[0] === 's' && seg[1] && seg.length === 2 && method === 'GET') {
    return handleShortLink(env, seg[1]);
  }

  if (seg[0] !== 'api') return json({ error: 'not_found', message: '' }, 404);

  // POST /api/lead — called by Google Apps Script.
  if (seg[1] === 'lead' && seg.length === 2 && method === 'POST') {
    return handleLead(req, env, ctx);
  }

  // POST /api/youtrust/webhook — a quote was signed.
  if (seg[1] === 'youtrust' && seg[2] === 'webhook' && method === 'POST') {
    return handleYoutrustWebhook(req, env, ctx);
  }

  // Voice agent. Same data, same tables — only the way in differs.
  if (seg[1] === 'voice') {
    // Called by ElevenLabs as it sets the conversation up, before the caller
    // hears anything. Deliberately unauthenticated — see the route.
    if (seg[2] === 'greeting' && seg.length === 3 && method === 'POST') {
      return handleGreeting();
    }
    if (seg[2] === 'case' && seg.length === 3 && method === 'POST') {
      return handleVoiceOpen(req, env);
    }
    if (seg[2] === 'case' && seg[3] && seg[4] === 'triage' && method === 'POST') {
      return handleVoiceTriage(req, env, seg[3]);
    }
    if (seg[2] === 'case' && seg[3] && seg[4] === 'link' && method === 'POST') {
      return handleVoiceLink(req, env, seg[3]);
    }
    if (seg[2] === 'case' && seg[3] && seg[4] === 'progress' && method === 'GET') {
      return handleVoiceProgress(req, env, seg[3]);
    }
  }

  if (seg[1] === 'case' && seg[2]) {
    const token = seg[2];

    // GET /api/case/:token
    if (seg.length === 3 && method === 'GET') {
      return handleGetCase(env, ctx, token);
    }
    // PATCH /api/case/:token/answers
    if (seg[3] === 'answers' && seg.length === 4 && method === 'PATCH') {
      return handleAnswers(req, env, token, url.searchParams.get('confirm') === '1');
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
    // POST /api/case/:token/quote — the voice agent, once the photos are in
    if (seg[3] === 'quote' && seg.length === 4 && method === 'POST') {
      return handleQuote(req, env, ctx, token);
    }

    if (seg[3] === 'quote' && seg[4] === 'accept' && method === 'POST') {
      return handleQuoteAccept(req, env, token);
    }

    if (seg[3] === 'submit' && seg.length === 4 && method === 'POST') {
      return handleSubmit(req, env, ctx, token);
    }
  }

  return json({ error: 'not_found', message: 'Route inconnue.' }, 404);
}
