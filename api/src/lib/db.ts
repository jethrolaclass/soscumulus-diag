/**
 * D1 access. Every SQL statement lives here — routes handle domain objects,
 * never rows.
 */

import type {
  Answers,
  CaseStatus,
  ControlPanelAnalysis,
  ControlPanelState,
  Diagnosis,
  DiagnosisCase,
  LocalVerdict,
  PhotoAnalysis,
  PhotoSlot,
  PhotoState,
} from '../../../shared/types';
import type { Env } from '../env';

/** Case lifetime. Past this, photos and content are purged. */
export const CASE_TTL_DAYS = 7;

const now = () => new Date().toISOString();

interface CaseRow {
  token: string;
  ref: string;
  status: CaseStatus;
  phone: string;
  city: string | null;
  reported_issue: string | null;
  answers: string;
  diagnosis: string | null;
  panel_frames: number;
  panel_analysis: string | null;
  panel_status: ControlPanelState['analysisStatus'];
  panel_video_key: string | null;
  created_at: string;
  expires_at: string;
}

interface PhotoRow {
  slot: number;
  r2_key: string | null;
  skipped: number;
  attempts: number;
  analysis: string | null;
  analysis_status: PhotoState['analysisStatus'];
  local_verdict: LocalVerdict | null;
}

/* ------------------------------------------------------------------ */
/* Creation                                                            */
/* ------------------------------------------------------------------ */

export async function createCase(
  env: Env,
  token: string,
  lead: { phone: string; city?: string; reportedIssue?: string },
): Promise<DiagnosisCase> {
  const ref = await nextRef(env);
  const created = now();
  const expires = new Date(Date.now() + CASE_TTL_DAYS * 86_400_000).toISOString();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO cases
         (token, ref, status, phone, city, reported_issue, answers,
          created_at, updated_at, expires_at)
       VALUES (?, ?, 'open', ?, ?, ?, '{}', ?, ?, ?)`,
    ).bind(
      token,
      ref,
      lead.phone,
      lead.city ?? null,
      lead.reportedIssue ?? null,
      created,
      created,
      expires,
    ),
    ...[1, 2, 3].map((slot) =>
      env.DB.prepare(
        `INSERT INTO photos (case_token, slot, updated_at) VALUES (?, ?, ?)`,
      ).bind(token, slot, created),
    ),
  ]);

  await logEvent(env, token, 'case_created', lead.reportedIssue ?? null);
  return (await getCase(env, token))!;
}

/**
 * `UPDATE ... RETURNING` in one pass: two separate statements would let two
 * concurrent submissions receive the same reference.
 */
async function nextRef(env: Env): Promise<string> {
  const row = await env.DB.prepare(
    `UPDATE counters SET value = value + 1 WHERE name = 'case_ref' RETURNING value`,
  ).first<{ value: number }>();
  const n = row?.value ?? Date.now() % 10000;
  return `SC-${String(n).padStart(4, '0')}`;
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export async function getCase(
  env: Env,
  token: string,
): Promise<DiagnosisCase | null> {
  const row = await env.DB.prepare(
    `SELECT token, ref, status, phone, city, reported_issue, answers, diagnosis,
            panel_frames, panel_analysis, panel_status, panel_video_key,
            created_at, expires_at
       FROM cases WHERE token = ?`,
  )
    .bind(token)
    .first<CaseRow>();

  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) return null;

  const { results } = await env.DB.prepare(
    `SELECT slot, r2_key, skipped, attempts, analysis, analysis_status, local_verdict
       FROM photos WHERE case_token = ? ORDER BY slot`,
  )
    .bind(token)
    .all<PhotoRow>();

  const photos = Object.fromEntries(
    ([1, 2, 3] as PhotoSlot[]).map((slot) => {
      const p = results.find((r) => r.slot === slot);
      const state: PhotoState = {
        slot,
        uploaded: Boolean(p?.r2_key),
        skipped: Boolean(p?.skipped),
        attempts: p?.attempts ?? 0,
        analysis: p?.analysis ? (JSON.parse(p.analysis) as PhotoAnalysis) : null,
        analysisStatus: p?.analysis_status ?? 'idle',
        localVerdict: p?.local_verdict ?? null,
      };
      return [slot, state];
    }),
  ) as Record<PhotoSlot, PhotoState>;

  return {
    ref: row.ref,
    status: row.status,
    phone: row.phone,
    city: row.city,
    reportedIssue: row.reported_issue,
    answers: readAnswers(row.answers),
    photos,
    panel: {
      captured: row.panel_frames > 0,
      frameCount: row.panel_frames,
      videoUploaded: Boolean(row.panel_video_key),
      analysis: row.panel_analysis
        ? (JSON.parse(row.panel_analysis) as ControlPanelAnalysis)
        : null,
      analysisStatus: row.panel_status,
    },
    diagnosis: row.diagnosis ? (JSON.parse(row.diagnosis) as Diagnosis) : null,
    emergencyPhone: env.EMERGENCY_PHONE,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export async function getPhotoKey(
  env: Env,
  token: string,
  slot: PhotoSlot,
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT r2_key FROM photos WHERE case_token = ? AND slot = ?`,
  )
    .bind(token, slot)
    .first<{ r2_key: string | null }>();
  return row?.r2_key ?? null;
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

