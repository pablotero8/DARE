// Claude tool definitions — match exactly the JSON shape client.html expects

export const TRAINING_TOOL = {
  name: 'save_training_plan',
  description: 'Guarda el plan de entrenamiento semanal completo para un cliente. Llama esta función cuando tengas toda la información necesaria.',
  input_schema: {
    type: 'object',
    required: ['clientId', 'weekOf', 'days'],
    properties: {
      clientId: { type: 'string' },
      weekOf: {
        type: 'string',
        description: 'Lunes de la semana en formato YYYY-MM-DD',
      },
      days: {
        type: 'array',
        minItems: 7,
        maxItems: 7,
        items: {
          type: 'object',
          required: ['label', 'fullDate', 'type', 'session', 'note', 'noteType'],
          properties: {
            label: { type: 'string', enum: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] },
            fullDate: {
              type: 'string',
              description: 'Ej: Monday, 2 June 2026',
            },
            type: { type: 'string', enum: ['strength', 'cardio', 'rest'] },
            session: {
              type: 'string',
              description: 'Nombre de la sesión. Ej: Upper Body, HIIT, Active Rest',
            },
            items: {
              type: 'array',
              description: 'Ejercicios para días de fuerza o cardio',
              items: {
                type: 'object',
                required: ['name', 'detail', 'badge'],
                properties: {
                  name: { type: 'string' },
                  detail: {
                    type: 'string',
                    description: 'Detalles: calentamiento, técnica, descanso',
                  },
                  badge: {
                    type: 'string',
                    description: 'Ej: 4×6 @80%, 8 rounds, 40 min',
                  },
                  gold: {
                    type: 'boolean',
                    description: 'true para días de cardio (badge dorado)',
                  },
                },
              },
            },
            activities: {
              type: 'array',
              description: 'Actividades de recuperación para días de descanso',
              items: {
                type: 'object',
                required: ['name', 'detail'],
                properties: {
                  name: { type: 'string' },
                  detail: { type: 'string' },
                },
              },
            },
            note: {
              type: 'string',
              description: 'Nota personal de Erika para este día: técnica, motivación, por qué esta sesión',
            },
            noteType: { type: 'string', enum: ['strength', 'cardio', 'rest'] },
          },
        },
      },
    },
  },
};

export const NUTRITION_TOOL = {
  name: 'save_nutrition_plan',
  description: 'Guarda el plan de nutrición semanal completo para un cliente. Llama esta función cuando tengas toda la información necesaria.',
  input_schema: {
    type: 'object',
    required: ['clientId', 'weekOf', 'days'],
    properties: {
      clientId: { type: 'string' },
      weekOf: { type: 'string' },
      days: {
        type: 'array',
        minItems: 7,
        maxItems: 7,
        items: {
          type: 'object',
          required: ['label', 'kcal', 'protein', 'carbs', 'fat', 'meals', 'note'],
          properties: {
            label: { type: 'string', enum: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] },
            kcal: { type: 'number' },
            protein: { type: 'number', description: 'Gramos de proteína' },
            carbs: { type: 'number', description: 'Gramos de carbohidratos' },
            fat: { type: 'number', description: 'Gramos de grasa' },
            meals: {
              type: 'array',
              description: '4-5 comidas con horarios, ingredientes y pasos de preparación',
              items: {
                type: 'object',
                required: ['time', 'name', 'desc', 'kcal', 'steps'],
                properties: {
                  time: { type: 'string', description: 'Horario HH:MM' },
                  name: { type: 'string' },
                  desc: {
                    type: 'string',
                    description: 'Descripción breve: ingredientes principales',
                  },
                  kcal: { type: 'number' },
                  ingredients: {
                    type: 'array',
                    description: 'Ingredientes con cantidades EXACTAS (en crudo) para esta comida. Base de la lista de la compra semanal.',
                    items: {
                      type: 'object',
                      required: ['item', 'qty', 'unit'],
                      properties: {
                        item: { type: 'string', description: 'Nombre del ingrediente. Ej: Chicken breast, Brown rice' },
                        qty:  { type: 'number', description: 'Cantidad numérica. Ej: 200, 1.5' },
                        unit: { type: 'string', description: 'Unidad: g, ml, unit (piezas), tbsp, etc.' },
                      },
                    },
                  },
                  steps: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Pasos de preparación detallados, claros y ejecutables',
                  },
                },
              },
            },
            note: {
              type: 'string',
              description: 'Nota de Daniel: por qué esta nutrición hoy, objetivos del día, consejos',
            },
          },
        },
      },
    },
  },
};

