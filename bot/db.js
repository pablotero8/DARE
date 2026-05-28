import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dir, 'data');
mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = join(DATA_DIR, 'dare.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ─────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    initials        TEXT NOT NULL,
    email           TEXT UNIQUE NOT NULL,
    password_hash   TEXT NOT NULL,
    phone           TEXT,
    goal            TEXT NOT NULL,
    current_week    INTEGER DEFAULT 1,
    total_weeks     INTEGER DEFAULT 12,
    height_cm       REAL,
    weight_kg       REAL,
    body_fat_pct    REAL,
    lean_mass_kg    REAL,
    notes           TEXT,
    role            TEXT NOT NULL DEFAULT 'client',
    specialty       TEXT,
    created_at      TEXT DEFAULT (datetime('now')),
    last_login_at   TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_clients_email ON clients(email);
  CREATE INDEX IF NOT EXISTS idx_clients_phone ON clients(phone);

  CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    client_id   TEXT NOT NULL,
    created_at  TEXT DEFAULT (datetime('now')),
    expires_at  TEXT NOT NULL,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_client ON sessions(client_id);

  CREATE TABLE IF NOT EXISTS plans (
    client_id       TEXT NOT NULL,
    week_of         TEXT NOT NULL,
    plan_json       TEXT NOT NULL,
    training_ready  INTEGER DEFAULT 0,
    nutrition_ready INTEGER DEFAULT 0,
    created_at      TEXT DEFAULT (datetime('now')),
    published_at    TEXT,
    PRIMARY KEY (client_id, week_of),
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_plans_client ON plans(client_id);
`);

// ── Safe migrations for existing DBs ──────────────────────────
for (const sql of [
  `ALTER TABLE clients ADD COLUMN role TEXT NOT NULL DEFAULT 'client'`,
  `ALTER TABLE clients ADD COLUMN specialty TEXT`,
]) {
  try { db.exec(sql); } catch {} // column already exists — fine
}

export default db;
