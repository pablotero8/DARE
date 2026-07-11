// ── Plan validation ───────────────────────────────────────────
// Single source of truth for "is this weekly plan complete enough to save?".
// Returns { ok, errors, warnings }:
//   errors   → block the save (critical missing data)
//   warnings → allowed, but surfaced to the coach (e.g. an empty note)
//
// Used by planner.savePlan (hard gate) and the edit endpoints.

export const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_SET = new Set(DAY_LABELS);
const TRAINING_TYPES = new Set(['strength', 'cardio', 'rest']);

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

// ── "Pending" (intentionally blank) days ──────────────────────
// A coach can leave a day empty; it shows as "still planning" on the client.
// Such days are skipped by validation (neither blocked nor required to be full).

// Nutrition day is empty when there are no macros and no meals.
export function isEmptyNutritionDay(day) {
  if (!day || typeof day !== 'object') return true;
  const noMacros = !(day.kcal > 0) && !(day.protein > 0) && !(day.carbs > 0) && !(day.fat > 0);
  const noMeals = !Array.isArray(day.meals) || day.meals.length === 0;
  return noMacros && noMeals;
}

// Training day is empty when there are no exercises, no activities and no note.
export function isEmptyTrainingDay(day) {
  if (!day || typeof day !== 'object') return true;
  const noItems = !Array.isArray(day.items) || day.items.length === 0;
  const noActivities = !Array.isArray(day.activities) || day.activities.length === 0;
  const noNote = !isNonEmptyString(day.note);
  return noItems && noActivities && noNote;
}

// weekOf must be an ISO date (YYYY-MM-DD) that lands on a Monday.
export function isValidWeekOf(weekOf) {
  if (!isNonEmptyString(weekOf) || !/^\d{4}-\d{2}-\d{2}$/.test(weekOf)) return false;
  const d = new Date(weekOf + 'T12:00:00Z');
  if (Number.isNaN(d.getTime())) return false;
  return d.getUTCDay() === 1; // Monday
}

// ── Per-day validators ────────────────────────────────────────

// Validate one training day. `index` (0-6) is optional; when given we also
// check the label matches the expected weekday position.
export function validateTrainingDay(day, index = null) {
  const errors = [];
  const warnings = [];
  const where = index === null ? (day?.label || '?') : (DAY_LABELS[index] || `#${index}`);

  if (!day || typeof day !== 'object') {
    return { errors: [`Día ${where}: datos ausentes`], warnings };
  }
  if (!isNonEmptyString(day.label) || !DAY_SET.has(day.label)) {
    errors.push(`Día ${where}: etiqueta inválida (esperado Mon–Sun)`);
  } else if (index !== null && day.label !== DAY_LABELS[index]) {
    errors.push(`Día ${where}: etiqueta "${day.label}" fuera de orden`);
  }
  if (!isNonEmptyString(day.type) || !TRAINING_TYPES.has(day.type)) {
    errors.push(`Día ${where}: tipo inválido (strength | cardio | rest)`);
  }
  if (!isNonEmptyString(day.session)) {
    errors.push(`Día ${where}: falta el nombre de la sesión`);
  }

  if (day.type === 'rest') {
    // Rest days may list recovery activities; each needs a name.
    if (Array.isArray(day.activities)) {
      day.activities.forEach((a, i) => {
        if (!isNonEmptyString(a?.name)) errors.push(`Día ${where}: actividad #${i + 1} sin nombre`);
      });
    }
  } else {
    // Strength / cardio days require at least one exercise with a name + badge.
    if (!Array.isArray(day.items) || day.items.length === 0) {
      errors.push(`Día ${where}: sin ejercicios (se requiere al menos 1)`);
    } else {
      day.items.forEach((it, i) => {
        if (!isNonEmptyString(it?.name)) errors.push(`Día ${where}: ejercicio #${i + 1} sin nombre`);
        if (!isNonEmptyString(it?.badge)) warnings.push(`Día ${where}: ejercicio "${it?.name || i + 1}" sin series/reps`);
      });
    }
  }

  if (!isNonEmptyString(day.note)) warnings.push(`Día ${where}: sin nota del coach`);

  return { errors, warnings };
}

