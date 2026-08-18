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

export async function sendDiagSms(
  env: Env,
  token: string,
  phone: string,
  url: string,
): Promise<boolean> {
  const recipient = normalizePhone(phone);
  if (!recipient) {
    await logEvent(env, token, 'sms_invalid_number', phone);
    return false;
  }

  if (!smsAllowed(recipient, env.SMS_ALLOWLIST)) {
    // The case stays created and its link valid: the lead email shows it with
    // a "not sent" notice, and the team can pass it on by hand.
    await logEvent(env, token, 'sms_blocked_by_allowlist', recipient);
    console.warn(
      `SMS not sent to ${recipient}: test allowlist active (SMS_ALLOWLIST). ` +
        'Clear that variable to go live.',
    );
    return false;
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
    await logEvent(env, token, 'sms_failed', `${res.status} ${detail.slice(0, 200)}`);
    throw new SmsError(`Brevo ${res.status}`, res.status);
  }

  await logEvent(env, token, 'sms_sent', recipient);
  return true;
}
