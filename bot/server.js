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
import { listExercises } from './exercises.js';
import {
  verifyClientPassword, getClientById, getClientByEmail,
  listClients, createClient, deleteClient, resetClientPassword, updateClient,
  touchLastSeen, isRecentlyActive,
} from './clients.js';
import { signToken, verifyToken, persistSession, revokeSession, isSessionValid, passwordPolicyError, verifyPassword, hashPassword } from './auth.js';
import { TRAINING_TOOL, NUTRITION_TOOL, CREATE_CLIENT_TOOL, RESET_PASSWORD_TOOL, SHOW_TEMPLATE_TOOL, ADD_NOTE_TOOL, FILL_NUTRITION_FROM_TEXT_TOOL, PREFILL_PLAN_TABLE_TOOL } from './tools.js';
import { saveLog, getLog, getRecentLogs, getAdherenceSummary, saveCheckIn, getCheckIns } from './logs.js';
import { addMessage, getThread, markRead, unreadCount, unreadByClientForCoach } from './messages.js';
import { sendPasswordReset } from './mailer.js';
import { sendWelcomeNotifications, sendTestEmail, sendWelcomeEmail, sendNewMessageEmail, sendPlanReadyEmail } from './notifier.js';
import { createContractForClient, getLatestContractForClient, generateContractPdf } from './contract.js';
import { generatePlanPdf } from './planPdf.js';
import { scheduleDailyBackups, runBackup, latestBackupPath } from './backup.js';
import {
  fitbitConfigured, buildAuthUrl as buildFitbitAuthUrl, handleCallback as handleFitbitCallback,
  getStatus as fitbitStatus, getSummary as getFitbitSummary, disconnect as disconnectFitbit,
} from './fitbit.js';
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

const APP_ORIGIN = (process.env.APP_URL || 'https://darehabits.com').replace(/\/$/, '');
const IS_PROD = process.env.NODE_ENV === 'production';

// Force HTTPS behind the Railway proxy + security headers on every response.
app.use((req, res, next) => {
  if (IS_PROD && req.headers['x-forwarded-proto'] === 'http') {
    return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
  }
  if (IS_PROD) res.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.header('X-Content-Type-Options', 'nosniff');
  res.header('X-Frame-Options', 'DENY');
  res.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// CORS allowlist. darehabits.com (+ www) and this Railway app are the same
// deployment, so requests are same-origin in practice — this allowlist is a
// defensive backstop, not a required cross-origin bridge.
const ALLOWED_ORIGINS = new Set([
  APP_ORIGIN,
  'https://darehabits.com',
  'https://www.darehabits.com',
  'https://dare-production-2636.up.railway.app',
]);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Static files — never serve server code, runtime data or database files.
app.use('/bot', (req, res) => res.status(404).end());
app.use('/data', (req, res) => res.status(404).end());
app.use((req, res, next) => {
  if (/\.(db|db-shm|db-wal|sqlite|env)$/i.test(req.path)) return res.status(404).end();
  next();
});
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
  touchLastSeen(client.id); // marks them "active in portal" for message notifications
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
    const baseUrl  = process.env.APP_URL || 'https://darehabits.com';
    const resetUrl = `${baseUrl}/reset.html?token=${token}`;
    await sendPasswordReset(client.email, client.name, resetUrl);
    console.log(`[reset] Sent password reset to ${client.email}`);
  } catch (err) {
    console.error('[forgot-password]', err.message);
  }
});

app.post('/api/auth/reset-password', loginLimiter, async (req, res) => {
  const { token, password } = req.body || {};
  if (!token) return res.status(400).json({ error: 'Token is required.' });
  const policyErr = passwordPolicyError(password);
  if (policyErr) return res.status(400).json({ error: policyErr });
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
      consentRequired: client.role === 'client' && !client.healthConsentAt,
    },
  });
});

// Change own password (any logged-in user). Requires the current password,
// enforces the password policy and revokes every other active session.
app.post('/api/auth/change-password', loginLimiter, requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword) return res.status(400).json({ error: 'La contraseña actual es obligatoria.' });
  const policyErr = passwordPolicyError(newPassword);
  if (policyErr) return res.status(400).json({ error: policyErr });
  try {
    const verified = await verifyClientPassword(req.client.email, currentPassword);
    if (!verified) return res.status(401).json({ error: 'La contraseña actual no es correcta.' });
    const db = (await import('./db.js')).default;
    const hash = await hashPassword(newPassword);
    db.prepare('UPDATE clients SET password_hash = ? WHERE id = ?').run(hash, req.client.id);
    // Keep this session alive, kill the rest.
    db.prepare('DELETE FROM sessions WHERE client_id = ? AND token != ?').run(req.client.id, req.token);
    res.json({ ok: true });
  } catch (err) {
    console.error('[change-password]', err.message);
    res.status(500).json({ error: 'No se pudo cambiar la contraseña.' });
  }
});

