import './env.js'; // Load .env FIRST
import express from 'express';
import { handleIncoming } from './conversations.js';
import { getLatestPlan, getPlanByWeek, listPlanWeeks, seedPlan } from './planner.js';
import {
  verifyClientPassword,
  getClientById,
  listClients,
  createClient,
  deleteClient,
  resetClientPassword,
  getClientByEmail,
} from './clients.js';
import { signToken, verifyToken, persistSession, revokeSession, isAdmin } from './auth.js';

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// CORS — allow client portal to fetch plans
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Auth middleware ───────────────────────────────────────────

function requireClient(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No autenticado' });

  const payload = verifyToken(token);
  if (!payload?.sub) return res.status(401).json({ error: 'Token inválido o expirado' });

  const client = getClientById(payload.sub);
  if (!client) return res.status(401).json({ error: 'Cliente no encontrado' });

  req.client = client;
  next();
}

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token !== process.env.ADMIN_API_TOKEN) {
    return res.status(403).json({ error: 'Acceso denegado' });
  }
  next();
}

// ── Twilio WhatsApp webhook ───────────────────────────────────

app.post('/webhook', async (req, res) => {
  const from = req.body?.From ?? '';
  const body = (req.body?.Body ?? '').trim();

  if (!from || !body) {
    return res.status(400).send('Bad Request');
  }

  let reply;
  try {
    reply = await handleIncoming(from, body);
  } catch (err) {
    console.error('[webhook] error:', err);
    reply = 'Error interno. Intenta de nuevo o escribe /reset.';
  }

  res.type('text/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Message><![CDATA[${reply}]]></Message></Response>`
  );
});

// ── Client auth ───────────────────────────────────────────────

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email y contraseña requeridos' });
  }
  const client = await verifyClientPassword(email, password);
  if (!client) return res.status(401).json({ error: 'Credenciales incorrectas' });

  const token = signToken(client.id);
  persistSession(token, client.id);

  res.json({
    token,
    client: {
      id: client.id,
      name: client.name,
      initials: client.initials,
      email: client.email,
      goal: client.goal,
      currentWeek: client.currentWeek,
      totalWeeks: client.totalWeeks,
      weight: client.weight,
      bodyFat: client.bodyFat,
      lean: client.lean,
      height: client.height,
    },
  });
});

