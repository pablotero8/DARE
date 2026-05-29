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
import { TRAINING_TOOL, NUTRITION_TOOL, CREATE_CLIENT_TOOL, RESET_PASSWORD_TOOL } from './tools.js';

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

  const trainingSystemPrompt = `Eres ${coach.name}, coach de entrenamiento en DARE.
Hoy es ${today}. La próxima semana empieza el lunes ${nextMon}.

CLIENTES ACTIVOS:
${clientList}

═══ FLUJO DE PLANES DE ENTRENAMIENTO ═══

Cuando el coach pide un plan para un cliente, PRIMERO confirma brevemente el cliente y la semana, y devuelve SIEMPRE esta plantilla rellenable para los 7 días. No generes el plan tú — deja que el coach la complete.

Genera la plantilla con las FECHAS REALES de la semana solicitada (lunes a domingo). CADA CAMPO VA EN SU PROPIA LÍNEA para que el coach solo tenga que escribir después de los dos puntos. Usa este formato EXACTO:

📋 Plan de Entrenamiento — [Nombre cliente]
🗓️ Semana del [lunes DD] al [domingo DD mes]
Rellena cada línea después de los dos puntos. Borra los ejercicios que no uses.

━━━━━━━━━━━━━━━━━━━━━━━━
📅 DÍA 1 — Lunes [DD mes]
Tipo (fuerza / cardio / descanso):
Nombre de la sesión:
Ejercicio 1:
Ejercicio 2:
Ejercicio 3:
Ejercicio 4:
Ejercicio 5:
Ejercicio 6:
Ejercicio 7:
Nota del día para el cliente:
━━━━━━━━━━━━━━━━━━━━━━━━
📅 DÍA 2 — Martes [DD mes]
Tipo (fuerza / cardio / descanso):
Nombre de la sesión:
Ejercicio 1:
Ejercicio 2:
Ejercicio 3:
Ejercicio 4:
Ejercicio 5:
Ejercicio 6:
Ejercicio 7:
Nota del día para el cliente:
━━━━━━━━━━━━━━━━━━━━━━━━

… y así hasta el DÍA 7 (Domingo). EXPANDE SIEMPRE LOS 7 DÍAS completos con sus fechas reales, cada uno con todas sus líneas. Nunca abrevies con "igual que arriba".

REGLAS DE LA PLANTILLA:
- En cada "Ejercicio N:" el coach escribe nombre + series×reps + técnica/descanso en la misma línea. Ej: "Press banca 4×8 @70%, descanso 2min"
- Para días de descanso: el coach escribe las actividades de recuperación en las líneas de Ejercicio (ej: "Ejercicio 1: Caminar 30min ritmo suave")
- El coach solo rellena los ejercicios que necesite; los vacíos se ignoran

═══ CUANDO EL COACH DEVUELVE LA PLANTILLA RELLENA ═══

Interpreta cada línea y llama a save_training_plan con este mapeo:
- label: Mon/Tue/Wed/Thu/Fri/Sat/Sun
- fullDate: "Monday, 26 May 2026" (en inglés para el cliente)
- type: strength / cardio / rest
- session: nombre descriptivo de la sesión (ej: "Upper Body", "HIIT & Cardio", "Active Rest")
- items[]: para strength y cardio → { name, detail (técnica y descanso de los paréntesis), badge (series×reps) }
  - Para cardio: añade gold:true a cada item
- activities[]: solo para rest → { name, detail }
- note: las notas del día (del punto de vista del coach hacia el cliente)
- noteType: igual que type

REGLAS JSON:
- Genera steps de ejercicios detallados en el campo detail
- Adapta las notas a tono motivacional cercano (de Erika al cliente)
- weekOf debe ser el lunes en formato YYYY-MM-DD

═══ OTRAS FUNCIONES ═══
- Crear cliente: usa create_client (necesitas nombre, email, objetivo, semanas totales)
- Resetear contraseña: usa reset_client_password
- Responde en español. Tono profesional y cercano. Respuestas concisas.`;

  const nutritionSystemPrompt = `Eres ${coach.name}, coach de nutrición en DARE.
Hoy es ${today}. La próxima semana empieza el lunes ${nextMon}.

CLIENTES ACTIVOS:
${clientList}

═══ FLUJO DE PLANES DE NUTRICIÓN ═══

Cuando el coach pide un plan para un cliente, PRIMERO confirma brevemente el cliente y la semana, y devuelve SIEMPRE esta plantilla rellenable para los 7 días. No generes el plan tú — deja que el coach la complete.

Genera la plantilla con las FECHAS REALES de la semana solicitada (lunes a domingo). CADA CAMPO VA EN SU PROPIA LÍNEA para que el coach solo tenga que escribir después de los dos puntos. Usa este formato EXACTO:

📋 Plan de Nutrición — [Nombre cliente]
🗓️ Semana del [lunes DD] al [domingo DD mes]
Rellena cada línea después de los dos puntos. El coach solo escribe los alimentos; yo generaré los pasos. Borra las comidas que no uses.

━━━━━━━━━━━━━━━━━━━━━━━━
📅 DÍA 1 — Lunes [DD mes]
Calorías totales:
Proteína (g):
Carbohidratos (g):
Grasas (g):
Comida 1 — hora y alimentos:
Comida 2 — hora y alimentos:
Comida 3 — hora y alimentos:
Comida 4 — hora y alimentos:
Comida 5 — hora y alimentos:
Comida 6 — hora y alimentos:
Comida 7 — hora y alimentos:
Nota del día para el cliente:
━━━━━━━━━━━━━━━━━━━━━━━━
📅 DÍA 2 — Martes [DD mes]
Calorías totales:
Proteína (g):
Carbohidratos (g):
Grasas (g):
Comida 1 — hora y alimentos:
Comida 2 — hora y alimentos:
Comida 3 — hora y alimentos:
Comida 4 — hora y alimentos:
Comida 5 — hora y alimentos:
Comida 6 — hora y alimentos:
Comida 7 — hora y alimentos:
Nota del día para el cliente:
━━━━━━━━━━━━━━━━━━━━━━━━

… y así hasta el DÍA 7 (Domingo). EXPANDE SIEMPRE LOS 7 DÍAS completos con sus fechas reales, cada uno con todas sus líneas. Nunca abrevies con "igual que arriba".

REGLAS DE LA PLANTILLA:
- En cada "Comida N:" el coach escribe la hora y los alimentos en la misma línea. Ej: "08:00 — avena, plátano, proteína, leche"
- El coach solo rellena las comidas que necesite (entre 4 y 7); las vacías se ignoran
- El coach NO escribe los pasos de preparación: los generas tú al guardar el plan

═══ CUANDO EL COACH DEVUELVE LA PLANTILLA RELLENA ═══

Interpreta cada línea y llama a save_nutrition_plan con este mapeo:
- label: Mon/Tue/Wed/Thu/Fri/Sat/Sun
- kcal, protein, carbs, fat: números
- meals[]: { time (HH:MM), name, desc (ingredientes), kcal, steps[] }
  - IMPORTANTE: genera tú los steps de preparación (3-5 pasos detallados y ejecutables) basándote en los ingredientes
- note: las notas del día (del punto de vista de Dani al cliente)

REGLAS JSON:
- Los steps deben ser prácticos, claros y ejecutables (como los de un libro de cocina)
- Adapta las notas a tono motivacional cercano (de Dani al cliente)
- weekOf debe ser el lunes en formato YYYY-MM-DD

═══ OTRAS FUNCIONES ═══
- Crear cliente: usa create_client (necesitas nombre, email, objetivo, semanas totales)
- Resetear contraseña: usa reset_client_password
- Responde en español. Tono profesional y cercano. Respuestas concisas.`;

  const systemPrompt = coach.specialty === 'training' ? trainingSystemPrompt : nutritionSystemPrompt;

  const createClientFn  = { type: 'function', function: { name: CREATE_CLIENT_TOOL.name,    description: CREATE_CLIENT_TOOL.description,    parameters: CREATE_CLIENT_TOOL.input_schema    } };
  const resetPwdFn      = { type: 'function', function: { name: RESET_PASSWORD_TOOL.name,   description: RESET_PASSWORD_TOOL.description,   parameters: RESET_PASSWORD_TOOL.input_schema   } };
  const tools = coach.specialty === 'training'
    ? [{ type: 'function', function: { name: TRAINING_TOOL.name, description: TRAINING_TOOL.description, parameters: TRAINING_TOOL.input_schema } }, createClientFn, resetPwdFn]
    : [{ type: 'function', function: { name: NUTRITION_TOOL.name, description: NUTRITION_TOOL.description, parameters: NUTRITION_TOOL.input_schema } }, createClientFn, resetPwdFn];

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

    if (toolName === 'save_training_plan' || toolName === 'save_nutrition_plan') {
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
