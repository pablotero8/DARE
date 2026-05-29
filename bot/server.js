import './env.js';
import express from 'express';
import OpenAI from 'openai';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getLatestPlan, getPlanByWeek, listPlanWeeks, seedPlan, savePlan } from './planner.js';
import {
  verifyClientPassword, getClientById, getClientByEmail,
  listClients, createClient, deleteClient, resetClientPassword, updateClient,
} from './clients.js';
import { signToken, verifyToken, persistSession, revokeSession } from './auth.js';
import { TRAINING_TOOL, NUTRITION_TOOL, CREATE_CLIENT_TOOL, RESET_PASSWORD_TOOL, SHOW_TEMPLATE_TOOL } from './tools.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dir, '..');

const app    = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Static files
app.use('/bot', (req, res) => res.status(404).end());
app.use(express.static(ROOT, { index: 'index.html', dotfiles: 'ignore' }));

// ── Auth middleware ───────────────────────────────────────────

function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim() || null;
  if (!token) return res.status(401).json({ error: 'No autenticado' });
  const payload = verifyToken(token);
  if (!payload?.sub) return res.status(401).json({ error: 'Token inválido o expirado' });
  const client = getClientById(payload.sub);
  if (!client) return res.status(401).json({ error: 'Usuario no encontrado' });
  req.client = client;
  next();
}

function requireCoach(req, res, next) {
  requireAuth(req, res, () => {
    if (req.client.role !== 'coach') return res.status(403).json({ error: 'Acceso denegado' });
    next();
  });
}

// ── Auth routes ───────────────────────────────────────────────

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });
  const client = await verifyClientPassword(email, password);
  if (!client) return res.status(401).json({ error: 'Credenciales incorrectas' });
  const token = signToken(client.id);
  persistSession(token, client.id);
  res.json({
    token,
    client: {
      id: client.id, name: client.name, initials: client.initials,
      email: client.email, goal: client.goal, role: client.role,
      specialty: client.specialty, currentWeek: client.currentWeek,
      totalWeeks: client.totalWeeks, weight: client.weight,
      bodyFat: client.bodyFat, lean: client.lean, height: client.height,
    },
  });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  revokeSession(req.headers.authorization.slice(7));
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const c = req.client;
  res.json({
    id: c.id, name: c.name, initials: c.initials, email: c.email,
    goal: c.goal, role: c.role, specialty: c.specialty,
    currentWeek: c.currentWeek, totalWeeks: c.totalWeeks,
    weight: c.weight, bodyFat: c.bodyFat, lean: c.lean, height: c.height,
  });
});

// ── Plan API (clients) ────────────────────────────────────────

app.get('/api/plans/:clientId', requireAuth, (req, res) => {
  if (req.client.id !== req.params.clientId && req.client.role !== 'coach') {
    return res.status(403).json({ error: 'Acceso denegado' });
  }
  const plan = getLatestPlan(req.params.clientId);
  if (!plan) return res.status(404).json({ error: 'Sin planes todavía' });
  res.json(plan);
});

app.get('/api/plans/:clientId/week/:weekOf', requireAuth, (req, res) => {
  if (req.client.id !== req.params.clientId && req.client.role !== 'coach') {
    return res.status(403).json({ error: 'Acceso denegado' });
  }
  const plan = getPlanByWeek(req.params.clientId, req.params.weekOf);
  if (!plan) return res.status(404).json({ error: 'Semana no encontrada' });
  res.json(plan);
});

app.get('/api/plans/:clientId/weeks', requireAuth, (req, res) => {
  if (req.client.id !== req.params.clientId && req.client.role !== 'coach') {
    return res.status(403).json({ error: 'Acceso denegado' });
  }
  res.json(listPlanWeeks(req.params.clientId));
});

// ── Coach API ─────────────────────────────────────────────────

app.get('/api/coach/clients', requireCoach, (req, res) => {
  const clients = listClients().filter(c => c.role === 'client');
  res.json(clients.map(c => ({
    id: c.id, name: c.name, initials: c.initials, email: c.email,
    goal: c.goal, currentWeek: c.currentWeek, totalWeeks: c.totalWeeks,
  })));
});

