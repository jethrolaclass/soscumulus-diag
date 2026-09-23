/**
 * Quote: what the intervention costs, from the diagnosis and the catalogue.
 *
 * Called by the voice agent once the photos are in, and reachable on its own so
 * a quote can be produced for a web-only client too.
 *
 * The synthesis runs after the client is let go, so the first call usually
 * finds no diagnosis yet: it closes the case, starts the work and answers
 * `ready: false`. The agent says a word and asks again. Same polling shape as
 * everything else here.
 */

import type { Env } from '../env';
import type { Installation, Nameplate } from '../../../shared/types';
import { getCase, logEvent } from '../lib/db';
import { buildQuote } from '../lib/pricing';
import { quoteMessage, sendSms } from '../lib/sms';
import { json, notFound } from '../lib/http';
import { closeAndDiagnose } from './case';
import { requireVoiceSecret } from './voice';

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

  const nameplate: Nameplate | null = found.photos[1].analysis?.nameplate ?? null;
  const installation: Installation | null =
    found.photos[2].analysis?.installation ?? null;
  const quote = buildQuote(found.diagnosis, nameplate, installation);

  if (quote.needsHumanPricing) {
    await logEvent(env, token, 'quote_needs_human', quote.reason.slice(0, 120));
    return json({ sayExactly: quote.reason, ready: true, sent: false, quote });
  }

  // The text is the offer. It goes out before the agent says the figure, so a
  // client who hangs up mid-sentence still has it in writing.
  let sent = false;
  try {
    sent =
      (await sendSms(
        env,
        token,
        found.phone,
        quoteMessage(found.ref, quote.total as number),
        'quote',
        'voice',
      )) === 'sent';
  } catch (err) {
    console.error('quote SMS failed', err);
  }

  await logEvent(env, token, 'quote_sent', `${quote.total} EUR sms=${sent}`);

  const detail = quote.lines.map((l) => `${l.label} ${l.amount} euros`).join(', ');
  return json({
    sayExactly: sent
      ? `Votre devis est de ${quote.total} euros tout compris : ${detail}. ` +
        `Je viens de vous l'envoyer par SMS${quote.reason ? '. ' + quote.reason : ''} ` +
        `Répondez OK et un technicien vous rappelle pour le rendez-vous.`
      : `Votre devis est de ${quote.total} euros tout compris : ${detail}. ` +
        `Je n'ai pas pu vous l'envoyer par SMS, alors un technicien vous rappelle pour vous le confirmer et fixer le rendez-vous.`,
    ready: true,
    sent,
    quote,
  });
}

/**
 * The client accepted.
 *
 * Nothing calls this yet: accepting happens by replying OK to the text, and an
 * inbound SMS needs a dedicated number and a webhook that do not exist. The
 * endpoint is here so that whatever ends up carrying that reply — the operator's
 * webhook, or somebody in the office — has one place to say so, and so the
 * acceptance is recorded rather than living in a phone.
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
