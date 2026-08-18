import type { Env } from '../env';
import type { LeadRequest, LeadResponse } from '../../../shared/types';
import { createCase, logEvent } from '../lib/db';
import { newCaseToken } from '../lib/signing';
import { sendDiagSms } from '../lib/sms';
import { badRequest, json, secretMatches, unauthorized } from '../lib/http';

/**
 * Entry point from the website form.
 *
 * The soscumulus.fr form already posts to a Google Apps Script web app. That
 * chain is preserved: the script keeps its Sheet and its emails and simply
 * relays the submission here. See scripts/apps-script.gs.
 */
export async function handleLead(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (!secretMatches(req.headers.get('x-lead-secret'), env.LEAD_SECRET)) {
    throw unauthorized();
  }

  const body = (await req.json().catch(() => null)) as LeadRequest | null;
  if (!body?.phone || typeof body.phone !== 'string') {
    throw badRequest('Champ `phone` requis.');
  }

  const token = newCaseToken();
  const created = await createCase(env, token, {
    phone: body.phone.trim(),
    city: body.city?.trim() || undefined,
    reportedIssue: body.reportedIssue?.trim() || undefined,
  });

  const url = `${env.PUBLIC_WEB_URL}/d/${token}`;

  let smsSent = false;
  try {
    smsSent = await sendDiagSms(env, token, created.phone, url);
  } catch (err) {
    // The case exists and the link is valid: a send failure must not cost the
    // lead. The team can resend the link by hand from the event log.
    console.error('SMS send failed', err);
    ctx.waitUntil(logEvent(env, token, 'sms_to_resend', url));
  }

  const payload: LeadResponse = { ref: created.ref, url, smsSent };
  return json(payload, 201);
}
