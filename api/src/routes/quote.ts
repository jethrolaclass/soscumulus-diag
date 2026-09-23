/**
 * Quote, as the voice agent asks for it once the photos are in.
 *
 * The synthesis runs after the client is let go, so the first call usually
 * finds no diagnosis yet: it closes the case, starts the work and answers
 * `ready: false`. The agent says a word and asks again. Same polling shape as
 * everything else here.
 *
 * When the diagnosis is there, the quote is drawn, handed to Youtrust and
 * texted as a signing link — the same path the cron takes for web-only
 * clients, so the agent never has a quote the web client would not get.
 */

import type { Env } from '../env';
import { getCase, logEvent } from '../lib/db';
import { json, notFound } from '../lib/http';
import { sendQuoteForSignature } from '../lib/signature-flow';
import { closeAndDiagnose } from './case';
import { requireVoiceSecret } from './voice';

const SIGN_ONLINE =
  'Ouvrez le lien, signez le devis en ligne, et un technicien vous rappelle pour le rendez-vous.';

export async function handleQuote(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  token: string,
): Promise<Response> {
  requireVoiceSecret(req, env);

  const found = await getCase(env, token);
  if (!found) throw notFound();

  if (!found.diagnosis) {
    await closeAndDiagnose(env, ctx, token, found);
    return json({
      sayExactly:
        'Je prépare votre devis, ça prend moins d’une minute. Restez en ligne si ' +
        'vous voulez, ou raccrochez : vous le recevrez par SMS dans tous les cas.',
      ready: false,
    });
  }

  let r;
  try {
    r = await sendQuoteForSignature(env, token, 'voice', { retryFailed: true });
  } catch (err) {
    // Into the case's own trail, where support looks first — the Worker log
    // is not something anyone opens at 19:00 with a client on the line.
    await logEvent(env, token, 'quote_failed', String(err).slice(0, 300));
    throw err;
  }

  if (r.ok && r.already && r.status === 'pending') {
    return json({
      sayExactly: 'Je prépare votre devis, ça prend moins d’une minute.',
      ready: false,
    });
  }
  if (r.ok && r.already && r.status === 'failed') {
    return json({
      sayExactly: 'Je n’arrive pas à préparer votre devis pour le moment. Un technicien vous rappelle pour vous le confirmer.',
      ready: true,
      sent: false,
    });
  }
  if (r.ok && r.already) {
    return json({
      sayExactly: `Votre devis vous a déjà été envoyé par SMS. ${SIGN_ONLINE}`,
      ready: true,
      sent: r.status !== 'created',
      signed: r.status === 'signed',
    });
  }

  if (!r.ok) {
    const sayExactly =
      r.reason === 'missing_contact'
        ? 'Pour vous envoyer le devis à signer, il me manque votre adresse e-mail. ' +
          'Vous pouvez la saisir sur le lien reçu par SMS, à la dernière étape, et le devis part aussitôt.'
        : r.reason === 'needs_human' && r.quote
          ? r.quote.reason
          : 'Je prépare votre devis, un instant.';
    return json({ sayExactly, ready: r.reason !== 'no_diagnosis', sent: false, reason: r.reason });
  }

  const total = r.quote.total ?? 0;
  return json({
    sayExactly:
      r.sms === 'sent'
        ? `Votre devis est de ${total} euros tout compris. Je viens de vous l'envoyer par SMS. ${SIGN_ONLINE}`
        : `Votre devis est de ${total} euros tout compris. Je n'ai pas pu vous l'envoyer par SMS, alors un technicien vous rappelle pour vous le confirmer et fixer le rendez-vous.`,
    ready: true,
    sent: r.sms === 'sent',
    quote: r.quote,
  });
}

/**
 * Kept for the day a client accepts by another route — a call, an email. The
 * signature is the acceptance now, and the webhook records it.
 */
export async function handleQuoteAccept(
  req: Request,
  env: Env,
  token: string,
): Promise<Response> {
  requireVoiceSecret(req, env);

  const found = await getCase(env, token);
  if (!found) throw notFound();

  await logEvent(env, token, 'quote_accepted', found.ref);
  return json({ ok: true, ref: found.ref });
}
