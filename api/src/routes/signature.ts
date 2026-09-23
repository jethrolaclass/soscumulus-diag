/**
 * The two doors of the signature: the short link the client taps, and the
 * webhook Youtrust calls when they have signed.
 */

import type { Env } from '../env';
import { findCasesAwaitingQuote, getQuoteByShort, logEvent } from '../lib/db';
import { json } from '../lib/http';
import { completeSignature, sendQuoteForSignature } from '../lib/signature-flow';
import { webhookIsGenuine } from '../lib/youtrust';

/**
 * diag.soscumulus.fr/s/<short> lands here. A 302, not a page: the client
 * asked to sign, the signing page is Youtrust's, and any screen of ours in
 * between is one more tap on a phone.
 */
export async function handleShortLink(env: Env, short: string): Promise<Response> {
  const q = await getQuoteByShort(env, short);
  if (!q?.signatureLink) {
    return new Response('Ce lien de devis est inconnu ou a expiré.', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  await logEvent(env, q.caseToken, 'quote_link_opened', q.status);
  return Response.redirect(q.signatureLink, 302);
}

interface WebhookEvent {
  event_id?: string;
  event_name?: string;
  sandbox?: boolean;
  data?: { signature_request?: { id?: string; status?: string; external_id?: string } };
}

/**
 * Youtrust wants a 2xx within one second, and what we do on a signature —
 * download the PDF, mail the team — takes longer. So: verify, acknowledge,
 * and do the work after the response has left.
 */
export async function handleYoutrustWebhook(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const raw = await req.arrayBuffer();
  const genuine = await webhookIsGenuine(
    raw,
    req.headers.get('x-yousign-signature-256'),
    env.YOUTRUST_WEBHOOK_SECRET,
  );
  if (!genuine) return json({ error: 'bad_signature' }, 401);

  let event: WebhookEvent;
  try {
    event = JSON.parse(new TextDecoder().decode(raw)) as WebhookEvent;
  } catch {
    return json({ error: 'bad_json' }, 400);
  }

  const requestId = event.data?.signature_request?.id;
  if (event.event_name === 'signature_request.done' && requestId) {
    ctx.waitUntil(
      completeSignature(env, requestId).catch((err) =>
        console.error('completeSignature failed', err),
      ),
    );
  }
  // Every other event is acknowledged and ignored: declines and expirations
  // are visible in Youtrust, and nothing here should act on them yet.
  return json({ ok: true });
}

/** Cron: quote every diagnosed case the submission request could not. */
export async function resumeQuotes(env: Env): Promise<number> {
  const tokens = await findCasesAwaitingQuote(env);
  let sent = 0;
  for (const token of tokens) {
    try {
      const r = await sendQuoteForSignature(env, token, 'web');
      if (r.ok && !r.already) sent++;
    } catch (err) {
      console.error(`quote failed for ${token}`, err);
      await logEvent(env, token, 'quote_failed', String(err).slice(0, 160));
    }
  }
  return sent;
}