app.post('/api/coach/chat', requireCoach, async (req, res) => {
  const { messages = [] } = req.body;
  const coach = req.client;

  const today = new Date().toLocaleDateString('es-ES', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const nextMon = nextMondayStr();
  const clientList = listClients()
    .filter(c => c.role === 'client')
    .map((c, i) => `${i + 1}. ${c.name} (id: ${c.id}) — ${c.goal}, Semana ${c.currentWeek}/${c.totalWeeks}`)
    .join('\n') || '(Sin clientes todavía)';

  const specialtyLabel = coach.specialty === 'training' ? 'entrenamiento' : 'nutrición';
  const systemPrompt = `Eres ${coach.name}, coach de ${specialtyLabel} en DARE.
Hoy es ${today}. La próxima semana empieza el lunes ${nextMon}.

CLIENTES ACTIVOS:
${clientList}

FLUJO PARA CREAR UN PLAN:
1. Cuando el coach pida un plan, confirma brevemente: cliente y semana (lunes en formato YYYY-MM-DD).
2. Una vez confirmados, llama INMEDIATAMENTE a show_plan_template — NUNCA escribas una plantilla de texto.
3. El coach rellenará la tabla interactiva que aparecerá en el chat.
4. Cuando el coach diga que ya guardó o que necesita algo más, responde con normalidad.

OTRAS FUNCIONES:
- Crear cliente: usa create_client (nombre, email, objetivo, semanas totales)
- Resetear contraseña: usa reset_client_password
- Responde en español. Tono profesional y cercano. Respuestas concisas.`;

  const toFn = t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } });
  const tools = [
    toFn(SHOW_TEMPLATE_TOOL),
    toFn(coach.specialty === 'training' ? TRAINING_TOOL : NUTRITION_TOOL),
    toFn(CREATE_CLIENT_TOOL),
    toFn(RESET_PASSWORD_TOOL),
  ];

  try {
    // ── Prompt caching: keep recent messages window to balance cache efficiency ──
    const MAX_HISTORY = 10;
    const recentMessages = messages.length > MAX_HISTORY
      ? messages.slice(-MAX_HISTORY)
      : messages;

    const openaiMessages = [
      {
        role: 'system',
        content: systemPrompt,
        cache_control: { type: 'ephemeral' }
      },
      ...recentMessages
    ];

    const first = await openai.chat.completions.create({
      model: 'gpt-4-turbo', max_tokens: 4096,
      messages: openaiMessages, tools, tool_choice: 'auto',
    });

    const choice = first.choices[0];

    // ── No tool call — plain text reply ──────────────────────
    if (choice.finish_reason !== 'tool_calls') {
      return res.json({ reply: choice.message.content, action: null });
    }

    // ── Tool call ─────────────────────────────────────────────
    const toolCall = choice.message.tool_calls[0];
    const toolName = toolCall.function.name;
    const toolInput = JSON.parse(toolCall.function.arguments);

    let toolResultContent;
    let action = null;

    if (toolName === 'show_plan_template') {
      // Build 7-day labels from weekOf
      const dayNames = ['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo'];
      const shortLabels = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
      const days = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(toolInput.weekOf + 'T12:00:00Z');
        d.setUTCDate(d.getUTCDate() + i);
        const months = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
        const fullDateEn = d.toLocaleDateString('en-GB', {
          weekday:'long', day:'numeric', month:'long', year:'numeric', timeZone:'UTC'
        });
        return {
          label: `${dayNames[i]} ${d.getUTCDate()} ${months[d.getUTCMonth()]}`,
          shortLabel: shortLabels[i],
          fullDate: fullDateEn,
        };
      });
      action = { type: 'show_template', specialty: coach.specialty, clientId: toolInput.clientId, weekOf: toolInput.weekOf, clientName: toolInput.clientName, days };
      toolResultContent = JSON.stringify({ success: true, message: 'Tabla interactiva mostrada al coach.' });
    } else if (toolName === 'save_training_plan' || toolName === 'save_nutrition_plan') {
      const plan = savePlan(toolName, toolInput);
      action = { type: 'plan_saved', toolName, weekOf: toolInput.weekOf, clientId: toolInput.clientId };
      toolResultContent = JSON.stringify({ success: true, weekOf: toolInput.weekOf, clientId: toolInput.clientId });
    } else if (toolName === 'create_client') {
      const { client, generatedPassword } = await createClient(toolInput);
      action = { type: 'client_created', client, password: generatedPassword };
      toolResultContent = JSON.stringify({ success: true, name: client.name, email: client.email, password: generatedPassword });
    } else if (toolName === 'reset_client_password') {
      const newPwd = await resetClientPassword(toolInput.clientId);
      if (!newPwd) {
        toolResultContent = JSON.stringify({ success: false, error: 'Cliente no encontrado' });
        action = null;
      } else {
        const c = getClientById(toolInput.clientId);
        action = { type: 'password_reset', clientId: toolInput.clientId, clientName: c?.name || toolInput.clientId, password: newPwd };
        toolResultContent = JSON.stringify({ success: true, clientId: toolInput.clientId, newPassword: newPwd });
      }
    } else {
      return res.json({ reply: 'Herramienta desconocida.', action: null });
    }

    // Get AI confirmation message (reuse cached system prompt and recent history)
    const second = await openai.chat.completions.create({
      model: 'gpt-4-turbo', max_tokens: 512,
      messages: [
        {
          role: 'system',
          content: systemPrompt,
          cache_control: { type: 'ephemeral' }
        },
        ...recentMessages,
        choice.message,
        { role: 'tool', tool_call_id: toolCall.id, content: toolResultContent },
      ],
    });

    res.json({ reply: second.choices[0].message.content, action });
  } catch (err) {
    console.error('[coach/chat]', err);
    res.status(500).json({ error: 'Error al procesar el mensaje.' });
  }
});

