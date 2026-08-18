/**
 * Accès D1. Toutes les requêtes SQL vivent ici — les routes manipulent des
 * objets du domaine, jamais des lignes.
 */

import type {
  Answers,
  Diagnostic,
  Dossier,
  DossierStatus,
  PhotoAnalysis,
  PhotoSlot,
  PhotoState,
} from '../../../shared/types';
import type { Env } from '../env';

/** Durée de vie d'un dossier. Au-delà, purge des photos et du contenu. */
export const DOSSIER_TTL_DAYS = 7;

const now = () => new Date().toISOString();

interface DossierRow {
  token: string;
  ref: string;
  status: DossierStatus;
  tel: string;
  ville: string | null;
  probleme: string | null;
  answers: string;
  diagnostic: string | null;
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
}

/* ------------------------------------------------------------------ */
/* Création                                                            */
/* ------------------------------------------------------------------ */

export async function createDossier(
  env: Env,
  token: string,
  lead: { tel: string; ville?: string; probleme?: string },
): Promise<Dossier> {
  const ref = await nextRef(env);
  const created = now();
  const expires = new Date(
    Date.now() + DOSSIER_TTL_DAYS * 86_400_000,
  ).toISOString();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO dossiers
         (token, ref, status, tel, ville, probleme, answers, created_at, updated_at, expires_at)
       VALUES (?, ?, 'ouvert', ?, ?, ?, '{}', ?, ?, ?)`,
    ).bind(
      token,
      ref,
      lead.tel,
      lead.ville ?? null,
      lead.probleme ?? null,
      created,
      created,
      expires,
    ),
    ...[1, 2, 3].map((slot) =>
      env.DB.prepare(
        `INSERT INTO photos (dossier_token, slot, updated_at) VALUES (?, ?, ?)`,
      ).bind(token, slot, created),
    ),
  ]);

  await logEvent(env, token, 'dossier_cree', lead.probleme ?? null);
  return (await getDossier(env, token))!;
}

/**
 * `UPDATE ... RETURNING` en une passe : deux requêtes séparées permettraient
 * à deux soumissions simultanées d'obtenir la même référence.
 */
async function nextRef(env: Env): Promise<string> {
  const row = await env.DB.prepare(
    `UPDATE counters SET value = value + 1 WHERE name = 'dossier_ref' RETURNING value`,
  ).first<{ value: number }>();
  const n = row?.value ?? Date.now() % 10000;
  return `SC-${String(n).padStart(4, '0')}`;
}

/* ------------------------------------------------------------------ */
/* Lecture                                                             */
/* ------------------------------------------------------------------ */

export async function getDossier(
  env: Env,
  token: string,
): Promise<Dossier | null> {
  const row = await env.DB.prepare(
    `SELECT token, ref, status, tel, ville, probleme, answers, diagnostic,
            created_at, expires_at
       FROM dossiers WHERE token = ?`,
  )
    .bind(token)
    .first<DossierRow>();

  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) return null;

  const { results } = await env.DB.prepare(
    `SELECT slot, r2_key, skipped, attempts, analysis, analysis_status
       FROM photos WHERE dossier_token = ? ORDER BY slot`,
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
      };
      return [slot, state];
    }),
  ) as Record<PhotoSlot, PhotoState>;

  return {
    ref: row.ref,
    status: row.status,
    tel: row.tel,
    ville: row.ville,
    probleme: row.probleme,
    answers: JSON.parse(row.answers) as Answers,
    photos,
    diagnostic: row.diagnostic
      ? (JSON.parse(row.diagnostic) as Diagnostic)
      : null,
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
    `SELECT r2_key FROM photos WHERE dossier_token = ? AND slot = ?`,
  )
    .bind(token, slot)
    .first<{ r2_key: string | null }>();
  return row?.r2_key ?? null;
}

/* ------------------------------------------------------------------ */
/* Écriture                                                            */
/* ------------------------------------------------------------------ */

export async function setStatus(
  env: Env,
  token: string,
  status: DossierStatus,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE dossiers SET status = ?, updated_at = ? WHERE token = ?`,
  )
    .bind(status, now(), token)
    .run();
}

export async function saveAnswers(
  env: Env,
  token: string,
  answers: Answers,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE dossiers
        SET answers = ?, updated_at = ?,
            status = CASE WHEN status = 'ouvert' THEN 'en_cours' ELSE status END
      WHERE token = ?`,
  )
    .bind(JSON.stringify(answers), now(), token)
    .run();
}

export async function recordUpload(
  env: Env,
  token: string,
  slot: PhotoSlot,
  r2Key: string,
): Promise<number> {
  const row = await env.DB.prepare(
    `UPDATE photos
        SET r2_key = ?, skipped = 0, attempts = attempts + 1,
            analysis = NULL, analysis_status = 'pending', updated_at = ?
      WHERE dossier_token = ? AND slot = ?
      RETURNING attempts`,
  )
    .bind(r2Key, now(), token, slot)
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
      WHERE dossier_token = ? AND slot = ?`,
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
      WHERE dossier_token = ? AND slot = ?`,
  )
    .bind(now(), token, slot)
    .run();
}

export async function saveDiagnostic(
  env: Env,
  token: string,
  diagnostic: Diagnostic,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE dossiers
        SET diagnostic = ?, status = 'soumis', updated_at = ?
      WHERE token = ?`,
  )
    .bind(JSON.stringify(diagnostic), now(), token)
    .run();
}

export async function logEvent(
  env: Env,
  token: string | null,
  kind: string,
  detail: string | null = null,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO events (dossier_token, kind, detail, created_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(token, kind, detail, now())
    .run();
}

/* ------------------------------------------------------------------ */
/* Purge                                                               */
/* ------------------------------------------------------------------ */

/**
 * Supprime photos et contenu des dossiers expirés. On conserve la ligne
 * `dossiers` vidée de ses données personnelles : la référence reste traçable
 * en comptabilité sans qu'aucune donnée du client ne subsiste.
 */
export async function purgeExpired(env: Env): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT token FROM dossiers
      WHERE expires_at < ? AND status != 'expire' LIMIT 200`,
  )
    .bind(now())
    .all<{ token: string }>();

  for (const { token } of results) {
    const { results: keys } = await env.DB.prepare(
      `SELECT r2_key FROM photos WHERE dossier_token = ? AND r2_key IS NOT NULL`,
    )
      .bind(token)
      .all<{ r2_key: string }>();

    await Promise.all(keys.map(({ r2_key }) => env.PHOTOS.delete(r2_key)));

    await env.DB.batch([
      env.DB.prepare(`DELETE FROM photos WHERE dossier_token = ?`).bind(token),
      env.DB.prepare(
        `UPDATE dossiers
            SET status = 'expire', tel = '', ville = NULL, probleme = NULL,
                answers = '{}', diagnostic = NULL, updated_at = ?
          WHERE token = ?`,
      ).bind(now(), token),
    ]);
  }

  return results.length;
}
