import OpenAI from 'openai';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { formatClientsForPrompt, listClientsShort, createClient, deleteClient, findClient, resetClientPassword } from './clients.js';
import { TRAINING_TOOL, NUTRITION_TOOL } from './tools.js';
import { sendMessage } from './whatsapp.js';
import { savePlan } from './planner.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(__dir, 'state');
mkdirSync(STATE_DIR, { recursive: true });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Users / roles ─────────────────────────────────────────────
// Erika  = admin · specialty: training  (creates clients, generates training plans)
// Daniel = admin · specialty: both      (creates clients, generates training + nutrition plans)

function getUsers() {
  return {
    ...(process.env.ERIKA_PHONE
      ? { [process.env.ERIKA_PHONE]: { name: 'Erika', role: 'admin', specialty: 'training' } }
      : {}),
    ...(process.env.DANIEL_PHONE
      ? { [process.env.DANIEL_PHONE]: { name: 'Daniel', role: 'admin', specialty: 'both' } }
      : {}),
  };
}

// ── State persistence ─────────────────────────────────────────

function statePath(phone) {
  return join(STATE_DIR, phone.replace(/\W/g, '_') + '.json');
}

function loadState(phone) {
  const p = statePath(phone);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function saveState(phone, state) {
  writeFileSync(statePath(phone), JSON.stringify(state, null, 2));
}

function clearState(phone) {
  const p = statePath(phone);
  if (existsSync(p)) unlinkSync(p);
}

// ── Date helpers ──────────────────────────────────────────────

function nextMonday() {
  const d = new Date();
  const day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? 1 : 8 - day));
  return d.toISOString().split('T')[0];
}

// ── System prompts ────────────────────────────────────────────

