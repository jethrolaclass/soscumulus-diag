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

/**
 * Longueur maximale d'un segment en alphabet GSM-7. Au-delà, l'opérateur
 * scinde et facture deux SMS.
 *
 * ‼️ Le message ne doit contenir AUCUN caractère accentué. Un seul « é » bascule
 * l'encodage en UCS-2 et ramène la limite à 70 caractères — le message devient
 * alors trois segments au lieu d'un. C'est pourquoi le texte ci-dessous écrit
 * « recu » et « Etablissez » sans accent : ce n'est pas une faute à corriger.
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
  // Calibre : ce texte plus une URL de 51 caracteres tient sous 160.
  return `SOS Cumulus : votre diagnostic a distance en 2 min avec 3 photos, sans frais de deplacement : ${url}`;
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
    // Journalisé et non simplement affiché : c'est une derive de facturation,
    // pas un incident technique, et elle passerait autrement inapercue.
    const segments = Math.ceil(content.length / SINGLE_SEGMENT);
    await logEvent(env, token, 'sms_multi_segment', `${content.length} car., ${segments} segments`);
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