// Explicit GDPR consent for processing health data (art. 9.2.a). Recorded with
// timestamp + policy version. The client portal blocks usage until accepted.
const PRIVACY_POLICY_VERSION = '2026-07-10';
app.post('/api/auth/consent', requireAuth, async (req, res) => {
  if (req.body?.accept !== true) return res.status(400).json({ error: 'Consent must be explicitly accepted.' });
  const db = (await import('./db.js')).default;
  db.prepare("UPDATE clients SET health_consent_at = datetime('now'), health_consent_version = ? WHERE id = ?")
    .run(PRIVACY_POLICY_VERSION, req.client.id);
  res.json({ ok: true, version: PRIVACY_POLICY_VERSION });
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
    consentRequired: c.role === 'client' && !c.healthConsentAt,
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

// ── Fitbit integration ────────────────────────────────────────
// Each client links their own Fitbit account via OAuth (see bot/fitbit.js).
// Coaches may read a client's summary — the same access model as check-ins.

app.get('/api/fitbit/status', requireAuth, (req, res) => {
  res.json(fitbitStatus(req.client.id));
});

app.post('/api/fitbit/connect', requireAuth, (req, res) => {
  if (!fitbitConfigured()) return res.status(503).json({ error: 'Fitbit no está configurado' });
  try {
    res.json({ url: buildFitbitAuthUrl(req.client.id) });
  } catch (err) {
    console.error('[fitbit] connect:', err.message);
    res.status(500).json({ error: 'No se pudo iniciar la conexión con Fitbit' });
  }
});

// Unauthenticated by design: the browser lands here redirected from
// fitbit.com. The signed single-use `state` row maps back to the client.
app.get('/api/fitbit/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code || !state) return res.redirect('/client.html?fitbit=denied');
  try {
    await handleFitbitCallback(String(code), String(state));
    res.redirect('/client.html?fitbit=connected');
  } catch (err) {
    console.error('[fitbit] callback:', err.message);
    res.redirect('/client.html?fitbit=error');
  }
});

app.get('/api/fitbit/summary/:clientId', requireAuth, async (req, res) => {
  const { clientId } = req.params;
  if (req.client.id !== clientId && req.client.role !== 'coach') {
    return res.status(403).json({ error: 'Acceso denegado' });
  }
  if (!fitbitConfigured()) return res.json({ configured: false, connected: false, data: null });
  try {
    const data = await getFitbitSummary(clientId);
    res.json({ configured: true, connected: data !== null, data });
  } catch (err) {
    console.error('[fitbit] summary:', err.message);
    res.status(502).json({ error: 'No se pudieron obtener los datos de Fitbit' });
  }
});

app.delete('/api/fitbit/disconnect', requireAuth, async (req, res) => {
  try {
    await disconnectFitbit(req.client.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[fitbit] disconnect:', err.message);
    res.status(500).json({ error: 'No se pudo desconectar Fitbit' });
  }
});

// ── Messaging (client side) ───────────────────────────────────
// Shared thread between the client and their coaches. Clients only ever see
// their own thread (scoped to req.client.id).

app.get('/api/messages', requireAuth, (req, res) => {
  if (req.client.role !== 'client') return res.status(403).json({ error: 'Solo clientes' });
  markRead(req.client.id, 'coach');           // client is reading → coach msgs read
  res.json({ messages: getThread(req.client.id), unread: 0 });
});

// Lightweight unread poll (does NOT mark anything read) for the floating badge.
app.get('/api/messages/unread', requireAuth, (req, res) => {
  if (req.client.role !== 'client') return res.status(403).json({ error: 'Solo clientes' });
  res.json({ unread: unreadCount(req.client.id, 'coach') });
});

app.post('/api/messages', requireAuth, (req, res) => {
  if (req.client.role !== 'client') return res.status(403).json({ error: 'Solo clientes' });
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Mensaje vacío' });
  const msg = addMessage(req.client.id, 'client', text, null);
  // Both coaches share every client thread — email whichever ones aren't
  // currently active in their portal (the active ones just see the badge).
  listClients().filter(c => c.role === 'coach' && !isRecentlyActive(c.id)).forEach(coach => {
    sendNewMessageEmail({ toEmail: coach.email, toName: coach.name, fromName: req.client.name, preview: text, portalPath: '/coach.html' })
      .catch(err => console.error('[notify] coach message email failed:', err.message));
  });
  res.json({ ok: true, message: msg });
});

// ── Coach API ─────────────────────────────────────────────────

app.get('/api/coach/clients', requireCoach, (req, res) => {
  const clients = listClients().filter(c => c.role === 'client');
  const unread = unreadByClientForCoach();
  res.json(clients.map(c => ({
    id: c.id, name: c.name, initials: c.initials, email: c.email,
    goal: c.goal, currentWeek: c.currentWeek, totalWeeks: c.totalWeeks,
    adherence: getAdherenceSummary(c.id, 7),
    unreadMessages: unread[c.id] || 0,
  })));
});

// ── Messaging (coach side) ────────────────────────────────────
app.get('/api/coach/messages/:clientId', requireCoach, (req, res) => {
  const client = getClientById(req.params.clientId);
  if (!client || client.role !== 'client') return res.status(404).json({ error: 'Cliente no encontrado' });
  markRead(req.params.clientId, 'client');    // coach is reading → client msgs read
  res.json({ messages: getThread(req.params.clientId) });
});

app.post('/api/coach/messages/:clientId', requireCoach, (req, res) => {
  const client = getClientById(req.params.clientId);
  if (!client || client.role !== 'client') return res.status(404).json({ error: 'Cliente no encontrado' });
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Mensaje vacío' });
  const msg = addMessage(req.params.clientId, 'coach', text, req.client.id);
  if (!isRecentlyActive(client.id)) {
    sendNewMessageEmail({ toEmail: client.email, toName: client.name, fromName: req.client.name, preview: text, portalPath: '/client.html' })
      .catch(err => console.error('[notify] client message email failed:', err.message));
  }
  res.json({ ok: true, message: msg });
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

// Create a client from the intake form. Same effect as the AI create_client
// tool: account + coaching-agreement snapshot + welcome notifications.
app.post('/api/coach/clients', requireCoach, async (req, res) => {
  const { name, email, goal, totalWeeks, currentWeek, phone, birthDate, height, weight, bodyFat, notes } = req.body || {};
  if (!name?.trim() || !email?.trim() || !goal?.trim() || !totalWeeks) {
    return res.status(400).json({ error: 'Faltan campos obligatorios: nombre, email, objetivo y semanas.' });
  }
  try {
    const { client, generatedPassword } = await createClient({
      name: name.trim(), email: email.trim(), goal: goal.trim(),
      totalWeeks: Number(totalWeeks), currentWeek: Number(currentWeek) || 1,
      phone: phone?.trim() || null, birthDate: birthDate || null,
      height: height ? Number(height) : null, weight: weight ? Number(weight) : null,
      bodyFat: bodyFat ? Number(bodyFat) : null, notes: notes?.trim() || null,
    });
    const contract = createContractForClient(client);
    const contractPdf = generateContractPdf(contract);
    sendWelcomeNotifications(client, generatedPassword, contractPdf).catch(err =>
      console.error('[notifier] welcome notifications failed:', err.message)
    );
    console.log(`[coach] ${req.client.email} created client ${client.email} (contract #${contract.id})`);
    res.json({ client, password: generatedPassword, contractId: contract.id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Coaching agreement PDF for a client (latest snapshot), generated on the fly.
app.get('/api/coach/contracts/:clientId', requireCoach, (req, res) => {
  const client = getClientById(req.params.clientId);
  if (!client || client.role !== 'client') return res.status(404).json({ error: 'Cliente no encontrado' });
  // Older clients (created before contracts existed) get a snapshot on first download.
  const contract = getLatestContractForClient(client.id) || createContractForClient(client);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="DARE-agreement-${client.id}.pdf"`);
  generateContractPdf(contract).pipe(res);
});

// Full client profile (for coach profile panel)
app.get('/api/coach/clients/:clientId', requireCoach, (req, res) => {
  const client = getClientById(req.params.clientId);
  if (!client || client.role !== 'client') return res.status(404).json({ error: 'Cliente no encontrado' });
  res.json(client);
});

// Current weekly plan of a client, exactly as the client sees it in client.html.
// Lets coaches review a published plan before deciding whether to readjust it.
// Optional ?weekOf=YYYY-MM-DD to inspect a specific week (defaults to latest).
app.get('/api/coach/client-plan/:clientId', requireCoach, (req, res) => {
  const client = getClientById(req.params.clientId);
  if (!client || client.role !== 'client') return res.status(404).json({ error: 'Cliente no encontrado' });
  const { weekOf } = req.query;
  const plan = weekOf ? getPlanByWeek(req.params.clientId, weekOf) : getLatestPlan(req.params.clientId);
  if (!plan) return res.status(404).json({ error: 'Sin planes todavía' });
  if (!plan.shoppingList) plan.shoppingList = shoppingListForPlan(plan); // legacy plans
  res.json(plan);
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

// Regenerate a client's password and email it to them directly. The welcome
// email sent on account creation carries the signed contract instead of the
// password, so this is the only way a client actually receives credentials.
app.post('/api/coach/clients/:clientId/send-credentials', requireCoach, async (req, res) => {
  const client = getClientById(req.params.clientId);
  if (!client || client.role !== 'client') return res.status(404).json({ error: 'Cliente no encontrado' });
  const newPwd = await resetClientPassword(client.id);
  if (!newPwd) return res.status(500).json({ error: 'No se pudo generar la contraseña' });
  try {
    await sendWelcomeEmail(client, newPwd);
  } catch (err) {
    return res.status(502).json({ error: 'Contraseña actualizada pero el envío del email falló: ' + err.message });
  }
  console.log(`[coach] ${req.client.email} sent credentials to ${client.email}`);
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

// Map a saved meal name to one of the 5 fixed table slots.
const MEAL_NAME_TO_SLOT = {
  'breakfast': 'breakfast', 'morning snack': 'morningSnack', 'lunch': 'lunch',
  'snack': 'snack', 'dinner': 'dinner',
};

// Overlay a saved plan onto the empty template days (keyed by short label), so
// the interactive table opens pre-filled — used for editing an existing plan.
function prefillTemplateFromPlan(templateDays, plan, specialty) {
  if (!plan) return templateDays;
  const halves = specialty === 'nutrition' ? plan.nutrition : plan.training;
  if (!Array.isArray(halves)) return templateDays;
  const byLabel = {};
  halves.forEach(d => { if (d?.label) byLabel[d.label] = d; });

  return templateDays.map(td => {
    const src = byLabel[td.shortLabel];
    if (!src) return td;
    if (specialty === 'nutrition') {
      const meals = {};
      (src.meals || []).forEach((m, i) => {
        const slot = MEAL_NAME_TO_SLOT[String(m.name || '').trim().toLowerCase()]
          || ['breakfast', 'morningSnack', 'lunch', 'snack', 'dinner'][i];
        if (slot) meals[slot] = m.dishName || m.desc || '';
      });
      return { ...td, kcal: src.kcal || 0, protein: src.protein || 0, carbs: src.carbs || 0, fat: src.fat || 0, meals, note: src.note || '' };
    }
    // training
    const exItems = src.type === 'rest' ? (src.activities || []) : (src.items || []);
    const exercises = exItems.map(e => ({ name: e.name || '', setsReps: e.badge || '', notes: e.detail || '' }));
    return { ...td, type: src.type || 'rest', session: src.session || '', exercises, note: src.note || '' };
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
2. En cuanto tengas cliente y semana, llama INMEDIATAMENTE a show_plan_template — NUNCA escribas una plantilla de texto. Si ya existe un plan esa semana, la tabla se abre con el plan actual cargado para editarlo.
3. NO preguntes por alergias, objetivos, macros, preferencias ni restricciones: el coach rellena todo eso directamente en la tabla. Tú solo muestra la tabla.
4. Cuando el coach diga que ya guardó o que necesita algo más, responde con normalidad.

DÍAS OPCIONALES: el coach NO tiene que rellenar los 7 días. Puede planificar solo lunes a viernes, por ejemplo. Los días que deje en blanco aparecen al cliente como "aún sin planificar". Nunca insistas en completar toda la semana.

COMANDOS EN BLOQUE (usa prefill_plan_table): cuando el coach pida rellenar varios días a la vez, llama a prefill_plan_table con SOLO los días pedidos. Ejemplos:
- "rellena todos los días de esta semana con 1600 kcal, 125 de proteína, 155 de carbos, 55 de grasas" → days = los 7 días, cada uno con esos macros.
- "pon 2200 kcal de lunes a viernes" → days = Mon..Fri con kcal 2200 (y los macros si los da).
- "necesito editar la comida del martes" → llama a show_plan_template (carga el plan existente); el coach edita ese hueco en la tabla y guarda.
Tras prefill_plan_table, la tabla aparece pre-rellenada; el coach revisa y pulsa Guardar (las cantidades exactas por ingrediente se calculan al guardar).${pasteFlow}

OTRAS FUNCIONES:
- Añadir una nota a un plan ya creado: usa add_plan_note (no regenera el plan)
- Crear cliente: usa create_client (nombre, email, objetivo, semanas totales)
- Resetear contraseña: usa reset_client_password
- Responde en español. Tono profesional y cercano. Respuestas concisas.`;

  const toFn = t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } });
  const tools = [
    toFn(SHOW_TEMPLATE_TOOL),
    toFn(PREFILL_PLAN_TABLE_TOOL),
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
      let days = buildTemplateDays(toolInput.weekOf);
      // If a plan already exists for this week, open the table pre-filled so the
      // coach can edit a specific day/meal instead of starting from scratch.
      const existing = getPlanByWeek(toolInput.clientId, toolInput.weekOf);
      const editing = !!existing;
      if (editing) days = prefillTemplateFromPlan(days, existing, coach.specialty);
      action = { type: 'show_template', specialty: coach.specialty, prefilled: editing, clientId: toolInput.clientId, weekOf: toolInput.weekOf, clientName: toolInput.clientName, days };
      toolResultContent = JSON.stringify({ success: true, message: editing ? 'Tabla mostrada con el plan existente para editar.' : 'Tabla interactiva mostrada al coach.' });
    } else if (toolName === 'prefill_plan_table') {
      // Bulk fill: apply the AI's per-day values onto the template (layered on top
      // of any existing plan), then show the table for review + save. The exact
      // macro math still happens on save (save-plan-table), so macros stay precise.
      let days = buildTemplateDays(toolInput.weekOf);
      const existing = getPlanByWeek(toolInput.clientId, toolInput.weekOf);
      if (existing) days = prefillTemplateFromPlan(days, existing, coach.specialty);
      const byLabel = {};
      (toolInput.days || []).forEach(d => { if (d?.label) byLabel[d.label] = d; });
      let filled = 0;
      days = days.map(td => {
        const src = byLabel[td.shortLabel];
        if (!src) return td;
        filled++;
        if (coach.specialty === 'nutrition') {
          return {
            ...td,
            kcal: src.kcal != null ? src.kcal : td.kcal,
            protein: src.protein != null ? src.protein : td.protein,
            carbs: src.carbs != null ? src.carbs : td.carbs,
            fat: src.fat != null ? src.fat : td.fat,
            meals: { ...(td.meals || {}), ...(src.meals || {}) },
            note: src.note != null ? src.note : td.note,
          };
        }
        return {
          ...td,
          type: src.type || td.type,
          session: src.session != null ? src.session : td.session,
          exercises: Array.isArray(src.exercises) ? src.exercises : td.exercises,
          note: src.note != null ? src.note : td.note,
        };
      });
      action = { type: 'show_template', specialty: coach.specialty, prefilled: true, clientId: toolInput.clientId, weekOf: toolInput.weekOf, clientName: toolInput.clientName, days };
      toolResultContent = JSON.stringify({ success: true, message: 'Tabla pre-rellenada en bloque.', daysFilled: filled });
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
      const contract = createContractForClient(client);
      const contractPdf = generateContractPdf(contract);
      action = { type: 'client_created', client, password: generatedPassword, contractId: contract.id };
      toolResultContent = JSON.stringify({ success: true, name: client.name, email: client.email, password: generatedPassword });
      sendWelcomeNotifications(client, generatedPassword, contractPdf).catch(err =>
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
// For accuracy the MODEL is used only as a nutrition database — per food it
// returns standard per-100g macros + a starting portion + prep steps. ALL
// arithmetic is done in JS: solveDayQuantities sizes the grams to hit the day's
// targets (protein-priority) and every macro is computed exactly from
// grams × per-100g density. The model never does the math or target-matching.

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

// The model acts purely as a nutrition database: per food it returns standard
// per-100g macros + a starting portion; per meal, prep steps. No totals and no
// per-meal macros — JS computes those exactly.
function nutritionLookupPrompt(day) {
  return `You are a nutrition database. For ONE day, return each food with its STANDARD nutrition facts.

MEALS (${day.meals.length}) — keep exactly these foods, in these slots:
${day.meals.map(m => `{id:${m.id}, name:"${m.name}", time:"${m.time}", foods:"${m.dishes}"}`).join('\n')}

For EVERY food in every meal return:
- "item": food name in English (clean, singular)
- "grams": a sensible raw/uncooked starting portion in grams (convert counts: "3 eggs" → ~150, "1 banana" → ~120, "1 orange" → ~130)
- "protein100","carbs100","fat100": grams of protein / carbs / fat per 100 g of that food, from standard nutrition references (raw/uncooked). Be precise — these drive the client's macros.
Per meal also give 3-4 short "steps". Do NOT output meal or day totals — only per-food facts.

Daily targets (context only, to pick sensible starting portions): ${day.kcal} kcal · P${day.protein} · C${day.carbs} · F${day.fat} g.

Return ONLY this JSON, including ALL ${day.meals.length} meals:
{
  "meals": [
    {"id":0,"name":"Breakfast","time":"08:00","steps":["...","..."],
     "foods":[
       {"item":"Whole eggs","grams":150,"protein100":13,"carbs100":1.1,"fat100":11},
       {"item":"Oats","grams":60,"protein100":13,"carbs100":67,"fat100":7}
     ]}
  ]
}`;
}

// Which macro a food predominantly provides (by grams per 100 g) — drives scaling.
function primaryMacro(f) {
  const p = Number(f.protein100) || 0, c = Number(f.carbs100) || 0, ft = Number(f.fat100) || 0;
  if (p >= c && p >= ft) return 'protein';
  if (c >= p && c >= ft) return 'carbs';
  return 'fat';
}

const MACRO_KEYS = { protein: 'protein100', carbs: 'carbs100', fat: 'fat100' };

// Solve a small square linear system A·x = b by Gaussian elimination with
// partial pivoting. Returns the solution vector, or null if A is singular
// (degenerate foods — e.g. two groups with proportionally identical macros).
function solveLinearSystem(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);   // augmented matrix (copy)
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-9) return null;   // singular / no unique solution
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / M[i][i]);
}

// Solve gram quantities so the day's protein/carbs/fat hit their targets EXACTLY.
// Each food is scaled by one factor per its "primary" macro group, so the achieved
// protein/carbs/fat are a linear function of the group scale factors. We build that
// (≤3×3) system and solve it directly — no iteration, no convergence guessing.
// Cross-contributions (e.g. eggs adding fat while sitting in the protein group)
// are captured by the off-diagonal matrix terms, so the solution is exact when the
// food set is feasible. A negative scale means a target is genuinely infeasible
// (the other foods already overshoot that macro): we clamp it to 0 and re-solve the
// remaining macros, leaving the overshoot to surface in checkDayTotals / the retry.
function solveDayQuantities(foods, targets) {
  for (const f of foods) if (f.baseGrams === undefined) f.baseGrams = f.grams;

  // Group contribution to macro `Mi` when the group for `Mj` is scaled by 1.
  const contrib = (Mi, Mj) => foods
    .filter(f => f.primary === Mj)
    .reduce((s, f) => s + f.baseGrams * (Number(f[MACRO_KEYS[Mi]]) || 0) / 100, 0);

  const trySolve = (group) => {
    if (!group.length) return null;
    const A = group.map(Mi => group.map(Mj => contrib(Mi, Mj)));
    const b = group.map(Mi => Number(targets[Mi]) || 0);
    const sol = solveLinearSystem(A, b);
    if (!sol) return null;
    const out = {};
    group.forEach((M, i) => { out[M] = sol[i]; });
    return out;
  };

  // Macros we can actually steer: positive target AND at least one food primarily
  // providing it. Kept in protein → carbs → fat priority order.
  let active = ['protein', 'carbs', 'fat'].filter(M =>
    (Number(targets[M]) || 0) > 0 &&
    foods.some(f => f.primary === M && (Number(f[MACRO_KEYS[M]]) || 0) > 0)
  );

  const scales = { protein: 1, carbs: 1, fat: 1 };   // groups we don't solve keep baseline
  while (active.length) {
    const sol = trySolve(active);
    if (!sol) { active = active.slice(0, -1); continue; }   // singular → drop lowest priority
    const neg = active.filter(M => !(sol[M] >= 0));
    for (const M of active) scales[M] = Math.max(0, sol[M]);
    if (!neg.length) break;
    active = active.filter(M => !neg.includes(M));           // clamp infeasible groups to 0, re-solve rest
  }

  for (const f of foods) {
    const s = scales[f.primary];
    if (Number.isFinite(s)) f.grams = Math.max(0, f.baseGrams * s);
  }
}

const round0 = (n) => Math.round(Number(n) || 0);

// Turn a solved food/meal structure into the final day result (meals with exact
// per-meal macros, aggregated shopping list, day totals and the target check).
function buildDayResult(day, mealsRaw, foods) {
  solveDayQuantities(foods, day);   // size portions to the targets, exactly

  const meals = mealsRaw.map(m => {
    let p = 0, c = 0, ft = 0;
    const parts = m.foods.filter(f => Math.round(f.grams) >= 1).map(f => {
      const g = Math.round(f.grams);
      p  += g * f.protein100 / 100;
      c  += g * f.carbs100   / 100;
      ft += g * f.fat100     / 100;
      return `${g}g ${f.item.toLowerCase()}`;
    });
    const protein = round0(p), carbs = round0(c), fat = round0(ft);
    return {
      id: m.id,
      ingredients: parts.join(', '),
      protein, carbs, fat,
      kcal: round0(protein * 4 + carbs * 4 + fat * 9),
      steps: m.steps.length ? m.steps : ['Prepare as planned.'],
    };
  });

  // Shopping list: aggregate solved grams by food across the whole day.
  const agg = {};
  for (const f of foods) {
    const g = Math.round(f.grams);
    if (g >= 1) agg[f.item] = (agg[f.item] || 0) + g;
  }
  const shopping = Object.entries(agg).map(([item, g]) => ({ item, qty: `${g}g` }));

  const totals = sumMealMacros(meals);
  const check = checkDayTotals(day, totals);
  return { meals, shopping, totals, ok: check.ok, check };
}

// One corrective pass when the food set can't hit the targets (a macro — usually
// fat — overshoots because other foods carry it "for free"). We ask the model for
// leaner/richer substitutes with the same culinary role, keeping items in order so
// we can map the new per-100g facts straight back onto the existing food objects.
async function refineFoodsForFeasibility(day, foods, check) {
  const overshoot = (check.off || []).filter(o => o.achieved > o.target).map(o => o.macro);
  if (!overshoot.length) return false;

  const list = foods.map((f, i) =>
    `${i}: "${f.item}" — P100:${f.protein100} C100:${f.carbs100} F100:${f.fat100}`).join('\n');
  const prompt = `You are a nutrition database. A daily meal plan cannot hit its macro targets because these macros OVERSHOOT: ${overshoot.join(', ')}.
Daily targets: P${day.protein} C${day.carbs} F${day.fat} g (${day.kcal} kcal).

FOODS (index: name — grams of protein/carbs/fat per 100 g):
${list}

For the foods driving the overshooting macro(s), propose a LEANER/adjusted alternative that keeps the same culinary role (e.g. replace whole eggs with egg whites, full-fat yoghurt with 0% fat, olive oil with a smaller/leaner fat, fatty cuts with lean cuts). Foods that are fine may stay unchanged.
Return ONLY JSON with EVERY food, in the SAME index order:
{"foods":[{"index":0,"item":"Egg whites","protein100":11,"carbs100":0.7,"fat100":0.2}, ...]}`;

  const resp = await openai.chat.completions.create({
    model: NUTRITION_MODEL, max_tokens: 1400,
    response_format: { type: 'json_object' },
    messages: [{ role: 'user', content: prompt }],
  });
  const parsed = JSON.parse(resp.choices[0].message.content);
  const subs = Array.isArray(parsed.foods) ? parsed.foods : [];
  if (!subs.length) return false;

  let changed = false;
  subs.forEach((s, i) => {
    const idx = Number.isInteger(s?.index) ? s.index : i;
    const f = foods[idx];
    if (!f) return;
    const p = Math.max(0, Number(s.protein100) || 0);
    const c = Math.max(0, Number(s.carbs100)   || 0);
    const ft = Math.max(0, Number(s.fat100)    || 0);
    if (p + c + ft <= 0) return;              // ignore nonsense rows
    if (s.item) f.item = String(s.item).trim() || f.item;
    f.protein100 = p; f.carbs100 = c; f.fat100 = ft;
    f.primary = primaryMacro(f);             // profile changed → regroup
    changed = true;
  });
  return changed;
}

async function computeNutritionDay(day) {
  const empty = { meals: [], shopping: [], totals: { protein: 0, carbs: 0, fat: 0, kcal: 0 }, ok: false };
  try {
    const resp = await openai.chat.completions.create({
      model: NUTRITION_MODEL, max_tokens: 2600,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: nutritionLookupPrompt(day) }],
    });
    const parsed = JSON.parse(resp.choices[0].message.content);
    const rawMeals = Array.isArray(parsed.meals) ? parsed.meals : [];
    if (!rawMeals.length) return empty;

    // Index the model's meals by id, but drive output off the INPUT meals so ids,
    // names and times are authoritative (never trust the model to echo them).
    const byId = {};
    rawMeals.forEach((m, i) => { const id = Number.isInteger(m?.id) ? m.id : i; if (byId[id] === undefined) byId[id] = m; });

    const foods = [];
    const mealsRaw = day.meals.map((inMeal, i) => {
      const src = byId[inMeal.id] ?? rawMeals[i] ?? {};
      const mealFoods = (Array.isArray(src.foods) ? src.foods : []).map(f => {
        const food = {
          item: (String(f.item || '').trim() || 'food'),
          grams: Math.max(0, Number(f.grams) || 0),
          protein100: Math.max(0, Number(f.protein100) || 0),
          carbs100:   Math.max(0, Number(f.carbs100)   || 0),
          fat100:     Math.max(0, Number(f.fat100)     || 0),
        };
        food.primary = primaryMacro(food);
        foods.push(food);
        return food;
      });
      return { id: inMeal.id, steps: Array.isArray(src.steps) ? src.steps : [], foods: mealFoods };
    });
    if (!foods.length) return empty;

    let result = buildDayResult(day, mealsRaw, foods);

    // Bounded (single) retry: if the food set is genuinely infeasible, ask the
    // model once for leaner substitutes and re-solve. Keep whichever result is
    // better so a bad substitution never makes the day worse.
    if (!result.ok) {
      try {
        const changed = await refineFoodsForFeasibility(day, foods, result.check);
        if (changed) {
          for (const f of foods) delete f.baseGrams;     // re-derive starting portions
          const retry = buildDayResult(day, mealsRaw, foods);
          if (retry.ok || Math.abs(retry.totals.kcal - day.kcal) < Math.abs(result.totals.kcal - day.kcal)) {
            result = retry;
          }
        }
      } catch (e) {
        console.error('[nutrition] substitution retry failed:', day.dayId, e.message);
      }
    }

    if (!result.ok) {
      const detail = result.check.off.map(o => `${o.macro} ${o.achieved}/${o.target}`).join(', ')
        || (result.check.proteinShort ? 'protein below target' : '');
      console.warn(`[nutrition] day ${day.dayId} off target (food set may be infeasible): ${detail}`);
    }
    const { meals, shopping, totals, ok } = result;
    return { meals, shopping, totals, ok };
  } catch (e) {
    console.error('[AI nutrition day]', day.dayId, e.message);
    return empty;
  }
}

// Email the client the first time a week becomes fully published (both training
// and nutrition halves ready). Fire-and-forget — pass the pre-mutation published
// state so later edits to an already-live week never re-notify.
function notifyIfNewlyPublished(clientId, weekOf, wasPublished) {
  if (wasPublished) return;
  const plan = getPlanByWeek(clientId, weekOf);
  if (!plan || !plan.publishedAt) return;
  const client = getClientById(clientId);
  if (!client || !client.email) return;
  sendPlanReadyEmail({ toEmail: client.email, toName: client.name, weekOf })
    .catch(err => console.error('[notify] plan ready email failed:', err.message));
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

    const wasPublished = !!getPlanByWeek(clientId, weekOf)?.publishedAt;
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

    notifyIfNewlyPublished(clientId, weekOf, wasPublished);
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
    const wasPublished = !!getPlanByWeek(clientId, weekOf)?.publishedAt;
    const plan = updatePlanDay(clientId, weekOf, specialty, Number(dayIndex), day);
    notifyIfNewlyPublished(clientId, weekOf, wasPublished);
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
    const wasPublished = !!getPlanByWeek(clientId, weekOf)?.publishedAt;
    const plan = savePlan(toolName, { clientId, weekOf, days });
    notifyIfNewlyPublished(clientId, weekOf, wasPublished);
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

// Branded weekly-plan PDF. Client downloads their own week; coach any client's.
app.get('/api/plans/:clientId/week/:weekOf/pdf', requireAuth, (req, res) => {
  const { clientId, weekOf } = req.params;
  if (req.client.id !== clientId && req.client.role !== 'coach') {
    return res.status(403).json({ error: 'Acceso denegado' });
  }
  const client = getClientById(clientId);
  if (!client || client.role !== 'client') return res.status(404).json({ error: 'Cliente no encontrado' });
  const plan = getPlanByWeek(clientId, weekOf);
  if (!plan) return res.status(404).json({ error: 'Semana no encontrada' });
  if (!plan.shoppingList) plan.shoppingList = shoppingListForPlan(plan); // legacy plans
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="DARE-plan-${clientId}-${weekOf}.pdf"`);
  generatePlanPdf(plan, client).pipe(res);
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

// ── Exercise library (coach) ──────────────────────────────────
// Unique exercise names from every saved/archived training plan. Powers the
// quick-pick dropdown above the chat input for the training coach.
app.get('/api/coach/exercises', requireCoach, (req, res) => {
  try {
    res.json({ exercises: listExercises() });
  } catch (err) {
    console.error('[exercises]', err);
    res.status(500).json({ error: 'Error al cargar ejercicios' });
  }
});

// ── Backups ───────────────────────────────────────────────────
// Off-site copy path: a coach downloads the encrypted-at-rest DB backup from
// time to time. Complements (not replaces) Railway volume backups.
app.get('/api/coach/backup', requireCoach, async (req, res) => {
  try {
    const path = (await runBackup()) || latestBackupPath();
    if (!path) return res.status(404).json({ error: 'No hay backups todavía' });
    res.download(path, path.split('/').pop());
  } catch (err) {
    console.error('[backup] download failed:', err.message);
    res.status(500).json({ error: 'No se pudo generar el backup' });
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
  // Never create the demo account in production unless explicitly requested —
  // it has a known weak password and would expose the coach message thread.
  if (IS_PROD && process.env.SEED_DEMO !== 'true') return;
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
  if (IS_PROD && process.env.SEED_DEMO !== 'true') return;
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
  scheduleDailyBackups();
});
