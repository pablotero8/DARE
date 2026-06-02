import { CHAT_MODEL, NUTRITION_MODEL, TRAINING_MODEL } from './env.js';
import express from 'express';
import rateLimit from 'express-rate-limit';
import OpenAI from 'openai';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getLatestPlan, getPlanByWeek, listPlanWeeks, seedPlan, savePlan, updatePlanDay, appendPlanNote } from './planner.js';
import { PlanValidationError } from './validators.js';
import { shoppingListForPlan } from './shopping.js';
import { listRecipes, listRecipesGrouped, backfillRecipesIfEmpty } from './recipes.js';
import {
  verifyClientPassword, getClientById, getClientByEmail,
  listClients, createClient, deleteClient, resetClientPassword, updateClient,
} from './clients.js';
import { signToken, verifyToken, persistSession, revokeSession, isSessionValid } from './auth.js';
import { TRAINING_TOOL, NUTRITION_TOOL, CREATE_CLIENT_TOOL, RESET_PASSWORD_TOOL, SHOW_TEMPLATE_TOOL, ADD_NOTE_TOOL, FILL_NUTRITION_FROM_TEXT_TOOL } from './tools.js';
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
  if (!plan.shoppingList) plan.shoppingList = shoppingListForPlan(plan); // legacy plans
  res.json(plan);
});

