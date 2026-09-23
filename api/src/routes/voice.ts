/**
 * Endpoints called by the ElevenLabs voice agent during a phone call.
 *
 * The agent is a caller like any other, not a privileged one: it holds a shared
 * secret, it works on one case at a time, and everything it does lands in the
 * same tables and the same event log as the web journey. Nothing here is a
 * second implementation of the diagnosis — it is the same one, driven by voice.
 *
 * Every response carries a `sayExactly` field: a French sentence the agent may read
 * verbatim. It exists to stop the model improvising figures. A voice agent that
 * paraphrases "capacité 150 litres" as "environ 200 litres" has told a client
 * something false, out loud, with the company's name on it.
 */

import type { Env } from '../env';
import type { Answers, PhotoSlot, SafetyFlag } from '../../../shared/types';
import { BLOCKING_SAFETY_FLAGS } from '../../../shared/types';
import {
  createCase,
  getCase,
  logEvent,
  saveAnswers,
  setStatus,
} from '../lib/db';
import { normalizePhone, sendDiagSms } from '../lib/sms';
import { sendSafetyAlert } from '../lib/report';
import { newCaseToken } from '../lib/signing';
import { badRequest, json, notFound, secretMatches, unauthorized } from '../lib/http';

export function requireVoiceSecret(req: Request, env: Env): void {
  // A header, not a query parameter: unlike Apps Script, ElevenLabs sends
  // custom headers on its server tools, and a secret in a URL ends up in logs.
  if (!secretMatches(req.headers.get('x-voice-secret'), env.VOICE_SECRET)) {
    throw unauthorized();
  }
}

/* ------------------------------------------------------------------ */
/* Opening the case                                                    */
/* ------------------------------------------------------------------ */

interface OpenBody {
  firstName?: string;
  lastName?: string;
  phone?: string;
  city?: string;
  reportedIssue?: string;
}

/**
 * Called once the agent has the caller's name and number.
 *
 * Opening a case sends nothing. The link asks for three photos, and whether
 * photos are the right thing to ask for is settled one question later — by the
 * triage. Texting here would put "photograph your nameplate" in the hand of
 * somebody standing in water, which is both useless and callous.
 */
export async function handleVoiceOpen(req: Request, env: Env): Promise<Response> {
  requireVoiceSecret(req, env);

  const body = (await req.json().catch(() => null)) as OpenBody | null;
  const phone = body?.phone?.trim();
  if (!phone) throw badRequest('Champ `phone` requis.');

  // A model in a hurry — an urgent caller, a low temperature — has been seen
  // opening the case before asking anything, with "À confirmer" in every
  // field. Refusing here, with a sentence it can act on, is cheaper than a
  // case nobody can reach.
  const looksLikeName = (v: string | undefined) =>
    !!v && v.trim().length >= 2 && !/confirm|inconnu|\?|n\/a|xxx/i.test(v);
  if (!normalizePhone(phone)) {
    return json(
      {
        sayExactly:
          'Je n’ai pas bien noté votre numéro. Vous pouvez me le redonner, chiffre par chiffre ?',
        error: 'invalid_phone',
      },
      422,
    );
  }
  if (!looksLikeName(body?.firstName) || !looksLikeName(body?.lastName)) {
    return json(
      {
        sayExactly: 'Il me manque votre nom pour ouvrir le dossier. Pouvez-vous m’indiquer vos noms et prénoms, s’il vous plaît ?',
        error: 'missing_name',
      },
      422,
    );
  }

  const token = newCaseToken();
  const created = await createCase(env, token, {
    phone,
    city: body?.city?.trim() || undefined,
    reportedIssue: body?.reportedIssue?.trim() || undefined,
  });

  // The name goes in straight away so the last screen is already filled and
  // the client never retypes what they just said out loud.
  const answers: Answers = { safety: [] };
  if (body?.firstName?.trim()) answers.firstName = body.firstName.trim();
  if (body?.lastName?.trim()) answers.lastName = body.lastName.trim();
  await saveAnswers(env, token, answers);

  await logEvent(env, token, 'voice_case_opened', created.ref);

  return json({
    token,
    ref: created.ref,
    url: `${env.PUBLIC_WEB_URL}/d/${token}`,
    sayExactly: `C'est noté, je m'occupe de vous. Votre dossier, c'est le ${spell(created.ref)}.`,
  });
}

/* ------------------------------------------------------------------ */
/* Triage                                                              */
/* ------------------------------------------------------------------ */

interface TriageBody {
  leak?: boolean;
  powerCut?: boolean;
  /**
   * `false` answers the triage without texting anyone.
   *
   * It exists so a test case can be walked through without putting a real text
   * on a real phone: the allowlist has been empty since go-live, so every send
   * here is a send for good.
   */
  sendSms?: boolean;
}

/**
 * The one safety question asked by voice.
 *
 * Stricter than the web on purpose: on screen the client is asked *where* water
 * is showing and most leaks wait, but the agent asks one yes/no question and
 * sees nothing. Either answer hands the call to a human.
 */