export async function setStatus(
  env: Env,
  token: string,
  status: CaseStatus,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE cases SET status = ?, updated_at = ? WHERE token = ?`,
  )
    .bind(status, now(), token)
    .run();
}

/**
 * Answers as stored, brought to the current shape.
 *
 * `availability` used to hold a single slot and now holds a list. Cases opened
 * before the change still carry the old form, and every reader downstream —
 * page, report, synthesis — would choke on it. Converting once here beats
 * guarding in three places.
 */
function readAnswers(raw: string): Answers {
  const answers = JSON.parse(raw) as Answers;
  const availability = answers.availability as unknown;
  if (typeof availability === 'string') {
    return { ...answers, availability: [availability] as Answers['availability'] };
  }
  return answers;
}

/**
 * Cases closed but still without a written diagnosis.
 *
 * The synthesis runs after the client has been let go, and that continuation
 * is capped at thirty seconds of wall time by the platform — a high-effort call
 * sometimes lands just under and sometimes gets cut, silently. This is the
 * sweep that finishes the job.
 *
 * @param before Only cases untouched since then, so a synthesis still running
 * is not started a second time.
 */
export async function findCasesAwaitingDiagnosis(
  env: Env,
  before: string,
  limit = 10,
): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT token FROM cases
      WHERE status = 'submitted' AND diagnosis IS NULL AND updated_at < ?
      ORDER BY updated_at LIMIT ?`,
  )
    .bind(before, limit)
    .all<{ token: string }>();
  return results.map((r) => r.token);
}

export async function saveAnswers(
  env: Env,
  token: string,
  answers: Answers,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE cases
        SET answers = ?, updated_at = ?,
            status = CASE WHEN status = 'open' THEN 'in_progress' ELSE status END
      WHERE token = ?`,
  )
    .bind(JSON.stringify(answers), now(), token)
    .run();
}

/**
 * @param analysisStatus `pending` when a vision call is on its way, `done` for
 * a slot nobody analyses — the row must never claim to be waiting for a result
 * that will not come, and `failed` would log a failure that never happened.
 */
export async function recordUpload(
  env: Env,
  token: string,
  slot: PhotoSlot,
  r2Key: string,
  analysisStatus: 'pending' | 'done',
  localVerdict: LocalVerdict | null,
): Promise<number> {
  const row = await env.DB.prepare(
    `UPDATE photos
        SET r2_key = ?, skipped = 0, attempts = attempts + 1,
            analysis = NULL, analysis_status = ?, local_verdict = ?, updated_at = ?
      WHERE case_token = ? AND slot = ?
      RETURNING attempts`,
  )
    .bind(r2Key, analysisStatus, localVerdict, now(), token, slot)
    .first<{ attempts: number }>();
  return row?.attempts ?? 1;
}

export async function saveAnalysis(
  env: Env,
  token: string,
  slot: PhotoSlot,
  analysis: PhotoAnalysis | null,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE photos
        SET analysis = ?, analysis_status = ?, updated_at = ?
      WHERE case_token = ? AND slot = ?`,
  )
    .bind(
      analysis ? JSON.stringify(analysis) : null,
      analysis ? 'done' : 'failed',
      now(),
      token,
      slot,
    )
    .run();
}

export async function markSkipped(
  env: Env,
  token: string,
  slot: PhotoSlot,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE photos
        SET skipped = 1, analysis_status = 'idle', updated_at = ?
      WHERE case_token = ? AND slot = ?`,
  )
    .bind(now(), token, slot)
    .run();
}

/* ---------- Control panel ---------- */

/**
 * R2 key of one panel frame. The index is part of the key: the sequence only
 * makes sense in order.
 */
export const panelFrameKey = (token: string, index: number) =>
  `${token}/panel-${String(index).padStart(2, '0')}.jpg`;

/** Single key: at most one panel recording per case. */
export const panelVideoKey = (token: string) => `${token}/panel-source`;

export async function recordPanelFrames(
  env: Env,
  token: string,
  frameCount: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE cases
        SET panel_frames = ?, panel_analysis = NULL,
            panel_status = 'pending', updated_at = ?
      WHERE token = ?`,
  )
    .bind(frameCount, now(), token)
    .run();
}

