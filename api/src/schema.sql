-- Schéma D1. Appliquer :
--   wrangler d1 execute soscumulus-diag --file=src/schema.sql --local
--   wrangler d1 execute soscumulus-diag --file=src/schema.sql --remote

CREATE TABLE IF NOT EXISTS dossiers (
  token       TEXT PRIMARY KEY,          -- opaque, aléatoire, jamais dérivé de ref
  ref         TEXT NOT NULL UNIQUE,      -- SC-0024, affiché au client
  status      TEXT NOT NULL,             -- ouvert | en_cours | stop_securite | soumis | expire
  tel         TEXT NOT NULL,
  ville       TEXT,
  probleme    TEXT,
  answers     TEXT NOT NULL DEFAULT '{}',
  diagnostic  TEXT,
  -- Bandeau de commande : 0 ou 1 capture par dossier, d'où des colonnes
  -- plutôt qu'une table. `bandeau_frames` compte les images extraites.
  bandeau_frames  INTEGER NOT NULL DEFAULT 0,
  bandeau_analysis TEXT,
  bandeau_status  TEXT NOT NULL DEFAULT 'idle',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

-- Sert la purge RGPD : les photos du domicile d'un client n'ont pas à
-- survivre au dossier. Le cron balaie sur cet index.
CREATE INDEX IF NOT EXISTS idx_dossiers_expires ON dossiers (expires_at);
CREATE INDEX IF NOT EXISTS idx_dossiers_status ON dossiers (status);

CREATE TABLE IF NOT EXISTS photos (
  dossier_token   TEXT NOT NULL,
  slot            INTEGER NOT NULL,      -- 1 plaque | 2 ensemble | 3 fuite
  r2_key          TEXT,
  skipped         INTEGER NOT NULL DEFAULT 0,
  attempts        INTEGER NOT NULL DEFAULT 0,
  analysis        TEXT,
  analysis_status TEXT NOT NULL DEFAULT 'idle',  -- idle | pending | done | failed
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (dossier_token, slot),
  FOREIGN KEY (dossier_token) REFERENCES dossiers (token) ON DELETE CASCADE
);

-- Journal d'audit. Utile au support ("le client dit qu'il a envoyé la photo")
-- et à la mesure du taux d'abandon par écran.
CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  dossier_token TEXT,
  kind          TEXT NOT NULL,
  detail        TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_dossier ON events (dossier_token);

-- Séquence des références clients. Une table plutôt qu'un AUTOINCREMENT :
-- la référence doit rester stable et lisible même si un dossier est purgé.
CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

INSERT OR IGNORE INTO counters (name, value) VALUES ('dossier_ref', 24);