function buildSystemPrompt(user, planContext = null) {
  const today = new Date().toLocaleDateString('es-ES', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const nextMon = nextMonday();
  const clientList = formatClientsForPrompt();

  const teamLine =
    user.name === 'Erika'
      ? 'Tu compañero es Daniel (nutrición, entrenamiento y co-administrador del sistema).'
      : 'Tu compañera es Erika (entrenamiento y co-administradora del sistema).';

  const common = `
Hoy es ${today}. La próxima semana empieza el lunes ${nextMon}.

CLIENTES ACTIVOS:
${clientList}

EQUIPO DARE:
- Erika Silva — Performance & Biomechanics Lead (admin)
- Daniel Otero — Nutrition Science & Culinary Execution
${teamLine}

ESTILO:
- Habla siempre en primera persona como ${user.name}.
- Refiérete a tu compañero(a) por su nombre (Erika / Daniel) cuando aparezca en la conversación.
- Respuestas muy cortas y directas (WhatsApp).
- En español. Profesional pero cálido.

FLUJO GENERAL:
Cuando el usuario dice "plan para [cliente]":
1. Confirma cliente y semana ("Perfecto — plan para [cliente] semana ${nextMon}.")
2. Haz UNA sola pregunta con todos los datos que necesitas (usar bullets).
3. Cuando recibas la respuesta, escribe "[LISTO PARA GENERAR]" — el sistema genera automáticamente.
4. Confirma el resultado o pide ajustes.
5. Listo. Te avisaré cuando ${user.name === 'Erika' ? 'Daniel' : 'Erika'} suba su parte.
`.trim();

  // ── Role-specific ─────────────────────────────────────────

  const adminCommands = `
GESTIÓN DE CLIENTES (tú y tu compañero(a) podéis hacerlo):
- "/nuevo-cliente" → flujo guiado para crear cliente nuevo
- "/listar" → ver todos los clientes
- "/eliminar [id]" → eliminar cliente
- "/password [id]" → resetear contraseña de un cliente`;

  // Erika (admin · specialty: training)
  if (user.role === 'admin' && user.name === 'Erika') {
    return `Eres Erika, Performance & Biomechanics Lead en DARE Dubai. Co-administras el sistema junto con Daniel.
Saluda al usuario por su nombre cuando proceda.

${common}

PASO 2 — Pregunta única para PLAN DE ENTRENAMIENTO:
"¿Cuál es el plan para [cliente] semana ${nextMon}? Dime:
• Días de descanso (ej: Wed, Sun)
• Tipo cada día (ej: Mon-Strength, Tue-Cardio, Wed-Rest)
• Consideraciones especiales (lesiones, viajes, energía)
Escribe libremente, no hace falta formato específico."

GENERACIÓN:
Cuando hayas recogido los datos, escribe "[LISTO PARA GENERAR]" y el sistema creará:
- 7 días con ejercicios, series, descansos
- Una nota tuya (Erika) para cada sesión, con tu voz: técnica, intención, motivación
- Todo en JSON, listo para el portal
${adminCommands}

NO preguntes sobre "formato" o "estructura" — tú solo recoge info, el sistema genera.`;
  }

  // Daniel (admin · specialty: both — training + nutrition)
  const isTraining = planContext === 'training';

  if (isTraining) {
    return `Eres Daniel Otero, Nutrition Science & Culinary Execution Lead en DARE Dubai. Hoy estás cubriendo el plan de entrenamiento. Co-administras el sistema junto con Erika.

${common}

PASO 2 — Pregunta única para PLAN DE ENTRENAMIENTO:
"¿Plan de entrenamiento para [cliente] semana ${nextMon}? Dame:
• Días de descanso (ej: Wed, Sun)
• Tipo cada día (ej: Mon-Strength, Tue-Cardio, Wed-Rest)
• Consideraciones especiales (lesiones, viajes, energía)"

GENERACIÓN:
Cuando hayas recogido los datos, escribe "[LISTO PARA GENERAR]" — el sistema generará 7 días con ejercicios, badges (series/reps), notas por día.
${adminCommands}

NO preguntes sobre "formato" — recoge info, el sistema genera.`;
  }

  return `Eres Daniel Otero, Nutrition Science & Culinary Execution Lead en DARE Dubai. Co-administras el sistema junto con Erika.

${common}

PASO 2 — Pregunta única para PLAN DE NUTRICIÓN:
"¿Plan nutricional para [cliente] semana ${nextMon}? Dame:
• Calorías objetivo (ej: 2200)
• Proteína mínima (ej: 180g)
• Restricciones / preferencias (sin lácteos, sin gluten, etc.)
• Alimentos destacados a incluir
• Consideraciones (viajes, digestión, cenas sociales...)"

GENERACIÓN:
Cuando hayas recogido los datos, escribe "[LISTO PARA GENERAR]" — el sistema generará 7 días × 4-5 comidas con recetas, macros y pasos. Cada día llevará una nota tuya (Daniel) con la lógica nutricional.

Si el plan tiene una contraparte de entrenamiento ya guardada, menciónalo: "Erika ya subió la parte de entreno — vamos a cerrar la semana."
${adminCommands}

NO preguntes sobre "formato" — recoge info, el sistema genera.`;
}

// ── Admin commands (Erika only) ───────────────────────────────

async function handleAdminCommand(from, body, state) {
  const text = body.trim();
  const lower = text.toLowerCase();

  // Flujo de creación de cliente
  if (state.creatingClient) {
    return continueClientCreation(from, text, state);
  }

  if (lower === '/nuevo-cliente' || lower === '/nuevo cliente' || lower === '/new-client') {
    state.creatingClient = { step: 'name', data: {} };
    saveState(from, state);
    return '🆕 Vamos a crear un cliente nuevo.\n\n1/5 — ¿Nombre completo del cliente?';
  }

  if (lower === '/listar' || lower === '/list' || lower === '/clientes') {
    return '📋 Clientes registrados:\n\n' + listClientsShort();
  }

  if (lower.startsWith('/eliminar ') || lower.startsWith('/delete ')) {
    const id = text.split(/\s+/)[1];
    const ok = deleteClient(id);
    return ok ? `✅ Cliente "${id}" eliminado.` : `❌ No encontré ningún cliente con id "${id}".`;
  }

  if (lower.startsWith('/password ') || lower.startsWith('/reset-password ')) {
    const id = text.split(/\s+/)[1];
    const newPwd = await resetClientPassword(id);
    return newPwd
      ? `🔑 Nueva contraseña para "${id}":\n\n*${newPwd}*\n\nCompártela con el cliente por canal seguro.`
      : `❌ No encontré "${id}".`;
  }

  return null;
}

async function continueClientCreation(from, text, state) {
  const c = state.creatingClient;
  const lower = text.toLowerCase();

  if (lower === '/cancelar' || lower === 'cancel') {
    state.creatingClient = null;
    saveState(from, state);
    return '🚫 Creación de cliente cancelada.';
  }

  switch (c.step) {
    case 'name':
      c.data.name = text;
      c.step = 'email';
      saveState(from, state);
      return `2/5 — Email del cliente (será su usuario para entrar al portal):`;

    case 'email':
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text)) {
        return '❌ Email inválido. Intenta de nuevo, o escribe /cancelar.';
      }
      c.data.email = text;
      c.step = 'goal';
      saveState(from, state);
      return `3/5 — Protocolo / objetivo (ej: Fat-Loss Protocol, Muscle Gain, Recomp):`;

    case 'goal':
      c.data.goal = text;
      c.step = 'weeks';
      saveState(from, state);
      return `4/5 — Duración del protocolo (semanas totales, ej: 12):`;

    case 'weeks':
      const w = parseInt(text, 10);
      if (!w || w < 1 || w > 52) {
        return '❌ Número inválido. Dame solo el número de semanas (1-52), o /cancelar.';
      }
      c.data.totalWeeks = w;
      c.data.currentWeek = 1;
      c.step = 'notes';
      saveState(from, state);
      return `5/5 — Notas iniciales (gym, restricciones, lesiones, lo que sea relevante). Si no hay nada, escribe "ninguna".`;

    case 'notes':
      c.data.notes = lower === 'ninguna' || lower === 'none' ? null : text;

      // Create the client
      try {
        const { client, generatedPassword } = await createClient(c.data);
        state.creatingClient = null;
        saveState(from, state);

        return (
          `✅ Cliente creado:\n\n` +
          `*${client.name}*\n` +
          `Email: ${client.email}\n` +
          `Protocolo: ${client.goal} (${client.totalWeeks} semanas)\n` +
          `ID: ${client.id}\n\n` +
          `🔑 Contraseña inicial: *${generatedPassword}*\n\n` +
          `Compártesela con el cliente por canal seguro. Puede cambiarla desde el portal.\n\n` +
          `Ya puedes generar planes para ${client.name.split(' ')[0]}.`
        );
      } catch (err) {
        state.creatingClient = null;
        saveState(from, state);
        return `❌ Error al crear cliente: ${err.message}`;
      }
  }
}

