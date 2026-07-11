// ── Fitbit (Google) integration ───────────────────────────────
// OAuth 2.0 Authorization Code + PKCE against the Fitbit Web API.
// Clients connect their own Fitbit account from the portal; we only
// request the scopes we actually display (activity, heartrate, sleep)
// and only read daily summaries — no intraday data, so no special
// Fitbit approval is needed.
//
// Legal constraints baked in (Fitbit Platform Terms of Service):
//   • Data is used only to provide coaching — never for advertising.
//   • Minimal scopes; the token response gives us the user id, so we
//     don't even request the `profile` scope.
//   • Disconnect revokes the token at Fitbit AND deletes our copy.
//
// The feature is entirely env-gated: without FITBIT_CLIENT_ID and
// FITBIT_CLIENT_SECRET every endpoint reports { configured: false }
// and the portal hides the card.

import './env.js';
import db from './db.js';
import { randomBytes, createHash } from 'crypto';

const CLIENT_ID     = process.env.FITBIT_CLIENT_ID     || '';
const CLIENT_SECRET = process.env.FITBIT_CLIENT_SECRET || '';
const APP_URL       = (process.env.APP_URL || 'https://darehabits.com').replace(/\/$/, '');
const REDIRECT_URI  = `${APP_URL}/api/fitbit/callback`;

const AUTHORIZE_URL = 'https://www.fitbit.com/oauth2/authorize';
const TOKEN_URL     = 'https://api.fitbit.com/oauth2/token';
const REVOKE_URL    = 'https://api.fitbit.com/oauth2/revoke';
const API_BASE      = 'https://api.fitbit.com';

// Only what we show in the portal. Fitbit asks the user to approve each
// scope individually on their consent screen.
const SCOPES = 'activity heartrate sleep';

export const fitbitConfigured = () => Boolean(CLIENT_ID && CLIENT_SECRET);

// ── Schema ─────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS fitbit_tokens (
    client_id       TEXT PRIMARY KEY,
    fitbit_user_id  TEXT,
    access_token    TEXT NOT NULL,
    refresh_token   TEXT NOT NULL,
    scope           TEXT,
    expires_at      TEXT NOT NULL,
    connected_at    TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  );

  -- Short-lived CSRF state for the OAuth dance (10-min expiry, single use).
  CREATE TABLE IF NOT EXISTS fitbit_oauth_states (
    state          TEXT PRIMARY KEY,
    client_id      TEXT NOT NULL,
    code_verifier  TEXT NOT NULL,
    created_at     TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  );
`);

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ── OAuth: authorize URL ──────────────────────────────────────

export function buildAuthUrl(clientId) {
  if (!fitbitConfigured()) throw new Error('Fitbit no está configurado');
  const state    = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(48)); // 64 chars — within Fitbit's 43-128 limit
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  db.prepare(`DELETE FROM fitbit_oauth_states WHERE client_id = ? OR created_at < datetime('now', '-10 minutes')`).run(clientId);
  db.prepare('INSERT INTO fitbit_oauth_states (state, client_id, code_verifier) VALUES (?,?,?)').run(state, clientId, verifier);
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${AUTHORIZE_URL}?${q}`;
}

// ── OAuth: token exchange / refresh ───────────────────────────

async function tokenRequest(params) {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.errors?.[0]?.message || `Fitbit token error (HTTP ${r.status})`;
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  return data;
}

function saveTokens(clientId, data) {
  const expiresAt = new Date(Date.now() + (data.expires_in - 60) * 1000).toISOString();
  db.prepare(`
    INSERT INTO fitbit_tokens (client_id, fitbit_user_id, access_token, refresh_token, scope, expires_at, connected_at)
    VALUES (?,?,?,?,?,?, datetime('now'))
    ON CONFLICT(client_id) DO UPDATE SET
      fitbit_user_id = excluded.fitbit_user_id,
      access_token   = excluded.access_token,
      refresh_token  = excluded.refresh_token,
      scope          = excluded.scope,
      expires_at     = excluded.expires_at
  `).run(clientId, data.user_id || null, data.access_token, data.refresh_token, data.scope || null, expiresAt);
}

export async function handleCallback(code, state) {
  if (!fitbitConfigured()) throw new Error('Fitbit no está configurado');
  const row = db.prepare(`SELECT * FROM fitbit_oauth_states WHERE state = ? AND created_at > datetime('now', '-10 minutes')`).get(state);
  if (!row) throw new Error('Estado OAuth inválido o caducado');
  db.prepare('DELETE FROM fitbit_oauth_states WHERE state = ?').run(state); // single use
  const data = await tokenRequest({
    client_id: CLIENT_ID,
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT_URI,
    code,
    code_verifier: row.code_verifier,
  });
  saveTokens(row.client_id, data);
  summaryCache.delete(row.client_id);
  return row.client_id;
}

