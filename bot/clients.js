import db from './db.js';
import { hashPassword, verifyPassword, generatePassword } from './auth.js';

// ── Helpers ───────────────────────────────────────────────────

function toClient(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    initials: row.initials,
    email: row.email,
    phone: row.phone,
    goal: row.goal,
    currentWeek: row.current_week,
    totalWeeks: row.total_weeks,
    height: row.height_cm,
    weight: row.weight_kg,
    bodyFat: row.body_fat_pct,
    lean: row.lean_mass_kg,
    notes: row.notes,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

function slugify(name) {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function initialsFromName(name) {
  return name
    .split(/\s+/)
    .map(w => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

// ── CRUD ──────────────────────────────────────────────────────

export async function createClient({ name, email, goal, phone, currentWeek = 1, totalWeeks = 12, weight, height, bodyFat, lean, notes, password }) {
  const id = slugify(name);
  const initials = initialsFromName(name);
  const pwd = password || generatePassword();
  const passwordHash = await hashPassword(pwd);

  try {
    db.prepare(`
      INSERT INTO clients (id, name, initials, email, password_hash, phone, goal, current_week, total_weeks, height_cm, weight_kg, body_fat_pct, lean_mass_kg, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, initials, email.toLowerCase(), passwordHash, phone || null, goal, currentWeek, totalWeeks, height ?? null, weight ?? null, bodyFat ?? null, lean ?? null, notes || null);
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw new Error('Ya existe un cliente con ese email o id.');
    }
    throw err;
  }

  return { client: toClient(getClientRow(id)), generatedPassword: pwd };
}

function getClientRow(id) {
  return db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
}

export function getClientById(id) {
  return toClient(getClientRow(id));
}

export function getClientByEmail(email) {
  return toClient(db.prepare('SELECT * FROM clients WHERE email = ?').get(email.toLowerCase()));
}

export function findClient(query) {
  const q = query.toLowerCase().trim();
  const rows = db.prepare('SELECT * FROM clients').all();
  const found = rows.find(
    c =>
      c.name.toLowerCase().includes(q) ||
      q.includes(c.name.split(' ')[0].toLowerCase()) ||
      c.id.includes(q) ||
      c.email === q
  );
  return found ? toClient(found) : null;
}

export function listClients() {
  return db.prepare('SELECT * FROM clients ORDER BY created_at DESC').all().map(toClient);
}

export function deleteClient(id) {
  const result = db.prepare('DELETE FROM clients WHERE id = ?').run(id);
  return result.changes > 0;
}

export function updateClient(id, fields) {
  const allowed = ['name', 'email', 'phone', 'goal', 'current_week', 'total_weeks', 'height_cm', 'weight_kg', 'body_fat_pct', 'lean_mass_kg', 'notes'];
  const updates = [];
  const values = [];
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.includes(k)) {
      updates.push(`${k} = ?`);
      values.push(v);
    }
  }
  if (!updates.length) return getClientById(id);
  values.push(id);
  db.prepare(`UPDATE clients SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  return getClientById(id);
}

export async function verifyClientPassword(email, password) {
  const row = db.prepare('SELECT * FROM clients WHERE email = ?').get(email.toLowerCase());
  if (!row) return null;
  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) return null;
  db.prepare("UPDATE clients SET last_login_at = datetime('now') WHERE id = ?").run(row.id);
  return toClient(row);
}

export async function resetClientPassword(id) {
  const newPwd = generatePassword();
  const hash = await hashPassword(newPwd);
  const result = db.prepare('UPDATE clients SET password_hash = ? WHERE id = ?').run(hash, id);
  if (!result.changes) return null;
  return newPwd;
}

// ── Convenience for bot prompts ───────────────────────────────

export function formatClientsForPrompt() {
  const all = listClients();
  if (!all.length) return '(Aún no hay clientes en el sistema.)';
  return all
    .map(
      (c, i) =>
        `${i + 1}. ${c.name} (id: ${c.id}) — ${c.goal}, Semana ${c.currentWeek}/${c.totalWeeks}${c.weight ? `, ${c.weight}kg` : ''}${c.bodyFat ? `, ${c.bodyFat}% grasa` : ''}`
    )
    .join('\n');
}

export function listClientsShort() {
  const all = listClients();
  if (!all.length) return '(Sin clientes registrados todavía.)';
  return all
    .map(
      (c, i) =>
        `${i + 1}. ${c.name} — ${c.goal} · Semana ${c.currentWeek}/${c.totalWeeks}`
    )
    .join('\n');
}