app.get('/api/plans/:clientId/week/:weekOf', requireAuth, (req, res) => {
  if (req.client.id !== req.params.clientId && req.client.role !== 'coach') {
    return res.status(403).json({ error: 'Acceso denegado' });
  }
  const plan = getPlanByWeek(req.params.clientId, req.params.weekOf);
  if (!plan) return res.status(404).json({ error: 'Semana no encontrada' });
  if (!plan.shoppingList) plan.shoppingList = shoppingListForPlan(plan); // legacy plans
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

// Build the 7-day scaffold (Spanish display label + short Mon–Sun label + full
// English date) for a week starting at weekOf. Shared by show_plan_template and
// fill_nutrition_from_text so both render the same interactive table structure.
function buildTemplateDays(weekOf) {
  const dayNames = ['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo'];
  const shortLabels = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const months = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekOf + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + i);
    const fullDateEn = d.toLocaleDateString('en-GB', {
      weekday:'long', day:'numeric', month:'long', year:'numeric', timeZone:'UTC'
    });
    return {
      label: `${dayNames[i]} ${d.getUTCDate()} ${months[d.getUTCMonth()]}`,
      shortLabel: shortLabels[i],
      fullDate: fullDateEn,
    };
  });
}

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
  const pasteFlow = coach.specialty === 'nutrition' ? `

SI EL COACH PEGA UN PLAN SEMANAL EN TEXTO (varios días con sus comidas):
- Llama a fill_nutrition_from_text para parsearlo y rellenar la tabla automáticamente (necesitas cliente y semana, igual que con show_plan_template).
- Mapea cada comida a su hueco: Desayuno→breakfast, media mañana/almuerzo→morningSnack, Comida→lunch, Merienda/Snack→snack, Cena→dinner.
- Combina los alimentos de cada comida en un solo texto y TRADÚCELOS AL INGLÉS.
- NO inventes macros (kcal/proteína/carbos/grasa): el coach los añade a mano en la tabla.` : '';
  const systemPrompt = `Eres ${coach.name}, coach de ${specialtyLabel} en DARE.
Hoy es ${today}. La próxima semana empieza el lunes ${nextMon}.

CLIENTES ACTIVOS:
${clientList}

FLUJO PARA CREAR UN PLAN:
1. Cuando el coach pida un plan, confirma brevemente cliente y semana (lunes en formato YYYY-MM-DD).
2. En cuanto tengas cliente y semana, llama INMEDIATAMENTE a show_plan_template — NUNCA escribas una plantilla de texto.
3. NO preguntes por alergias, objetivos, macros, preferencias ni restricciones: el coach rellena todo eso directamente en la tabla. Tú solo muestra la tabla.
4. Cuando el coach diga que ya guardó o que necesita algo más, responde con normalidad.${pasteFlow}

OTRAS FUNCIONES:
- Añadir una nota a un plan ya creado: usa add_plan_note (no regenera el plan)
- Crear cliente: usa create_client (nombre, email, objetivo, semanas totales)
- Resetear contraseña: usa reset_client_password
- Responde en español. Tono profesional y cercano. Respuestas concisas.`;

  const toFn = t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } });
  const tools = [
    toFn(SHOW_TEMPLATE_TOOL),
    toFn(coach.specialty === 'training' ? TRAINING_TOOL : NUTRITION_TOOL),
    ...(coach.specialty === 'nutrition' ? [toFn(FILL_NUTRITION_FROM_TEXT_TOOL)] : []),
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
      model: CHAT_MODEL, max_tokens: 4096,
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
      const days = buildTemplateDays(toolInput.weekOf);
      action = { type: 'show_template', specialty: coach.specialty, clientId: toolInput.clientId, weekOf: toolInput.weekOf, clientName: toolInput.clientName, days };
      toolResultContent = JSON.stringify({ success: true, message: 'Tabla interactiva mostrada al coach.' });
    } else if (toolName === 'fill_nutrition_from_text') {
      // Parsed a pasted weekly plan: render the same nutrition table but with the
      // dishes pre-filled. Macros are left blank for the coach to add by hand.
      const days = buildTemplateDays(toolInput.weekOf);
      const parsedByLabel = {};
      (toolInput.days || []).forEach(d => { if (d?.label) parsedByLabel[d.label] = d; });
      let filled = 0;
      days.forEach(day => {
        const parsed = parsedByLabel[day.shortLabel];
        if (!parsed) return;
        if (parsed.meals && typeof parsed.meals === 'object') { day.meals = parsed.meals; filled++; }
        if (typeof parsed.note === 'string' && parsed.note.trim()) day.note = parsed.note.trim();
      });
      action = { type: 'show_template', specialty: 'nutrition', prefilled: true, clientId: toolInput.clientId, weekOf: toolInput.weekOf, clientName: toolInput.clientName, days };
      toolResultContent = JSON.stringify({ success: true, message: 'Plan parseado y tabla pre-rellenada.', daysFilled: filled });
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
      model: CHAT_MODEL, max_tokens: 512,
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

// ── Per-day macro engine ──────────────────────────────────────
// Sizes the coach's foods (in grams) so the day's totals hit the macro targets,
// protein-priority and within 2%. Called once PER DAY in parallel. A
// deterministic check (checkDayTotals) audits the model's arithmetic and
// triggers ONE corrective re-prompt when it drifts off target.

const MACRO_TOLERANCE = 0.02; // max 2% deviation per macro (coaching spec)

// Sum the per-meal macros into a day total. Source of truth for verification —
// we never trust the model's own "totals", we recompute from the meals.
function sumMealMacros(meals) {
  return (meals || []).reduce((t, m) => ({
    protein: t.protein + (Number(m.protein) || 0),
    carbs:   t.carbs   + (Number(m.carbs)   || 0),
    fat:     t.fat     + (Number(m.fat)     || 0),
    kcal:    t.kcal    + (Number(m.kcal)    || 0),
  }), { protein: 0, carbs: 0, fat: 0, kcal: 0 });
}

// Compare achieved totals to targets. Returns the macros that drift > 2% and a
// flag for protein landing below target (never allowed). Macros with no target
// (0) are not constrained.
function checkDayTotals(targets, totals) {
  const off = [];
  for (const k of ['kcal', 'protein', 'carbs', 'fat']) {
    const target = Number(targets[k]) || 0;
    if (target <= 0) continue;
    const achieved = Number(totals[k]) || 0;
    const pct = Math.abs(achieved - target) / target;
    if (pct > MACRO_TOLERANCE) off.push({ macro: k, achieved: Math.round(achieved), target, pct });
  }
  const pTarget = Number(targets.protein) || 0;
  const proteinShort = pTarget > 0 && (Number(totals.protein) || 0) < pTarget * (1 - MACRO_TOLERANCE);
  return { ok: off.length === 0 && !proteinShort, off, proteinShort };
}

const NUTRITION_RULES = `MANDATORY RULES:
1. Use ONLY the foods the coach listed for each meal — never add or remove foods.
2. Assign an EXACT raw/uncooked gram (or unit) quantity to every food so the SUM of all meals meets the daily targets.
3. PROTEIN IS THE PRIORITY: the day must NEVER end below the protein target. Hit protein first, then calories, then carbs, then fat.
4. Do NOT spread equal amounts across meals if that misses the targets. Accuracy beats even distribution beats variety.
5. Every macro and the calorie total must land within 2% of its target.
6. Compute each food's macros from standard nutrition values; a meal's macros are the sum of its foods; the day is the sum of its meals.
7. Before returning, ADD UP all meals and check against the targets. If any macro or kcal is off by more than 2% (or protein is below target), re-scale the grams and recompute until it fits.`;

function nutritionDayPrompt(day) {
  return `You are a precision nutrition planner. Process ONE day for a client.

DAILY TARGETS (the sum of all meals MUST match these within 2%):
calories=${day.kcal} kcal · protein=${day.protein} g · carbs=${day.carbs} g · fat=${day.fat} g
Day note (context only): "${day.note}"

MEALS (${day.meals.length}) — use exactly these foods, in these slots:
${day.meals.map(m => `{id:${m.id}, name:"${m.name}", time:"${m.time}", foods:"${m.dishes}"}`).join('\n')}

${NUTRITION_RULES}

For EACH meal: write the foods WITH their exact grams into "ingredients" (e.g. "150g chicken breast, 80g white rice, 100g broccoli"), give the meal's protein/carbs/fat (grams) and kcal, and 3-4 clear preparation steps. Then return the day "totals" and a "shopping" list aggregating every food with its quantity.

Return ONLY this JSON, including ALL ${day.meals.length} meals (one object per slot id):
{
  "meals": [
    {"id":0,"name":"Breakfast","time":"08:00","ingredients":"150g eggs, 60g oats, 100g berries","protein":35,"carbs":48,"fat":18,"kcal":520,"steps":["...","..."]}
  ],
  "totals": {"protein":160,"carbs":220,"fat":70,"kcal":2100},
  "shopping": [{"item":"Eggs","qty":"150g"},{"item":"Oats (raw)","qty":"60g"}]
}`;
}

async function callNutritionModel(content) {
  const resp = await openai.chat.completions.create({
    model: NUTRITION_MODEL, max_tokens: 2400,
    response_format: { type: 'json_object' },
    messages: [{ role: 'user', content }],
  });
  const parsed = JSON.parse(resp.choices[0].message.content);
  return {
    meals: Array.isArray(parsed.meals) ? parsed.meals : [],
    shopping: Array.isArray(parsed.shopping) ? parsed.shopping : [],
  };
}

async function computeNutritionDay(day) {
  try {
    let { meals, shopping } = await callNutritionModel(nutritionDayPrompt(day));
    let totals = sumMealMacros(meals);
    let check = checkDayTotals(day, totals);

    // One deterministic correction pass: feed the exact drift back and re-scale.
    if (!check.ok && meals.length > 0) {
      const drift = [
        `calories: ${Math.round(totals.kcal)} vs target ${day.kcal}`,
        `protein: ${Math.round(totals.protein)} vs target ${day.protein}${check.proteinShort ? '  ← BELOW target, must increase' : ''}`,
        `carbs: ${Math.round(totals.carbs)} vs target ${day.carbs}`,
        `fat: ${Math.round(totals.fat)} vs target ${day.fat}`,
      ].join('\n');
      try {
        const corrected = await callNutritionModel(`${nutritionDayPrompt(day)}

A previous attempt produced these totals, which are OUT OF TOLERANCE:
${drift}

Re-scale the gram quantities of the SAME foods so every macro and the calorie total land within 2% of target, keeping protein at or above target. Recompute every meal and the day totals, then return the corrected JSON in the same shape.`);
        if (corrected.meals.length > 0) {
          const newTotals = sumMealMacros(corrected.meals);
          const newCheck = checkDayTotals(day, newTotals);
          // Accept the correction only if it's genuinely better.
          if (newCheck.ok || (!newCheck.proteinShort && newCheck.off.length <= check.off.length)) {
            meals = corrected.meals;
            shopping = corrected.shopping.length ? corrected.shopping : shopping;
            totals = newTotals; check = newCheck;
          }
        }
      } catch (e) {
        console.error('[AI nutrition correction]', day.dayId, e.message);
      }
    }

    if (!check.ok) {
      const detail = check.off.map(o => `${o.macro} ${o.achieved}/${o.target}`).join(', ') || (check.proteinShort ? 'protein below target' : '');
      console.warn(`[nutrition] day ${day.dayId} still off target: ${detail}`);
    }
    return { meals, shopping, totals, ok: check.ok };
  } catch (e) {
    console.error('[AI nutrition day]', day.dayId, e.message);
    return { meals: [], shopping: [], totals: { protein: 0, carbs: 0, fat: 0, kcal: 0 }, ok: false };
  }
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

    let verification = null; // nutrition only: per-day achieved-vs-target macro check

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

      // One AI call PER DAY, in parallel — guarantees every day Mon–Sun gets
      // per-meal ingredients/macros. (A single call across all 7 days was
      // unreliable: gpt-4o-mini often returned only the first day.)
      const aiDays = {};
      await Promise.all(daysForAI.map(async (day) => {
        aiDays[day.dayId] = await computeNutritionDay(day);
      }));

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
              dishName: m.dishes, // raw coach input — used as the clean reusable recipe name
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

      // Per-day macro verification (achieved vs target) for the coach's confirmation.
      verification = toolInput.days
        .filter(d => d.meals.length > 0 && d.kcal > 0)
        .map(d => {
          const totals = sumMealMacros(d.meals);
          const chk = checkDayTotals(d, totals);
          return {
            label: d.label, ok: chk.ok,
            targets: { kcal: d.kcal, protein: d.protein, carbs: d.carbs, fat: d.fat },
            totals: {
              kcal: Math.round(totals.kcal), protein: Math.round(totals.protein),
              carbs: Math.round(totals.carbs), fat: Math.round(totals.fat),
            },
          };
        });

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
          model: TRAINING_MODEL, max_tokens: 3000,
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

    res.json({ success: true, weekOf, clientId, verification });
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
  const shoppingList = plan.shoppingList || shoppingListForPlan(plan);
  if (!shoppingList) return res.status(404).json({ error: 'Sin lista de la compra para esta semana' });
  res.json(shoppingList);
});

