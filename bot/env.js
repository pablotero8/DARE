import dotenv from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));

// Local dev: load bot/.env. In production (Railway) vars come from
// process.env, so a missing file here is fine (dotenv ignores it).
dotenv.config({ path: join(__dir, '.env') });
// Also try the project-root .env as a fallback.
dotenv.config({ path: join(__dir, '..', '.env') });

// ── Model selection ───────────────────────────────────────────
// Centralized so models can be changed per-deployment via env vars (no code
// edit). Defaults are the current production choices.
//   CHAT_MODEL      — coach web chat + WhatsApp conversation (tool calls, replies)
//   NUTRITION_MODEL — macro engine: sizes portions to hit daily targets (needs strong arithmetic)
//   TRAINING_MODEL  — training plan refinement (exercise names / descriptions)
export const CHAT_MODEL      = process.env.OPENAI_CHAT_MODEL      || 'gpt-4-turbo';
export const NUTRITION_MODEL = process.env.OPENAI_NUTRITION_MODEL || 'gpt-4o';
export const TRAINING_MODEL  = process.env.OPENAI_TRAINING_MODEL  || 'gpt-4o-mini';