app.post('/api/auth/logout', requireClient, (req, res) => {
  const token = req.headers.authorization.slice(7);
  revokeSession(token);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireClient, (req, res) => {
  res.json({
    id: req.client.id,
    name: req.client.name,
    initials: req.client.initials,
    email: req.client.email,
    goal: req.client.goal,
    currentWeek: req.client.currentWeek,
    totalWeeks: req.client.totalWeeks,
    weight: req.client.weight,
    bodyFat: req.client.bodyFat,
    lean: req.client.lean,
    height: req.client.height,
  });
});

// ── Plan API (client must be authenticated for their own data) ─

app.get('/api/plans/:clientId', requireClient, (req, res) => {
  if (req.client.id !== req.params.clientId && !req.headers['x-admin-override']) {
    return res.status(403).json({ error: 'No puedes ver el plan de otro cliente' });
  }
  const plan = getLatestPlan(req.params.clientId);
  if (!plan) return res.status(404).json({ error: 'No hay planes para este cliente' });
  res.json(plan);
});

app.get('/api/plans/:clientId/week/:weekOf', requireClient, (req, res) => {
  if (req.client.id !== req.params.clientId) {
    return res.status(403).json({ error: 'No puedes ver el plan de otro cliente' });
  }
  const plan = getPlanByWeek(req.params.clientId, req.params.weekOf);
  if (!plan) return res.status(404).json({ error: 'Semana no encontrada' });
  res.json(plan);
});

// List all published weeks for a client (used by the week-selector dropdown)
app.get('/api/plans/:clientId/weeks', requireClient, (req, res) => {
  if (req.client.id !== req.params.clientId) {
    return res.status(403).json({ error: 'No puedes ver los planes de otro cliente' });
  }
  res.json(listPlanWeeks(req.params.clientId));
});

// ── Admin API (managed via HTTP for tooling, also via WhatsApp) ─

app.get('/api/clients', requireAdmin, (req, res) => {
  res.json(listClients().map(c => ({
    id: c.id, name: c.name, email: c.email, goal: c.goal,
    currentWeek: c.currentWeek, totalWeeks: c.totalWeeks,
    createdAt: c.createdAt, lastLoginAt: c.lastLoginAt,
  })));
});

app.post('/api/clients', requireAdmin, async (req, res) => {
  try {
    const { client, generatedPassword } = await createClient(req.body);
    res.status(201).json({ client, generatedPassword });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/clients/:id', requireAdmin, (req, res) => {
  const ok = deleteClient(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Cliente no encontrado' });
  res.json({ ok: true });
});

app.post('/api/clients/:id/reset-password', requireAdmin, async (req, res) => {
  const newPwd = await resetClientPassword(req.params.id);
  if (!newPwd) return res.status(404).json({ error: 'Cliente no encontrado' });
  res.json({ newPassword: newPwd });
});

// ── Health ────────────────────────────────────────────────────

app.get('/health', (_, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ── Start ─────────────────────────────────────────────────────

// ── Auto-seed demo client on first run ────────────────────────
// Railway has an ephemeral filesystem — SQLite is reset on every deploy.
// This ensures the demo user always exists when the server starts.

async function seedDemoClient() {
  try {
    const existing = getClientByEmail('client@dare.ae');
    if (existing) {
      console.log('[seed] Demo client already exists:', existing.email);
      return;
    }
    await createClient({
      name:         'Alex Hammond',
      email:        'client@dare.ae',
      password:     'dare2026',
      goal:         'Fat-Loss Protocol',
      currentWeek:  8,
      totalWeeks:   12,
      height:       181,
      weight:       82.8,
      bodyFat:      18.8,
      lean:         67.4,
      notes:        'Entrena en gym privado. Sin restricciones alimentarias.',
    });
    console.log('[seed] Demo client created — client@dare.ae / dare2026');
  } catch (err) {
    console.error('[seed] Error seeding demo client:', err.message);
  }
}

// ── Demo plan seed ────────────────────────────────────────────

function currentMondayStr() {
  const d = new Date();
  const day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  return d.toISOString().split('T')[0];
}

function nextMondayStr() {
  const d = new Date();
  const day = d.getDay(); // 0=Sun
  const add = day === 0 ? 1 : 8 - day;
  d.setDate(d.getDate() + add);
  return d.toISOString().split('T')[0]; // YYYY-MM-DD
}

function dayLabel(baseDate, offset) {
  const d = new Date(baseDate + 'T12:00:00Z');
  d.setDate(d.getDate() + offset);
  const short = d.toLocaleDateString('en-GB', { weekday: 'short' }).slice(0, 3);
  const full  = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  return { label: short, fullDate: full };
}

function buildDemoWeek(weekOf) {
  const types    = ['strength','cardio','rest','strength','cardio','strength','rest'];
  const sessions = ['Upper Body','HIIT & Cardio','Active Rest','Lower Body','Cardio & Core','Full Body Power','Active Rest'];
  const noteTypes= ['strength','cardio','rest','strength','cardio','strength','rest'];

  const trainingByDay = [
    { items:[
        {name:'Barbell Bench Press',  detail:'Warm-up 2×8 @60% · Main 4 sets · 90s rest',      badge:'4×6 @80%'},
        {name:'Wide-Grip Pull-ups',   detail:'Strict form · full range · 90s rest',              badge:'4×8'},
        {name:'Overhead Press',       detail:'Standing barbell · braced core · controlled',      badge:'3×8 @75%'},
        {name:'Cable Row',            detail:'3s hold at chest · slow eccentric · 75s rest',    badge:'4×10'},
        {name:'Face Pulls',           detail:'External rotation · superset with pushdowns',      badge:'3×15'},
      ],
      note:"Strong start to the week. Log every weight — we're building on last week's numbers. If the last 2 reps of set 4 feel easy, add 2.5 kg next Monday.",
      metrics:{main:65,mainLabel:'min · session',bars:[{name:'Volume',value:18,max:25,label:'18 sets'},{name:'Intensity',value:80,max:100,label:'80%'},{name:'Duration',value:65,max:90,label:'65 min'}]},
    },
    { items:[
        {name:'Warm-up jog',     detail:'Easy pace · HR below 130 bpm · 5 min', badge:'5 min',    gold:true},
        {name:'HIIT Intervals',  detail:'40s max effort / 20s full rest · 8 rounds', badge:'8 rounds', gold:true},
        {name:'Battle Ropes',    detail:'Alternating waves · 30s on / 30s rest', badge:'3×30s',   gold:true},
        {name:'Jump Rope',       detail:'Continuous rhythm · double unders if comfortable', badge:'3×2 min', gold:true},
        {name:'Cool-down walk',  detail:'HR below 100 bpm before leaving', badge:'10 min',        gold:true},
      ],
      note:"Push hard in the 40-second windows — RPE 9. Full recovery in the 20 seconds. Log your peak HR.",
      metrics:{main:50,mainLabel:'min · session',bars:[{name:'Duration',value:50,max:90,label:'50 min'},{name:'Intensity',value:85,max:100,label:'85%'},{name:'Effort',value:90,max:100,label:'RPE 9'}]},
    },
    { activities:[
        {name:'30-min outdoor walk',        detail:'Easy pace · natural light · barefoot on grass if possible'},
        {name:'20-min yoga flow',           detail:'Hip flexors · thoracic spine · hamstrings'},
        {name:'Full-body foam rolling',     detail:'Calves · quads · IT band · lats · 15 min'},
        {name:'Diaphragmatic breathing',    detail:'4-7-8 pattern · lying flat · 10 min · no screens'},
      ],
      note:"Rest day is where adaptation happens. Don't skip the foam rolling — Thursday's squat session depends on it.",
      metrics:{main:75,mainLabel:'min · recovery',bars:[{name:'Duration',value:75,max:90,label:'75 min'},{name:'Recovery',value:85,max:100,label:'Mobility'},{name:'Sleep',value:82,max:100,label:'8h target'}]},
    },
    { items:[
        {name:'Back Squat',           detail:'Warm-up 2×8 @55% · Main 4 sets · 2 min rest', badge:'4×6 @85%'},
        {name:'Romanian Deadlift',    detail:'4s eccentric · hinge at hip · neutral spine',  badge:'3×8 @75%'},
        {name:'Bulgarian Split Squat',detail:'Rear foot elevated · dumbbell hold · each leg', badge:'3×10/side'},
        {name:'Hip Thrust',           detail:'Barbell · 1s pause at top · full glute squeeze', badge:'4×12'},
        {name:'Leg Curl (seated)',    detail:'Full range · 3s negative · controlled lowering', badge:'3×12'},
      ],
      note:"Heaviest squat session this week. Take warm-up sets seriously. Track RPE on every working set. If the last 2 reps feel easy, add 2.5 kg next Thursday.",
      metrics:{main:70,mainLabel:'min · session',bars:[{name:'Volume',value:17,max:25,label:'17 sets'},{name:'Intensity',value:82,max:100,label:'82%'},{name:'Duration',value:70,max:90,label:'70 min'}]},
    },
    { items:[
        {name:'Zone 2 Cycling',  detail:'Moderate pace · HR 130–145 bpm · steady', badge:'40 min', gold:true},
        {name:'Plank hold',      detail:'Strict form · no hip drop',                badge:'3×60s',  gold:true},
        {name:'Side Plank',      detail:'Level hips · each side',                   badge:'3×30s/side', gold:true},
        {name:'Dead Bug',        detail:'Slow and controlled · lower back into floor', badge:'3×10', gold:true},
        {name:'Mobility finish', detail:'Hip flexors · hamstrings · thoracic rotation', badge:'10 min', gold:true},
      ],
      note:"Easy aerobic day before Saturday's peak session. Keep cycling in zone 2 — you should hold a full conversation. Leave fresh, not fatigued.",
      metrics:{main:60,mainLabel:'min · session',bars:[{name:'Duration',value:60,max:90,label:'60 min'},{name:'Intensity',value:68,max:100,label:'Z2 Zone'},{name:'Effort',value:65,max:100,label:'RPE 6'}]},
    },
    { items:[
        {name:'Deadlift',        detail:'Warm-up 2×5 @60% · Main 4 sets · 2.5 min rest', badge:'4×5 @87%'},
        {name:'Overhead Press',  detail:'Standing barbell · controlled descent',           badge:'4×6 @78%'},
        {name:'Weighted Pull-ups',detail:'Belt + plates · full hang · chin clears bar',   badge:'3×6'},
        {name:'Dips',            detail:'Chest-forward lean · full range · bodyweight',   badge:'3×10'},
        {name:'Farmer Carry',    detail:'Heaviest dumbbells · correct posture · 20m',     badge:'3×20m'},
      ],
      note:"Weekly peak session. Deadlift is the priority — everything else follows. If energy is high, chase a small PR. Record all weights.",
      metrics:{main:80,mainLabel:'min · session',bars:[{name:'Volume',value:17,max:25,label:'17 sets'},{name:'Intensity',value:85,max:100,label:'85%'},{name:'Duration',value:80,max:90,label:'80 min'}]},
    },
    { activities:[
        {name:'45-min outdoor walk',        detail:'Leisurely pace · natural light · no agenda'},
        {name:'Full-body static stretching', detail:'45–60s per stretch · focus on legs after Saturday'},
        {name:'Light swim (optional)',       detail:'20 min easy · not competitive · enjoy the water'},
        {name:'No structured training',     detail:'Let the body consolidate this week\'s adaptations'},
      ],
      note:"End of the week. You trained hard — now let the body build. Monday starts a new block. Arrive rested.",
      metrics:{main:70,mainLabel:'min · recovery',bars:[{name:'Duration',value:70,max:90,label:'70 min'},{name:'Recovery',value:95,max:100,label:'Complete'},{name:'Sleep',value:88,max:100,label:'9h target'}]},
    },
  ];

  const nutritionByDay = [
    { kcal:2200, protein:185, carbs:195, fat:55,
      meals:[
        {time:'07:00',name:'Pre-workout Breakfast',  desc:'Oat porridge · 2 boiled eggs · espresso',               kcal:460, steps:['Cook 70g oats in 280ml water for 4 min, stir until creamy','Boil 2 eggs for 7 min, peel and halve','Brew espresso black, no sugar']},
        {time:'10:30',name:'Post-workout Recovery',  desc:'Whey isolate shake · rice cake · honey',                 kcal:380, steps:['Shake 1 scoop whey in 300ml cold water for 20s','Drizzle honey on 1 rice cake','Eat within 20 min of last set']},
        {time:'13:00',name:'Lunch',                  desc:'Chicken breast · brown rice · roasted courgette',        kcal:680, steps:['Roast sliced courgette at 200°C for 20 min with 1 tsp olive oil','Pan-fry 180g chicken 5–6 min per side, rest 3 min','Cook 180g brown rice per packet (~25 min)']},
        {time:'16:30',name:'Afternoon Snack',         desc:'Greek yoghurt · granola · mixed berries',                kcal:320, steps:['Spoon 200g Greek yoghurt into a bowl','Add 40g granola and 80g mixed berries','Optional: drizzle ½ tsp honey']},
        {time:'20:00',name:'Dinner',                 desc:'Sea bass · sweet potato purée · asparagus',             kcal:560, steps:['Boil 200g sweet potato, mash with 1 tsp butter','Steam 150g asparagus 4 min','Pan-fry sea bass skin-down 4 min, flip 2 min']},
      ],
      note:"Upper body day — keep carbs high around training. Post-workout window is critical: eat within 30 min. Hydration target: 3.2 L.",
    },
    { kcal:1980, protein:175, carbs:165, fat:52,
      meals:[
        {time:'07:00',name:'Breakfast',        desc:'Egg white omelette · spinach · feta · wholemeal toast', kcal:390, steps:['Wilt 60g spinach in a pan with oil spray','Whisk 4 egg whites, pour over spinach, add 30g feta','Fold and cook 30s more, serve with 1 slice wholemeal toast']},
        {time:'11:00',name:'Post-workout',     desc:'Whey protein shake · banana · almond butter',          kcal:360, steps:['Blend 1 scoop whey with 250ml cold almond milk','Slice 1 banana and measure 1 tbsp almond butter alongside','Consume within 30 min of finishing training']},
        {time:'13:30',name:'Lunch',            desc:'Grilled chicken · quinoa · roasted peppers · tahini',  kcal:620, steps:['Cook 150g quinoa in 300ml water for 15 min','Roast 2 halved red peppers at 200°C for 22 min','Grill 180g chicken 5 min each side, rest 3 min','Drizzle tahini dressing: 1.5 tbsp tahini + lemon juice + water + salt']},
        {time:'17:00',name:'Afternoon Snack',  desc:'Cottage cheese · sliced pear · walnuts',               kcal:300, steps:['Spoon 200g low-fat cottage cheese into a bowl','Core and slice 1 ripe pear into fans','Add 25g walnut halves alongside']},
        {time:'20:00',name:'Dinner',           desc:'Sea bass · steamed broccoli · sweet potato',           kcal:430, steps:['Steam 150g broccoli 5–6 min until vibrant green','Cube and roast 160g sweet potato at 200°C for 22 min','Pan-fry sea bass skin-down 4 min, flip 2 min, drizzle lemon-herb dressing']},
      ],
      note:"Moderate carb day aligned with HIIT. Protein quality is the priority. Avoid heavy food after 20:30 — overnight recovery matters.",
    },
    { kcal:1860, protein:165, carbs:142, fat:60,
      meals:[
        {time:'08:00',name:'Breakfast', desc:'Avocado toast · 2 poached eggs · smoked salmon',     kcal:520, steps:['Poach 2 eggs in simmering water with a splash of vinegar for 3–4 min','Toast 2 sourdough slices until firm and golden','Mash ½ avocado with lemon and black pepper','Top with 50g smoked salmon and eggs, scatter capers']},
        {time:'13:00',name:'Lunch',     desc:'Red lentil soup · sourdough · mixed leaf salad',     kcal:560, steps:['Sauté onion + garlic + cumin 3 min, add 150g lentils + stock, simmer 20 min','Blend smooth, season with lemon and smoked paprika','Serve with 1 slice toasted sourdough and a dressed mixed salad']},
        {time:'17:00',name:'Snack',     desc:'Medjool dates · almonds · green tea',                kcal:280, steps:['Set out 3 pitted medjool dates and 25g whole almonds','Brew green tea at 80°C for 2–3 min','Eat slowly — this is a recovery snack, not a performance refuel']},
        {time:'20:00',name:'Dinner',    desc:'Roasted turkey · beets · wilted spinach · tahini',   kcal:500, steps:['Roast 200g turkey breast with garlic and oregano at 190°C for 25 min','Wilt 80g spinach with 1 crushed garlic clove for 2 min','Drizzle tahini dressing: 1.5 tbsp tahini + lemon + water + salt']},
      ],
      note:"Recovery nutrition today. Anti-inflammatory priority — no processed sugar. High-quality fats support joint and hormonal health. Aim for 3.0 L water.",
    },
    { kcal:2280, protein:182, carbs:210, fat:50,
      meals:[
        {time:'07:00',name:'Pre-workout',    desc:'Banana · peanut butter toast · black coffee',    kcal:360, steps:['Toast 1 slice wholemeal bread until golden','Spread 1.5 tbsp natural peanut butter, top with ½ sliced banana','Brew black coffee — eat 60–75 min before your session']},
        {time:'10:30',name:'Post-workout',   desc:'Whey shake · 2 rice cakes · honey',              kcal:420, steps:['Shake 1 scoop whey in 300ml cold water','Spread ½ tsp honey on each of 2 rice cakes','Consume within 30 min — timing is critical on leg day']},
        {time:'13:00',name:'Lunch',          desc:'Beef stir-fry · jasmine rice · pak choi · sesame', kcal:740, steps:['Cook 200g jasmine rice (bring to boil, lid on low 12 min, rest 5 min)','Slice 180g lean beef sirloin, season, stir-fry 2–3 min in hot wok','Add 2 pak choi heads + garlic + ginger, toss 2 min, serve over rice']},
        {time:'16:30',name:'Afternoon Snack',desc:'Greek yoghurt · granola · diced mango',          kcal:380, steps:['Dice ½ fresh mango into small cubes','Spoon 200g Greek yoghurt, add 40g granola and mango on top']},
        {time:'20:00',name:'Dinner',         desc:'Grilled salmon · pasta primavera · parmesan',    kcal:680, steps:['Cook 120g rigatoni al dente, reserve ½ cup pasta water','Sauté courgette + cherry tomatoes + pepper in olive oil 5 min, toss with pasta','Grill 180g salmon skin-up 4–5 min, flip 3 min, serve alongside with parmesan']},
      ],
      note:"Highest carb day — designed around your heaviest training load. Don't skip the pre-workout meal. Pasta at dinner ensures full glycogen replenishment.",
    },
    { kcal:2020, protein:172, carbs:175, fat:55,
      meals:[
        {time:'07:00',name:'Breakfast', desc:'Scrambled eggs · smoked salmon · avocado · toast',   kcal:460, steps:['Whisk 3 eggs + 1 egg white with 1 tbsp milk, salt and pepper','Cook on low heat stirring slowly — pull off when slightly glossy','Serve on toasted wholemeal with 50g smoked salmon and sliced avocado']},
        {time:'12:30',name:'Lunch',     desc:'Tuna salad · bulgur wheat · cucumber · tomatoes',    kcal:580, steps:['Pour boiling water over 120g bulgur (1:1.5), cover 15 min, fluff','Drain 1 tin tuna, break into chunks, combine with bulgur, diced cucumber, halved cherry tomatoes','Dress with 1.5 tbsp olive oil + lemon juice + salt + fresh mint']},
        {time:'16:00',name:'Snack',     desc:'Protein bar · apple · black coffee',                 kcal:300, steps:['Choose a bar with 20g+ protein and under 10g sugar','Eat with 1 whole apple — the skin has the fibre you want','Brew black coffee to bridge to dinner without spiking hunger']},
        {time:'20:00',name:'Dinner',    desc:'Chicken thigh · Puy lentils · roasted peppers',      kcal:680, steps:['Roast 2 bone-in chicken thighs at 200°C skin-up for 35–40 min','Cook 150g Puy lentils in stock for 20 min, drain','Roast 2 red peppers at 200°C for 25 min, peel and slice, serve over lentils with chicken and fresh coriander']},
      ],
      note:"Friday evening meal is your pre-load for Saturday's peak session — don't skip it. Sleep 8+ hours tonight. That's where the gains actually happen.",
    },
    { kcal:2320, protein:188, carbs:220, fat:52,
      meals:[
        {time:'07:00',name:'Pre-workout', desc:'Overnight oats · protein powder · blueberries',   kcal:460, steps:['Night before: mix 80g oats + 1 scoop protein + 1 tbsp chia seeds in a jar with 250ml oat milk, refrigerate overnight','Morning: top with 80g blueberries, eat at room temperature','Consume 60–90 min before training']},
        {time:'10:30',name:'Post-workout',desc:'Recovery shake · banana · almond butter (2 tbsp)', kcal:490, steps:['Blend 1 scoop recovery protein with 300ml cold milk','Slice 1 large banana and measure 2 tbsp almond butter alongside','Consume within 30 min — Saturday is peak day and this window is everything']},
        {time:'13:00',name:'Lunch',       desc:'Sirloin steak · sweet potato · asparagus · garlic butter', kcal:780, steps:['Remove steak from fridge 30 min before cooking','Cube 220g sweet potato, roast at 200°C for 25 min','Sear steak in screaming-hot cast iron 3 min per side for medium-rare, rest 5 min','Steam 150g asparagus 4 min, toss in butter + garlic, serve everything together']},
        {time:'16:30',name:'Afternoon Snack',desc:'Cottage cheese · tropical fruit · walnuts',     kcal:360, steps:['Cube 100g mango + 80g pineapple','Spoon 200g cottage cheese, add fruit and crush 30g walnuts over the top','Sprinkle ¼ tsp cinnamon — improves insulin sensitivity around strength training']},
        {time:'20:00',name:'Dinner',      desc:'Sea bass · saffron risotto · cherry tomatoes',    kcal:690, steps:['Warm 750ml stock in a saucepan throughout','Sauté ½ onion in olive oil, add 150g arborio rice, toast 2 min','Add saffron + stock one ladle at a time, stirring every 2 min for 18–20 min','Pan-fry sea bass skin-down 4 min, flip 2 min, serve over risotto with halved cherry tomatoes and parmesan']},
      ],
      note:"Highest calorie day of the week — you've earned it. Sunday is active rest so eat generously tonight.",
    },
    { kcal:1820, protein:158, carbs:130, fat:65,
      meals:[
        {time:'09:00',name:'Brunch',  desc:'Smoked salmon · scrambled eggs · avocado · sourdough', kcal:580, steps:['Whisk 3 eggs with 1 tbsp crème fraîche and chopped dill','Cook slowly in a buttered pan, stirring gently — pull off when just set','Serve on sourdough with 60g smoked salmon, mashed avocado and capers']},
        {time:'14:00',name:'Lunch',   desc:'Buddha bowl · falafel · hummus · tabbouleh · tahini',  kcal:580, steps:['Warm 5 falafel at 180°C for 10 min','Make tabbouleh: parsley + mint + tomato + lemon + olive oil + cooked bulgur','Assemble bowl with hummus, falafel, tabbouleh, drizzle tahini and pinch of sumac']},
        {time:'18:00',name:'Snack',   desc:'Mixed nuts · dark chocolate · herbal tea',             kcal:330, steps:['Weigh 40g mixed nuts (almonds, cashews, brazil, macadamia)','Break 2 squares (20g) of 70%+ dark chocolate','Brew chamomile or peppermint tea — herbal, not caffeinated. Wind down.']},
        {time:'20:30',name:'Dinner',  desc:'Chicken broth · seasonal vegetables · soba noodles',  kcal:330, steps:['Simmer 1L chicken stock with garlic + ginger 10 min','Cook 60g soba noodles 3–4 min, drain and rinse cold','Add pak choi + broccoli + carrots to broth 3 min, ladle over noodles','Garnish with spring onions, sesame oil and optional soft-boiled egg']},
      ],
      note:"Calorie reset day — lighter on quantity, high on micronutrients and healthy fats. Eat slowly, hydrate well, sleep 9 hours tonight.",
    },
  ];

  return types.map((type, i) => {
    const { label, fullDate } = dayLabel(weekOf, i);
    const t = trainingByDay[i];
    const n = nutritionByDay[i];
    return {
      label,
      fullDate,
      type,
      training: {
        session:  sessions[i],
        ...(t.items      ? { items:      t.items      } : {}),
        ...(t.activities ? { activities: t.activities } : {}),
        note:     t.note,
        noteType: noteTypes[i],
        metrics:  t.metrics,
      },
      nutrition: {
        kcal:    n.kcal,
        protein: n.protein,
        carbs:   n.carbs,
        fat:     n.fat,
        meals:   n.meals,
        note:    n.note,
      },
    };
  });
}

async function seedDemoPlan() {
  const clientId = 'alex-hammond';

  const weeksToSeed = [
    { weekOf: currentMondayStr(), label: 'current week' },
    { weekOf: nextMondayStr(),    label: 'next week'    },
  ];

  for (const { weekOf, label } of weeksToSeed) {
    try {
      const week   = buildDemoWeek(weekOf);
      const seeded = seedPlan(clientId, weekOf, week);
      console.log(seeded
        ? `[seed] Demo plan seeded — ${label} (${weekOf})`
        : `[seed] Demo plan already exists — ${label} (${weekOf})`);
    } catch (err) {
      console.error(`[seed] Error seeding demo plan for ${label}:`, err.message);
    }
  }
}

const PORT = process.env.PORT ?? 3001;
app.listen(PORT, async () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║   DARE Bot Server  :${PORT}             ║
  ║   Webhook: POST /webhook             ║
  ║   Auth:    POST /api/auth/login      ║
  ║   Plans:   GET  /api/plans/:id       ║
  ║   Admin:   /api/clients              ║
  ╚══════════════════════════════════════╝
  `);
  await seedDemoClient();
  await seedDemoPlan();
});