export async function handleVoiceTriage(
  req: Request,
  env: Env,
  token: string,
): Promise<Response> {
  requireVoiceSecret(req, env);

  const found = await getCase(env, token);
  if (!found) throw notFound();

  const body = (await req.json().catch(() => null)) as TriageBody | null;
  if (!body) throw badRequest('Corps invalide.');

  const flags: SafetyFlag[] = [];
  if (body.powerCut === true) flags.push('breaker_tripped');
  if (body.leak === true) flags.push('water_leak');

  const answers: Answers = {
    ...found.answers,
    safety: flags.length > 0 ? flags : ['none'],
  };
  await saveAnswers(env, token, answers);

  const transfer = flags.some((f) => BLOCKING_SAFETY_FLAGS.includes(f));
  if (transfer && found.status !== 'safety_stop') {
    await setStatus(env, token, 'safety_stop');
    await logEvent(env, token, 'safety_stop', `voice ${flags.join(',')}`);
    await sendSafetyAlert(env, found.ref, found.phone, found.city, flags);
  }

  // This is where the link goes out, and only on this branch. The text asks for
  // three photos; a caller being handed to a technician has no photos to take,
  // and one sent anyway would reach them mid-emergency.
  const url = `${env.PUBLIC_WEB_URL}/d/${token}`;
  let smsSent = false;
  // Three ways of not sending, and only one is a failure. Suppressed or
  // blocked, the caller carries on without a link; failed, the caller is
  // handed to someone who can do something about it.
  let smsBlocked = false;
  let smsFailed = false;
  if (transfer) {
    await logEvent(env, token, 'sms_skipped', 'transfer');
  } else if (body.sendSms === false) {
    await logEvent(env, token, 'sms_suppressed', url);
  } else {
    try {
      const outcome = await sendDiagSms(env, token, found.phone, url, 'voice');
      smsSent = outcome === 'sent';
      smsBlocked = outcome === 'blocked';
      smsFailed = outcome === 'invalid';
    } catch (err) {
      console.error('voice: SMS failed', err);
      await logEvent(env, token, 'sms_to_resend', url);
      smsFailed = true;
    }
  }

  const who = [found.answers.firstName, found.answers.lastName]
    .filter((v) => v)
    .join(' ');

  // Built on every call, not only when transferring: the agent also hands over
  // when the text fails to leave, and it needs the same sentence then.
  const handover =
    `${who || 'Client'}, ${spell(found.phone)}, dossier ${spell(found.ref)}. ` +
    (body.powerCut ? 'Disjoncteur sauté. ' : '') +
    (body.leak ? 'Fuite d’eau déclarée. ' : '') +
    (smsFailed ? 'SMS non parti, le client attend son lien. ' : '');

  return json({
    transfer,
    smsSent,
    // True when the voice allowlist held the text back: a test number, not a
    // failure. The agent carries on without a link and without a transfer.
    smsBlocked,
    // Read to the technician at the start of the transfer, not to the client.
    handover,
    // Each of these carries one of the three things a worried caller needs to
    // hear — we are on it, we will understand the fault, we will bring a fix —
    // and none of them describes how the caller feels.
    sayExactly: transfer
      ? 'Dans ce cas je ne vous fais pas attendre : je vous passe tout de suite un technicien, il prend le relais.'
      : smsSent
        ? 'Très bien, ce n’est pas une urgence immédiate, on va pouvoir faire ça posément. Je viens de vous envoyer un SMS avec un lien : il vous guide pour trois photos, deux à trois minutes. C’est avec ça qu’on comprend exactement votre panne et qu’on vous apporte la bonne solution.'
        : smsFailed
          ? 'Très bien, ce n’est pas une urgence immédiate. Je n’arrive pas à vous envoyer le SMS, alors je vous passe directement un technicien, il s’occupe de vous.'
          : 'Très bien, ce n’est pas une urgence immédiate, on va pouvoir faire ça posément. Je vais vous demander trois photos : c’est avec ça qu’on comprend exactement votre panne.',
  });
}

/* ------------------------------------------------------------------ */
/* Progress                                                            */
/* ------------------------------------------------------------------ */

const SLOT_NAMES: Record<PhotoSlot, string> = {
  1: 'l’étiquette',
  2: 'l’appareil en entier',
  3: 'la zone de fuite',
};

/**
 * What the agent may say about the photos, while the client is still on the
 * line. Polled every few seconds.
 */
export async function handleVoiceProgress(
  req: Request,
  env: Env,
  token: string,
): Promise<Response> {
  requireVoiceSecret(req, env);

  const found = await getCase(env, token);
  if (!found) throw notFound();

  const slots = ([1, 2, 3] as PhotoSlot[]).map((slot) => {
    const p = found.photos[slot];
    return {
      slot,
      name: SLOT_NAMES[slot],
      received: p.uploaded,
      skipped: p.skipped,
      analysing: p.analysisStatus === 'pending',
    };
  });

  const received = slots.filter((s) => s.received).length;
  const settled = slots.filter((s) => s.received || s.skipped).length;
  const nameplate = found.photos[1].analysis?.nameplate ?? null;

  // Only what was actually read. A voice agent handed a null field will fill it
  // in with something plausible, and a wrong capacity orders the wrong tank.
  const read = nameplate?.readable
    ? [
        nameplate.brand,
        nameplate.model,
        nameplate.capacityLiters ? `${nameplate.capacityLiters} litres` : null,
      ].filter((v): v is string => Boolean(v))
    : [];

  const sayExactly =
    settled === 3
      ? read.length > 0
        ? `J'ai bien reçu vos trois photos, et je lis ${read.join(', ')}. C'est tout bon, on a ce qu'il faut pour comprendre la panne.`
        : 'J’ai bien reçu vos trois photos, elles sont bien nettes. On a ce qu’il faut.'
      : received === 0
        ? 'Je n’ai pas encore reçu de photo, prenez votre temps, je reste en ligne avec vous.'
        : `J’ai bien reçu ${received === 1 ? 'la première photo' : `${received} photos`} sur trois, c’est parfait, continuez.`;

  return json({ sayExactly, complete: settled === 3, received, settled, read, slots });
}

/** Digit by digit: a reference or a number read as a whole is misheard. */
function spell(value: string): string {
  return value.split('').join(' ');
}
