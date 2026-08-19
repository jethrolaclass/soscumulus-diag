import type { Env } from '../env';
import type {
  Answers,
  Diagnosis,
  DiagnosisCase,
  PhotoAnalysis,
  PhotoSlot,
} from '../../../shared/types';
import { BLOCKING_SAFETY_FLAGS } from '../../../shared/types';
import { synthesize } from '../lib/claude';
import {
  findCasesAwaitingDiagnosis,
  getCase,
  logEvent,
  saveAnswers,
  saveDiagnosis,
  setStatus,
} from '../lib/db';
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
  confirmed: boolean,
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
  //
  // But only once the client has confirmed. The safety question is
  // multiple-choice — "touchez tout ce qui vous concerne" — and every tap is
  // saved as it happens. Escalating on the first tick meant a mis-tap alerted
  // the team and locked the file for good, with no way back and no way to
  // untick. The answers are still recorded either way, so a hazard ticked and
  // then abandoned stays visible on the case.
  const hazards = (answers.safety ?? []).filter((f) =>
    BLOCKING_SAFETY_FLAGS.includes(f),
  );
  if (confirmed && hazards.length > 0 && found.status !== 'safety_stop') {
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

  // Already in: a second tap, or a client coming back to the link, must not
  // start a second synthesis. The diagnosis may still be on its way.
  if (found.status === 'submitted') {
    return json({ status: 'submitted', diagnosis: found.diagnosis });
  }

  // The case is closed here, before the diagnosis exists. The synthesis is a
  // high-effort call: twenty-five seconds and more, which is a long time to
  // hold a client standing in a cellar on a spinner. If they close the tab in
  // the meantime the file must already be ours — a submission that only counts
  // once the model has answered is a submission we lose.
  await setStatus(env, token, 'submitted');
  await logEvent(env, token, 'case_submitted', `panel=${found.panel.captured}`);

  ctx.waitUntil(diagnoseInBackground(env, token, found));

  return json({ status: 'submitted', diagnosis: null });
}

/** Retry window: long enough that a synthesis still in flight is left alone. */
const DIAGNOSIS_RETRY_AFTER_MS = 90_000;

/**
 * Finishes the cases whose background synthesis never landed.
 *
 * Called by the cron. Without it, a continuation cut at the platform's
 * thirty-second ceiling leaves a case closed, a client told everything is on
 * its way, and neither diagnosis nor intervention report at the other end.
 */
export async function resumeDiagnoses(env: Env): Promise<number> {
  const before = new Date(Date.now() - DIAGNOSIS_RETRY_AFTER_MS).toISOString();
  const tokens = await findCasesAwaitingDiagnosis(env, before);

  for (const token of tokens) {
    const found = await getCase(env, token);
    if (found) await diagnoseInBackground(env, token, found);
  }
  return tokens.length;
}

/**
 * Synthesis and report, after the client has been let go.
 *
 * A failure here costs the written diagnosis, never the case: the answers and
 * the photos are on file, and the report goes out with what is known.
 */
async function diagnoseInBackground(
  env: Env,
  token: string,
  found: DiagnosisCase,
): Promise<void> {
  const analyses = ([1, 2, 3] as PhotoSlot[])
    .map((slot) => found.photos[slot].analysis)
    .filter((a): a is PhotoAnalysis => a !== null);

  let diagnosis: Diagnosis | null = null;
  try {
    // Three photos are not required: a client who found nothing to photograph
    // still has a problem and must be able to submit. The diagnosis will simply
    // carry lower confidence.
    diagnosis = await synthesize(env, {
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
      'diagnosis_ready',
      `photos=${analyses.length} urgency=${diagnosis.urgency} confidence=${diagnosis.confidence}`,
    );
  } catch (err) {
    console.error('synthesis failed', err);
    await logEvent(env, token, 'diagnosis_failed', String(err));
  }

  await pushReport(env, token, { ...found, status: 'submitted', diagnosis });
}
