// ── Exercise library ──────────────────────────────────────────
// The training counterpart of recipes.js. There is no dedicated table: the
// list of "exercises used so far" is derived on read from every saved training
// plan (plans.plan_json) plus the archived halves (plan_history). The coach UI
// reads it to offer a quick-pick dropdown above the chat input.

import db from './db.js';

const safeParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// Pull every exercise/activity name out of a training-days array.
function namesFromTrainingDays(days, into) {
  if (!Array.isArray(days)) return;
  for (const day of days) {
    for (const it of (day?.items || [])) {
      const n = clean(it?.name);
      if (n) into.add(n);
    }
    for (const act of (day?.activities || [])) {
      const n = clean(act?.name);
      if (n) into.add(n);
    }
  }
}

// Unique exercise names across all plans + history, alphabetically sorted.
// Case-insensitive de-dup keeps the first-seen casing.
export function listExercises(limit = 400) {
  const seen = new Map(); // lowercased → display name
  const add = (set) => set.forEach(n => {
    const key = n.toLowerCase();
    if (!seen.has(key)) seen.set(key, n);
  });

  // Active + scheduled plans: plan_json.training is the days array.
  for (const row of db.prepare('SELECT plan_json FROM plans').all()) {
    const plan = safeParse(row.plan_json);
    const found = new Set();
    namesFromTrainingDays(plan?.training, found);
    add(found);
  }
  // Archived training halves: plan_json is the days array itself.
  for (const row of db.prepare("SELECT plan_json FROM plan_history WHERE plan_type = 'training'").all()) {
    const days = safeParse(row.plan_json);
    const found = new Set();
    namesFromTrainingDays(days, found);
    add(found);
  }

  return [...seen.values()].sort((a, b) => a.localeCompare(b)).slice(0, limit);
}
