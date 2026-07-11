// ── Fitbit data via the Google Health API ─────────────────────
// Google is sunsetting the legacy Fitbit Web API in September 2026; Fitbit
// data now flows through the Google Health API (health.googleapis.com, v4)
// authorised with Google OAuth 2.0. This module integrates the NEW API
// directly — no dev.fitbit.com registration involved.
//
// Setup lives in Google Cloud Console (see FITBIT_SETUP.md): a project with
// the Health API enabled, an OAuth consent screen, and a Web OAuth client.
//
// Legal constraints baked in (Google Health API terms — all scopes are
// "restricted" and require a privacy/security review to go to production):
//   • Data is used only to provide coaching — never for advertising.
//   • Minimal read-only scopes: activity_and_fitness, sleep, and
//     health_metrics_and_measurements (resting HR + HRV).
//   • Disconnect revokes the Google token AND deletes our copy.
//
// The feature is entirely env-gated: without GOOGLE_HEALTH_CLIENT_ID and
// GOOGLE_HEALTH_CLIENT_SECRET every endpoint reports { configured: false }
// and the portal hides the card.

import './env.js';
import db from './db.js';
import { randomBytes, createHash } from 'crypto';

// GOOGLE_HEALTH_* preferred; FITBIT_* accepted as aliases so a deployment
// configured under the old names keeps working.
const CLIENT_ID     = process.env.GOOGLE_HEALTH_CLIENT_ID     || process.env.FITBIT_CLIENT_ID     || '';
const CLIENT_SECRET = process.env.GOOGLE_HEALTH_CLIENT_SECRET || process.env.FITBIT_CLIENT_SECRET || '';
const APP_URL       = (process.env.APP_URL || 'https://darehabits.com').replace(/\/$/, '');
const REDIRECT_URI  = `${APP_URL}/api/fitbit/callback`;
const DEBUG         = process.env.HEALTH_API_DEBUG === '1';

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL     = 'https://oauth2.googleapis.com/token';
const REVOKE_URL    = 'https://oauth2.googleapis.com/revoke';
const API_BASE      = 'https://health.googleapis.com/v4/users/me/dataTypes';