// Fitbit refresh tokens are single-use: the response carries a new pair
// that must be persisted immediately or the connection is lost.
async function refreshTokens(clientId, refreshToken) {
  try {
    const data = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
    saveTokens(clientId, data);
    return data.access_token;
  } catch (err) {
    // invalid_grant → the user revoked access from their Fitbit account.
    // Drop our copy so the portal shows "disconnected" instead of erroring.
    if (err.status === 400 || err.status === 401) {
      db.prepare('DELETE FROM fitbit_tokens WHERE client_id = ?').run(clientId);
    }
    throw err;
  }
}

async function getAccessToken(clientId) {
  const row = db.prepare('SELECT * FROM fitbit_tokens WHERE client_id = ?').get(clientId);
  if (!row) return null;
  if (new Date(row.expires_at) > new Date()) return row.access_token;
  return refreshTokens(clientId, row.refresh_token);
}

// ── Status / disconnect ───────────────────────────────────────

export function getStatus(clientId) {
  if (!fitbitConfigured()) return { configured: false, connected: false };
  const row = db.prepare('SELECT connected_at FROM fitbit_tokens WHERE client_id = ?').get(clientId);
  return { configured: true, connected: Boolean(row), since: row?.connected_at || null };
}

export async function disconnect(clientId) {
  const row = db.prepare('SELECT access_token FROM fitbit_tokens WHERE client_id = ?').get(clientId);
  if (!row) return;
  // Best-effort revoke at Fitbit — our copy is deleted regardless.
  try {
    await fetch(REVOKE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ token: row.access_token }),
    });
  } catch (err) {
    console.error('[fitbit] revoke failed:', err.message);
  }
  db.prepare('DELETE FROM fitbit_tokens WHERE client_id = ?').run(clientId);
  summaryCache.delete(clientId);
}

// ── Daily summary ─────────────────────────────────────────────
// Fitbit allows 150 requests/user/hour; a 10-min cache keeps a client
// refreshing their portal all day well under the limit (4 calls/fetch).

const summaryCache = new Map(); // clientId → { at, data }
const CACHE_TTL_MS = 10 * 60 * 1000;

async function apiGet(accessToken, path) {
  const r = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) {
    const err = new Error(`Fitbit API ${path} → HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

export async function getSummary(clientId) {
  const cached = summaryCache.get(clientId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;

  let token = await getAccessToken(clientId);
  if (!token) return null;

  // 'today' is resolved by Fitbit in the user's own profile timezone.
  const fetchAll = (tk) => Promise.allSettled([
    apiGet(tk, '/1/user/-/activities/date/today.json'),
    apiGet(tk, '/1/user/-/activities/heart/date/today/1d.json'),
    apiGet(tk, '/1/user/-/hrv/date/today.json'),
    apiGet(tk, '/1.2/user/-/sleep/date/today.json'),
  ]);

  let results = await fetchAll(token);
  // A stale access token slips through if the clock-based check passed but
  // Fitbit disagrees — refresh once and retry.
  if (results.every(x => x.status === 'rejected' && x.reason?.status === 401)) {
    const row = db.prepare('SELECT refresh_token FROM fitbit_tokens WHERE client_id = ?').get(clientId);
    if (!row) return null;
    token = await refreshTokens(clientId, row.refresh_token);
    results = await fetchAll(token);
  }

  const [act, heart, hrv, sleep] = results.map(x => (x.status === 'fulfilled' ? x.value : null));

  const mainSleep = sleep?.sleep?.find(s => s.isMainSleep) || sleep?.sleep?.[0] || null;
  const data = {
    date: new Date().toISOString().split('T')[0],
    steps:            act?.summary?.steps ?? null,
    caloriesOut:      act?.summary?.caloriesOut ?? null,
    activeMinutes:    act?.summary ? (act.summary.fairlyActiveMinutes || 0) + (act.summary.veryActiveMinutes || 0) : null,
    restingHeartRate: heart?.['activities-heart']?.[0]?.value?.restingHeartRate ?? null,
    hrvMs:            hrv?.hrv?.[0]?.value?.dailyRmssd ?? null,
    sleepMinutes:     sleep?.summary?.totalMinutesAsleep ?? null,
    sleepEfficiency:  mainSleep?.efficiency ?? null,
    fetchedAt:        new Date().toISOString(),
  };
  summaryCache.set(clientId, { at: Date.now(), data });
  return data;
}
