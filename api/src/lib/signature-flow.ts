/**
 * From a finished diagnosis to a signed quote.
 *
 * Two halves, each idempotent on its own row in `quotes`:
 *   - `sendQuoteForSignature` — price it, draw it, hand it to Youtrust, text
 *     the short link. Runs from the voice route or from the cron sweep, never
 *     from the submission request, whose 30 s wall clock is already spent on
 *     the synthesis.
 *   - `completeSignature` — the webhook's work: mark, fetch the signed PDF,
 *     and turn it into an intervention request for the team.
 *
 * A demo quote carries invented amounts, and so it only ever goes to the
 * team's own numbers whatever channel opened the case. That guard lives here
 * and not in the caller, because it is the kind of thing a caller forgets.
 */

import type { Env } from '../env';
import type { Installation, Nameplate } from '../../../shared/types';
import {
  getCase,
  getQuote,
  getQuoteByRequest,
  hasEvent,
  claimQuote,
  deleteQuote,
  logEvent,
  saveFailedQuote,
  STALE_CLAIM_MS,
  markQuoteSigned,
  saveQuote,
  setQuoteStatus,
} from './db';
import { buildQuote, type Quote } from './pricing';
import { renderQuotePdf, SIGNATURE_BOX } from './quote-pdf';
import { pushInterventionRequest } from './report';
import { normalizePhone, quoteMessage, sendSms, type SmsChannel, type SmsOutcome } from './sms';
import { createSignatureRequest, downloadSigned } from './youtrust';

export type QuoteOutcome =
  | { ok: true; already: true; status: string }
  | { ok: true; already: false; url: string; sms: SmsOutcome; quote: Quote }
  | { ok: false; reason: 'not_found' | 'no_diagnosis' | 'missing_contact' | 'needs_human'; quote?: Quote };

const SHORT_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Eight characters, no look-alikes: it is read off a phone screen. */
function newShortToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => SHORT_ALPHABET[b % SHORT_ALPHABET.length]).join('');
}

export async function sendQuoteForSignature(
  env: Env,
  token: string,
  channel: SmsChannel,
  opts: { retryFailed?: boolean } = {},
): Promise<QuoteOutcome> {
  const found = await getCase(env, token);
  if (!found) return { ok: false, reason: 'not_found' };
  // A demo quote has fixed amounts and leaves on the tap; a real one prices
  // what the diagnosis found, so it waits for it.
  if (!found.diagnosis && env.QUOTE_DEMO !== '1') return { ok: false, reason: 'no_diagnosis' };

  const existing = await getQuote(env, token);
  const stale =
    existing?.status === 'pending' &&
    Date.now() - Date.parse(existing.createdAt) > STALE_CLAIM_MS;
  if ((existing?.status === 'failed' && opts.retryFailed) || stale) {
    await deleteQuote(env, token);
  } else if (existing) {
    return { ok: true, already: true, status: existing.status };
  }

  if (!(await claimQuote(env, token))) {
    return { ok: true, already: true, status: 'pending' };
  }

  try {
    const outcome = await produceAndSend(env, token, found, channel);
    // Missing contact or no price: recorded, so the confirmation page's polls
    // and the cron stop asking every few seconds. The voice route retries on
    // request, once the client has typed the missing email.
    if (!outcome.ok) await saveFailedQuote(env, token, outcome.reason);
    return outcome;
  } catch (err) {
    await saveFailedQuote(env, token, String(err));
    throw err;
  }
}

async function produceAndSend(
  env: Env,
  token: string,
  found: NonNullable<Awaited<ReturnType<typeof getCase>>>,
  channel: SmsChannel,
): Promise<QuoteOutcome> {
  const demo = env.QUOTE_DEMO === '1';
  if (!found.diagnosis && !demo) return { ok: false, reason: 'no_diagnosis' };
  const a = found.answers;
  const email = a.email?.trim();
  if (!email || !a.firstName?.trim() || !a.lastName?.trim()) {
    await logEvent(env, token, 'quote_needs_contact', email ? 'name' : 'email');
    return { ok: false, reason: 'missing_contact' };
  }

  const nameplate: Nameplate | null = found.photos[1].analysis?.nameplate ?? null;
  const installation: Installation | null = found.photos[2].analysis?.installation ?? null;
  const quote = buildQuote(found.diagnosis, nameplate, installation, demo);
  if (quote.needsHumanPricing) {
    await logEvent(env, token, 'quote_needs_human', quote.reason.slice(0, 120));
    return { ok: false, reason: 'needs_human', quote };
  }

  const pdf = await renderQuotePdf({
    ref: found.ref,
    date: new Date(),
    client: {
      firstName: a.firstName.trim(),
      lastName: a.lastName.trim(),
      address: a.address?.trim(),
      phone: found.phone,
      email,
    },
    summary: found.diagnosis?.summary ?? objectLine(found, nameplate),
    quote,
  });

  const phone = normalizePhone(found.phone);
  const signature = await createSignatureRequest(env, {
    name: `Devis ${found.ref}`,
    externalId: token,
    pdf,
    filename: `Devis ${found.ref}.pdf`,
    signer: {
      firstName: a.firstName.trim(),
      lastName: a.lastName.trim(),
      email,
      phone: phone ? `+${phone}` : undefined,
    },
    box: SIGNATURE_BOX,
  });

  const short = newShortToken();
  await saveQuote(env, {
    caseToken: token,
    short,
    quote,
    demo,
    requestId: signature.requestId,
    signerId: signature.signerId,
    signatureLink: signature.signatureLink,
  });

  const url = `${env.PUBLIC_WEB_URL}/s/${short}`;
  // Invented amounts never leave the team: a demo quote takes the voice
  // allowlist whatever channel it came from.
  const sms = await sendSms(
    env,
    token,
    found.phone,
    quoteMessage(found.ref, url),
    'quote',
    demo ? 'voice' : channel,
  );
  await setQuoteStatus(env, token, sms === 'sent' ? 'sent' : 'created');
  await logEvent(
    env,
    token,
    'quote_sent',
    `${quote.total} EUR sms=${sms} demo=${demo} youtrust=${signature.requestId}`,
  );

  return { ok: true, already: false, url, sms, quote };
}