// ── Plan generation ───────────────────────────────────────────

async function generatePlanAsync(phone, state, user) {
  const isTraining = state.planType === 'training';
  const tool = isTraining ? TRAINING_TOOL : NUTRITION_TOOL;

  const baseSystemPrompt = buildSystemPrompt(user, state.planType);

  const genSystemPrompt = baseSystemPrompt + `

INSTRUCCIÓN CRÍTICA: Tienes toda la información necesaria. DEBES llamar la función ${tool.name} AHORA con el plan completo de 7 días. No preguntes nada más. Genera el plan directamente.

Recuerda firmar las notas con tu voz (${user.name === 'Erika' ? 'Erika' : 'Daniel'}).`;

  try {
    const toolDef = {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    };

    const messagesWithSystem = [
      { role: 'system', content: genSystemPrompt },
      ...trimMessages(state.messages),
    ];

    const response = await openai.chat.completions.create({
      model: 'gpt-4-turbo',
      max_tokens: 4096,
      messages: messagesWithSystem,
      tools: [toolDef],
      tool_choice: { type: 'function', function: { name: tool.name } },
    });

    const toolCall = response.choices[0].message.tool_calls?.[0];
    if (!toolCall) throw new Error('OpenAI no llamó la función de guardado');

    const input = JSON.parse(toolCall.function.arguments);
    const plan = savePlan(toolCall.function.name, input);
    const summary = formatSummary(input, isTraining ? 'trainer' : 'nutritionist', plan, user);

    state.messages.push({ role: 'assistant', content: summary });
    state.generating = false;
    state.planType = null;
    saveState(phone, state);

    await sendMessage(phone, summary);

    // ── Multi-party notifications when plan is fully published ──
    if (plan.trainingReady && plan.nutritionReady && plan.publishedAt) {
      await broadcastPublishedPlan(plan, input.clientId);
      // Plan completo — limpiar conversación para el siguiente cliente
      clearState(phone);
    }
  } catch (err) {
    console.error('[generator] error:', err);
    state.generating = false;
    saveState(phone, state);
    await sendMessage(
      phone,
      '❌ Error generando el plan. Por favor escribe más detalles o /reset para reiniciar.'
    );
  }
}

