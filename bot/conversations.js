import OpenAI from 'openai';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { CLIENTS } from './clients.js';
import { TRAINING_TOOL, NUTRITION_TOOL } from './tools.js';
import { sendMessage } from './whatsapp.js';
import { savePlan } from './planner.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(__dir, 'state');
mkdirSync(STATE_DIR, { recursive: true });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Registered team members — loaded from env
// Daniel can do BOTH training and nutrition plans
function getUsers() {
  return {
    ...(process.env.ERIKA_PHONE
      ? { [process.env.ERIKA_PHONE]: { name: 'Erika', role: 'trainer' } }
      : {}),
    ...(process.env.DANIEL_PHONE
      ? { [process.env.DANIEL_PHONE]: { name: 'Daniel', role: 'both' } }
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

// ── System prompts ────────────────────────────────────────────

function nextMonday() {
  const d = new Date();
  const day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? 1 : 8 - day));
  return d.toISOString().split('T')[0];
}

function buildSystemPrompt(user) {
  const today = new Date().toLocaleDateString('es-ES', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const nextMon = nextMonday();
  const clientList = CLIENTS.map(
    (c, i) =>
      `${i + 1}. ${c.name} (id: ${c.id}) — ${c.goal}, Semana ${c.currentWeek}/${c.totalWeeks}, ${c.weight}kg, ${c.bodyFat}% grasa corporal`
  ).join('\n');

  const common = `
Hoy es ${today}. La próxima semana empieza el lunes ${nextMon}.

CLIENTES ACTIVOS:
${clientList}

ESTILO:
- Respuestas muy cortas y directas (WhatsApp)
- En español
- Profesional

FLUJO GENERAL:
Cuando el usuario dice "plan para [cliente]":
1. Confirma el cliente y la semana
2. Haz UNA sola pregunta con todos los datos que necesitas (usar bullets)
3. Cuando recibas la respuesta, escribe "[LISTO PARA GENERAR]" — el sistema genera automáticamente
4. Confirma el resultado o pide ajustes
5. Listo.
`.trim();

  if (user.role === 'trainer') {
    return `Eres Erika, Head of Performance en DARE. Preparas planes de entrenamiento semanal.

${common}

PASO 2 - Pregunta única (todas las opciones en un mensaje):
"¿Cuál es tu plan para [cliente] semana ${nextMon}? Dame:
• Días de descanso (ej: Wed, Sun)
• Tipo cada día (ej: Mon-Strength, Tue-Cardio, Wed-Rest)
• Cualquier consideración especial
Puedes escribir libremente, no necesita formato específico."

GENERACIÓN:
Cuando hayas recogido los datos, escribe "[LISTO PARA GENERAR]" y el sistema creará:
- 7 días con ejercicios específicos, series, descansos
- Notas técnicas tuyas para cada sesión
- Todo en JSON, listo para el portal

NO preguntes sobre "formato" o "estructura" — tú solo recoge info, el sistema genera.`;
  }

  return `Eres Daniel, Head of Nutrition en DARE. Preparas planes de nutrición semanal.

${common}

PASO 2 - Pregunta única (todas las opciones en un mensaje):
"¿Cuál es tu plan para [cliente] semana ${nextMon}? Dame:
• Calorías objetivo (ej: 2200)
• Proteína mínima (ej: 180g)
• Restricciones/preferencias (ej: sin lácteos, sin gluten)
• Alimentos destacados a incluir
• Consideraciones especiales (viajes, digestión, etc.)
Puedes escribir libremente."

GENERACIÓN:
Cuando hayas recogido los datos, escribe "[LISTO PARA GENERAR]" y el sistema creará:
- 7 días × 4-5 comidas con recetas detalladas
- Macros calibrados al entrenamiento del día
- Pasos de preparación paso a paso
- Todo en JSON, listo para el portal

NO preguntes sobre "formato" — recoge info, el sistema genera.`;
}

// ── Generation logic ──────────────────────────────────────────

async function generatePlanAsync(phone, state, user) {
  // If Daniel is doing training, act as Erika
  let effectiveRole = user.role;
  if (user.role === 'nutritionist' && state.planType === 'training') {
    effectiveRole = 'trainer';
  }

  const tool = effectiveRole === 'trainer' ? TRAINING_TOOL : NUTRITION_TOOL;
  const baseSystemPrompt = effectiveRole === 'trainer'
    ? buildSystemPrompt({ role: 'trainer' })
    : buildSystemPrompt({ role: 'nutritionist' });

  const genSystemPrompt = baseSystemPrompt + `

INSTRUCCIÓN CRÍTICA: Tienes toda la información necesaria. DEBES llamar la función ${tool.name} AHORA con el plan completo de 7 días. No preguntes nada más. Genera el plan directamente.`;

  try {
    // Convert tools to OpenAI format
    const toolDef = {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    };

    // Build messages with system prompt at the start
    const messagesWithSystem = [
      { role: 'system', content: genSystemPrompt },
      ...state.messages,
    ];

    const response = await openai.chat.completions.create({
      model: 'gpt-4-turbo',
      max_tokens: 4096,
      messages: messagesWithSystem,
      tools: [toolDef],
      tool_choice: { type: 'function', function: { name: tool.name } },
    });

    // Find tool call in response
    const toolCall = response.choices[0].message.tool_calls?.[0];
    if (!toolCall) throw new Error('OpenAI no llamó la función de guardado');

    const input = JSON.parse(toolCall.function.arguments);
    const plan = savePlan(toolCall.function.name, input);
    const summary = formatSummary(input, effectiveRole, plan);

    // Add exchange to history so user can still adjust
    const assistantText = response.choices[0].message.content || '';
    state.messages.push({
      role: 'assistant',
      content: assistantText ? `${assistantText}\n\n${summary}` : summary,
    });
    state.generating = false;
    saveState(phone, state);

    await sendMessage(phone, summary);
  } catch (err) {
    console.error('[generator] error:', err);
    state.generating = false;
    saveState(phone, state);
    await sendMessage(
      phone,
      '❌ Error generando el plan. Por favor escribe más detalles o escribe /reset para reiniciar.'
    );
  }
}

function formatSummary(input, role, savedPlan) {
  const days = input.days;
  const weekOf = input.weekOf;

  if (role === 'trainer') {
    const lines = days.map(d => {
      const e = d.type === 'strength' ? '💪' : d.type === 'cardio' ? '🏃' : '🌿';
      return `${e} ${d.label}: ${d.session}`;
    });
    const status = savedPlan?.nutritionReady
      ? '✅ Plan COMPLETO publicado en el portal.'
      : '⏳ Esperando plan de nutrición de Daniel.';
    return (
      `✅ Plan de entrenamiento guardado · Semana ${weekOf}\n\n` +
      lines.join('\n') +
      `\n\n${status}\n\n¿Algo que ajustar? Dime el cambio o responde "ok" para confirmar.`
    );
  }

  const avgKcal = Math.round(days.reduce((s, d) => s + d.kcal, 0) / 7);
  const avgProt = Math.round(days.reduce((s, d) => s + d.protein, 0) / 7);
  const lines = days.map(d => `• ${d.label}: ${d.kcal} kcal · P${d.protein}g · C${d.carbs}g · G${d.fat}g`);
  const status = savedPlan?.trainingReady
    ? '✅ Plan COMPLETO publicado en el portal del cliente.'
    : '⏳ Esperando plan de entrenamiento de Erika.';
  return (
    `✅ Plan de nutrición guardado · Semana ${weekOf}\n\n` +
    `Media: ${avgKcal} kcal · ${avgProt}g proteína\n\n` +
    lines.join('\n') +
    `\n\n${status}\n\n¿Algo que ajustar? Dime el cambio o responde "ok" para confirmar.`
  );
}

// ── Main handler ──────────────────────────────────────────────

export async function handleIncoming(from, body) {
  const USERS = getUsers();
  const user = USERS[from];

  if (!user) {
    return 'Este número no está registrado en el sistema DARE. Contacta al administrador.';
  }

  // System commands
  const cmd = body.toLowerCase().trim();
  if (cmd === '/reset' || cmd === 'reset') {
    clearState(from);
    return `🔄 Conversación reiniciada. ¡Hola ${user.name}! ¿Para qué cliente quieres preparar el plan?`;
  }

  let state = loadState(from) ?? {
    phone: from,
    role: user.role,
    messages: [],
    generating: false,
    planType: null, // 'training' or 'nutrition' — Daniel decides both
  };

  if (state.generating) {
    return '⏳ Todavía generando el plan. Por favor espera unos segundos...';
  }

  // Detectar si Daniel menciona qué tipo de plan
  if (user.role === 'nutritionist' && !state.planType) {
    if (body.toLowerCase().includes('entrenamiento') || body.toLowerCase().includes('training')) {
      state.planType = 'training';
    } else if (body.toLowerCase().includes('nutrición') || body.toLowerCase().includes('nutrition')) {
      state.planType = 'nutrition';
    }
  }

  state.messages.push({ role: 'user', content: body });

  // Quick chat turn with GPT-4 (fast, no tool use)
  // Build messages with system prompt at the start
  // If Daniel is doing training, use Erika's system prompt
  let systemPrompt = buildSystemPrompt(user);
  if (user.role === 'nutritionist' && state.planType === 'training') {
    systemPrompt = buildSystemPrompt({ role: 'trainer' });
  } else if (user.role === 'nutritionist' && state.planType === 'nutrition') {
    systemPrompt = buildSystemPrompt({ role: 'nutritionist' });
  }

  const messagesWithSystem = [
    { role: 'system', content: systemPrompt },
    ...state.messages,
  ];

  const chatResponse = await openai.chat.completions.create({
    model: 'gpt-4-turbo',
    max_tokens: 1024,
    messages: messagesWithSystem,
  });

  const text = chatResponse.choices[0].message.content ?? '';
  state.messages.push({ role: 'assistant', content: text });

  // If Claude signals it has all info, trigger async generation
  if (text.includes('[LISTO PARA GENERAR]')) {
    state.generating = true;
    saveState(from, state);
    generatePlanAsync(from, state, user).catch(console.error);

    const displayText = text.replace('[LISTO PARA GENERAR]', '').trim();
    return (
      (displayText ? displayText + '\n\n' : '') +
      '⏳ Generando el plan completo con IA... Tarda ~30 segundos. Te aviso cuando esté listo.'
    );
  }

  saveState(from, state);
  return text;
}
