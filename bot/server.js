import './env.js'; // Load .env FIRST
import express from 'express';
import { handleIncoming } from './conversations.js';
import { getLatestPlan, getPlanByWeek } from './planner.js';
import {
  verifyClientPassword,
  getClientById,
  listClients,
  createClient,
  deleteClient,
  resetClientPassword,
} from './clients.js';
import { signToken, verifyToken, persistSession, revokeSession, isAdmin } from './auth.js';

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// CORS — allow client portal to fetch plans
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Auth middleware ───────────────────────────────────────────

function requireClient(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No autenticado' });

  const payload = verifyToken(token);
  if (!payload?.sub) return res.status(401).json({ error: 'Token inválido o expirado' });

  const client = getClientById(payload.sub);
  if (!client) return res.status(401).json({ error: 'Cliente no encontrado' });

  req.client = client;
  next();
}

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token !== process.env.ADMIN_API_TOKEN) {
    return res.status(403).json({ error: 'Acceso denegado' });
  }
  next();
}

// ── Twilio WhatsApp webhook ───────────────────────────────────

app.post('/webhook', async (req, res) => {
  const from = req.body?.From ?? '';
  const body = (req.body?.Body ?? '').trim();

  if (!from || !body) {
    return res.status(400).send('Bad Request');
  }

  let reply;
  try {
    reply = await handleIncoming(from, body);
  } catch (err) {
    console.error('[webhook] error:', err);
    reply = 'Error interno. Intenta de nuevo o escribe /reset.';
  }

  res.type('text/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Message><![CDATA[${reply}]]></Message></Response>`
  );
});

// ── Client auth ───────────────────────────────────────────────

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email y contraseña requeridos' });
  }
  const client = await verifyClientPassword(email, password);
  if (!client) return res.status(401).json({ error: 'Credenciales incorrectas' });

  const token = signToken(client.id);
  persistSession(token, client.id);

  res.json({
    token,
    client: {
      id: client.id,
      name: client.name,
      initials: client.initials,
      email: client.email,
      goal: client.goal,
      currentWeek: client.currentWeek,
      totalWeeks: client.totalWeeks,
      weight: client.weight,
      bodyFat: client.bodyFat,
      lean: client.lean,
      height: client.height,
    },
  });
});

app.post('/api/auth/logout', requireClient, (req, res) => {
  const token = req.headers.authorization.slice(7);
  revokeSession(token);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireClient, (req, res) => {
  res.json({
    id: req.client.id,
    name: req.client.name,
    initials: req.client.initials,
    email: req.client.email,
    goal: req.client.goal,
    currentWeek: req.client.currentWeek,
    totalWeeks: req.client.totalWeeks,
    weight: req.client.weight,
    bodyFat: req.client.bodyFat,
    lean: req.client.lean,
    height: req.client.height,
  });
});

// ── Plan API (client must be authenticated for their own data) ─

app.get('/api/plans/:clientId', requireClient, (req, res) => {
  if (req.client.id !== req.params.clientId && !req.headers['x-admin-override']) {
    return res.status(403).json({ error: 'No puedes ver el plan de otro cliente' });
  }
  const plan = getLatestPlan(req.params.clientId);
  if (!plan) return res.status(404).json({ error: 'No hay planes para este cliente' });
  res.json(plan);
});

app.get('/api/plans/:clientId/week/:weekOf', requireClient, (req, res) => {
  if (req.client.id !== req.params.clientId) {
    return res.status(403).json({ error: 'No puedes ver el plan de otro cliente' });
  }
  const plan = getPlanByWeek(req.params.clientId, req.params.weekOf);
  if (!plan) return res.status(404).json({ error: 'Semana no encontrada' });
  res.json(plan);
});

// ── Admin API (managed via HTTP for tooling, also via WhatsApp) ─

app.get('/api/clients', requireAdmin, (req, res) => {
  res.json(listClients().map(c => ({
    id: c.id, name: c.name, email: c.email, goal: c.goal,
    currentWeek: c.currentWeek, totalWeeks: c.totalWeeks,
    createdAt: c.createdAt, lastLoginAt: c.lastLoginAt,
  })));
});

app.post('/api/clients', requireAdmin, async (req, res) => {
  try {
    const { client, generatedPassword } = await createClient(req.body);
    res.status(201).json({ client, generatedPassword });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/clients/:id', requireAdmin, (req, res) => {
  const ok = deleteClient(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Cliente no encontrado' });
  res.json({ ok: true });
});

app.post('/api/clients/:id/reset-password', requireAdmin, async (req, res) => {
  const newPwd = await resetClientPassword(req.params.id);
  if (!newPwd) return res.status(404).json({ error: 'Cliente no encontrado' });
  res.json({ newPassword: newPwd });
});

// ── Health ────────────────────────────────────────────────────

app.get('/health', (_, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ── Start ─────────────────────────────────────────────────────

const PORT = process.env.PORT ?? 3001;
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║   DARE Bot Server  :${PORT}             ║
  ║   Webhook: POST /webhook             ║
  ║   Auth:    POST /api/auth/login      ║
  ║   Plans:   GET  /api/plans/:id       ║
  ║   Admin:   /api/clients              ║
  ╚══════════════════════════════════════╝
  `);
});
