import './env.js'; // load .env before reading DATA_DIR, whoever the entry point is
import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { join, dirname, resolve, isAbsolute } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
// A relative DATA_DIR (e.g. "./data" in .env) is resolved against the REPO
// ROOT, never the process cwd — otherwise the server and any script run from
// a different directory would silently open two different databases.
export const DATA_DIR = process.env.DATA_DIR
  ? (isAbsolute(process.env.DATA_DIR) ? process.env.DATA_DIR : resolve(__dir, '..', process.env.DATA_DIR))
  : join(__dir, 'data');
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

  -- Daily training / nutrition logs from clients
  CREATE TABLE IF NOT EXISTS daily_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id   TEXT NOT NULL,
    log_date    TEXT NOT NULL,
    type        TEXT NOT NULL CHECK(type IN ('training','nutrition')),
    data_json   TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT DEFAULT (datetime('now')),
    UNIQUE(client_id, log_date, type),
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_daily_logs_client ON daily_logs(client_id);
  CREATE INDEX IF NOT EXISTS idx_daily_logs_date   ON daily_logs(client_id, log_date);

  -- Weekly body-metrics check-ins
  CREATE TABLE IF NOT EXISTS check_ins (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id     TEXT NOT NULL,
    check_date    TEXT NOT NULL,
    weight_kg     REAL,
    body_fat_pct  REAL,
    lean_mass_kg  REAL,
    notes         TEXT,
    created_at    TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_checkins_client ON check_ins(client_id);

  -- Plan version history (archived before each overwrite)
  CREATE TABLE IF NOT EXISTS plan_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id   TEXT NOT NULL,
    week_of     TEXT NOT NULL,
    plan_type   TEXT NOT NULL CHECK(plan_type IN ('training','nutrition')),
    plan_json   TEXT NOT NULL,
    saved_at    TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_plan_history_client ON plan_history(client_id, week_of);

  -- Reusable recipe library — one row per (meal_type, recipe). Built from every
  -- saved nutrition plan so coaches can reuse previous recipes per meal slot.
  CREATE TABLE IF NOT EXISTS recipes (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    meal_type        TEXT NOT NULL,         -- normalized slot: breakfast | lunch | dinner | snack…
    name             TEXT NOT NULL,         -- recipe label (dish/ingredient summary)
    kcal             REAL,
    protein          REAL,
    carbs            REAL,
    fat              REAL,
    ingredients_json TEXT NOT NULL DEFAULT '[]',
    steps_json       TEXT NOT NULL DEFAULT '[]',
    times_used       INTEGER NOT NULL DEFAULT 1,
    created_at       TEXT DEFAULT (datetime('now')),
    last_used_at     TEXT DEFAULT (datetime('now')),
    UNIQUE(meal_type, name)
  );
  CREATE INDEX IF NOT EXISTS idx_recipes_meal_type ON recipes(meal_type);

  -- Password reset tokens
  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token       TEXT PRIMARY KEY,
    client_id   TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    used        INTEGER DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  );

  -- Client ⇄ coach messaging. One shared thread per client; both coaches see it.
  -- from_role tells who wrote it; coach_id records which coach replied (null for
  -- client messages). read_at is set when the *other* side opens the thread.
  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id   TEXT NOT NULL,
    coach_id    TEXT,
    from_role   TEXT NOT NULL CHECK(from_role IN ('client','coach')),
    text        TEXT NOT NULL,
    created_at  TEXT DEFAULT (datetime('now')),
    read_at     TEXT,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_messages_client ON messages(client_id, created_at);

  -- Coaching agreements. One row per client intake: data_json snapshots the
  -- client's details at creation time so the contract keeps showing what was
  -- signed even if the profile (weight, goal…) changes later.
  CREATE TABLE IF NOT EXISTS contracts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id   TEXT NOT NULL,
    version     TEXT NOT NULL,
    data_json   TEXT NOT NULL,
    created_at  TEXT DEFAULT (datetime('now')),
    signed_at   TEXT,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_contracts_client ON contracts(client_id);
`);

// ── Safe migrations for existing DBs ──────────────────────────
for (const sql of [
  `ALTER TABLE clients ADD COLUMN role TEXT NOT NULL DEFAULT 'client'`,
  `ALTER TABLE clients ADD COLUMN specialty TEXT`,
  // GDPR art. 9: explicit consent to process health data, recorded with
  // timestamp + policy version so consent can be evidenced and re-requested
  // when the privacy policy changes.
  `ALTER TABLE clients ADD COLUMN health_consent_at TEXT`,
  `ALTER TABLE clients ADD COLUMN health_consent_version TEXT`,
  // Date of birth (YYYY-MM-DD) — needed to identify the client in the
  // coaching agreement and to confirm they are of legal age.
  `ALTER TABLE clients ADD COLUMN birth_date TEXT`,
]) {
  try { db.exec(sql); } catch {} // column already exists — fine
}

export default db;
