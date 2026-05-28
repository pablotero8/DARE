import './env.js';
import express from 'express';
import OpenAI from 'openai';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getLatestPlan, getPlanByWeek, listPlanWeeks, seedPlan, savePlan } from './planner.js';
import {
  verifyClientPassword, getClientById, getClientByEmail,
  listClients, createClient, deleteClient, resetClientPassword,
} from './clients.js';
import { signToken, verifyToken, persistSession, revokeSession } from './auth.js';
import { TRAINING_TOOL, NUTRITION_TOOL, CREATE_CLIENT_TOOL } from './tools.js';

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

  const specialtyLine = coach.specialty === 'training'
    ? 'Tu especialidad es el entrenamiento. Generas planes de entrenamiento de 7 días.'
    : 'Tu especialidad es la nutrición. Generas planes nutricionales de 7 días.';

  const systemPrompt = `Eres ${coach.name}, coach en DARE. ${specialtyLine}
También puedes dar de alta nuevos clientes en el sistema.

Hoy es ${today}. La próxima semana empieza el lunes ${nextMon}.

CLIENTES ACTIVOS:
${clientList}

INSTRUCCIONES:
- Cuando te pidan un plan, confirma cliente y semana. Haz UNA pregunta con toda la info que necesitas (bullets).
- Cuando tengas todo, genera el plan completo con la función correspondiente — no esperes confirmación extra.
- Para crear un cliente usa create_client. Necesitas: nombre, email, objetivo y semanas totales.
- Responde en español. Tono profesional y cercano. Respuestas concisas.`;

  const tools = [
    { type: 'function', function: { name: TRAINING_TOOL.name,    description: TRAINING_TOOL.description,    parameters: TRAINING_TOOL.input_schema    } },
    { type: 'function', function: { name: NUTRITION_TOOL.name,   description: NUTRITION_TOOL.description,   parameters: NUTRITION_TOOL.input_schema   } },
    { type: 'function', function: { name: CREATE_CLIENT_TOOL.name, description: CREATE_CLIENT_TOOL.description, parameters: CREATE_CLIENT_TOOL.input_schema } },
  ];

  try {
    const openaiMessages = [{ role: 'system', content: systemPrompt }, ...messages];

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

    if (toolName === 'save_training_plan' || toolName === 'save_nutrition_plan') {
      const plan = savePlan(toolName, toolInput);
      action = { type: 'plan_saved', toolName, weekOf: toolInput.weekOf, clientId: toolInput.clientId };
      toolResultContent = JSON.stringify({ success: true, weekOf: toolInput.weekOf, clientId: toolInput.clientId });
    } else if (toolName === 'create_client') {
      const { client, generatedPassword } = await createClient(toolInput);
      action = { type: 'client_created', client, password: generatedPassword };
      toolResultContent = JSON.stringify({ success: true, name: client.name, email: client.email, password: generatedPassword });
    } else {
      return res.json({ reply: 'Herramienta desconocida.', action: null });
    }

    // Get AI confirmation message
    const second = await openai.chat.completions.create({
      model: 'gpt-4-turbo', max_tokens: 512,
      messages: [
        ...openaiMessages,
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
    if (getClientByEmail(c.email)) continue;
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
