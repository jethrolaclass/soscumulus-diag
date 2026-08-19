-- D1 schema. Apply with:
--   wrangler d1 execute soscumulus-diag --file=src/schema.sql --local
--   wrangler d1 execute soscumulus-diag --file=src/schema.sql --remote

CREATE TABLE IF NOT EXISTS cases (
  token              TEXT PRIMARY KEY,   -- opaque, random, never derived from ref
  ref                TEXT NOT NULL UNIQUE, -- SC-0024, shown to the client
  status             TEXT NOT NULL,      -- open | in_progress | safety_stop | submitted | expired
  phone              TEXT NOT NULL,
  city               TEXT,
  reported_issue     TEXT,
  answers            TEXT NOT NULL DEFAULT '{}',
  diagnosis          TEXT,
  -- Control panel: zero or one capture per case, hence columns rather than a
  -- table. `panel_frames` counts the extracted frames.
  panel_frames       INTEGER NOT NULL DEFAULT 0,
  panel_analysis     TEXT,
  panel_status       TEXT NOT NULL DEFAULT 'idle',
  panel_video_key    TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  expires_at         TEXT NOT NULL
);

-- Drives the GDPR purge: photos of a client's home must not outlive the case.
-- The cron sweeps on this index.
CREATE INDEX IF NOT EXISTS idx_cases_expires ON cases (expires_at);
CREATE INDEX IF NOT EXISTS idx_cases_status ON cases (status);

CREATE TABLE IF NOT EXISTS photos (
  case_token      TEXT NOT NULL,
  slot            INTEGER NOT NULL,   -- 1 nameplate | 2 overview | 3 leak
  r2_key          TEXT,
  skipped         INTEGER NOT NULL DEFAULT 0,
  attempts        INTEGER NOT NULL DEFAULT 0,
  analysis        TEXT,
  analysis_status TEXT NOT NULL DEFAULT 'idle',  -- idle | pending | done | failed
  -- Verdict of the browser-side check, recorded at upload. The only quality
  -- signal on the slots the model no longer sees.
  local_verdict   TEXT,                          -- ok | blurry | dark | overexposed
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (case_token, slot),
  FOREIGN KEY (case_token) REFERENCES cases (token) ON DELETE CASCADE
);

-- Audit trail. Useful for support ("the client says they sent the photo") and
-- for measuring drop-off per screen.
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  case_token TEXT,
  kind       TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_case ON events (case_token);

-- Client reference sequence. A table rather than AUTOINCREMENT: the reference
-- must stay stable and readable even after a case is purged.
CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

INSERT OR IGNORE INTO counters (name, value) VALUES ('case_ref', 24);
