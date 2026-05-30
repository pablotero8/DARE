import db from './db.js';

// ── Daily logs (training / nutrition adherence) ───────────────

export function saveLog(clientId, logDate, type, data) {
  db.prepare(`
    INSERT INTO daily_logs (client_id, log_date, type, data_json)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(client_id, log_date, type) DO UPDATE SET
      data_json  = excluded.data_json,
      created_at = datetime('now')
  `).run(clientId, logDate, type, JSON.stringify(data));
}

export function getLog(clientId, logDate, type) {
  const row = db.prepare(
    'SELECT * FROM daily_logs WHERE client_id = ? AND log_date = ? AND type = ?'
  ).get(clientId, logDate, type);
  return row ? { ...row, data: JSON.parse(row.data_json) } : null;
}

// Returns all logs for a client in the last `days` days (default 30)
export function getRecentLogs(clientId, days = 30) {
  return db.prepare(`
    SELECT log_date, type, data_json FROM daily_logs
    WHERE client_id = ? AND log_date >= date('now', ?)
    ORDER BY log_date DESC
  `).all(clientId, `-${days} days`).map(r => ({
    logDate: r.log_date, type: r.type, data: JSON.parse(r.data_json),
  }));
}

// Adherence summary: how many training days done in last N days
export function getAdherenceSummary(clientId, days = 7) {
  const rows = db.prepare(`
    SELECT log_date, type, data_json FROM daily_logs
    WHERE client_id = ? AND log_date >= date('now', ?) AND type = 'training'
    ORDER BY log_date DESC
  `).all(clientId, `-${days} days`);
  const done = rows.filter(r => {
    try { return JSON.parse(r.data_json).done === true; } catch { return false; }
  }).length;
  return { days, logged: rows.length, done };
}

// ── Body metrics check-ins ────────────────────────────────────

export function saveCheckIn(clientId, checkDate, { weightKg, bodyFatPct, leanMassKg, notes }) {
  const lean = leanMassKg ?? (weightKg && bodyFatPct ? +(weightKg * (1 - bodyFatPct / 100)).toFixed(1) : null);
  db.prepare(`
    INSERT INTO check_ins (client_id, check_date, weight_kg, body_fat_pct, lean_mass_kg, notes)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT DO NOTHING
  `).run(clientId, checkDate, weightKg ?? null, bodyFatPct ?? null, lean, notes ?? null);

  // Also keep clients.weight_kg / body_fat_pct current for profile display
  if (weightKg || bodyFatPct) {
    const updates = {};
    if (weightKg)     updates.weight_kg    = weightKg;
    if (bodyFatPct)   updates.body_fat_pct = bodyFatPct;
    if (lean)         updates.lean_mass_kg = lean;
    const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE clients SET ${sets} WHERE id = ?`).run(...Object.values(updates), clientId);
  }
}

export function getCheckIns(clientId, limit = 52) {
  return db.prepare(`
    SELECT check_date, weight_kg, body_fat_pct, lean_mass_kg, notes
    FROM check_ins WHERE client_id = ?
    ORDER BY check_date ASC
    LIMIT ?
  `).all(clientId, limit).map(r => ({
    date: r.check_date, weight: r.weight_kg, bodyFat: r.body_fat_pct,
    lean: r.lean_mass_kg, notes: r.notes,
  }));
}

// ── Plan version history ──────────────────────────────────────

export function archivePlanVersion(clientId, weekOf, planType, planData) {
  db.prepare(`
    INSERT INTO plan_history (client_id, week_of, plan_type, plan_json)
    VALUES (?, ?, ?, ?)
  `).run(clientId, weekOf, planType, JSON.stringify(planData));
}

export function getPlanHistory(clientId, weekOf) {
  return db.prepare(`
    SELECT plan_type, plan_json, saved_at FROM plan_history
    WHERE client_id = ? AND week_of = ?
    ORDER BY saved_at DESC LIMIT 20
  `).all(clientId, weekOf).map(r => ({
    type: r.plan_type, savedAt: r.saved_at, plan: JSON.parse(r.plan_json),
  }));
}
