// ── Weekly shopping list ──────────────────────────────────────
// Deterministically aggregates ingredient quantities across all 7 days of a
// nutrition plan into one structured, de-duplicated shopping list.
//
// Ingredient data is read from each meal, in priority order:
//   1. meal.ingredients  → [{ item, qty, unit? }]  (structured, preferred)
//   2. meal.shopping     → [{ item, qty }]          (table-flow, day-level)
//   3. day.shopping      → [{ item, qty }]          (legacy fallback)
//
// The output is fully structured (no free-text parsing needed downstream):
//   { generatedAt, count, items: [{ name, quantity, unit, display, category }] }

const UNIT_ALIASES = {
  g: 'g', gr: 'g', gram: 'g', grams: 'g', gramo: 'g', gramos: 'g',
  kg: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilogramos: 'kg',
  ml: 'ml', milliliter: 'ml', mililitro: 'ml', mililitros: 'ml',
  l: 'l', liter: 'l', litre: 'l', litro: 'l', litros: 'l',
  tbsp: 'tbsp', tablespoon: 'tbsp', cucharada: 'tbsp',
  tsp: 'tsp', teaspoon: 'tsp', cucharadita: 'tsp',
  cup: 'cup', cups: 'cup', taza: 'cup', tazas: 'cup',
  unit: 'unit', units: 'unit', u: 'unit', pc: 'unit', pcs: 'unit',
  piece: 'unit', pieces: 'unit', ud: 'unit', uds: 'unit', x: 'unit',
};

// Units that share a base so they can be summed together.
const CONVERT_TO_BASE = { g: ['g', 1], kg: ['g', 1000], ml: ['ml', 1], l: ['ml', 1000] };

const CATEGORY_KEYWORDS = [
  ['protein', ['chicken', 'beef', 'steak', 'turkey', 'salmon', 'tuna', 'fish', 'egg', 'pork', 'shrimp', 'prawn', 'tofu', 'whey', 'pollo', 'ternera', 'huevo', 'pavo', 'atún', 'salmón', 'gamba', 'cerdo']],
  ['carbs', ['rice', 'oat', 'oats', 'pasta', 'bread', 'potato', 'quinoa', 'tortilla', 'noodle', 'arroz', 'avena', 'pan', 'patata', 'pasta', 'fideos']],
  ['vegetables & fruit', ['broccoli', 'spinach', 'asparagus', 'tomato', 'pepper', 'onion', 'lettuce', 'cucumber', 'carrot', 'banana', 'apple', 'berry', 'berries', 'lemon', 'lime', 'avocado', 'brócoli', 'espinaca', 'espárrago', 'tomate', 'pimiento', 'cebolla', 'zanahoria', 'plátano', 'manzana', 'aguacate', 'limón']],
  ['dairy', ['milk', 'yogurt', 'yoghurt', 'cheese', 'cottage', 'leche', 'yogur', 'queso']],
  ['fats & oils', ['oil', 'olive', 'butter', 'almond', 'nut', 'nuts', 'seed', 'seeds', 'aceite', 'mantequilla', 'almendra', 'nuez', 'semilla']],
];

function canonicalUnit(raw) {
  const key = String(raw || '').trim().toLowerCase().replace(/\.$/, '');
  if (!key) return 'unit';
  return UNIT_ALIASES[key] || key;
}

// Parse a quantity that may be a number ("18"), a string ("350g", "1.4 L",
// "2 tbsp") or a {value, unit} pair. Returns { value:Number|null, unit }.
export function parseQuantity(qty, unitHint) {
  if (qty == null) return { value: null, unit: canonicalUnit(unitHint) };
  if (typeof qty === 'number') return { value: Number.isFinite(qty) ? qty : null, unit: canonicalUnit(unitHint) };

  const str = String(qty).trim();
  const m = str.match(/^([\d]+(?:[.,]\d+)?)\s*(.*)$/);
  if (!m) return { value: null, unit: canonicalUnit(unitHint || str) };
  const value = parseFloat(m[1].replace(',', '.'));
  const unit = canonicalUnit(m[2] || unitHint);
  return { value: Number.isFinite(value) ? value : null, unit };
}

