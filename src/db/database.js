import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Bump when the schema changes. Older demo databases are rebuilt and reseeded. */
export const SCHEMA_VERSION = 2;

const TABLES = ['audit_log', 'dispatches', 'run_stages', 'run_steps', 'runs', 'donations', 'vehicles', 'recipients', 'donors', 'users'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('coordinator', 'viewer')),
  password_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS donors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS recipients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  capacity_kg REAL NOT NULL CHECK (capacity_kg >= 0),
  accepts TEXT NOT NULL,
  has_cold_storage INTEGER NOT NULL DEFAULT 0,
  closes_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vehicles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  capacity_kg REAL NOT NULL CHECK (capacity_kg > 0),
  refrigerated INTEGER NOT NULL DEFAULT 0,
  available INTEGER NOT NULL DEFAULT 1,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  speed_kmh REAL NOT NULL CHECK (speed_kmh > 0)
);

CREATE TABLE IF NOT EXISTS donations (
  id TEXT PRIMARY KEY,
  donor_id TEXT NOT NULL REFERENCES donors(id),
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  quantity_kg REAL NOT NULL CHECK (quantity_kg > 0),
  needs_cold INTEGER NOT NULL DEFAULT 0,
  ready_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'proposed', 'assigned', 'delivered')),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  objective TEXT NOT NULL,
  planner_mode TEXT NOT NULL CHECK (planner_mode IN ('pending', 'gemini', 'deterministic_fallback', 'none')),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'completed_with_warnings', 'failed')),
  fallback_reason TEXT,
  model TEXT,
  summary TEXT,
  metrics TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_user ON runs(user_id, started_at);

CREATE TABLE IF NOT EXISTS run_stages (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'success', 'warning', 'failed', 'skipped')),
  summary TEXT,
  detail TEXT,
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  duration_ms INTEGER,
  PRIMARY KEY (run_id, key)
);

CREATE TABLE IF NOT EXISTS run_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  tool TEXT,
  input TEXT,
  output TEXT,
  ok INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_steps_run ON run_steps(run_id, seq);

CREATE TABLE IF NOT EXISTS dispatches (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  donation_id TEXT NOT NULL REFERENCES donations(id),
  recipient_id TEXT NOT NULL REFERENCES recipients(id),
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  quantity_kg REAL NOT NULL CHECK (quantity_kg > 0),
  priority TEXT NOT NULL CHECK (priority IN ('critical', 'high', 'normal', 'low')),
  source TEXT NOT NULL CHECK (source IN ('gemini', 'deterministic')),
  distance_km REAL NOT NULL,
  pickup_at TEXT NOT NULL,
  deliver_at TEXT NOT NULL,
  slack_minutes INTEGER NOT NULL,
  rationale TEXT NOT NULL,
  constraints_checked TEXT NOT NULL,
  assumptions TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending_approval', 'approved', 'rejected', 'delivered')),
  decided_by TEXT REFERENCES users(id),
  decided_at TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dispatch_run ON dispatches(run_id);
-- At most one live (not rejected) dispatch per donation: a database-level guard against double allocation.
CREATE UNIQUE INDEX IF NOT EXISTS uq_dispatch_live_donation ON dispatches(donation_id) WHERE status <> 'rejected';

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  action TEXT NOT NULL,
  target TEXT,
  details TEXT,
  created_at TEXT NOT NULL
);
`;

/**
 * Opens and migrates the SQLite database. Use ':memory:' for tests.
 */
export function openDatabase(path) {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version !== SCHEMA_VERSION) {
    // Demo data only: rebuild rather than migrate column by column.
    db.exec('PRAGMA foreign_keys = OFF;');
    for (const t of TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  }
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

/** Runs fn inside an IMMEDIATE transaction (takes the write lock up front), rolling back on any error. */
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
