import './env.js'; // Load .env FIRST, before any other imports
import express from 'express';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { handleIncoming } from './conversations.js';
import { getLatestPlan, getPlanByWeek } from './planner.js';

const __dir = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// CORS — allow client portal to fetch plans
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

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
    reply = 'Error interno. Por favor intenta de nuevo o escribe /reset.';
  }

  // TwiML response
  res.type('text/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Message><![CDATA[${reply}]]></Message></Response>`
  );
});

// ── Plan API for client portal ────────────────────────────────

// GET /api/plans/:clientId → latest plan (full merged week if both halves ready)
app.get('/api/plans/:clientId', (req, res) => {
  const plan = getLatestPlan(req.params.clientId);
  if (!plan) return res.status(404).json({ error: 'No hay planes para este cliente' });
  res.json(plan);
});

// GET /api/plans/:clientId/week/:weekOf → specific week
app.get('/api/plans/:clientId/week/:weekOf', (req, res) => {
  const plan = getPlanByWeek(req.params.clientId, req.params.weekOf);
  if (!plan) return res.status(404).json({ error: 'Semana no encontrada' });
  res.json(plan);
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT ?? 3001;
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║   DARE Bot Server  :${PORT}             ║
  ║   Webhook: POST /webhook             ║
  ║   Plans API: GET /api/plans/:id      ║
  ╚══════════════════════════════════════╝
  `);
});
