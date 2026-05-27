// Client database — add new clients here
export const CLIENTS = [
  {
    id: 'alex-hammond',
    name: 'Alex Hammond',
    initials: 'AH',
    email: 'client@dare.ae',
    goal: 'Fat-Loss Protocol',
    currentWeek: 8,
    totalWeeks: 12,
    height: 181,
    weight: 82.8,
    bodyFat: 18.8,
    lean: 67.4,
    notes: 'Entrena en gym privado. Sin restricciones alimentarias.',
  },
];

export function findClient(query) {
  const q = query.toLowerCase().trim();
  return CLIENTS.find(
    c =>
      c.name.toLowerCase().includes(q) ||
      q.includes(c.name.split(' ')[0].toLowerCase()) ||
      c.id.includes(q)
  );
}

export function getClientById(id) {
  return CLIENTS.find(c => c.id === id);
}

export function listClients() {
  return CLIENTS.map(
    (c, i) =>
      `${i + 1}. ${c.name} — ${c.goal} · Semana ${c.currentWeek}/${c.totalWeeks} · ${c.weight}kg`
  ).join('\n');
}
