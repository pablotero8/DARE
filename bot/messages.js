import db from './db.js';

// ── Client ⇄ coach messaging ──────────────────────────────────
// A single shared thread per client. Both coaches read/write the same thread.
// from_role marks the author; coach_id records which coach replied.

const MAX_LEN = 2000;

// Insert a message. fromRole 'client' → coachId is null. 'coach' → coachId set.
export function addMessage(clientId, fromRole, text, coachId = null) {
  const clean = String(text ?? '').trim().slice(0, MAX_LEN);
  if (!clean) return null;
  const info = db.prepare(`
    INSERT INTO messages (client_id, coach_id, from_role, text)
    VALUES (?, ?, ?, ?)
  `).run(clientId, coachId, fromRole, clean);
  return getMessageById(info.lastInsertRowid);
}

function getMessageById(id) {
  const r = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  return r ? mapRow(r) : null;
}

function mapRow(r) {
  return {
    id: r.id, clientId: r.client_id, coachId: r.coach_id,
    fromRole: r.from_role, text: r.text,
    createdAt: r.created_at, readAt: r.read_at,
  };
}

// Full thread for a client, oldest → newest.
export function getThread(clientId, limit = 200) {
  return db.prepare(`
    SELECT * FROM messages WHERE client_id = ?
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `).all(clientId, limit).map(mapRow);
}

// Mark every message written by `fromRole` for this client as read (the other
// party just opened the thread). Returns the number of rows touched.
export function markRead(clientId, fromRole) {
  const info = db.prepare(`
    UPDATE messages SET read_at = datetime('now')
    WHERE client_id = ? AND from_role = ? AND read_at IS NULL
  `).run(clientId, fromRole);
  return info.changes;
}

// How many unread messages from `fromRole` exist for this client.
export function unreadCount(clientId, fromRole) {
  const r = db.prepare(`
    SELECT COUNT(*) AS n FROM messages
    WHERE client_id = ? AND from_role = ? AND read_at IS NULL
  `).get(clientId, fromRole);
  return r?.n || 0;
}

// Unread-from-client counts keyed by clientId — powers the coach sidebar badges.
export function unreadByClientForCoach() {
  const rows = db.prepare(`
    SELECT client_id, COUNT(*) AS n FROM messages
    WHERE from_role = 'client' AND read_at IS NULL
    GROUP BY client_id
  `).all();
  const map = {};
  rows.forEach(r => { map[r.client_id] = r.n; });
  return map;
}