export async function recordPanelVideo(
  env: Env,
  token: string,
  key: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE cases SET panel_video_key = ?, updated_at = ? WHERE token = ?`,
  )
    .bind(key, now(), token)
    .run();
}

export async function savePanelAnalysis(
  env: Env,
  token: string,
  analysis: ControlPanelAnalysis | null,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE cases
        SET panel_analysis = ?, panel_status = ?, updated_at = ?
      WHERE token = ?`,
  )
    .bind(
      analysis ? JSON.stringify(analysis) : null,
      analysis ? 'done' : 'failed',
      now(),
      token,
    )
    .run();
}

export async function saveDiagnosis(
  env: Env,
  token: string,
  diagnosis: Diagnosis,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE cases
        SET diagnosis = ?, status = 'submitted', updated_at = ?
      WHERE token = ?`,
  )
    .bind(JSON.stringify(diagnosis), now(), token)
    .run();
}

/**
 * Whether an event of this kind, with a detail starting with this prefix, has
 * been logged on the case. The event log is the only place a sent SMS is
 * recorded, so it is what keeps a retried tool call from texting twice.
 */
export async function hasEvent(
  env: Env,
  token: string,
  kind: string,
  detailPrefix = '',
): Promise<boolean> {
  const row = await env.DB.prepare(
    'SELECT 1 FROM events WHERE case_token = ? AND kind = ? AND COALESCE(detail, \'\') LIKE ? LIMIT 1',
  )
    .bind(token, kind, `${detailPrefix}%`)
    .first();
  return row !== null;
}

export async function logEvent(
  env: Env,
  token: string | null,
  kind: string,
  detail: string | null = null,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO events (case_token, kind, detail, created_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(token, kind, detail, now())
    .run();
}

/* ------------------------------------------------------------------ */
/* Purge                                                               */
/* ------------------------------------------------------------------ */

/**
 * Delete photos and content of expired cases. The `cases` row is kept but
 * emptied of personal data: the reference stays traceable for accounting
 * without any client data surviving.
 */
export async function purgeExpired(env: Env): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT token FROM cases WHERE expires_at < ? AND status != 'expired' LIMIT 200`,
  )
    .bind(now())
    .all<{ token: string }>();

  for (const { token } of results) {
    // Listing the case prefix catches everything: photos, panel frames and the
    // source video, which do not all live in the `photos` table.
    const listed = await env.PHOTOS.list({ prefix: `${token}/` });
    await Promise.all(listed.objects.map((o) => env.PHOTOS.delete(o.key)));

    await env.DB.batch([
      env.DB.prepare(`DELETE FROM photos WHERE case_token = ?`).bind(token),
      env.DB.prepare(
        `UPDATE cases
            SET status = 'expired', phone = '', city = NULL, reported_issue = NULL,
                answers = '{}', diagnosis = NULL, panel_frames = 0,
                panel_analysis = NULL, panel_status = 'idle',
                panel_video_key = NULL, updated_at = ?
          WHERE token = ?`,
      ).bind(now(), token),
    ]);
  }

  return results.length;
}

/* ------------------------------------------------------------------ */
/* Quotes                                                              */
/* ------------------------------------------------------------------ */

export interface QuoteRow {
  caseToken: string;
  short: string;
  quote: import('./pricing').Quote;
  demo: boolean;
  status: 'pending' | 'created' | 'sent' | 'signed' | 'declined' | 'expired' | 'failed';
  requestId: string | null;
  signerId: string | null;
  signatureLink: string | null;
  createdAt: string;
  signedAt: string | null;
}

interface QuoteRaw {
  case_token: string;
  short: string;
  quote: string;
  demo: number;
  status: QuoteRow['status'];
  youtrust_request_id: string | null;
  youtrust_signer_id: string | null;
  signature_link: string | null;
  created_at: string;
  signed_at: string | null;
}

const rowToQuote = (r: QuoteRaw): QuoteRow => ({
  caseToken: r.case_token,
  short: r.short,
  quote: JSON.parse(r.quote),
  demo: r.demo === 1,
  status: r.status,
  requestId: r.youtrust_request_id,
  signerId: r.youtrust_signer_id,
  signatureLink: r.signature_link,
  createdAt: r.created_at,
  signedAt: r.signed_at,
});

export async function saveQuote(
  env: Env,
  q: {
    caseToken: string;
    short: string;
    quote: import('./pricing').Quote;
    demo: boolean;
    requestId: string;
    signerId: string;
    signatureLink: string;
  },
): Promise<void> {
  // Replaces the 'pending' claim taken by `claimQuote`.
  await env.DB.prepare(
    `INSERT OR REPLACE INTO quotes (case_token, short, quote, demo, status, youtrust_request_id,
                         youtrust_signer_id, signature_link, created_at)
     VALUES (?, ?, ?, ?, 'created', ?, ?, ?, ?)`,
  )
    .bind(q.caseToken, q.short, JSON.stringify(q.quote), q.demo ? 1 : 0,
          q.requestId, q.signerId, q.signatureLink, new Date().toISOString())
    .run();
}

