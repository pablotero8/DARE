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
      notes:       { type: 'string',  description: 'Notas iniciales: gym, restricciones alimentarias, lesiones, etc.' },
    },
  },
};