// Minimal read-only scopes for what the portal shows.
const SCOPES = [
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
].join(' ');

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
  if (!fitbitConfigured()) throw new Error('Google Health API no está configurada');
  const state    = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(48)); // 64 chars — within the 43-128 PKCE limit
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
    // offline + consent guarantees Google returns a refresh_token on every
    // (re)connection, not just the first one.
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${AUTHORIZE_URL}?${q}`;
}

// ── OAuth: token exchange / refresh ───────────────────────────

async function tokenRequest(params) {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.error_description || data?.error || `Google token error (HTTP ${r.status})`;
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  return data;
}

function saveTokens(clientId, data, prevRefreshToken = null) {
  const expiresAt = new Date(Date.now() + ((data.expires_in || 3600) - 60) * 1000).toISOString();
  // Google only re-issues the refresh_token when prompt=consent; on plain
  // refreshes the previous one stays valid and must be kept.
  const refreshToken = data.refresh_token || prevRefreshToken;
  db.prepare(`
    INSERT INTO fitbit_tokens (client_id, fitbit_user_id, access_token, refresh_token, scope, expires_at, connected_at)
    VALUES (?,?,?,?,?,?, datetime('now'))
    ON CONFLICT(client_id) DO UPDATE SET
      access_token   = excluded.access_token,
      refresh_token  = excluded.refresh_token,
      scope          = excluded.scope,
      expires_at     = excluded.expires_at
  `).run(clientId, null, data.access_token, refreshToken, data.scope || null, expiresAt);
}

export async function handleCallback(code, state) {
  if (!fitbitConfigured()) throw new Error('Google Health API no está configurada');
  const row = db.prepare(`SELECT * FROM fitbit_oauth_states WHERE state = ? AND created_at > datetime('now', '-10 minutes')`).get(state);
  if (!row) throw new Error('Estado OAuth inválido o caducado');
  db.prepare('DELETE FROM fitbit_oauth_states WHERE state = ?').run(state); // single use
  const data = await tokenRequest({
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT_URI,
    code,
    code_verifier: row.code_verifier,
  });
  if (!data.refresh_token) throw new Error('Google no devolvió refresh_token');
  saveTokens(row.client_id, data);
  summaryCache.delete(row.client_id);
  return row.client_id;
}

async function refreshTokens(clientId, refreshToken) {
  try {
    const data = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
    saveTokens(clientId, data, refreshToken);
    return data.access_token;
  } catch (err) {
    // invalid_grant → the user revoked access from their Google account (or
    // the 7-day testing-mode refresh token expired). Drop our copy so the
    // portal shows "disconnected" instead of erroring.
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
  const row = db.prepare('SELECT access_token, refresh_token FROM fitbit_tokens WHERE client_id = ?').get(clientId);
  if (!row) return;
  // Best-effort revoke at Google — our copy is deleted regardless. Revoking
  // either token of the pair invalidates both.
  try {
    await fetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: row.refresh_token || row.access_token }),
    });
  } catch (err) {
    console.error('[fitbit] revoke failed:', err.message);
  }
  db.prepare('DELETE FROM fitbit_tokens WHERE client_id = ?').run(clientId);
  summaryCache.delete(clientId);
}

// ── Daily summary ─────────────────────────────────────────────
// 6 Health-API calls per fetch, cached 10 min per client — a client
// refreshing their portal all day stays far below Google's quotas.

const summaryCache = new Map(); // clientId → { at, data }
const CACHE_TTL_MS = 10 * 60 * 1000;

async function apiCall(accessToken, path, body = null) {
  const r = await fetch(`${API_BASE}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(`Health API ${path.split('?')[0]} → HTTP ${r.status}: ${data?.error?.message || ''}`);
    err.status = r.status;
    throw err;
  }
  if (DEBUG) console.log(`[fitbit][debug] ${path.split('?')[0]} →`, JSON.stringify(data).slice(0, 800));
  return data;
}

// The Health API is new and some response field names may evolve; extract
// values by well-known key first, then fall back to the first number found,
// so a schema tweak degrades to "—" in the portal instead of crashing.
function deepFind(obj, keys, depth = 0) {
  if (obj == null || depth > 6) return null;
  if (typeof obj === 'object') {
    for (const k of keys) if (obj[k] != null && typeof obj[k] !== 'object') return obj[k];
    for (const v of Object.values(obj)) {
      const hit = deepFind(v, keys, depth + 1);
      if (hit != null) return hit;
    }
  }
  return null;
}
function firstNumber(obj, depth = 0) {
  if (obj == null || depth > 6) return null;
  if (typeof obj === 'number' && Number.isFinite(obj)) return obj;
  if (typeof obj === 'string' && /^-?\d+(\.\d+)?$/.test(obj)) return Number(obj);
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (/time|date|offset|name|source|id/i.test(k)) continue; // skip timestamps/ids
      const n = firstNumber(v, depth + 1);
      if (n != null) return n;
    }
  }
  return null;
}
const num = (obj, keys) => {
  const v = deepFind(obj, keys);
  if (v != null && Number.isFinite(Number(v))) return Number(v);
  return firstNumber(obj);
};

const pad = (n) => String(n).padStart(2, '0');
const civilDate = (d) => ({ date: { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() } });

// dailyRollUp of today (closed-open civil range: today → tomorrow).
async function rollUpToday(token, dataType) {
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 86400000);
  const r = await apiCall(token, `/${dataType}/dataPoints:dailyRollUp`, {
    range: { start: civilDate(today), end: civilDate(tomorrow) },
    windowSizeDays: 1,
  });
  const points = r.rollupDataPoints || [];
  if (!points.length) return null;
  const { civilStartTime, civilEndTime, ...values } = points[points.length - 1];
  return values;
}