export const FILL_NUTRITION_FROM_TEXT_TOOL = {
  name: 'fill_nutrition_from_text',
  description: 'Rellena la tabla interactiva de nutrición a partir de un plan semanal que el coach PEGA como texto libre (varios días con sus comidas, en cualquier idioma). Úsalo SIEMPRE que el coach pegue un plan de comidas de varios días en lugar de pedir una tabla vacía. Para CADA día: identifica el día de la semana, mapea cada comida a uno de los 5 huecos fijos (breakfast, morningSnack, lunch, snack, dinner) y combina los alimentos de esa comida en UN solo texto separado por comas. IMPORTANTE: traduce TODOS los alimentos al INGLÉS (ej: "3 huevos enteros" → "3 whole eggs"; "200 g claras" → "200g egg whites"; "60 g avena sin gluten" → "60g gluten-free oats"; "Ensalada verde" → "Green salad"). NO inventes ni rellenes macros (kcal/proteína/carbos/grasa): el coach los añade a mano después en la tabla.',
  input_schema: {
    type: 'object',
    required: ['clientId', 'weekOf', 'clientName', 'days'],
    properties: {
      clientId:   { type: 'string', description: 'ID del cliente (ej: alex-hammond)' },
      weekOf:     { type: 'string', description: 'Lunes de la semana en formato YYYY-MM-DD' },
      clientName: { type: 'string', description: 'Nombre completo del cliente' },
      days: {
        type: 'array',
        description: 'Un objeto por cada día presente en el texto (1-7). Los días que NO aparezcan en el texto se omiten y quedan en blanco en la tabla.',
        items: {
          type: 'object',
          required: ['label', 'meals'],
          properties: {
            label: {
              type: 'string',
              enum: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
              description: 'Día de la semana al que corresponde (Lunes→Mon, Martes→Tue, Miércoles→Wed, Jueves→Thu, Viernes→Fri, Sábado→Sat, Domingo→Sun)',
            },
            note: { type: 'string', description: 'Nota del día si el coach escribió alguna (opcional)' },
            meals: {
              type: 'object',
              description: 'Alimentos por hueco de comida, cada uno como UN texto en INGLÉS separado por comas. Omite los huecos sin comida.',
              properties: {
                breakfast:    { type: 'string', description: 'Desayuno. Ej: "3 whole eggs, 200g egg whites, 60g gluten-free oats, 100g berries"' },
                morningSnack: { type: 'string', description: 'Media mañana / almuerzo (si lo hay)' },
                lunch:        { type: 'string', description: 'Comida del mediodía' },
                snack:        { type: 'string', description: 'Merienda / snack de tarde' },
                dinner:       { type: 'string', description: 'Cena' },
              },
            },
          },
        },
      },
    },
  },
};

export const RESET_PASSWORD_TOOL = {
  name: 'reset_client_password',
  description: 'Resetea la contraseña de un cliente y devuelve la nueva contraseña temporal. Úsalo cuando un cliente haya olvidado su contraseña.',
  input_schema: {
    type: 'object',
    required: ['clientId'],
    properties: {
      clientId: { type: 'string', description: 'ID del cliente (ej: diego-tero). Búscalo en la lista de clientes activos.' },
    },
  },
};

export const SHOW_TEMPLATE_TOOL = {
  name: 'show_plan_template',
  description: 'Muestra al coach una tabla interactiva para rellenar el plan semanal. Úsalo SIEMPRE que el coach quiera crear un plan y hayas confirmado cliente y semana. NUNCA escribas una plantilla de texto — usa siempre esta función.',
  input_schema: {
    type: 'object',
    required: ['clientId', 'weekOf', 'clientName'],
    properties: {
      clientId:   { type: 'string', description: 'ID del cliente (ej: alex-hammond)' },
      weekOf:     { type: 'string', description: 'Lunes de la semana en formato YYYY-MM-DD' },
      clientName: { type: 'string', description: 'Nombre completo del cliente' },
    },
  },
};