async function broadcastPublishedPlan(plan, clientId) {
  // Import lazily to avoid circular deps
  const { getClientById } = await import('./clients.js');
  const client = getClientById(clientId);
  if (!client) return;

  const weekOf = plan.weekOf;

  const msgErika = `✅ Plan semana ${weekOf} de ${client.name} PUBLICADO en el portal. Entreno + nutrición ya están disponibles para el cliente.`;
  const msgDaniel = `✅ Plan semana ${weekOf} de ${client.name} PUBLICADO. Tu nutrición + el entreno de Erika ya están live en el portal.`;
  const msgAdmin = `📡 [DARE] Plan ${client.name} (${weekOf}) publicado en el portal — entreno + nutrición completos.`;
  const msgClient = `Hola ${client.name.split(' ')[0]}, tu plan semanal de DARE para la semana del ${weekOf} ya está disponible en el portal. Erika y Daniel lo han preparado para ti — entra y revísalo cuando quieras.`;

  const recipients = [];
  if (process.env.ERIKA_PHONE) recipients.push({ phone: process.env.ERIKA_PHONE, body: msgErika });
  if (process.env.DANIEL_PHONE) recipients.push({ phone: process.env.DANIEL_PHONE, body: msgDaniel });
  if (process.env.ADMIN_PHONE) recipients.push({ phone: process.env.ADMIN_PHONE, body: msgAdmin });
  if (client.phone) recipients.push({ phone: `whatsapp:${client.phone}`, body: msgClient });

  for (const r of recipients) {
    try {
      await sendMessage(r.phone, r.body);
    } catch (err) {
      console.error('[notify] failed to', r.phone, err.message);
    }
  }
}

function formatSummary(input, role, savedPlan, user) {
  const days = input.days;
  const weekOf = input.weekOf;
  const partnerName = user.name === 'Erika' ? 'Daniel' : 'Erika';

  if (role === 'trainer') {
    const lines = days.map(d => {
      const e = d.type === 'strength' ? '💪' : d.type === 'cardio' ? '🏃' : '🌿';
      return `${e} ${d.label}: ${d.session}`;
    });
    const status = savedPlan?.nutritionReady
      ? '✅ Plan COMPLETO — entreno + nutrición publicados en el portal.'
      : `⏳ Esperando la parte de nutrición de ${partnerName}.`;
    return (
      `✅ ${user.name === 'Erika' ? 'Erika' : 'Plan de entrenamiento'} guardado · Semana ${weekOf}\n\n` +
      lines.join('\n') +
      `\n\n${status}\n\n¿Algo que ajustar? Dime el cambio o responde "ok" para confirmar.`
    );
  }

  const avgKcal = Math.round(days.reduce((s, d) => s + d.kcal, 0) / 7);
  const avgProt = Math.round(days.reduce((s, d) => s + d.protein, 0) / 7);
  const lines = days.map(d => `• ${d.label}: ${d.kcal} kcal · P${d.protein}g · C${d.carbs}g · G${d.fat}g`);
  const status = savedPlan?.trainingReady
    ? '✅ Plan COMPLETO — entreno + nutrición publicados en el portal.'
    : `⏳ Esperando la parte de entrenamiento de ${partnerName}.`;
  return (
    `✅ Plan de nutrición guardado · Semana ${weekOf}\n\n` +
    `Media: ${avgKcal} kcal · ${avgProt}g proteína\n\n` +
    lines.join('\n') +
    `\n\n${status}\n\n¿Algo que ajustar? Dime el cambio o responde "ok" para confirmar.`
  );
}