/**
 * Takes the case's quote slot, or learns someone else has.
 *
 * The confirmation page polls every three seconds and any poll that sees the
 * diagnosis may start the quote; without an atomic claim, two of them a second
 * apart would each create a signature request and each send a text.
 */
export async function claimQuote(env: Env, caseToken: string): Promise<boolean> {
  const r = await env.DB.prepare(
    `INSERT OR IGNORE INTO quotes (case_token, short, quote, demo, status, created_at)
     VALUES (?, ?, '{}', 0, 'pending', ?)`,
  )
    .bind(caseToken, `pending-${caseToken}`, new Date().toISOString())
    .run();
  return (r.meta.changes ?? 0) === 1;
}

/** A claim older than this was taken by a request that died before finishing. */
export const STALE_CLAIM_MS = 3 * 60_000;

/**
 * Records a quote that could not be produced, so the sweep stops retrying it
 * every two minutes — each retry left a draft on the signature provider. The
 * voice route may still retry on request: it deletes this row first.
 */
export async function saveFailedQuote(env: Env, caseToken: string, error: string): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO quotes (case_token, short, quote, demo, status, created_at)
     VALUES (?, ?, ?, 0, 'failed', ?)`,
  )
    .bind(caseToken, `failed-${caseToken.slice(0, 8)}`, JSON.stringify({ error: error.slice(0, 300) }), new Date().toISOString())
    .run();
}

export async function deleteQuote(env: Env, caseToken: string): Promise<void> {
  await env.DB.prepare('DELETE FROM quotes WHERE case_token = ?').bind(caseToken).run();
}

export async function setQuoteStatus(env: Env, caseToken: string, status: QuoteRow['status']): Promise<void> {
  await env.DB.prepare('UPDATE quotes SET status = ? WHERE case_token = ?').bind(status, caseToken).run();
}

export async function markQuoteSigned(env: Env, caseToken: string): Promise<void> {
  await env.DB.prepare("UPDATE quotes SET status = 'signed', signed_at = ? WHERE case_token = ?")
    .bind(new Date().toISOString(), caseToken)
    .run();
}

export async function getQuote(env: Env, caseToken: string): Promise<QuoteRow | null> {
  const r = await env.DB.prepare('SELECT * FROM quotes WHERE case_token = ?').bind(caseToken).first<QuoteRaw>();
  return r ? rowToQuote(r) : null;
}

export async function getQuoteByShort(env: Env, short: string): Promise<QuoteRow | null> {
  const r = await env.DB.prepare('SELECT * FROM quotes WHERE short = ?').bind(short).first<QuoteRaw>();
  return r ? rowToQuote(r) : null;
}

export async function getQuoteByRequest(env: Env, requestId: string): Promise<QuoteRow | null> {
  const r = await env.DB.prepare('SELECT * FROM quotes WHERE youtrust_request_id = ?').bind(requestId).first<QuoteRaw>();
  return r ? rowToQuote(r) : null;
}

/**
 * Submitted, diagnosed, and never quoted. The cron picks these up because the
 * submission request has no wall clock left for a quote after the synthesis.
 */
export async function findCasesAwaitingQuote(env: Env, limit = 5): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT c.token FROM cases c
     LEFT JOIN quotes q ON q.case_token = c.token
     WHERE c.status = 'submitted' AND c.diagnosis IS NOT NULL
       AND (q.case_token IS NULL OR (q.status = 'pending' AND q.created_at < ?))
     ORDER BY c.updated_at ASC LIMIT ?`,
  )
    .bind(new Date(Date.now() - STALE_CLAIM_MS).toISOString(), limit)
    .all<{ token: string }>();
  return results.map((r) => r.token);
}

/**
 * Signed quotes whose intervention email never left — deferred while waiting
 * for the sheet, or cut before it could be sent. The cron flushes them.
 */
export async function findDeferredInterventions(env: Env, olderThanMs: number, limit = 5): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT q.case_token AS token FROM quotes q
     WHERE q.status = 'signed' AND q.signed_at < ?
       AND NOT EXISTS (SELECT 1 FROM events e WHERE e.case_token = q.case_token
                       AND e.kind IN ('intervention_requested', 'intervention_request_failed'))
     LIMIT ?`,
  )
    .bind(new Date(Date.now() - olderThanMs).toISOString(), limit)
    .all<{ token: string }>();
  return results.map((r) => r.token);
}