// ── Save plan from table ──────────────────────────────────────

app.post('/api/coach/save-plan-table', requireCoach, async (req, res) => {
  try {
    const { specialty, clientId, weekOf, days } = req.body;
    if (!specialty || !clientId || !weekOf || !Array.isArray(days)) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (specialty === 'nutrition') {
      // Collect all meals with ingredients (no macros from coach)
      const mealsForAI = [];
      days.forEach((d, di) => {
        (d.meals || []).forEach((m, mi) => {
          if (m.alimentos) mealsForAI.push({ id: `${di}-${mi}`, name: m.name, alimentos: m.alimentos });
        });
      });

      // Notes for AI translation
      const notesForAI = days.map((d, di) => ({ id: di, raw: d.note || '' })).filter(n => n.raw);

      // Single AI call: calculate macros from RAW ingredients, perfect names, generate steps & shopping list, translate notes
      let aiResult = { meals: [], notes: {} };
      if (mealsForAI.length > 0 || notesForAI.length > 0) {
        const aiResp = await openai.chat.completions.create({
          model: 'gpt-4o-mini', max_tokens: 4000,
          response_format: { type: 'json_object' },
          messages: [{ role: 'user', content: `You are a fitness nutrition assistant. Calculate macros from RAW (uncooked) ingredients using standard nutritional databases.

IMPORTANT: Use RAW ingredient values only. Example: raw eggs, uncooked oats, fresh vegetables, raw nuts. Do NOT account for cooking losses.

For each meal, list ingredients with quantities (e.g., "3 eggs, 50g oats, 200ml milk"). Calculate:
- Total protein in grams (RAW ingredient basis)
- Total carbs in grams (RAW ingredient basis)
- Total fat in grams (RAW ingredient basis)
- kcal = (protein×4) + (carbs×4) + (fat×9)

Generate 3-4 preparation steps in English. Create shopping list with quantities in grams or units.

MEALS:
${mealsForAI.map(m => `id="${m.id}" name="${m.name}" raw_ingredients="${m.alimentos}"`).join('\n')}

NOTES TO TRANSLATE AND REFINE (make them motivational, professional, in English — Daniel's coaching voice):
${notesForAI.map(n => `day=${n.id} raw="${n.raw}"`).join('\n')}

Return ONLY this JSON:
{
  "meals": [{"id":"0-0","name":"Perfected English Name","desc":"brief description","protein":45,"carbs":60,"fat":12,"kcal":492,"steps":["step 1","step 2","step 3"],"shopping":[{"item":"Eggs (large)","qty":"3"},{"item":"Oats (raw)","qty":"50g"}]}],
  "notes": {"0":"Refined note text","1":"..."}
}` }],
        });
        try { aiResult = JSON.parse(aiResp.choices[0].message.content); } catch(e) { console.error('[AI parse]', e); }
      }

      const aiMeals = {};
      (aiResult.meals || []).forEach(m => { aiMeals[m.id] = m; });

      const toolInput = {
        clientId, weekOf,
        days: days.map((d, di) => {
          const processedMeals = (d.meals || []).filter(m => m.alimentos).map((m, mi) => {
            const ai = aiMeals[`${di}-${mi}`] || {};
            return {
              time: m.time || '12:00',
              name: ai.name || m.name,
              desc: ai.desc || m.alimentos,
              kcal: ai.kcal || 0,
              protein: ai.protein || 0,
              carbs: ai.carbs || 0,
              fat: ai.fat || 0,
              steps: ai.steps || [m.alimentos],
              shopping: ai.shopping || [],
            };
          });
          // Compute day totals from AI-calculated meal macros
          let dayKcal = 0, dayProt = 0, dayCarbs = 0, dayFat = 0;
          processedMeals.forEach(m => {
            dayKcal += m.kcal; dayProt += m.protein; dayCarbs += m.carbs; dayFat += m.fat;
          });
          return {
            label: d.label || ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][di],
            kcal: Math.round(dayKcal), protein: Math.round(dayProt), carbs: Math.round(dayCarbs), fat: Math.round(dayFat),
            note: (aiResult.notes || {})[String(di)] || d.note || '',
            meals: processedMeals,
          };
        }),
      };
      savePlan('save_nutrition_plan', toolInput);

    } else if (specialty === 'training') {
      // Collect exercises and notes for AI
      const exsForAI = [];
      days.forEach((d, di) => {
        (d.exercises || []).forEach((e, ei) => {
          if (e.name) exsForAI.push({ id: `${di}-${ei}`, name: e.name, setsReps: e.setsReps||'', notes: e.notes||'' });
        });
      });
      const notesForAI = days.map((d, di) => ({ id: di, raw: d.note || '' })).filter(n => n.raw);

      let aiResult = { exercises: [], notes: {} };
      if (exsForAI.length > 0 || notesForAI.length > 0) {
        const aiResp = await openai.chat.completions.create({
          model: 'gpt-4o-mini', max_tokens: 3000,
          response_format: { type: 'json_object' },
          messages: [{ role: 'user', content: `You are a fitness training assistant. Process this data and return JSON.

EXERCISES (perfect the name to proper English, generate a clear 2-3 sentence execution description in English):
${exsForAI.map(e => `id="${e.id}" name="${e.name}" sets="${e.setsReps}" notes="${e.notes}"`).join('\n')}

NOTES TO TRANSLATE AND REFINE (make them motivational, professional, in English — Erika's coaching voice):
${notesForAI.map(n => `day=${n.id} raw="${n.raw}"`).join('\n')}

Return ONLY this JSON:
{
  "exercises": [{"id":"0-0","name":"Barbell Bench Press","detail":"Lie flat on bench, grip slightly wider than shoulders. Lower bar to mid-chest with controlled tempo, press up explosively. Keep shoulder blades retracted throughout."}],
  "notes": {"0":"Refined note text","1":"..."}
}` }],
        });
        try { aiResult = JSON.parse(aiResp.choices[0].message.content); } catch(e) { console.error('[AI parse]', e); }
      }

      const aiExs = {};
      (aiResult.exercises || []).forEach(e => { aiExs[e.id] = e; });

      const toolInput = {
        clientId, weekOf,
        days: days.map((d, di) => {
          const type = d.type || 'rest';
          const rawExs = (d.exercises || []).filter(e => e.name);
          const base = {
            label: d.label || ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][di],
            fullDate: d.fullDate || '',
            type,
            session: d.session || (type === 'rest' ? 'Active Rest' : 'Training'),
            note: (aiResult.notes || {})[String(di)] || d.note || '',
            noteType: type,
          };
          if (type === 'rest') {
            base.activities = rawExs.map((e, ei) => {
              const ai = aiExs[`${di}-${ei}`] || {};
              return { name: ai.name || e.name, detail: ai.detail || e.notes || 'Easy pace' };
            });
          } else {
            base.items = rawExs.map((e, ei) => {
              const ai = aiExs[`${di}-${ei}`] || {};
              return { name: ai.name || e.name, detail: ai.detail || e.notes || '', badge: e.setsReps || '', gold: type === 'cardio' };
            });
          }
          return base;
        }),
      };
      savePlan('save_training_plan', toolInput);

    } else {
      return res.status(400).json({ error: 'Invalid specialty' });
    }

    res.json({ success: true, weekOf, clientId });
  } catch (err) {
    console.error('[save-plan-table]', err);
    res.status(500).json({ error: 'Error saving plan' });
  }
});

