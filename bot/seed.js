// Seed script — run once to populate initial demo client
// Usage: node seed.js
import './env.js';
import { createClient, getClientByEmail } from './clients.js';

const DEMO = {
  name: 'Alex Hammond',
  email: 'client@dare.ae',
  password: 'dare2026', // public demo password
  goal: 'Fat-Loss Protocol',
  currentWeek: 8,
  totalWeeks: 12,
  height: 181,
  weight: 82.8,
  bodyFat: 18.8,
  lean: 67.4,
  notes: 'Entrena en gym privado. Sin restricciones alimentarias.',
};

(async () => {
  const existing = getClientByEmail(DEMO.email);
  if (existing) {
    console.log(`✓ Cliente demo ya existe: ${existing.name} (${existing.email})`);
    process.exit(0);
  }
  const { client, generatedPassword } = await createClient(DEMO);
  console.log('✓ Cliente demo creado:');
  console.log(`  Nombre: ${client.name}`);
  console.log(`  Email: ${client.email}`);
  console.log(`  Password: ${DEMO.password} (definida manualmente)`);
  console.log(`  ID: ${client.id}`);
  process.exit(0);
})();
