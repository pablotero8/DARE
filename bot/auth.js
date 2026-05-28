import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'crypto';
import db from './db.js';

const SALT_ROUNDS = 10;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-please-' + randomBytes(16).toString('hex');
const TOKEN_TTL_DAYS = 30;

// ── Password hashing ──────────────────────────────────────────

export async function hashPassword(plain) {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

// Random password of 10 chars (letters + numbers), no ambiguous (0/O, 1/l/I)
export function generatePassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let p = '';
  for (let i = 0; i < 10; i++) {
    p += chars[Math.floor(Math.random() * chars.length)];
  }
  return p;
}

// ── JWT ───────────────────────────────────────────────────────

export function signToken(clientId) {
  return jwt.sign({ sub: clientId }, JWT_SECRET, { expiresIn: `${TOKEN_TTL_DAYS}d` });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// Persist token row (lets us revoke via DELETE)
export function persistSession(token, clientId) {
  const expires = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(
    'INSERT OR REPLACE INTO sessions (token, client_id, expires_at) VALUES (?, ?, ?)'
  ).run(token, clientId, expires);
}

export function revokeSession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

// ── Role detection from phone ─────────────────────────────────

export function getRoleByPhone(phone) {
  if (!phone) return null;
  if (phone === process.env.ERIKA_PHONE) return 'admin'; // Erika = admin
  if (phone === process.env.DANIEL_PHONE) return 'admin'; // Daniel = also admin
  return null;
}

export function isAdmin(phone) {
  return getRoleByPhone(phone) === 'admin';
}