// ── Sliding window — keeps last 40 messages for OpenAI context ─

const CONTEXT_WINDOW = 40;

function trimMessages(messages) {
  if (messages.length <= CONTEXT_WINDOW) return messages;
  // Always keep pairs (user+assistant) to avoid orphaned roles
  const trimmed = messages.slice(-CONTEXT_WINDOW);
  // Ensure first message is from user
  if (trimmed[0]?.role === 'assistant') return trimmed.slice(1);
  return trimmed;
}

// ── Main handler ──────────────────────────────────────────────

export async function handleIncoming(from, body) {
  const USERS = getUsers();
  const user = USERS[from];

  if (!user) {
    return 'Este número no está registrado en el sistema DARE. Contacta con Erika o Daniel.';
  }

  // System commands
  const cmd = body.toLowerCase().trim();
  if (cmd === '/reset' || cmd === 'reset') {
    clearState(from);
    return `🔄 Conversación reiniciada. Hola ${user.name} 👋 ¿En qué te ayudo?`;
  }

  let state = loadState(from) ?? {
    phone: from,
    role: user.role,
    messages: [],
    generating: false,
    planType: null,
    creatingClient: null,
  };

  if (state.generating) {
    return '⏳ Todavía estoy generando el plan. Dame unos segundos más...';
  }

  // ── Admin commands (Erika + Daniel) ─────────────────────
  if (user.role === 'admin') {
    const adminReply = await handleAdminCommand(from, body, state);
    if (adminReply !== null) return adminReply;
  }

  // Daniel (specialty: both) — detect plan type from message
  if (user.role === 'admin' && user.specialty === 'both' && !state.planType) {
    const lower = body.toLowerCase();
    if (lower.includes('entrenamiento') || lower.includes('entreno') || lower.includes('training')) {
      state.planType = 'training';
    } else if (lower.includes('nutrición') || lower.includes('nutricion') || lower.includes('nutrition') || lower.includes('comida') || lower.includes('dieta')) {
      state.planType = 'nutrition';
    }
  }

  // Erika (specialty: training) defaults to training
  if (user.role === 'admin' && user.specialty === 'training' && !state.planType) {
    state.planType = 'training';
  }

  state.messages.push({ role: 'user', content: body });

  const systemPrompt = buildSystemPrompt(user, state.planType);
  const messagesWithSystem = [
    { role: 'system', content: systemPrompt },
    ...trimMessages(state.messages),
  ];

  const chatResponse = await openai.chat.completions.create({
    model: 'gpt-4-turbo',
    max_tokens: 1024,
    messages: messagesWithSystem,
  });

  const text = chatResponse.choices[0].message.content ?? '';
  state.messages.push({ role: 'assistant', content: text });

  if (text.includes('[LISTO PARA GENERAR]')) {
    state.generating = true;
    saveState(from, state);
    generatePlanAsync(from, state, user).catch(console.error);

    const displayText = text.replace('[LISTO PARA GENERAR]', '').trim();
    return (
      (displayText ? displayText + '\n\n' : '') +
      '⏳ Generando el plan completo... ~30s. Te aviso cuando esté listo.'
    );
  }

  saveState(from, state);
  return text;
}