// Validate one nutrition day.
export function validateNutritionDay(day, index = null) {
  const errors = [];
  const warnings = [];
  const where = index === null ? (day?.label || '?') : (DAY_LABELS[index] || `#${index}`);

  if (!day || typeof day !== 'object') {
    return { errors: [`Día ${where}: datos ausentes`], warnings };
  }
  if (!isNonEmptyString(day.label) || !DAY_SET.has(day.label)) {
    errors.push(`Día ${where}: etiqueta inválida (esperado Mon–Sun)`);
  } else if (index !== null && day.label !== DAY_LABELS[index]) {
    errors.push(`Día ${where}: etiqueta "${day.label}" fuera de orden`);
  }

  // Daily macro targets must be present and positive (kcal + protein at minimum).
  if (!isFiniteNumber(day.kcal) || day.kcal <= 0) errors.push(`Día ${where}: kcal objetivo ausente o inválido`);
  if (!isFiniteNumber(day.protein) || day.protein <= 0) errors.push(`Día ${where}: proteína objetivo ausente o inválida`);
  if (!isFiniteNumber(day.carbs) || day.carbs < 0) errors.push(`Día ${where}: carbohidratos inválidos`);
  if (!isFiniteNumber(day.fat) || day.fat < 0) errors.push(`Día ${where}: grasa inválida`);

  // Macro/kcal consistency ("regla de las proporciones"): the typed kcal should
  // match 4·protein + 4·carbs + 9·fat. A drift > 3% almost always means a data-
  // entry slip in the coach's targets — warn (don't block) so it's caught before
  // the solver runs against an impossible goal.
  if (isFiniteNumber(day.kcal) && day.kcal > 0 &&
      isFiniteNumber(day.protein) && isFiniteNumber(day.carbs) && isFiniteNumber(day.fat)) {
    const implied = day.protein * 4 + day.carbs * 4 + day.fat * 9;
    if (implied > 0 && Math.abs(implied - day.kcal) / day.kcal > 0.03) {
      warnings.push(`Día ${where}: kcal (${Math.round(day.kcal)}) no cuadra con los macros (4·P+4·C+9·G = ${Math.round(implied)} kcal)`);
    }
  }

  // Meals: at least one, each with time + name + kcal + steps.
  if (!Array.isArray(day.meals) || day.meals.length === 0) {
    errors.push(`Día ${where}: sin comidas (se requiere al menos 1)`);
  } else {
    day.meals.forEach((m, i) => {
      const mWhere = `Día ${where} · comida #${i + 1}`;
      if (!isNonEmptyString(m?.name)) errors.push(`${mWhere}: sin nombre`);
      if (!isNonEmptyString(m?.time)) warnings.push(`${mWhere}: sin horario`);
      if (!isFiniteNumber(m?.kcal) || m.kcal < 0) warnings.push(`${mWhere}: kcal ausente`);
      if (!Array.isArray(m?.steps) || m.steps.length === 0) warnings.push(`${mWhere}: sin pasos de preparación`);
    });
  }

  if (!isNonEmptyString(day.note)) warnings.push(`Día ${where}: sin nota del coach`);

  return { errors, warnings };
}

// ── Whole-plan validators ─────────────────────────────────────

function validatePlanShell(input) {
  const errors = [];
  if (!isNonEmptyString(input?.clientId)) errors.push('clientId ausente');
  if (!isValidWeekOf(input?.weekOf)) errors.push('weekOf debe ser un lunes en formato YYYY-MM-DD');
  if (!Array.isArray(input?.days)) {
    errors.push('days ausente');
  } else if (input.days.length < 1 || input.days.length > 7) {
    // A plan may be partial (1-6 days) — the coach can leave days blank.
    errors.push(`Se requieren entre 1 y 7 días (recibidos: ${input.days.length})`);
  }
  return errors;
}

export function validateTrainingPlan(input) {
  const errors = validatePlanShell(input);
  const warnings = [];
  if (Array.isArray(input?.days) && input.days.length >= 1 && input.days.length <= 7) {
    // Positional label check only applies to a full Mon–Sun week; for partial
    // weeks we just validate each day's label is a valid weekday.
    const positional = input.days.length === 7;
    let filledDays = 0;
    input.days.forEach((d, i) => {
      // Skip intentionally-blank days — coach can leave the week partial.
      if (isEmptyTrainingDay(d)) return;
      filledDays++;
      const r = validateTrainingDay(d, positional ? i : null);
      errors.push(...r.errors);
      warnings.push(...r.warnings);
    });
    if (filledDays === 0) errors.push('El plan está vacío — rellena al menos un día');
  }
  return { ok: errors.length === 0, errors, warnings };
}

export function validateNutritionPlan(input) {
  const errors = validatePlanShell(input);
  const warnings = [];
  if (Array.isArray(input?.days) && input.days.length >= 1 && input.days.length <= 7) {
    // Positional label check only applies to a full Mon–Sun week; for partial
    // weeks we just validate each day's label is a valid weekday.
    const positional = input.days.length === 7;
    let filledDays = 0;
    input.days.forEach((d, i) => {
      // Skip intentionally-blank days — coach can leave the week partial.
      if (isEmptyNutritionDay(d)) return;
      filledDays++;
      const r = validateNutritionDay(d, positional ? i : null);
      errors.push(...r.errors);
      warnings.push(...r.warnings);
    });
    if (filledDays === 0) errors.push('El plan está vacío — rellena al menos un día');
  }
  return { ok: errors.length === 0, errors, warnings };
}

// Dispatch by tool name (matches planner.savePlan call sites).
export function validatePlan(toolName, input) {
  return toolName === 'save_training_plan'
    ? validateTrainingPlan(input)
    : validateNutritionPlan(input);
}

// Thrown by planner.savePlan when a plan fails validation, so callers can
// distinguish "bad data" (422) from unexpected failures (500).
export class PlanValidationError extends Error {
  constructor(errors) {
    super('Plan incompleto: ' + errors.join('; '));
    this.name = 'PlanValidationError';
    this.errors = errors;
  }
}