function categoryFor(name) {
  const n = name.toLowerCase();
  for (const [cat, words] of CATEGORY_KEYWORDS) {
    if (words.some((w) => n.includes(w))) return cat;
  }
  return 'other';
}

function formatDisplay(value, unit) {
  if (value == null) return unit === 'unit' ? '' : unit;
  const round = (v) => (Math.round(v * 100) / 100).toString();
  if (unit === 'g' && value >= 1000) return `${round(value / 1000)} kg`;
  if (unit === 'ml' && value >= 1000) return `${round(value / 1000)} L`;
  if (unit === 'unit') return round(value);
  return `${round(value)} ${unit}`.trim();
}

// Pull raw [{item, qty, unit?}] entries out of a single day's meals.
function collectFromDay(day) {
  const out = [];
  const push = (entry) => {
    if (!entry) return;
    const name = (entry.item || entry.name || '').toString().trim();
    if (!name) return;
    out.push({ name, qty: entry.qty ?? entry.quantity ?? entry.amount, unit: entry.unit });
  };
  (day?.meals || []).forEach((meal) => {
    if (Array.isArray(meal?.ingredients)) meal.ingredients.forEach(push);
    if (Array.isArray(meal?.shopping)) meal.shopping.forEach(push);
  });
  if (Array.isArray(day?.shopping)) day.shopping.forEach(push);
  return out;
}

// Build the aggregated weekly list from a nutrition `days` array.
export function buildWeeklyShoppingList(nutritionDays) {
  if (!Array.isArray(nutritionDays) || nutritionDays.length === 0) return null;

  // key = lowercased name + '|' + canonical base unit
  const merged = new Map();

  for (const day of nutritionDays) {
    for (const raw of collectFromDay(day)) {
      const { value, unit } = parseQuantity(raw.qty, raw.unit);
      const conv = CONVERT_TO_BASE[unit];
      const baseUnit = conv ? conv[0] : unit;
      const baseValue = value != null && conv ? value * conv[1] : value;
      const key = `${raw.name.toLowerCase()}|${baseUnit}`;

      const existing = merged.get(key);
      if (existing) {
        if (baseValue != null) existing.value = (existing.value ?? 0) + baseValue;
        existing.occurrences += 1;
      } else {
        merged.set(key, { name: raw.name, value: baseValue, unit: baseUnit, occurrences: 1 });
      }
    }
  }

  if (merged.size === 0) return null;

  const items = [...merged.values()]
    .map((e) => ({
      name: e.name,
      quantity: e.value != null ? Math.round(e.value * 100) / 100 : null,
      unit: e.unit,
      display: formatDisplay(e.value, e.unit),
      category: categoryFor(e.name),
    }))
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

  return { generatedAt: new Date().toISOString(), count: items.length, items };
}

// Derive the nutrition `days` array from a plan in either stored shape:
//   • plan.nutrition         — raw half straight from the save flow
//   • plan.week[i].nutrition — merged/seeded shape (no separate half)
export function extractNutritionDays(plan) {
  if (!plan) return null;
  if (Array.isArray(plan.nutrition) && plan.nutrition.length) return plan.nutrition;
  if (Array.isArray(plan.week) && plan.week.length) {
    const days = plan.week
      .map((d) => (d && d.nutrition ? { ...d.nutrition, label: d.label } : null))
      .filter(Boolean);
    if (days.length) return days;
  }
  return null;
}

// Convenience: build the weekly list from a whole plan object (any shape).
export function shoppingListForPlan(plan) {
  const days = extractNutritionDays(plan);
  return days ? buildWeeklyShoppingList(days) : null;
}
