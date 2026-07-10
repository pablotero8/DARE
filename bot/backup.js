import db, { DATA_DIR } from './db.js';
import { mkdirSync, readdirSync, statSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';

const BACKUP_DIR = join(DATA_DIR, 'backups');
const KEEP_DAYS = Number(process.env.BACKUP_KEEP_DAYS) || 14;
const DAY_MS = 24 * 60 * 60 * 1000;

// Consistent online backup via better-sqlite3 (safe with WAL — no downtime).
// One file per day: dare-YYYY-MM-DD.db. Re-running on the same day overwrites,
// so the latest state of the day wins.
export async function runBackup() {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const dest = join(BACKUP_DIR, `dare-${stamp}.db`);
  await db.backup(dest);
  pruneOldBackups();
  console.log(`[backup] database backed up → ${dest}`);
  return dest;
}

function pruneOldBackups() {
  if (!existsSync(BACKUP_DIR)) return;
  const cutoff = Date.now() - KEEP_DAYS * DAY_MS;
  for (const f of readdirSync(BACKUP_DIR)) {
    if (!/^dare-\d{4}-\d{2}-\d{2}\.db$/.test(f)) continue;
    const path = join(BACKUP_DIR, f);
    if (statSync(path).mtimeMs < cutoff) {
      unlinkSync(path);
      console.log(`[backup] pruned old backup ${f}`);
    }
  }
}

// Newest backup on disk (for the coach download endpoint), or null.
export function latestBackupPath() {
  if (!existsSync(BACKUP_DIR)) return null;
  const files = readdirSync(BACKUP_DIR)
    .filter(f => /^dare-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort();
  return files.length ? join(BACKUP_DIR, files[files.length - 1]) : null;
}

// Run once at boot, then every 24 h. setInterval (not cron) keeps the
// dependency footprint at zero; exact time of day doesn't matter for backups.
export function scheduleDailyBackups() {
  runBackup().catch(err => console.error('[backup] boot backup failed:', err.message));
  const timer = setInterval(
    () => runBackup().catch(err => console.error('[backup] daily backup failed:', err.message)),
    DAY_MS
  );
  timer.unref(); // never keep the process alive just for backups
  console.log(`[backup] daily database backups scheduled (keep ${KEEP_DAYS} days)`);
}
