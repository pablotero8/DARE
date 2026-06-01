import './env.js';
import express from 'express';
import rateLimit from 'express-rate-limit';
import OpenAI from 'openai';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getLatestPlan, getPlanByWeek, listPlanWeeks, seedPlan, savePlan, updatePlanDay, appendPlanNote } from './planner.js';
import { PlanValidationError } from './validators.js';
import { buildWeeklyShoppingList } from './shopping.js';
import {
  verifyClientPassword, getClientById, getClientByEmail,
  listClients, createClient, deleteClient, resetClientPassword, updateClient,
} from './clients.js';
import { signToken, verifyToken, persistSession, revokeSession, isSessionValid } from './auth.js';
import { TRAINING_TOOL, NUTRITION_TOOL, CREATE_CLIENT_TOOL, RESET_PASSWORD_TOOL, SHOW_TEMPLATE_TOOL, ADD_NOTE_TOOL } from './tools.js';
import { saveLog, getLog, getRecentLogs, getAdherenceSummary, saveCheckIn, getCheckIns } from './logs.js';
import { sendPasswordReset } from './mailer.js';
import { sendWelcomeNotifications, scheduleDailyReminders, sendDailyReminders, sendTestEmail } from './notifier.js';
import { randomBytes } from 'crypto';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dir, '..');

const app    = express();
// Railway terminates TLS at a single proxy hop in front of the app; trust it
// so rate limiters and req.ip see the real client address (X-Forwarded-For).
app.set('trust proxy', 1);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(express.urlencoded({ extended: false, limit: '256kb' }));
app.use(express.json({ limit: '256kb' }));

// ── Rate limiters ─────────────────────────────────────────────
// Protect brute-force on login and cap expensive OpenAI-backed endpoints.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,        // 15 min
  max: 10,                          // 10 login attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de acceso. Inténtalo más tarde.' },
});

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,              // 1 min
  max: 15,                          // 15 AI calls per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas peticiones. Espera unos segundos.' },
});

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
  // Verify the token is still an active (non-revoked, non-expired) session in the DB.
  if (!isSessionValid(token)) return res.status(401).json({ error: 'Sesión expirada o revocada' });
  const client = getClientById(payload.sub);
  if (!client) return res.status(401).json({ error: 'Usuario no encontrado' });
  req.token = token;
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

// ── Password reset ────────────────────────────────────────────

