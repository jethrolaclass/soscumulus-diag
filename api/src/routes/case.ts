import type { Env } from '../env';
import type { Answers, PhotoAnalysis, PhotoSlot } from '../../../shared/types';
import { BLOCKING_SAFETY_FLAGS } from '../../../shared/types';
import { synthesize } from '../lib/claude';
import { getCase, logEvent, saveAnswers, saveDiagnosis, setStatus } from '../lib/db';
import { pushReport, sendSafetyAlert } from '../lib/report';
import { badRequest, json, notFound } from '../lib/http';

export async function handleGetCase(env: Env, token: string): Promise<Response> {
  const found = await getCase(env, token);
  if (!found) throw notFound();
  return json(found);
}

/* ------------------------------------------------------------------ */
/* Questionnaire answers                                               */
/* ------------------------------------------------------------------ */

export async function handleAnswers(
  req: Request,
  env: Env,
  token: string,
): Promise<Response> {
  const found = await getCase(env, token);
  if (!found) throw notFound();

  const patch = (await req.json().catch(() => null)) as Partial<Answers> | null;
  if (!patch || typeof patch !== 'object') throw badRequest('Corps invalide.');

  const answers: Answers = { ...found.answers, ...patch };
  await saveAnswers(env, token, answers);

  // A declared hazard stops the journey and triggers a call back. This is both
  // a duty of care and the strongest commercial signal in the funnel: it must
  // not sit in a queue.
  const hazards = (answers.safety ?? []).filter((f) =>
    BLOCKING_SAFETY_FLAGS.includes(f),
  );
  if (hazards.length > 0 && found.status !== 'safety_stop') {
    await setStatus(env, token, 'safety_stop');
    await logEvent(env, token, 'safety_stop', hazards.join(','));
    await sendSafetyAlert(env, found.ref, found.phone, found.city, hazards);
    return json({
      answers,
      status: 'safety_stop',
      emergencyPhone: env.EMERGENCY_PHONE,
    });
  }

  return json({ answers, status: found.status });
}

/* ------------------------------------------------------------------ */
/* Final submission                                                    */
/* ------------------------------------------------------------------ */

export async function handleSubmit(
  _req: Request,
  env: Env,
  ctx: ExecutionContext,
  token: string,
): Promise<Response> {
  const found = await getCase(env, token);
  if (!found) throw notFound();

  if (found.status === 'submitted' && found.diagnosis) {
    return json({ status: 'submitted', diagnosis: found.diagnosis });
  }

  const analyses = ([1, 2, 3] as PhotoSlot[])
    .map((slot) => found.photos[slot].analysis)
    .filter((a): a is PhotoAnalysis => a !== null);

  // Three photos are not required: a client who found nothing to photograph
  // still has a problem and must be able to submit. The diagnosis will simply
  // carry lower confidence.
  const diagnosis = await synthesize(env, {
    answers: found.answers,
    analyses,
    panel: found.panel.analysis,
    city: found.city,
    reportedIssue: found.reportedIssue,
  });

  await saveDiagnosis(env, token, diagnosis);
  await logEvent(
    env,
    token,
    'case_submitted',
    `photos=${analyses.length} panel=${found.panel.captured} urgency=${diagnosis.urgency} confidence=${diagnosis.confidence}`,
  );

  // The report is generated in the background: it must not delay the
  // confirmation screen, nor fail it if Apps Script is briefly unavailable.
  ctx.waitUntil(pushReport(env, token, { ...found, diagnosis }));

  return json({ status: 'submitted', diagnosis });
}
