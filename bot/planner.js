import db from './db.js';
import { archivePlanVersion } from './logs.js';

// ── Save a plan half (training or nutrition) ──────────────────

export function savePlan(toolName, input) {
  const { clientId, weekOf } = input;

  // Load existing row or start fresh
  const row = db.prepare('SELECT plan_json FROM plans WHERE client_id = ? AND week_of = ?').get(clientId, weekOf);
  let plan = row ? JSON.parse(row.plan_json) : { clientId, weekOf, createdAt: new Date().toISOString() };

  // Archive the previous version before overwriting
  if (row) {
    const planType = toolName === 'save_training_plan' ? 'training' : 'nutrition';
    const previous = toolName === 'save_training_plan' ? plan.training : plan.nutrition;
    if (previous) archivePlanVersion(clientId, weekOf, planType, previous);
  }

  if (toolName === 'save_training_plan') {
    plan.training = input.days;
    plan.trainingReady = true;
    plan.trainingAt = new Date().toISOString();
  } else {
    plan.nutrition = input.days;
    plan.nutritionReady = true;
    plan.nutritionAt = new Date().toISOString();
  }

  // Always build plan.week so partial saves are visible in the client portal
  plan.week = buildWeek(weekOf, plan.training, plan.nutrition);
  if (plan.trainingReady && plan.nutritionReady) {
    plan.publishedAt = new Date().toISOString();
  }

  upsertPlan(clientId, weekOf, plan);
  console.log(`[planner] saved ${toolName} for ${clientId} week ${weekOf}`);
  return plan;
}

// ── Seed a pre-built plan directly (used for demo seeding) ────

export function seedPlan(clientId, weekOf, week) {
  const existing = db.prepare('SELECT client_id FROM plans WHERE client_id = ? AND week_of = ?').get(clientId, weekOf);
  if (existing) return false; // already seeded

  const plan = {
    clientId,
    weekOf,
    week,
    trainingReady: true,
    nutritionReady: true,
    publishedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };

  upsertPlan(clientId, weekOf, plan);
  console.log(`[planner] seeded demo plan for ${clientId} week ${weekOf}`);
  return true;
}

function upsertPlan(clientId, weekOf, plan) {
  db.prepare(`
    INSERT INTO plans (client_id, week_of, plan_json, training_ready, nutrition_ready, published_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(client_id, week_of) DO UPDATE SET
      plan_json       = excluded.plan_json,
      training_ready  = excluded.training_ready,
      nutrition_ready = excluded.nutrition_ready,
      published_at    = excluded.published_at
  `).run(
    clientId,
    weekOf,
    JSON.stringify(plan),
    plan.trainingReady ? 1 : 0,
    plan.nutritionReady ? 1 : 0,
    plan.publishedAt || null,
  );
}

// ── Queries ───────────────────────────────────────────────────

export function getLatestPlan(clientId) {
  const row = db.prepare(
    'SELECT plan_json FROM plans WHERE client_id = ? ORDER BY week_of DESC LIMIT 1'
  ).get(clientId);
  return row ? JSON.parse(row.plan_json) : null;
}

export function getPlanByWeek(clientId, weekOf) {
  const row = db.prepare(
    'SELECT plan_json FROM plans WHERE client_id = ? AND week_of = ?'
  ).get(clientId, weekOf);
  return row ? JSON.parse(row.plan_json) : null;
}

export function listPlanWeeks(clientId) {
  return db.prepare(
    `SELECT week_of AS weekOf FROM plans
     WHERE client_id = ? AND (training_ready = 1 OR nutrition_ready = 1)
     ORDER BY week_of ASC`
  ).all(clientId);
}

// ── Build week array from whatever halves are available ───────

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function weekdayFull(weekOf, offset) {
  const d = new Date(weekOf + 'T12:00:00Z');
  d.setDate(d.getDate() + offset);
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}

function buildWeek(weekOf, trainingDays, nutritionDays) {
  const len = (trainingDays || nutritionDays || []).length || 7;
  return Array.from({ length: len }, (_, i) => {
    const t = trainingDays?.[i];
    const n = nutritionDays?.[i];
    return {
      label:    t?.label || n?.label || DAY_LABELS[i],
      fullDate: t?.fullDate || weekdayFull(weekOf, i),
      type:     t?.type || 'rest',
      training: {
        session:  t?.session || 'Plan pendiente',
        ...(t?.items      ? { items:      t.items      } : {}),
        ...(t?.activities ? { activities: t.activities } : {}),
        note:     t?.note    || '',
        noteType: t?.noteType || 'rest',
      },
      nutrition: {
        kcal:    n?.kcal    || 0,
        protein: n?.protein || 0,
        carbs:   n?.carbs   || 0,
        fat:     n?.fat     || 0,
        meals:   n?.meals   || [],
        note:    n?.note    || '',
      },
    };
  });
}
