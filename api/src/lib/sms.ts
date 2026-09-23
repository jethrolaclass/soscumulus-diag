/**
 * Transactional SMS through Brevo.
 *
 * The sender is alphanumeric ("SOSCumulus"), which prevents the recipient from
 * replying. The message must therefore never invite a reply — the prototype
 * offered "reply to this text with your photos", which would require a
 * two-way long number, a different plan and inbound MMS handling.
 */

import type { Env } from '../env';
import { logEvent } from './db';

const BREVO_ENDPOINT = 'https://api.brevo.com/v3/transactionalSMS/sms';

/**
 * Maximum length of one segment in the GSM-7 alphabet. Beyond it the carrier
 * splits the message and bills two texts.
 *
 * The message must contain NO accented character. A single "é" switches the
 * encoding to UCS-2 and drops the limit to 70 characters, turning the message
 * into three segments. That is why the text below writes "recu" and
 * "deplacement" without accents: it is not a typo to fix.
 */
const SINGLE_SEGMENT = 160;

export class SmsError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = 'SmsError';
  }
}

/**
 * Normalise a French number to the format Brevo expects: country code without
 * "+", no separators. "06 67 69 10 70" becomes "33667691070".
 */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+33')) return `33${digits.slice(3)}`;
  if (digits.startsWith('0033')) return `33${digits.slice(4)}`;
  if (digits.startsWith('33') && digits.length === 11) return digits;
  if (/^0[1-9]\d{8}$/.test(digits)) return `33${digits.slice(1)}`;
  return null;
}

export function diagMessage(url: string): string {
  // Calibrated so this text plus a 51-character URL stays under 160.
  return `SOS Cumulus : votre diagnostic a distance en 2 min avec 3 photos, sans frais de deplacement : ${url}`;
}

/**
 * Is this number allowed to receive a text?
 *
 * Compared on normalised numbers so the list can be written in any format —
 * "07 88 08 91 28" and "+33788089128" mean the same recipient.
 */
export function smsAllowed(
  recipient: string,
  allowlist: string | undefined,
): boolean {
  const entries = (allowlist ?? '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);

  // Empty list: production behaviour, everyone receives.
  if (entries.length === 0) return true;

  return entries.some((n) => normalizePhone(n) === recipient);
}

/**
 * Quote text. No accents, like the diagnosis one: an accented character flips
 * the whole message to UCS-2 and halves the segment to 70 characters.
 */
export function quoteMessage(ref: string, total: number): string {
  return (
    `SOS Cumulus, dossier ${ref} : votre devis est de ${total} EUR TTC, ` +
    `pose et deplacement compris. Repondez OK a ce message pour l'accepter, ` +
    `un technicien vous rappelle pour le rendez-vous.`
  );
}

/**
 * Who asked for the text. Each channel has its own allowlist: the website has
 * been open to every prospect since go-live, while the phone agent is still
 * tested by ear and must only ever text the team's own numbers.
 */
export type SmsChannel = 'web' | 'voice';

/**
 * `blocked` is not a failure: the allowlist did its job, and the caller must
 * carry on as if nothing was owed — not hand the call to a technician.
 */
export type SmsOutcome = 'sent' | 'blocked' | 'invalid';

function allowlistFor(env: Env, channel: SmsChannel): string | undefined {
  return channel === 'voice' ? env.SMS_ALLOWLIST_VOICE : env.SMS_ALLOWLIST;
}

/** Sends an already-built text. Throws on a Brevo failure. */
export async function sendSms(
  env: Env,
  token: string,
  phone: string,
  content: string,
  kind: string,
  channel: SmsChannel,
): Promise<SmsOutcome> {
  const recipient = normalizePhone(phone);
  if (!recipient) {
    await logEvent(env, token, 'sms_invalid_number', phone);
    return 'invalid';
  }
  if (!smsAllowed(recipient, allowlistFor(env, channel))) {
    await logEvent(env, token, 'sms_blocked_by_allowlist', `${channel} ${recipient}`);
    return 'blocked';
  }
  await post(env, token, recipient, content, kind);
  return 'sent';
}

export async function sendDiagSms(
  env: Env,
  token: string,
  phone: string,
  url: string,
  channel: SmsChannel,
): Promise<SmsOutcome> {
  const recipient = normalizePhone(phone);
  if (!recipient) {
    await logEvent(env, token, 'sms_invalid_number', phone);
    return 'invalid';
  }

  if (!smsAllowed(recipient, allowlistFor(env, channel))) {
    // The case stays created and its link valid: the lead email shows it with
    // a "not sent" notice, and the team can pass it on by hand.
    await logEvent(env, token, 'sms_blocked_by_allowlist', `${channel} ${recipient}`);
    console.warn(
      `SMS not sent to ${recipient}: allowlist active for channel ${channel}. ` +
        'Clear that variable to open it.',
    );
    return 'blocked';
  }

  const content = diagMessage(url);
  if (content.length > SINGLE_SEGMENT) {
    // Logged rather than printed: this is billing drift, not a technical
    // incident, and it would otherwise go unnoticed.
    const segments = Math.ceil(content.length / SINGLE_SEGMENT);
    await logEvent(
      env,
      token,
      'sms_multi_segment',
      `${content.length} chars, ${segments} segments`,
    );
  }

  await post(env, token, recipient, content, 'diag');
  return 'sent';
}

async function post(
  env: Env,
  token: string,
  recipient: string,
  content: string,
  kind: string,
): Promise<boolean> {
  const res = await fetch(BREVO_ENDPOINT, {
    method: 'POST',
    headers: {
      'api-key': env.SMS_API_KEY,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      sender: env.SMS_SENDER,
      recipient,
      content,
      // This text answers an explicit client request: it is transactional and
      // not subject to the time-of-day restrictions on marketing messages.
      type: 'transactional',
      unicodeEnabled: false,
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    await logEvent(env, token, 'sms_failed', `${kind} ${res.status} ${detail.slice(0, 180)}`);
    throw new SmsError(`Brevo ${res.status}`, res.status);
  }

  await logEvent(env, token, 'sms_sent', `${kind} ${recipient}`);
  return true;
}
