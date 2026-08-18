import type { Env } from '../env';
import type { LeadRequest, LeadResponse } from '../../../shared/types';
import { createDossier, logEvent } from '../lib/db';
import { newDossierToken } from '../lib/signing';
import { sendDiagSms } from '../lib/sms';
import { badRequest, json, secretMatches, unauthorized } from '../lib/http';

/**
 * Point d'entrée depuis le formulaire du site.
 *
 * Le formulaire de soscumulus.fr poste déjà vers un web app Google Apps Script.
 * On ne remplace pas cette chaîne : le script conserve son Sheet et ses e-mails
 * et relaie simplement la soumission ici. Voir scripts/apps-script.gs.
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
  if (!body?.tel || typeof body.tel !== 'string') {
    throw badRequest('Champ `tel` requis.');
  }

  const token = newDossierToken();
  const dossier = await createDossier(env, token, {
    tel: body.tel.trim(),
    ville: body.ville?.trim() || undefined,
    probleme: body.probleme?.trim() || undefined,
  });

  const url = `${env.PUBLIC_WEB_URL}/d/${token}`;

  let smsSent = false;
  try {
    smsSent = await sendDiagSms(env, token, dossier.tel, url);
  } catch (err) {
    // Le dossier existe et le lien est valide : un échec d'envoi ne doit pas
    // faire perdre le lead. L'équipe peut renvoyer le lien à la main depuis le
    // journal d'événements.
    console.error('envoi SMS échoué', err);
    ctx.waitUntil(logEvent(env, token, 'sms_a_renvoyer', url));
  }

  const payload: LeadResponse = { ref: dossier.ref, url, smsSent };
  return json(payload, 201);
}
