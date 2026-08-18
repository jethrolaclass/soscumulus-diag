/**
 * Envoi SMS transactionnel via Brevo.
 *
 * L'expéditeur est alphanumérique ("SOSCUMULUS"), ce qui interdit toute
 * réponse du destinataire. Le message ne doit donc jamais inviter à répondre —
 * le prototype proposait « répondez à ce SMS avec vos photos », ce qui
 * supposerait un numéro long à deux sens, une autre offre et un traitement
 * des MMS entrants.
 */

import type { Env } from '../env';
import { logEvent } from './db';

const BREVO_ENDPOINT = 'https://api.brevo.com/v3/transactionalSMS/sms';

/** Longueur maximale d'un SMS avant segmentation (GSM-7). */
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
 * Normalise un numéro français vers le format attendu par Brevo :
 * indicatif pays sans `+`, sans séparateur. « 06 67 69 10 70 » → « 33667691070 ».
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
  // Formulé pour tenir en un segment : au-delà de 160 caractères le message
  // est facturé double et peut arriver scindé sur certains opérateurs.
  const body = `SOS Cumulus : nous avons bien recu votre demande. Etablissez votre diagnostic a distance en 2 min avec 3 photos, sans frais de deplacement : ${url}`;
  return body;
}

export async function sendDiagSms(
  env: Env,
  token: string,
  tel: string,
  url: string,
): Promise<boolean> {
  const recipient = normalizePhone(tel);
  if (!recipient) {
    await logEvent(env, token, 'sms_numero_invalide', tel);
    return false;
  }

  const content = diagMessage(url);
  if (content.length > SINGLE_SEGMENT) {
    console.warn(`SMS sur ${Math.ceil(content.length / SINGLE_SEGMENT)} segments`);
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
      type: 'transactional',
      // Ce SMS répond à une demande explicite du client : il est transactionnel
      // et non soumis aux restrictions horaires de la prospection.
      unicodeEnabled: false,
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    await logEvent(env, token, 'sms_echec', `${res.status} ${detail.slice(0, 200)}`);
    throw new SmsError(`Brevo ${res.status}`, res.status);
  }

  await logEvent(env, token, 'sms_envoye', recipient);
  return true;
}
