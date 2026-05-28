import db from './db.js';

// ── Save a plan half (training or nutrition) ──────────────────

export function savePlan(toolName, input) {
  const { clientId, weekOf } = input;

  // Load existing row or start fresh
  const row = db.prepare('SELECT plan_json FROM plans WHERE client_id = ? AND week_of = ?').get(clientId, weekOf);
  let plan = row ? JSON.parse(row.plan_json) : { clientId, weekOf, createdAt: new Date().toISOString() };

  if (toolName === 'save_training_plan') {
    plan.training = input.days;
    plan.trainingReady = true;
    plan.trainingAt = new Date().toISOString();
  } else {
    plan.nutrition = input.days;
    plan.nutritionReady = true;
    plan.nutritionAt = new Date().toISOString();
  }

  // Merge into client-portal format when both halves are ready
  if (plan.trainingReady && plan.nutritionReady) {
    plan.week = mergeWeek(plan.training, plan.nutrition);
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

// ── Merge training + nutrition arrays → client.html format ────

function mergeWeek(trainingDays, nutritionDays) {
  return trainingDays.map((t, i) => {
    const n = nutritionDays[i];
    return {
      label:    t.label,
      fullDate: t.fullDate,
      type:     t.type,
      training: {
        session:    t.session,
        ...(t.items      ? { items:      t.items      } : {}),
        ...(t.activities ? { activities: t.activities } : {}),
        note:     t.note,
        noteType: t.noteType,
      },
      nutrition: {
        kcal:    n.kcal,
        protein: n.protein,
        carbs:   n.carbs,
        fat:     n.fat,
        meals:   n.meals,
        note:    n.note,
      },
    };
  });
}
