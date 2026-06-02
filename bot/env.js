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
// edit). Each task uses the cheapest model that does the job well:
//
//   CHAT_MODEL      — coach web chat + WhatsApp conversation. Only needs to
//                     follow structured instructions, emit tool calls, and write
//                     short confirmation text. gpt-4o-mini handles all of this
//                     and is ~15× cheaper than gpt-4-turbo (the old default).
//                     Override with OPENAI_CHAT_MODEL if a stronger model is ever
//                     needed for the conversation quality.
//   NUTRITION_MODEL — used purely as a nutrition database (per-food macros). The
//                     arithmetic / target-matching is done in JS, but accurate
//                     per-100g facts matter, so we keep the stronger gpt-4o here.
//   TRAINING_MODEL  — training plan refinement (exercise names / descriptions).
//                     Light-weight text work — gpt-4o-mini is plenty.
export const CHAT_MODEL      = process.env.OPENAI_CHAT_MODEL      || 'gpt-4o-mini';
export const NUTRITION_MODEL = process.env.OPENAI_NUTRITION_MODEL || 'gpt-4o';
export const TRAINING_MODEL  = process.env.OPENAI_TRAINING_MODEL  || 'gpt-4o-mini';