// list recent data points of a type (last `days`), newest last. Tries a
// civil-time filter first; if the API rejects the filter syntax, falls back
// to an unfiltered page.
async function listRecent(token, dataType, days = 3) {
  const since = new Date(Date.now() - days * 86400000);
  const iso = `${since.getFullYear()}-${pad(since.getMonth() + 1)}-${pad(since.getDate())}T00:00:00`;
  const field = dataType.replace(/-/g, '_');
  const filter = encodeURIComponent(`${field}.interval.civil_start_time >= "${iso}"`);
  try {
    const r = await apiCall(token, `/${dataType}/dataPoints?pageSize=200&filter=${filter}`);
    if (r.dataPoints?.length) return r.dataPoints;
  } catch (err) {
    if (err.status !== 400) throw err; // 400 → unsupported filter field, fall through
  }
  const r = await apiCall(token, `/${dataType}/dataPoints?pageSize=200`);
  return r.dataPoints || [];
}

const latest = (points) => (points && points.length ? points[points.length - 1] : null);

export async function getSummary(clientId) {
  const cached = summaryCache.get(clientId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;

  let token = await getAccessToken(clientId);
  if (!token) return null;

  const fetchAll = (tk) => Promise.allSettled([
    rollUpToday(tk, 'steps'),
    rollUpToday(tk, 'active-zone-minutes'),
    rollUpToday(tk, 'calories'),
    listRecent(tk, 'daily-resting-heart-rate', 3),
    listRecent(tk, 'heart-rate-variability', 2),
    listRecent(tk, 'sleep', 2),
  ]);

  let results = await fetchAll(token);
  // Stale access token slipping past the clock check → refresh once, retry.
  if (results.every(x => x.status === 'rejected' && x.reason?.status === 401)) {
    const row = db.prepare('SELECT refresh_token FROM fitbit_tokens WHERE client_id = ?').get(clientId);
    if (!row) return null;
    token = await refreshTokens(clientId, row.refresh_token);
    results = await fetchAll(token);
  }
  if (DEBUG) results.forEach((x, i) => { if (x.status === 'rejected') console.log(`[fitbit][debug] part ${i} failed:`, x.reason?.message); });

  const [steps, azm, cals, rhrList, hrvList, sleepList] = results.map(x => (x.status === 'fulfilled' ? x.value : null));

  const rhrPoint   = latest(rhrList);
  const hrvPoint   = latest(hrvList);
  const sleepPoint = latest(sleepList);

  // Sleep: prefer explicit minutes-asleep fields; fall back to session
  // duration computed from its start/end timestamps.
  let sleepMinutes = sleepPoint ? num(sleepPoint, ['minutesAsleep', 'totalMinutesAsleep', 'totalSleepMinutes']) : null;
  if (sleepPoint && (sleepMinutes == null || sleepMinutes > 24 * 60)) {
    const start = deepFind(sleepPoint, ['startTime', 'physicalStartTime']);
    const end   = deepFind(sleepPoint, ['endTime', 'physicalEndTime']);
    if (start && end) {
      const mins = Math.round((new Date(end) - new Date(start)) / 60000);
      if (mins > 0 && mins <= 24 * 60) sleepMinutes = mins;
    } else if (sleepMinutes > 24 * 60) {
      sleepMinutes = null;
    }
  }

  const data = {
    date: new Date().toISOString().split('T')[0],
    steps:            steps ? num(steps, ['count', 'steps', 'total']) : null,
    caloriesOut:      cals ? num(cals, ['calories', 'kilocalories', 'energyKcal', 'total']) : null,
    activeMinutes:    azm ? num(azm, ['totalMinutes', 'activeZoneMinutes', 'minutes', 'total']) : null,
    restingHeartRate: rhrPoint ? num(rhrPoint, ['restingHeartRate', 'bpm', 'beatsPerMinute', 'value']) : null,
    hrvMs:            hrvPoint ? num(hrvPoint, ['dailyRmssd', 'rmssd', 'milliseconds', 'value']) : null,
    sleepMinutes,
    sleepEfficiency:  sleepPoint ? deepFind(sleepPoint, ['efficiency', 'sleepEfficiency']) : null,
    fetchedAt:        new Date().toISOString(),
  };
  summaryCache.set(clientId, { at: Date.now(), data });
  return data;
}
