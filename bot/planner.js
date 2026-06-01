import db from './db.js';
import { archivePlanVersion } from './logs.js';
import { validatePlan, validateTrainingDay, validateNutritionDay, isValidWeekOf, PlanValidationError } from './validators.js';
import { buildWeeklyShoppingList } from './shopping.js';

const PLAN_TYPE_FOR = { save_training_plan: 'training', save_nutrition_plan: 'nutrition' };

// Load the stored plan object for a client+week, or null.
function loadPlan(clientId, weekOf) {
  const row = db.prepare('SELECT plan_json FROM plans WHERE client_id = ? AND week_of = ?').get(clientId, weekOf);
  return row ? JSON.parse(row.plan_json) : null;
}

// Recompute derived fields (week array, shopping list, published flag) after
// any mutation. Keeps the stored object internally consistent.
function refreshDerived(plan) {
  plan.week = buildWeek(plan.weekOf, plan.training, plan.nutrition);
  plan.shoppingList = plan.nutrition ? buildWeeklyShoppingList(plan.nutrition) : null;
  plan.publishedAt = plan.trainingReady && plan.nutritionReady
    ? (plan.publishedAt || new Date().toISOString())
    : null;
  return plan;
}

// ── Save a plan half (training or nutrition) ──────────────────
// Validates the incoming half BEFORE persisting. Throws PlanValidationError
// on incomplete data so callers can reject (HTTP 422 / WhatsApp message).

export function savePlan(toolName, input) {
  const planType = PLAN_TYPE_FOR[toolName];
  if (!planType) throw new Error(`savePlan: herramienta desconocida "${toolName}"`);

  // ── Gate: reject incomplete plans ───────────────────────────
  const { ok, errors } = validatePlan(toolName, input);
  if (!ok) throw new PlanValidationError(errors);

  const { clientId, weekOf } = input;
  const now = new Date().toISOString();

  let plan = loadPlan(clientId, weekOf) ?? { clientId, weekOf, createdAt: now };

  // Archive the previous version of this half before overwriting it.
  const previous = plan[planType];
  if (previous) archivePlanVersion(clientId, weekOf, planType, previous);

  plan[planType] = input.days;
  plan[`${planType}Ready`] = true;
  plan[`${planType}At`] = now;

  refreshDerived(plan);
  upsertPlan(clientId, weekOf, plan);
  console.log(`[planner] saved ${toolName} for ${clientId} week ${weekOf}`);
  return plan;
}

// ── Overwrite a full week half ────────────────────────────────
// Semantically identical to savePlan (which already replaces the half), but
// named explicitly for the "sobrescribir semana completa" edit flow.
export const overwritePlanHalf = savePlan;

// ── Edit a single day of an existing plan ─────────────────────
// Replaces days[dayIndex] of one half, validating just that day. Requires the
// half to already exist (you can't patch a day into a plan that was never saved).
export function updatePlanDay(clientId, weekOf, planType, dayIndex, dayData) {
  if (!['training', 'nutrition'].includes(planType)) throw new Error('planType inválido');
  if (!isValidWeekOf(weekOf)) throw new PlanValidationError(['weekOf debe ser un lunes en formato YYYY-MM-DD']);
  if (!Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex > 6) {
    throw new PlanValidationError([`dayIndex fuera de rango (0-6): ${dayIndex}`]);
  }

  const plan = loadPlan(clientId, weekOf);
  if (!plan || !Array.isArray(plan[planType])) {
    throw new PlanValidationError([`No existe un plan de ${planType} para ${weekOf}; guárdalo completo primero.`]);
  }

  // Force the label to the correct weekday slot, then validate the single day.
  const day = { ...dayData, label: DAY_LABELS[dayIndex] };
  const { errors } = planType === 'training'
    ? validateTrainingDay(day, dayIndex)
    : validateNutritionDay(day, dayIndex);
  if (errors.length) throw new PlanValidationError(errors);

  // Archive the full half before patching, so edits are reversible.
  archivePlanVersion(clientId, weekOf, planType, plan[planType]);

  plan[planType] = plan[planType].map((d, i) => (i === dayIndex ? day : d));
  plan[`${planType}At`] = new Date().toISOString();

  refreshDerived(plan);
  upsertPlan(clientId, weekOf, plan);
  console.log(`[planner] updated ${planType} day ${DAY_LABELS[dayIndex]} for ${clientId} week ${weekOf}`);
  return plan;
}

// ── Append a free-form note to a plan after creation ──────────
// Stored on plan.notes[] (plan-level), independent of the per-day coach notes.
export function appendPlanNote(clientId, weekOf, text, author = 'coach') {
  const note = String(text || '').trim();
  if (!note) throw new PlanValidationError(['La nota no puede estar vacía']);

  const plan = loadPlan(clientId, weekOf);
  if (!plan) throw new PlanValidationError([`No existe un plan para ${weekOf}`]);

  plan.notes = Array.isArray(plan.notes) ? plan.notes : [];
  plan.notes.push({ text: note, author, at: new Date().toISOString() });

  upsertPlan(clientId, weekOf, plan);
  console.log(`[planner] appended note (${author}) to ${clientId} week ${weekOf}`);
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
