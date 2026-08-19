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