app.post('/api/auth/forgot-password', loginLimiter, async (req, res) => {
  const { email } = req.body || {};
  // Always respond 200 — never reveal whether email exists
  res.json({ ok: true, message: 'If that email exists, a reset link has been sent.' });
  if (!email) return;
  try {
    const client = getClientByEmail(email);
    if (!client) return; // silent — don't leak existence
    // Generate secure token, store with 15-min expiry
    const token   = randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const db = (await import('./db.js')).default;
    db.prepare('INSERT INTO password_reset_tokens (token, client_id, expires_at) VALUES (?,?,?)').run(token, client.id, expires);
    const baseUrl  = process.env.APP_URL || 'https://dare-production-2636.up.railway.app';
    const resetUrl = `${baseUrl}/reset.html?token=${token}`;
    await sendPasswordReset(client.email, client.name, resetUrl);
    console.log(`[reset] Sent password reset to ${client.email}`);
  } catch (err) {
    console.error('[forgot-password]', err.message);
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password || password.length < 8) {
    return res.status(400).json({ error: 'Token and password (min 8 chars) are required.' });
  }
  try {
    const db = (await import('./db.js')).default;
    const row = db.prepare('SELECT * FROM password_reset_tokens WHERE token = ?').get(token);
    if (!row) return res.status(400).json({ error: 'Invalid or expired link.' });
    if (row.used) return res.status(400).json({ error: 'This link has already been used.' });
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: 'This link has expired. Request a new one.' });
    }
    // Mark token as used
    db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE token = ?').run(token);
    // Update password
    const { hashPassword } = await import('./auth.js');
    const hash = await hashPassword(password);
    db.prepare('UPDATE clients SET password_hash = ? WHERE id = ?').run(hash, row.client_id);
    // Revoke all active sessions for this client (force re-login)
    db.prepare('DELETE FROM sessions WHERE client_id = ?').run(row.client_id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[reset-password]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
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

// ── Daily logs ────────────────────────────────────────────────

// Client saves their own training or nutrition log for a date
app.post('/api/logs/:clientId', requireAuth, (req, res) => {
  const { clientId } = req.params;
  if (req.client.id !== clientId && req.client.role !== 'coach') {
    return res.status(403).json({ error: 'Acceso denegado' });
  }
  const { type, logDate, ...data } = req.body;
  if (!type || !logDate || !['training', 'nutrition'].includes(type)) {
    return res.status(400).json({ error: 'type (training|nutrition) y logDate son obligatorios' });
  }
  // Verify clientId belongs to a real client (not a coach)
  const target = getClientById(clientId);
  if (!target || target.role !== 'client') return res.status(404).json({ error: 'Cliente no encontrado' });
  saveLog(clientId, logDate, type, data);
  res.json({ ok: true });
});

// Get logs for a client (client sees own; coach sees any)
app.get('/api/logs/:clientId', requireAuth, (req, res) => {
  const { clientId } = req.params;
  if (req.client.id !== clientId && req.client.role !== 'coach') {
    return res.status(403).json({ error: 'Acceso denegado' });
  }
  const days = Math.min(Number(req.query.days) || 30, 365);
  res.json(getRecentLogs(clientId, days));
});

// Get a single log entry
app.get('/api/logs/:clientId/:date/:type', requireAuth, (req, res) => {
  const { clientId, date, type } = req.params;
  if (req.client.id !== clientId && req.client.role !== 'coach') {
    return res.status(403).json({ error: 'Acceso denegado' });
  }
  const log = getLog(clientId, date, type);
  res.json(log || null);
});

// ── Body-metrics check-ins ────────────────────────────────────

app.post('/api/checkins/:clientId', requireAuth, (req, res) => {
  const { clientId } = req.params;
  if (req.client.id !== clientId) return res.status(403).json({ error: 'Solo el cliente puede registrar sus métricas' });
  const { checkDate, weightKg, bodyFatPct, leanMassKg, notes } = req.body;
  if (!checkDate) return res.status(400).json({ error: 'checkDate es obligatorio' });
  saveCheckIn(clientId, checkDate, { weightKg, bodyFatPct, leanMassKg, notes });
  res.json({ ok: true });
});

app.get('/api/checkins/:clientId', requireAuth, (req, res) => {
  const { clientId } = req.params;
  if (req.client.id !== clientId && req.client.role !== 'coach') {
    return res.status(403).json({ error: 'Acceso denegado' });
  }
  res.json(getCheckIns(clientId));
});

// ── Coach API ─────────────────────────────────────────────────

app.get('/api/coach/clients', requireCoach, (req, res) => {
  const clients = listClients().filter(c => c.role === 'client');
  res.json(clients.map(c => ({
    id: c.id, name: c.name, initials: c.initials, email: c.email,
    goal: c.goal, currentWeek: c.currentWeek, totalWeeks: c.totalWeeks,
    adherence: getAdherenceSummary(c.id, 7),
  })));
});

// Send a single diagnostic email and return Resend's raw response (coach only)
app.post('/api/coach/test-email', requireCoach, async (req, res) => {
  const to = req.body?.to || req.client.email;
  try {
    const result = await sendTestEmail(to);
    res.json({ ok: true, result });
  } catch (err) {
    console.error('[test-email]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Manually trigger the daily reminder emails (for testing — coach only)
app.post('/api/coach/test-reminders', requireCoach, async (req, res) => {
  try {
    await sendDailyReminders();
    res.json({ ok: true, message: 'Reminder emails sent.' });
  } catch (err) {
    console.error('[test-reminders]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Full client profile (for coach profile panel)
app.get('/api/coach/clients/:clientId', requireCoach, (req, res) => {
  const client = getClientById(req.params.clientId);
  if (!client || client.role !== 'client') return res.status(404).json({ error: 'Cliente no encontrado' });
  res.json(client);
});

// Delete a client (coach only — clients only, never another coach)
app.delete('/api/coach/clients/:clientId', requireCoach, (req, res) => {
  const client = getClientById(req.params.clientId);
  if (!client || client.role !== 'client') return res.status(404).json({ error: 'Cliente no encontrado' });
  const ok = deleteClient(client.id);
  if (!ok) return res.status(500).json({ error: 'No se pudo eliminar el cliente' });
  console.log(`[coach] ${req.client.email} deleted client ${client.email}`);
  res.json({ ok: true });
});

app.post('/api/coach/chat', aiLimiter, requireCoach, async (req, res) => {
  const { messages = [] } = req.body;
  const coach = req.client;

  const today = new Date().toLocaleDateString('es-ES', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const nextMon = nextMondayStr();
  const clientList = listClients()
    .filter(c => c.role === 'client')
    .map((c, i) => `${i + 1}. ${sanitizeForPrompt(c.name, 60)} (id: ${c.id}) — ${sanitizeForPrompt(c.goal, 60)}, Semana ${c.currentWeek}/${c.totalWeeks}`)
    .join('\n') || '(Sin clientes todavía)';

  const specialtyLabel = coach.specialty === 'training' ? 'entrenamiento' : 'nutrición';
  const systemPrompt = `Eres ${coach.name}, coach de ${specialtyLabel} en DARE.
Hoy es ${today}. La próxima semana empieza el lunes ${nextMon}.

CLIENTES ACTIVOS:
${clientList}

FLUJO PARA CREAR UN PLAN:
1. Cuando el coach pida un plan, confirma brevemente: cliente y semana (lunes en formato YYYY-MM-DD).
2. CONFIRMA REQUISITOS antes de seguir (ver abajo). No avances con datos ambiguos.
3. Cuando cliente, semana y requisitos estén claros, llama INMEDIATAMENTE a show_plan_template — NUNCA escribas una plantilla de texto.
4. El coach rellenará la tabla interactiva que aparecerá en el chat.
5. Cuando el coach diga que ya guardó o que necesita algo más, responde con normalidad.

CONFIRMA REQUISITOS (paso 2) — nunca generes con información incompleta o ambigua:
${coach.specialty === 'nutrition'
  ? `• Alergias e intolerancias\n• Objetivo de calorías y proteína (o meta: déficit, mantenimiento, volumen)\n• Preferencias y alimentos a evitar\n• Nº de comidas al día y restricciones (religiosas, viajes, cenas fuera)`
  : `• Objetivo de la semana (fuerza, hipertrofia, acondicionamiento…)\n• Días disponibles y días de descanso\n• Lesiones o limitaciones de movimiento\n• Material / gimnasio disponible`}
Si falta algún punto o hay ambigüedad, haz UNA sola pregunta breve y concreta para cerrarlo. Solo cuando todo esté claro, muestra la tabla.

OTRAS FUNCIONES:
- Añadir una nota a un plan ya creado: usa add_plan_note (no regenera el plan)
- Crear cliente: usa create_client (nombre, email, objetivo, semanas totales)
- Resetear contraseña: usa reset_client_password
- Responde en español. Tono profesional y cercano. Respuestas concisas.`;

  const toFn = t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } });
  const tools = [
    toFn(SHOW_TEMPLATE_TOOL),
    toFn(coach.specialty === 'training' ? TRAINING_TOOL : NUTRITION_TOOL),
    toFn(ADD_NOTE_TOOL),
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
      try {
        savePlan(toolName, toolInput);
        action = { type: 'plan_saved', toolName, weekOf: toolInput.weekOf, clientId: toolInput.clientId };
        toolResultContent = JSON.stringify({ success: true, weekOf: toolInput.weekOf, clientId: toolInput.clientId });
      } catch (err) {
        if (!(err instanceof PlanValidationError)) throw err;
        // Hand the validation errors back to the model so it can ask the coach
        // to complete the missing fields instead of silently failing.
        action = null;
        toolResultContent = JSON.stringify({ success: false, error: 'Plan incompleto', missing: err.errors });
      }
    } else if (toolName === 'create_client') {
      const { client, generatedPassword } = await createClient(toolInput);
      action = { type: 'client_created', client, password: generatedPassword };
      toolResultContent = JSON.stringify({ success: true, name: client.name, email: client.email, password: generatedPassword });
      sendWelcomeNotifications(client, generatedPassword).catch(err =>
        console.error('[notifier] welcome notifications failed:', err.message)
      );
    } else if (toolName === 'add_plan_note') {
      try {
        appendPlanNote(toolInput.clientId, toolInput.weekOf, toolInput.note, coach.name || 'coach');
        action = { type: 'note_added', clientId: toolInput.clientId, weekOf: toolInput.weekOf };
        toolResultContent = JSON.stringify({ success: true, clientId: toolInput.clientId, weekOf: toolInput.weekOf });
      } catch (err) {
        if (!(err instanceof PlanValidationError)) throw err;
        action = null;
        toolResultContent = JSON.stringify({ success: false, error: err.message });
      }
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

// Strip characters that could break out of the JSON/prompt structure we build
// for the OpenAI calls (defends against prompt injection via coach input).
function sanitizeForPrompt(value, maxLen = 300) {
  return String(value ?? '')
    .replace(/[{}"\\\n\r\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

app.post('/api/coach/save-plan-table', aiLimiter, requireCoach, async (req, res) => {
  try {
    const { specialty, clientId, weekOf, days } = req.body;
    if (!specialty || !clientId || !weekOf || !Array.isArray(days)) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Ensure clientId is a real client (not a coach or non-existent user)
    const targetClient = getClientById(clientId);
    if (!targetClient || targetClient.role !== 'client') {
      return res.status(400).json({ error: 'Invalid clientId' });
    }

    if (specialty === 'nutrition') {
      // Collect days with daily macros and meal dishes
      const daysForAI = [];
      days.forEach((d, di) => {
        const meals = (d.meals || []).filter(m => m.dishes).map((m, mi) => ({
          id: mi,
          name: sanitizeForPrompt(m.name, 60),
          time: sanitizeForPrompt(m.time, 10),
          dishes: sanitizeForPrompt(m.dishes, 300),
        }));
        if (meals.length > 0) {
          daysForAI.push({
            dayId: di, label: sanitizeForPrompt(d.label, 40),
            kcal: Number(d.kcal)||0, protein: Number(d.protein)||0,
            carbs: Number(d.carbs)||0, fat: Number(d.fat)||0,
            meals, note: sanitizeForPrompt(d.note, 500),
          });
        }
      });

      // Single AI call: calculate ingredient distribution across 5 meals to hit daily macros
      let aiResult = { days: [], notes: {} };
      if (daysForAI.length > 0) {
        const aiResp = await openai.chat.completions.create({
          model: 'gpt-4o-mini', max_tokens: 5000,
          response_format: { type: 'json_object' },
          messages: [{ role: 'user', content: `You are a nutrition planning expert. For each day, you receive:
- Daily macros target: kcal, protein (g), carbs (g), fat (g)
- 5 meal slots with dish names (e.g., "grilled chicken breast, brown rice, broccoli")

Your task:
1. For each dish, identify the main ingredients
2. Calculate ingredient quantities (raw, uncooked) to hit the daily macros EXACTLY
3. Distribute those ingredients logically across the 5 meals (e.g., don't put all protein at breakfast)
4. For each meal, list: ingredients with quantities, macros (protein/carbs/fat), kcal, and 3-4 preparation steps
5. Create a complete shopping list for the day with all quantities in grams or units

IMPORTANT: All calculations use RAW/UNCOOKED ingredient values. Ensure meal distribution is realistic and balanced.

DAYS:
${daysForAI.map(day => `
day_id=${day.dayId} label="${day.label}" target_kcal=${day.kcal} target_protein=${day.protein}g target_carbs=${day.carbs}g target_fat=${day.fat}g note="${day.note}"
meals=[${day.meals.map(m => `{id:${m.id},name:"${m.name}",time:"${m.time}",dishes:"${m.dishes}"}`).join(',')}]
`).join('\n')}

Return ONLY this JSON structure:
{
  "days": [
    {
      "dayId": 0,
      "meals": [
        {
          "id": 0,
          "name": "Breakfast",
          "time": "08:00",
          "ingredients": "2 eggs, 50g oats, 200ml milk, 1 banana",
          "protein": 22,
          "carbs": 48,
          "fat": 12,
          "kcal": 380,
          "steps": ["Boil the eggs...", "Cook the oats...", "Combine and serve"]
        }
      ],
      "dayTotals": {
        "protein": 160,
        "carbs": 220,
        "fat": 70,
        "kcal": 2100
      },
      "shopping": [
        {"item": "Eggs (large)", "qty": "18"},
        {"item": "Oats (raw)", "qty": "350g"},
        {"item": "Whole milk", "qty": "1.4L"},
        {"item": "Bananas", "qty": "7"}
      ]
    }
  ]
}` }],
        });
        try { aiResult = JSON.parse(aiResp.choices[0].message.content); } catch(e) { console.error('[AI parse]', e); }
      }

      const aiDays = {};
      (aiResult.days || []).forEach(d => { aiDays[d.dayId] = d; });

      const toolInput = {
        clientId, weekOf,
        days: days.map((d, di) => {
          const aiDay = aiDays[di] || {};
          const aiMeals = (aiDay.meals || []).reduce((acc, m) => { acc[m.id] = m; return acc; }, {});

          const processedMeals = (d.meals || []).filter(m => m.dishes).map((m, mi) => {
            const ai = aiMeals[mi] || {};
            return {
              time: m.time || ['08:00','11:00','14:00','17:00','20:30'][mi],
              name: m.name,
              desc: ai.ingredients || m.dishes,
              kcal: ai.kcal || 0,
              protein: ai.protein || 0,
              carbs: ai.carbs || 0,
              fat: ai.fat || 0,
              steps: ai.steps || [m.dishes],
              shopping: mi === 0 ? (aiDay.shopping || []) : [], // Shopping list only on first meal
            };
          });

          return {
            label: d.label || ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][di],
            kcal: Number(d.kcal) || 0,
            protein: Number(d.protein) || 0,
            carbs: Number(d.carbs) || 0,
            fat: Number(d.fat) || 0,
            note: d.note || '',
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
          if (e.name) exsForAI.push({
            id: `${di}-${ei}`,
            name: sanitizeForPrompt(e.name, 80),
            setsReps: sanitizeForPrompt(e.setsReps, 40),
            notes: sanitizeForPrompt(e.notes, 200),
          });
        });
      });
      const notesForAI = days
        .map((d, di) => ({ id: di, raw: sanitizeForPrompt(d.note, 500) }))
        .filter(n => n.raw);

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
    if (err instanceof PlanValidationError) {
      // 422: the table is missing required data — tell the coach exactly what.
      const head = err.errors.slice(0, 4).join('; ');
      const more = err.errors.length > 4 ? ` (+${err.errors.length - 4} más)` : '';
      return res.status(422).json({ error: `Plan incompleto: ${head}${more}`, missing: err.errors });
    }
    console.error('[save-plan-table]', err);
    res.status(500).json({ error: 'Error saving plan' });
  }
});

// ── Plan editing (coach) ──────────────────────────────────────

function ensureClient(clientId, res) {
  const target = getClientById(clientId);
  if (!target || target.role !== 'client') {
    res.status(404).json({ error: 'Cliente no encontrado' });
    return null;
  }
  return target;
}

function handlePlanError(err, res, context, fallback) {
  if (err instanceof PlanValidationError) {
    return res.status(422).json({ error: err.message, missing: err.errors });
  }
  console.error(context, err);
  return res.status(500).json({ error: fallback });
}

// Edit a single day of an existing plan half.
// body: { specialty:'training'|'nutrition', dayIndex:0-6, day:{…} }
app.post('/api/coach/plans/:clientId/:weekOf/day', aiLimiter, requireCoach, (req, res) => {
  const { clientId, weekOf } = req.params;
  const { specialty, dayIndex, day } = req.body;
  if (!['training', 'nutrition'].includes(specialty)) return res.status(400).json({ error: 'specialty inválido' });
  if (!ensureClient(clientId, res)) return;
  try {
    const plan = updatePlanDay(clientId, weekOf, specialty, Number(dayIndex), day);
    res.json({ success: true, weekOf, clientId, dayIndex: Number(dayIndex), shoppingList: plan.shoppingList || null });
  } catch (err) {
    handlePlanError(err, res, '[plans/day]', 'Error al actualizar el día');
  }
});

// Overwrite a full week half (training or nutrition) — validated as complete.
// body: { specialty, days:[7] }
app.post('/api/coach/plans/:clientId/:weekOf/overwrite', aiLimiter, requireCoach, (req, res) => {
  const { clientId, weekOf } = req.params;
  const { specialty, days } = req.body;
  if (!['training', 'nutrition'].includes(specialty)) return res.status(400).json({ error: 'specialty inválido' });
  if (!Array.isArray(days)) return res.status(400).json({ error: 'days es obligatorio' });
  if (!ensureClient(clientId, res)) return;
  const toolName = specialty === 'training' ? 'save_training_plan' : 'save_nutrition_plan';
  try {
    const plan = savePlan(toolName, { clientId, weekOf, days });
    res.json({ success: true, weekOf, clientId, shoppingList: plan.shoppingList || null });
  } catch (err) {
    handlePlanError(err, res, '[plans/overwrite]', 'Error al sobrescribir la semana');
  }
});

// Append a free-form note to a plan after creation.  body: { note }
app.post('/api/coach/plans/:clientId/:weekOf/note', requireCoach, (req, res) => {
  const { clientId, weekOf } = req.params;
  if (!ensureClient(clientId, res)) return;
  try {
    const plan = appendPlanNote(clientId, weekOf, req.body?.note, req.client.name || 'coach');
    res.json({ success: true, notes: plan.notes });
  } catch (err) {
    handlePlanError(err, res, '[plans/note]', 'Error al añadir la nota');
  }
});

// Weekly shopping list (client sees own; coach sees any). Computed at save;
// recomputed on the fly for legacy plans saved before the feature existed.
app.get('/api/plans/:clientId/week/:weekOf/shopping', requireAuth, (req, res) => {
  if (req.client.id !== req.params.clientId && req.client.role !== 'coach') {
    return res.status(403).json({ error: 'Acceso denegado' });
  }
  const plan = getPlanByWeek(req.params.clientId, req.params.weekOf);
  if (!plan) return res.status(404).json({ error: 'Semana no encontrada' });
  const shoppingList = plan.shoppingList || (plan.nutrition ? buildWeeklyShoppingList(plan.nutrition) : null);
  if (!shoppingList) return res.status(404).json({ error: 'Sin lista de la compra para esta semana' });
  res.json(shoppingList);
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
    { name: 'Erika Silva', email: process.env.ERIKA_EMAIL || 'silvaepao@gmail.com',  password: process.env.ERIKA_PASSWORD, specialty: 'training' },
    { name: 'Dani Otero',  email: process.env.DANI_EMAIL  || 'daniotero15@gmail.com', password: process.env.DANI_PASSWORD,  specialty: 'nutrition' },
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
    // No literal fallback: if the password env var is missing, createClient
    // generates a strong random one which we log once so it can be rotated.
    const { generatedPassword } = await createClient({
      name: c.name, email: c.email, specialty: c.specialty,
      password: c.password || undefined,
      goal: 'Coach', totalWeeks: 99, role: 'coach',
    });
    if (c.password) {
      console.log(`[seed] Coach created — ${c.email}`);
    } else {
      console.warn(`[seed] Coach created — ${c.email}. No password env set; temporary password: ${generatedPassword}`);
    }
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
  scheduleDailyReminders();
});