export const PREFILL_PLAN_TABLE_TOOL = {
  name: 'prefill_plan_table',
  description: `Rellena la tabla interactiva del plan EN BLOQUE a partir de una instrucción del coach, y la muestra para revisar y guardar. Úsalo para comandos como "rellena todos los días con 1600 kcal, 125 proteína, 155 carbos, 55 grasas", "pon 2200 kcal de lunes a viernes", "copia el desayuno a toda la semana", o para preparar la edición de un plan existente. Incluye SOLO los días que el coach quiera tocar (los demás quedan en blanco o conservan el plan existente). Si ya existe un plan esa semana, tus valores se superponen sobre él. El cálculo exacto de gramos por ingrediente se hace al guardar — tú solo fijas los objetivos diarios y, si los menciona, los platos.`,
  input_schema: {
    type: 'object',
    required: ['clientId', 'weekOf', 'clientName', 'days'],
    properties: {
      clientId:   { type: 'string', description: 'ID del cliente (ej: alex-hammond)' },
      weekOf:     { type: 'string', description: 'Lunes de la semana en formato YYYY-MM-DD' },
      clientName: { type: 'string', description: 'Nombre completo del cliente' },
      days: {
        type: 'array',
        description: 'Un objeto por cada día que quieras rellenar (1-7). Omite los días que deben quedar en blanco.',
        items: {
          type: 'object',
          required: ['label'],
          properties: {
            label: { type: 'string', enum: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] },
            // ── Nutrición ──
            kcal:    { type: 'number', description: 'Objetivo de kcal del día (solo nutrición)' },
            protein: { type: 'number', description: 'Gramos de proteína objetivo (solo nutrición)' },
            carbs:   { type: 'number', description: 'Gramos de carbohidratos objetivo (solo nutrición)' },
            fat:     { type: 'number', description: 'Gramos de grasa objetivo (solo nutrición)' },
            meals: {
              type: 'object',
              description: 'Platos por hueco, cada uno como UN texto en INGLÉS separado por comas (solo nutrición). Omite los huecos vacíos.',
              properties: {
                breakfast:    { type: 'string' },
                morningSnack: { type: 'string' },
                lunch:        { type: 'string' },
                snack:        { type: 'string' },
                dinner:       { type: 'string' },
              },
            },
            // ── Entrenamiento ──
            type:    { type: 'string', enum: ['strength', 'cardio', 'rest'], description: 'Tipo de día (solo entrenamiento)' },
            session: { type: 'string', description: 'Nombre de la sesión, ej: Upper Body Push (solo entrenamiento)' },
            exercises: {
              type: 'array',
              description: 'Ejercicios del día (solo entrenamiento)',
              items: {
                type: 'object',
                required: ['name'],
                properties: {
                  name:     { type: 'string' },
                  setsReps: { type: 'string', description: 'Ej: 4×8 @70%' },
                  notes:    { type: 'string', description: 'Técnica, descanso, tempo' },
                },
              },
            },
            note: { type: 'string', description: 'Nota del coach para el día' },
          },
        },
      },
    },
  },
};

export const ADD_NOTE_TOOL = {
  name: 'add_plan_note',
  description: 'Añade una nota libre a un plan YA creado (logística, recordatorios, contexto del cliente) sin regenerar el plan. Úsalo cuando el coach quiera anotar algo sobre un plan existente.',
  input_schema: {
    type: 'object',
    required: ['clientId', 'weekOf', 'note'],
    properties: {
      clientId: { type: 'string', description: 'ID del cliente (ej: alex-hammond)' },
      weekOf:   { type: 'string', description: 'Lunes de la semana del plan, formato YYYY-MM-DD' },
      note:     { type: 'string', description: 'Texto de la nota a añadir' },
    },
  },
};

export const CREATE_CLIENT_TOOL = {
  name: 'create_client',
  description: 'Da de alta un nuevo cliente en el sistema DARE. Úsalo cuando el coach quiera crear una cuenta para un nuevo cliente.',
  input_schema: {
    type: 'object',
    required: ['name', 'email', 'goal', 'totalWeeks'],
    properties: {
      name:        { type: 'string',  description: 'Nombre completo del cliente' },
      email:       { type: 'string',  description: 'Email del cliente (será su usuario de acceso al portal)' },
      goal:        { type: 'string',  description: 'Protocolo u objetivo. Ej: Fat-Loss Protocol, Muscle Gain, Recomposición' },
      totalWeeks:  { type: 'integer', description: 'Duración del protocolo en semanas' },
      currentWeek: { type: 'integer', description: 'Semana en la que empieza (por defecto 1)' },
      phone:       { type: 'string',  description: 'Teléfono del cliente (opcional, aparece en el contrato)' },
      birthDate:   { type: 'string',  description: 'Fecha de nacimiento YYYY-MM-DD (opcional, aparece en el contrato)' },
      height:      { type: 'number',  description: 'Altura en cm (opcional)' },
      weight:      { type: 'number',  description: 'Peso inicial en kg (opcional)' },
      bodyFat:     { type: 'number',  description: '% de grasa corporal inicial (opcional)' },
      notes:       { type: 'string',  description: 'Notas iniciales: gym, restricciones alimentarias, lesiones, etc.' },
    },
  },
};