// ── Health ────────────────────────────────────────────────────

app.get('/health', (_, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ── Seed helpers ──────────────────────────────────────────────

function nextMondayStr() {
  const d = new Date();
  const day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? 1 : 8 - day));
  return d.toISOString().split('T')[0];
}

function currentMondayStr() {
  const d = new Date();
  const day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  return d.toISOString().split('T')[0];
}

async function seedCoaches() {
  const coaches = [
    { name: 'Erika Silva', email: 'silvaepao@gmail.com', password: process.env.ERIKA_PASSWORD || 'erika2026', specialty: 'training' },
    { name: 'Dani Otero',  email: 'daniotero15@gmail.com', password: process.env.DANI_PASSWORD  || 'dani2026',  specialty: 'nutrition' },
  ];
  for (const c of coaches) {
    const existing = getClientByEmail(c.email);
    if (existing) {
      if (!existing.specialty) {
        updateClient(existing.id, { specialty: c.specialty });
        console.log(`[seed] Patched specialty for ${c.email} → ${c.specialty}`);
      }
      continue;
    }
    await createClient({ ...c, goal: 'Coach', totalWeeks: 99, role: 'coach' });
    console.log(`[seed] Coach created — ${c.email}`);
  }
}

async function seedDemoClient() {
  if (getClientByEmail('client@dare.ae')) return;
  await createClient({
    name: 'Alex Hammond', email: 'client@dare.ae', password: 'dare2026',
    goal: 'Fat-Loss Protocol', currentWeek: 8, totalWeeks: 12,
    height: 181, weight: 82.8, bodyFat: 18.8, lean: 67.4,
    notes: 'Entrena en gym privado. Sin restricciones alimentarias.',
  });
  console.log('[seed] Demo client created — client@dare.ae / dare2026');
}

