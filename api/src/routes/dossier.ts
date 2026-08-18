import type { Env } from '../env';
import type { Answers, PhotoAnalysis, PhotoSlot } from '../../../shared/types';
import { BLOCKING_SAFETY_FLAGS } from '../../../shared/types';
import { synthesize } from '../lib/claude';
import {
  getDossier,
  logEvent,
  saveAnswers,
  saveDiagnostic,
  setStatus,
} from '../lib/db';
import { pushFiche, alertSecurite } from '../lib/fiche';
import { badRequest, json, notFound } from '../lib/http';

export async function handleGetDossier(
  env: Env,
  token: string,
): Promise<Response> {
  const dossier = await getDossier(env, token);
  if (!dossier) throw notFound();
  return json(dossier);
}

/* ------------------------------------------------------------------ */
/* Réponses au questionnaire                                           */
/* ------------------------------------------------------------------ */

export async function handleAnswers(
  req: Request,
  env: Env,
  token: string,
): Promise<Response> {
  const dossier = await getDossier(env, token);
  if (!dossier) throw notFound();

  const patch = (await req.json().catch(() => null)) as Partial<Answers> | null;
  if (!patch || typeof patch !== 'object') throw badRequest('Corps invalide.');

  const answers: Answers = { ...dossier.answers, ...patch };
  await saveAnswers(env, token, answers);

  // Un danger déclaré interrompt le parcours et déclenche un rappel. C'est à
  // la fois une obligation de prudence et le signal commercial le plus fort du
  // parcours : il ne doit pas rester dans une file d'attente.
  const danger = (answers.safety ?? []).filter((f) =>
    BLOCKING_SAFETY_FLAGS.includes(f),
  );
  if (danger.length > 0 && dossier.status !== 'stop_securite') {
    await setStatus(env, token, 'stop_securite');
    await logEvent(env, token, 'stop_securite', danger.join(','));
    await alertSecurite(env, dossier.ref, dossier.tel, dossier.ville, danger);
    return json({ answers, status: 'stop_securite', urgenceTel: env.URGENCE_TEL });
  }

  return json({ answers, status: dossier.status });
}

/* ------------------------------------------------------------------ */
/* Soumission finale                                                   */
/* ------------------------------------------------------------------ */

export async function handleSubmit(
  _req: Request,
  env: Env,
  ctx: ExecutionContext,
  token: string,
): Promise<Response> {
  const dossier = await getDossier(env, token);
  if (!dossier) throw notFound();

  if (dossier.status === 'soumis' && dossier.diagnostic) {
    return json({ status: 'soumis', diagnostic: dossier.diagnostic });
  }

  const analyses = ([1, 2, 3] as PhotoSlot[])
    .map((slot) => dossier.photos[slot].analysis)
    .filter((a): a is PhotoAnalysis => a !== null);

  // On n'exige pas les trois photos : un client qui n'a rien trouvé à
  // photographier a quand même un problème et doit pouvoir soumettre. Le
  // diagnostic portera simplement une confiance plus basse.
  const diagnostic = await synthesize(env, {
    answers: dossier.answers,
    analyses,
    ville: dossier.ville,
    probleme: dossier.probleme,
  });

  await saveDiagnostic(env, token, diagnostic);
  await logEvent(
    env,
    token,
    'dossier_soumis',
    `photos=${analyses.length} urgence=${diagnostic.urgency} confiance=${diagnostic.confidence}`,
  );

  // La fiche part en arrière-plan : sa génération ne doit pas retarder l'écran
  // de confirmation, ni la faire échouer si Apps Script est momentanément
  // indisponible.
  ctx.waitUntil(pushFiche(env, token, { ...dossier, diagnostic }));

  return json({ status: 'soumis', diagnostic });
}