// ── Recipe library (coach) ────────────────────────────────────
// Powers the "reuse previous recipe" dropdown per meal slot in the plan table.
// ?mealType=Breakfast → list for that slot; omitted → grouped by meal type.
app.get('/api/coach/recipes', requireCoach, (req, res) => {
  try {
    const { mealType } = req.query;
    res.json(mealType ? { mealType, recipes: listRecipes(mealType) } : { grouped: listRecipesGrouped() });
  } catch (err) {
    console.error('[recipes]', err);
    res.status(500).json({ error: 'Error al cargar recetas' });
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
          { time: '08:00', name: 'Breakfast', desc: 'Eggs & oats', kcal: 450, steps: ['Cook oats', 'Scramble eggs'],
            ingredients: [{ item: 'Eggs', qty: 3, unit: 'unit' }, { item: 'Oats', qty: 60, unit: 'g' }, { item: 'Milk', qty: 200, unit: 'ml' }] },
          { time: '13:00', name: 'Lunch',     desc: 'Chicken & rice', kcal: 680, steps: ['Grill chicken', 'Cook rice'],
            ingredients: [{ item: 'Chicken breast', qty: 200, unit: 'g' }, { item: 'Brown rice', qty: 80, unit: 'g' }, { item: 'Broccoli', qty: 150, unit: 'g' }] },
          { time: '20:00', name: 'Dinner',    desc: 'Salmon & veg', kcal: 560, steps: ['Pan-fry salmon', 'Steam veg'],
            ingredients: [{ item: 'Salmon fillet', qty: 180, unit: 'g' }, { item: 'Asparagus', qty: 120, unit: 'g' }, { item: 'Olive oil', qty: 10, unit: 'ml' }] },
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
      // Refresh stale demo seeds that predate the shopping-list feature (no
      // derivable ingredient data), but never clobber a real saved plan.
      const existing = getPlanByWeek(clientId, weekOf);
      const isStaleSeed = existing && !shoppingListForPlan(existing);
      if (existing && !isStaleSeed) { console.log(`[seed] Plan exists — ${weekOf}`); continue; }
      seedPlan(clientId, weekOf, buildDemoWeek(weekOf), { force: isStaleSeed });
      console.log(`[seed] Plan ${isStaleSeed ? 're-seeded' : 'seeded'} — ${weekOf}`);
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
  backfillRecipesIfEmpty();
  scheduleDailyReminders();
});
