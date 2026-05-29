import dotenv from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));

// Local dev: load bot/.env. In production (Railway) vars come from
// process.env, so a missing file here is fine (dotenv ignores it).
dotenv.config({ path: join(__dir, '.env') });
// Also try the project-root .env as a fallback.
dotenv.config({ path: join(__dir, '..', '.env') });
