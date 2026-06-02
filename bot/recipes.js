// ── Recipe library ────────────────────────────────────────────
// Every nutrition plan that gets saved feeds this library: each meal is stored
// as a reusable recipe, keyed by (meal_type, name). The coach UI reads it to
// offer a "reuse previous recipe" dropdown per meal slot.

import db from './db.js';
import { extractNutritionDays } from './shopping.js';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const safeParse = (s) => { try { return JSON.parse(s); } catch { return []; } };

// Canonical meal slot key, e.g. "Morning Snack" → "morning snack".
export function normalizeMealType(name) {
  return String(name || '').trim().toLowerCase() || 'other';
}

// A recipe's display label: prefer the dish/ingredient summary, fall back to slot.
function recipeName(meal) {
  return String(meal?.desc || meal?.name || '').trim().slice(0, 200);
}

function mapRow(r) {
  return {
    id: r.id, mealType: r.meal_type, name: r.name,
    kcal: r.kcal, protein: r.protein, carbs: r.carbs, fat: r.fat,
    ingredients: safeParse(r.ingredients_json),
    steps: safeParse(r.steps_json),
    timesUsed: r.times_used, lastUsedAt: r.last_used_at,
  };
}

// Upsert one recipe. Re-saving the same (meal_type, name) refreshes its data
// and bumps times_used instead of creating a duplicate.
export function saveRecipe(mealType, meal) {
  const name = recipeName(meal);
  if (!name) return false;
  db.prepare(`
    INSERT INTO recipes (meal_type, name, kcal, protein, carbs, fat, ingredients_json, steps_json)
    VALUES (@meal_type, @name, @kcal, @protein, @carbs, @fat, @ingredients, @steps)
    ON CONFLICT(meal_type, name) DO UPDATE SET
      kcal = excluded.kcal, protein = excluded.protein, carbs = excluded.carbs, fat = excluded.fat,
      ingredients_json = excluded.ingredients_json, steps_json = excluded.steps_json,
      times_used = times_used + 1, last_used_at = datetime('now')
  `).run({
    meal_type: normalizeMealType(mealType),
    name,
    kcal: num(meal.kcal), protein: num(meal.protein), carbs: num(meal.carbs), fat: num(meal.fat),
    ingredients: JSON.stringify(Array.isArray(meal.ingredients) ? meal.ingredients : []),
    steps: JSON.stringify(Array.isArray(meal.steps) ? meal.steps : []),
  });
  return true;
}

// Store every meal of a nutrition `days` array as a recipe. Returns the count.
export function saveRecipesFromNutritionDays(days) {
  if (!Array.isArray(days)) return 0;
  let n = 0;
  const tx = db.transaction(() => {
    for (const day of days) {
      for (const meal of (day?.meals || [])) {
        if (recipeName(meal) && saveRecipe(meal.name || 'meal', meal)) n++;
      }
    }
  });
  tx();
  return n;
}

// Recipes for one meal slot, most-used first.
export function listRecipes(mealType, limit = 100) {
  return db.prepare(
    `SELECT * FROM recipes WHERE meal_type = ? ORDER BY times_used DESC, last_used_at DESC LIMIT ?`
  ).all(normalizeMealType(mealType), limit).map(mapRow);
}

// One-time backfill: populate the library from every existing plan. Runs only
// when the table is empty, so it never inflates times_used on later boots.
export function backfillRecipesIfEmpty() {
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM recipes').get();
  if (c > 0) return 0;
  let n = 0;
  for (const row of db.prepare('SELECT plan_json FROM plans').all()) {
    try { n += saveRecipesFromNutritionDays(extractNutritionDays(JSON.parse(row.plan_json))); }
    catch { /* skip malformed plan rows */ }
  }
  if (n) console.log(`[recipes] backfilled ${n} recipe entries from existing plans`);
  return n;
}

// All recipes grouped by meal type: { breakfast: [...], lunch: [...], … }.
export function listRecipesGrouped(limit = 400) {
  const rows = db.prepare(
    `SELECT * FROM recipes ORDER BY meal_type, times_used DESC, last_used_at DESC LIMIT ?`
  ).all(limit).map(mapRow);
  const out = {};
  for (const r of rows) (out[r.mealType] = out[r.mealType] || []).push(r);
  return out;
}
