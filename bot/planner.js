import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const PLANS_DIR = join(__dir, 'plans');

export function savePlan(toolName, input) {
  const { clientId, weekOf } = input;
  const dir = join(PLANS_DIR, clientId);
  mkdirSync(dir, { recursive: true });

  const planPath = join(dir, `${weekOf}.json`);
  let plan = loadRaw(planPath) ?? { clientId, weekOf, createdAt: new Date().toISOString() };

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

  writeFileSync(planPath, JSON.stringify(plan, null, 2));
  console.log(`[planner] saved ${planPath}`);
  return plan;
}

function loadRaw(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

// Merge training + nutrition arrays into the shape client.html reads
function mergeWeek(trainingDays, nutritionDays) {
  return trainingDays.map((t, i) => {
    const n = nutritionDays[i];
    return {
      label: t.label,
      fullDate: t.fullDate,
      type: t.type,
      training: {
        session: t.session,
        ...(t.items ? { items: t.items } : {}),
        ...(t.activities ? { activities: t.activities } : {}),
        note: t.note,
        noteType: t.noteType,
      },
      nutrition: {
        kcal: n.kcal,
        protein: n.protein,
        carbs: n.carbs,
        fat: n.fat,
        meals: n.meals,
        note: n.note,
      },
    };
  });
}

export function getLatestPlan(clientId) {
  const dir = join(PLANS_DIR, clientId);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter(f => f.endsWith('.json')).sort().reverse();
  if (!files.length) return null;
  return loadRaw(join(dir, files[0]));
}

export function getPlanByWeek(clientId, weekOf) {
  return loadRaw(join(PLANS_DIR, clientId, `${weekOf}.json`));
}