/**
 * Called by the webhook, in the background: the webhook itself has answered
 * 200 already, because Youtrust gives it one second and this takes more.
 *
 * The email carries the intervention sheet, and a client who signs within a
 * minute of the text can beat the sheet to it — the diagnosis behind it takes
 * about that long. Then the email waits: `flushIntervention` sends it once the
 * report has run, and the cron sends it anyway if the report never says so.
 */
export async function completeSignature(env: Env, requestId: string): Promise<void> {
  const q = await getQuoteByRequest(env, requestId);
  if (!q) {
    console.warn(`signature done for unknown request ${requestId}`);
    return;
  }
  // Youtrust retries; the second delivery must not send a second email.
  if (q.status === 'signed') return;

  await markQuoteSigned(env, q.caseToken);
  await logEvent(env, q.caseToken, 'quote_signed', requestId);

  const reportRan =
    (await hasEvent(env, q.caseToken, 'report_generated')) ||
    (await hasEvent(env, q.caseToken, 'report_failed'));
  if (!reportRan) {
    await logEvent(env, q.caseToken, 'intervention_deferred', 'waiting for the sheet');
    return;
  }
  await requestIntervention(env, q.caseToken);
}

/** After a report: send the intervention email a signature left waiting. */
export async function flushIntervention(env: Env, caseToken: string): Promise<void> {
  const q = await getQuote(env, caseToken);
  if (q?.status === 'signed') await requestIntervention(env, caseToken);
}

/** Idempotent: an email already sent, or already failed, is not sent again. */
export async function requestIntervention(env: Env, caseToken: string): Promise<void> {
  if (
    (await hasEvent(env, caseToken, 'intervention_requested')) ||
    (await hasEvent(env, caseToken, 'intervention_request_failed'))
  ) {
    return;
  }
  const q = await getQuote(env, caseToken);
  const found = await getCase(env, caseToken);
  if (!q?.requestId || !found) return;

  let signedPdf: string | null = null;
  try {
    signedPdf = toBase64(await downloadSigned(env, q.requestId));
  } catch (err) {
    console.error('signed PDF download failed', err);
    await logEvent(env, caseToken, 'signed_pdf_unavailable', String(err).slice(0, 160));
  }

  const a = found.answers;
  const ok = await pushInterventionRequest(env, {
    ref: found.ref,
    token: caseToken,
    caseUrl: `${env.PUBLIC_WEB_URL}/d/${caseToken}`,
    to: env.INTERVENTION_EMAIL,
    client: {
      firstName: a.firstName ?? '',
      lastName: a.lastName ?? '',
      phone: found.phone,
      email: a.email ?? '',
      address: a.address ?? '',
      city: found.city,
    },
    availability: a.availability ?? [],
    diagnosis: found.diagnosis,
    quote: q.quote,
    demo: q.demo,
    signedAt: q.signedAt ?? new Date().toISOString(),
    signedPdf,
  });
  await logEvent(
    env,
    caseToken,
    ok ? 'intervention_requested' : 'intervention_request_failed',
    env.INTERVENTION_EMAIL,
  );
}

/** What the quote is for, when the written diagnosis is not there yet. */
function objectLine(
  found: NonNullable<Awaited<ReturnType<typeof getCase>>>,
  nameplate: Nameplate | null,
): string {
  const unit = nameplate?.readable
    ? [nameplate.brand, nameplate.model, nameplate.capacityLiters ? `${nameplate.capacityLiters} L` : null]
        .filter(Boolean)
        .join(' ')
    : '';
  const issue = found.reportedIssue?.trim();
  return (
    'Intervention sur chauffe-eau' +
    (unit ? ` (${unit})` : '') +
    (issue ? ` — problème signalé : « ${issue} ».` : '.') +
    ' Diagnostic établi à distance à partir des photos transmises.'
  );
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}