function dayLabel(baseDate, offset) {
  const d = new Date(baseDate + 'T12:00:00Z');
  d.setDate(d.getDate() + offset);
  return {
    label:    d.toLocaleDateString('en-GB', { weekday: 'short' }).slice(0, 3),
    fullDate: d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }),
  };
}

function buildDemoWeek(weekOf) {
  const types    = ['strength','cardio','rest','strength','cardio','strength','rest'];
  const sessions = ['Upper Body','HIIT & Cardio','Active Rest','Lower Body','Cardio & Core','Full Body Power','Active Rest'];
  return types.map((type, i) => {
    const { label, fullDate } = dayLabel(weekOf, i);
    return {
      label, fullDate, type,
      training: {
        session: sessions[i],
        items: type !== 'rest' ? [{ name: 'Demo exercise', detail: 'Demo detail', badge: '3×10' }] : undefined,
        activities: type === 'rest' ? [{ name: 'Active recovery', detail: '30 min walk' }] : undefined,
        note: `Demo training note for ${label}.`,
        noteType: type,
      },
      nutrition: {
        kcal: 2100, protein: 175, carbs: 180, fat: 55,
        meals: [
          { time: '08:00', name: 'Breakfast', desc: 'Eggs & oats', kcal: 450, steps: ['Cook oats', 'Scramble eggs'] },
          { time: '13:00', name: 'Lunch',     desc: 'Chicken & rice', kcal: 680, steps: ['Grill chicken', 'Cook rice'] },
          { time: '20:00', name: 'Dinner',    desc: 'Salmon & veg', kcal: 560, steps: ['Pan-fry salmon', 'Steam veg'] },
        ],
        note: `Demo nutrition note for ${label}.`,
      },
    };
  });
}

async function seedDemoPlan() {
  const clientId = 'alex-hammond';
  for (const weekOf of [currentMondayStr(), nextMondayStr()]) {
    try {
      const seeded = seedPlan(clientId, weekOf, buildDemoWeek(weekOf));
      console.log(seeded ? `[seed] Plan seeded — ${weekOf}` : `[seed] Plan exists — ${weekOf}`);
    } catch (err) {
      console.error('[seed] Plan error:', err.message);
    }
  }
}

// ── Start ─────────────────────────────────────────────────────

const PORT = process.env.PORT ?? 3001;
app.listen(PORT, async () => {
  console.log(`DARE server :${PORT}`);
  await seedCoaches();
  await seedDemoClient();
  await seedDemoPlan();
});
