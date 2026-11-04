// ═══════════════════════════════════════════════════════════════════════════
// blocks.mjs — مكتبة البلوكات. الطبقة اللي تعرف **شنو يُبنى**.
//
// كل بلوك: دالة تاخذ خيارات و ترجّع مجموعة عقد مربوطة داخلياً، بمدخل واحد
// و مخرج واحد (ولا مخرجين للتفريع). المُركّب (`assemble.mjs`) يربط المخرج
// بالمدخل اللي بعدو، و يحسب المواضع.
//
// 🔴 القاعدة اللي تحكم كل بلوك هنا:
//    **كل مسار يخرج عنصراً واحداً على الأقل، و كل توقّف لُه اسم مكتوب.**
//    `return []` و الفرع الميّت هما شكل الفشل الصامت — و الفشل الصامت هو
//    اللي كلّف أسابيع فـ نظام إنتاج حقيقي، ماشي الخطأ الأحمر.
//
// 🔴 و القاعدة الثانية: أي بلوك يمسّ الشبكة يُعطي **فرع خطأ صريح**، ما يمرّش
//    بـ continueRegularOutput. «Never Error» يحوّل الرفض لعلامة خضراء.
//
// عقد الـ typeVersion هنا مأخوذة من instance حيّة تخدم، ماشي من التوثيق:
//   code 2 · postgres 2.4 · if 2.2 · noOp 1 · httpRequest 4.2
//   scheduleTrigger 1.2 · webhook 2 · switch 3.2 · respondToWebhook 1.1 · wait 1.1
// ═══════════════════════════════════════════════════════════════════════════

import { node, cond, CRED, IS_TRUE, IS_FALSE, GT, EQUALS } from './kit.mjs';

// عقدة بموضع نسبي — المُركّب يحوّلو لبكسل.
const at = (col, row, n) => ({ ...n, _col: col, _row: row });

const pg = (name, query, replacement, col, row = 0, extra = {}) =>
  at(col, row, node(name, 'n8n-nodes-base.postgres', 2.4, [0, 0], {
    operation: 'executeQuery',
    query,
    options: replacement ? { queryReplacement: replacement } : {},
  }, { credentials: { postgres: CRED.postgres ?? { id: 'REPLACE_ME', name: 'Postgres' } }, ...extra }));

const js = (name, code, col, row = 0, mode = 'runOnceForAllItems') =>
  at(col, row, node(name, 'n8n-nodes-base.code', 2, [0, 0], { mode, jsCode: code }));

const ifNode = (name, expr, op, col, row = 0, right = '') =>
  at(col, row, node(name, 'n8n-nodes-base.if', 2.2, [0, 0], cond(name, expr, op, right)));

const stop = (label, col, row) =>
  at(col, row, node(label, 'n8n-nodes-base.noOp', 1, [0, 0]));

// 🔴 عقدة Postgres تستبدل العنصر الداخل بنتيجة استعلامها. بلا هذا، أوّل حارس
//    يمسح الطلب، و الحارس الموالي يقرا مفتاحو من {enabled:true} ⇒ فارغ.
//    الحارس يمسك العنصر عند الدخول و يرجّعو كما هو عند الخروج.
const guard = ({ hold, query, params, check, ok, stopLabel }) => ({
  nodes: [
    at(0, 0, node(hold, 'n8n-nodes-base.noOp', 1, [0, 0])),
    pg(`${hold} · استعلام`, query, params, 1),
    ifNode(check, '={{ $json.' + ok + ' }}', IS_TRUE, 2),
    js(`${hold} · رجّع العنصر`, `// يرجّع العنصر كما دخل الحارس، ماشي نتيجة الاستعلام.
const src = $('${hold}').item;
return src.binary ? { json: src.json, binary: src.binary } : { json: src.json };`, 3, 0, 'runOnceForEachItem'),
    stop(stopLabel, 3, 1),
  ],
  wires: [
    [hold, `${hold} · استعلام`],
    [`${hold} · استعلام`, check],
    [check, `${hold} · رجّع العنصر`],
    [check, stopLabel, { output: 1 }],
  ],
  entry: hold,
  exit: `${hold} · رجّع العنصر`,
  exitOutput: 0,
  width: 4,
});

// ═══ ١ · المشغّلات ═════════════════════════════════════════════════════════

/**
 * webhook — مدخل من مزوّد خارجي.
 * 🔴 respondNow=true يردّ 200 **قبل** أي معالجة. المزوّد ما ينتظرش، فما
 *    يعيدش الإرسال، فما تتضاعفش الأحداث. Meta تسحب الاشتراك إذا تأخّر الردّ.
 * opts: { path, methods=['POST'], respondNow=true, body='EVENT_RECEIVED' }
 */
export const webhook = (o = {}) => {
  const path = o.path ?? 'hook';
  const methods = o.methods ?? ['POST'];
  const nodes = [
    at(0, 0, node(o.name ?? 'Webhook', 'n8n-nodes-base.webhook', 2, [0, 0], {
      ...(methods.length > 1 ? { multipleMethods: true } : { httpMethod: methods[0] }),
      path,
      responseMode: o.respondNow === false ? 'lastNode' : 'responseNode',
      options: {},
    }, { webhookId: `${path}-webhook` })),
  ];
  const wires = [];
  let exit = o.name ?? 'Webhook';

  if (o.respondNow !== false) {
    nodes.push(at(1, 0, node('ردّ 200 فوراً', 'n8n-nodes-base.respondToWebhook', 1.1, [0, 0], {
      respondWith: 'text',
      responseBody: o.body ?? 'EVENT_RECEIVED',
      options: { responseCode: 200 },
    })));
    wires.push([exit, 'ردّ 200 فوراً']);
    exit = 'ردّ 200 فوراً';
  }
  return { nodes, wires, entry: nodes[0].name, exit, width: nodes.length };
};

/**
 * schedule — مشغّل زمني. لا webhook، لا حدّ ينادي.
 * opts: { minutes } | { hours } | { cron: '0 9 * * *' } · name
 */
export const schedule = (o = {}) => {
  const rule = o.cron
    ? { interval: [{ field: 'cronExpression', expression: o.cron }] }
    : o.hours
      ? { interval: [{ field: 'hours', hoursInterval: o.hours }] }
      : { interval: [{ field: 'minutes', minutesInterval: o.minutes ?? 5 }] };
  const name = o.name ?? (o.cron ? `جدولة ${o.cron}` : o.hours ? `كل ${o.hours} ساعة` : `كل ${o.minutes ?? 5} دقائق`);
  const n = at(0, 0, node(name, 'n8n-nodes-base.scheduleTrigger', 1.2, [0, 0], { rule }));
  return { nodes: [n], wires: [], entry: name, exit: name, width: 1 };
};

/** manual — للتجربة فقط. لا يُترك فـ ورك فلو إنتاج. */
export const manual = (o = {}) => {
  const name = o.name ?? 'تشغيل يدوي';
  const n = at(0, 0, node(name, 'n8n-nodes-base.manualTrigger', 1, [0, 0], {}));
  return { nodes: [n], wires: [], entry: name, exit: name, width: 1 };
};

// ═══ ٢ · الحُرّاس — أهمّ ما فـ المكتبة ═════════════════════════════════════

/**
 * killSwitch — مفتاح إيقاف واحد يُقرأ من القاعدة.
 * 🔴 بلا هذا، إيقاف البوت = إطفاء الورك فلو، و الإطفاء يخسّر كل حدث داخل.
 *    مفتاح واحد فقط: لا shadow_mode ولا أعلام متفرّقة يناقض بعضها بعضاً.
 * الجدول المتوقَّع: app_config(key text primary key, value text)
 * opts: { key='bot_enabled', table='app_config' }
 */
export const killSwitch = (o = {}) => {
  const key = o.key ?? 'bot_enabled';
  const table = o.table ?? 'app_config';
  // 🔴 select عارٍ يرجّع صفاً واحداً دائماً، حتى لو الجدول فارغ. لو كتبناها
  //    `select value from app_config where key=$1` ترجّع صفر صفوف عند غياب
  //    المفتاح ⇒ الفرع يموت أخضر و البوت يسكت بلا سبب مكتوب.
  const q = `select coalesce((select value from ${table} where key = $1), 'false') = 'true' as enabled`;
  return guard({ hold: 'مفتاح الإيقاف', query: q, params: `={{ ['${key}'] }}`,
    check: 'البوت مفعّل؟', ok: 'enabled', stopLabel: `وقف: ${key}=false` });
};

/**
 * dedupe — حارس التكرار (idempotency).
 * 🔴 كل مزوّد يعيد إرسال الحدث. بلا هذا الحارس، الحدث المُعاد يتعالج مرّتين —
 *    و هذا بالضبط شكل «٤٢ رسالة لزبون واحد فـ ١٤ ساعة».
 * 🔴 و لاحظ الـ CTE: `insert … on conflict do nothing returning` وحدها ترجّع
 *    **صفر صفوف** عند التكرار ⇒ موت صامت. الـ CTE تخلّي المخرج صفاً دائماً.
 * الجدول: seen_events(event_key text primary key, seen_at timestamptz)
 * opts: { key: '={{ $json.id }}' , table='seen_events', ttlDays=7 }
 */
export const dedupe = (o = {}) => {
  const table = o.table ?? 'seen_events';
  if (!o.key) throw new Error('dedupe: لازم key — التعبير اللي يعطي مفتاح الحدث الفريد');
  const q = `with attempt as (
  insert into ${table} (event_key, seen_at)
  values ($1, now())
  on conflict (event_key) do nothing
  returning 1
)
select (select count(*) from attempt) > 0 as is_new,
       $1 as event_key`;
  return guard({ hold: 'حارس التكرار', query: q,
    params: `={{ [${String(o.key).replace(/^=\{\{\s*|\s*\}\}$/g, '')}] }}`,
    check: 'حدث جديد؟', ok: 'is_new', stopLabel: 'وقف: حدث مكرّر' });
};

/**
 * dailyCap — سقف يومي. يمنع الحلقة المكلّفة قبل ما تصير فاتورة.
 * 🔴 السقف يُقرأ من القاعدة و يُقارَن بالعدّ الفعلي، ماشي بعدّاد فـ الذاكرة.
 *    عدّاد فـ الذاكرة يتصفّر مع كل إعادة تشغيل — و الحدّ يختفي بلا ما يعرف حدّ.
 * الجدول: actions_log(kind text, created_at timestamptz)
 * opts: { cap=50, kind='send', table='actions_log' }
 */
export const dailyCap = (o = {}) => {
  const cap = Number(o.cap ?? 50);
  const kind = o.kind ?? 'send';
  const table = o.table ?? 'actions_log';
  const q = `select count(*)::int as used,
       ${cap} as cap,
       count(*) < ${cap} as allowed
from ${table}
where kind = $1
  and created_at >= date_trunc('day', now())`;
  return guard({ hold: 'السقف اليومي', query: q, params: `={{ ['${kind}'] }}`,
    check: 'تحت السقف؟', ok: 'allowed', stopLabel: `وقف: بلغ السقف ${cap}/يوم` });
};

/**
 * echoFilter — يمنع الحلقة اللانهائية: الرسالة اللي بعثناها ترجع كحدث داخل.
 * 🔴 بلا هذا، كل ردّ يولّد حدثاً يولّد ردّاً. الحلقة تبان «نشاطاً» فـ اللوحة.
 * opts: { senderPath='$json.sender_id', ours='={{ [] }}' مصفوفة معرّفاتنا }
 */
export const echoFilter = (o = {}) => {
  const sender = o.senderPath ?? '$json.sender_id';
  const code = `// هل هذا الحدث من عندنا نحن؟ إذا إيه، نوقفو قبل ما يولّد ردّاً.
const ours = new Set(${JSON.stringify(o.ourIds ?? [])}.map(String));
const out = [];
for (const item of $input.all()) {
  const from = String(${sender.replace(/^\$json/, 'item.json')} ?? '');
  out.push({ json: { ...item.json, is_echo: ours.has(from), echo_from: from } });
}
// ما نرجّعش [] — نرجّع العناصر موسومة، و الـ IF هو اللي يفرز.
return out.length ? out : [{ json: { empty: true, is_echo: false, n: 0 } }];`;
  return {
    nodes: [
      js('هل هو صدانا؟', code, 0),
      ifNode('ماشي صدى؟', '={{ $json.is_echo }}', IS_FALSE, 1),
      stop('وقف: صدى منّا', 2, 1),
    ],
    wires: [
      ['هل هو صدانا؟', 'ماشي صدى؟'],
      ['ماشي صدى؟', 'وقف: صدى منّا', { output: 1 }],
    ],
    entry: 'هل هو صدانا؟',
    exit: 'ماشي صدى؟',
    exitOutput: 0,
    width: 2,
  };
};

/**
 * businessHours — يمرّر فقط داخل ساعات العمل بتوقيت محدّد.
 * 🔴 الوقت هنا يُحسب بالـ IANA timezone صراحةً. `new Date()` فـ n8n يعطي وقت
 *    الخادم — و خادم بتوقيت UTC يخلّي «التاسعة صباحاً» تصير العاشرة ليلاً.
 * opts: { tz='Africa/Algiers', from=9, to=18, days=[0,1,2,3,4] }
 */
export const businessHours = (o = {}) => {
  const tz = o.tz ?? 'Africa/Algiers';
  const from = o.from ?? 9;
  const to = o.to ?? 18;
  const days = o.days ?? [0, 1, 2, 3, 4];
  const code = `// 🔴 التوقيت صريح. توقيت الخادم ماشي توقيت العميل.
const TZ = ${JSON.stringify(tz)};
const parts = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, hour: '2-digit', weekday: 'short', hour12: false,
}).formatToParts(new Date());
const hour = Number(parts.find(p => p.type === 'hour')?.value ?? '0');
const wd   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
  .indexOf(parts.find(p => p.type === 'weekday')?.value ?? '');
const openDays = new Set(${JSON.stringify(days)});
const open = openDays.has(wd) && hour >= ${from} && hour < ${to};
const items = $input.all();
const base = items.length ? items : [{ json: { empty: true } }];
return base.map(i => ({ json: { ...i.json, within_hours: open, local_hour: hour, local_day: wd } }));`;
  return {
    nodes: [
      js('داخل ساعات العمل؟', code, 0),
      ifNode('مفتوح؟', '={{ $json.within_hours }}', IS_TRUE, 1),
      stop('وقف: خارج ساعات العمل', 2, 1),
    ],
    wires: [
      ['داخل ساعات العمل؟', 'مفتوح؟'],
      ['مفتوح؟', 'وقف: خارج ساعات العمل', { output: 1 }],
    ],
    entry: 'داخل ساعات العمل؟',
    exit: 'مفتوح؟',
    exitOutput: 0,
    width: 2,
  };
};

// ═══ ٣ · البيانات ══════════════════════════════════════════════════════════

/**
 * sql — استعلام حرّ.
 * ⚠️ إذا كان insert/update/delete بـ returning، لُفّو فـ CTE و اختم بـ select
 *    عارٍ — و إلا صفر صفوف تقتل الفرع بصمت. البلوك ينبّهك إذا نساها.
 * opts: { name, query, params='={{ [...] }}', continueOnFail=false }
 */
export const sql = (o = {}) => {
  if (!o.name || !o.query) throw new Error('sql: لازم name و query');
  const q = String(o.query);
  const writes = /^\s*(with[\s\S]*?)?\s*(insert|update|delete)\b/i.test(q);
  const endsBareSelect = /select[\s\S]*$/i.test(q.split(/\)\s*$/).pop() ?? '') && /^\s*with\b/i.test(q);
  if (writes && !endsBareSelect) {
    console.warn(`   ⚠️  sql "${o.name}": كتابة بلا CTE تختم بـ select — صفر صفوف تقتل الفرع بصمت.`);
  }
  return {
    nodes: [pg(o.name, q, o.params ?? null, 0, 0,
      o.continueOnFail ? { onError: 'continueRegularOutput' } : {})],
    wires: [],
    entry: o.name,
    exit: o.name,
    width: 1,
  };
};

/**
 * logAction — السجل اللي يجاوب «واش صار فعلاً؟».
 * 🔴 هذا ماشي زينة. بلا سجل أفعال، سؤال «ليش ما ردّش على هذا الزبون؟» ما عندو
 *    جواب — لا فـ n8n ولا فـ القاعدة.
 * الجدول: actions_log(kind, ref, detail jsonb, created_at default now())
 * opts: { kind='send', ref='={{ $json.id }}', detail='={{ JSON.stringify($json) }}' }
 */
export const logAction = (o = {}) => {
  const table = o.table ?? 'actions_log';
  const q = `with ins as (
  insert into ${table} (kind, ref, detail, created_at)
  values ($1, $2, $3::jsonb, now())
  returning id
)
select coalesce((select id from ins)::text, 'not-inserted') as log_id, $1 as kind`;
  const ref = o.ref ?? '$json.id';
  const detail = o.detail ?? 'JSON.stringify($json)';
  const clean = (s) => String(s).replace(/^=\{\{\s*|\s*\}\}$/g, '');
  return {
    nodes: [pg(o.name ?? `سجّل: ${o.kind ?? 'action'}`, q,
      `={{ ['${o.kind ?? 'action'}', String(${clean(ref)} ?? ''), ${clean(detail)}] }}`, 0)],
    wires: [],
    entry: o.name ?? `سجّل: ${o.kind ?? 'action'}`,
    exit: o.name ?? `سجّل: ${o.kind ?? 'action'}`,
    width: 1,
  };
};

// ═══ ٤ · المنطق ════════════════════════════════════════════════════════════

/**
 * code — عقدة Code.
 * 🔴 الوضع يُستنتج من الجسم: جسم يستعمل $input.all() لازم runOnceForAllItems،
 *    و إلا يشوف عنصراً واحداً فقط بلا خطأ. و `return []` ممنوعة أصلاً.
 * opts: { name, code, mode }
 */
export const code = (o = {}) => {
  if (!o.name || !o.code) throw new Error('code: لازم name و code');
  const body = String(o.code);
  const mode = o.mode ?? (/\$input\s*\.\s*(all|first|last)\s*\(|\bitems\b/.test(body)
    ? 'runOnceForAllItems' : 'runOnceForEachItem');
  return {
    nodes: [js(o.name, body, 0, 0, mode)],
    wires: [], entry: o.name, exit: o.name, width: 1,
  };
};

/**
 * branch — تفريع بمسارين، كل مسار خطّة فرعية كاملة.
 * opts: { name, when: '={{ ... }}', op=IS_TRUE, yes: [...], no: [...] }
 * المُركّب هو اللي يبني الفرعين — هنا نرجّع العقدة و نعلّم النوع.
 */
export const branch = (o = {}) => {
  if (!o.name || !o.when) throw new Error('branch: لازم name و when');
  return {
    kind: 'branch',
    nodes: [ifNode(o.name, o.when, o.op ?? IS_TRUE, 0, 0, o.right ?? '')],
    wires: [], entry: o.name, exit: o.name, width: 1,
    yes: o.yes ?? [], no: o.no ?? [],
  };
};

/**
 * route — Switch بمخارج مسمّاة.
 * opts: { name, on: '={{ $json.intent }}', cases: { سعر:[...], شكوى:[...] }, else:[...] }
 */
export const route = (o = {}) => {
  if (!o.name || !o.on) throw new Error('route: لازم name و on');
  const keys = Object.keys(o.cases ?? {});
  if (!keys.length) throw new Error('route: لازم case واحد على الأقل');
  const rules = keys.map((k, i) => ({
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [{ id: `r${i}`, leftValue: o.on, rightValue: k, operator: EQUALS }],
      combinator: 'and',
    },
    renameOutput: true,
    outputKey: k,
  }));
  return {
    kind: 'route',
    nodes: [at(0, 0, node(o.name, 'n8n-nodes-base.switch', 3.2, [0, 0], {
      rules: { values: rules },
      options: { fallbackOutput: 'extra', renameFallbackOutput: 'غير ذلك' },
    }))],
    wires: [], entry: o.name, exit: o.name, width: 1,
    cases: o.cases, fallback: o.else ?? [],
  };
};

/** wait — تباطؤ مقصود (احترام rate limit مثلاً). */
export const wait = (o = {}) => {
  const name = o.name ?? `انتظر ${o.seconds ?? 1}ث`;
  return {
    nodes: [at(0, 0, node(name, 'n8n-nodes-base.wait', 1.1, [0, 0], {
      amount: o.seconds ?? 1, unit: 'seconds',
    }, { webhookId: `wait-${o.seconds ?? 1}` }))],
    wires: [], entry: name, exit: name, width: 1,
  };
};

// ═══ ٥ · طبقة الـ AI ═══════════════════════════════════════════════════════

/**
 * llm — نداء Claude بمخرَج JSON مضمون.
 * 🔴 الضمانة فـ الكود، ماشي فـ البرومبت. «رجّع JSON» فـ البرومبت اقتراح؛ عقدة
 *    التفكيك اللي تمسك الفشل هي الضمانة. نموذج يرجّع نصّاً حرّاً مرّة من مية —
 *    و تلك المرّة توقف الفرع بلا سبب إذا ما كانش fallback.
 * 🔴 و المفتاح يجي من credential (httpHeaderAuth: x-api-key)، ما يُكتبش هنا.
 * opts: { name, system, user:'={{ $json.text }}', model, maxTokens, fallback:{...} }
 */
export const llm = (o = {}) => {
  const name = o.name ?? 'صنّف بـ Claude';
  const model = o.model ?? 'claude-sonnet-5-5';
  const maxTokens = o.maxTokens ?? 512;
  if (!o.system) throw new Error('llm: لازم system — البرومبت اللي يحدّد المخرَج');
  const userExpr = (o.user ?? '$json.text').replace(/^=\{\{\s*|\s*\}\}$/g, '');

  const body = `={{ JSON.stringify({
  model: ${JSON.stringify(model)},
  max_tokens: ${maxTokens},
  system: ${JSON.stringify(o.system)},
  messages: [{ role: 'user', content: String(${userExpr} ?? '') }]
}) }}`;

  const parse = `// 🔴 الضمانة هنا، ماشي فـ البرومبت. أي مخرَج غير متوقَّع يصير
//    صفاً موسوماً بـ llm_ok=false، ماشي فرعاً ميّتاً.
const fallback = ${JSON.stringify(o.fallback ?? { intent: 'unknown' })};
const out = [];
for (const item of $input.all()) {
  // أوّل جزء من النوع text، ماشي أوّل جزء — جزء تفكير ممكن يجي قبلو.
  const raw = (item.json?.content ?? []).find((c) => c.type === 'text')?.text ?? '';
  let parsed = null, err = '';
  try {
    const m = String(raw).match(/\\{[\\s\\S]*\\}/);
    parsed = m ? JSON.parse(m[0]) : null;
    if (!parsed) err = 'ما لقيت JSON فـ المخرَج';
  } catch (e) { err = String(e.message ?? e); }
  out.push({ json: {
    ...(parsed ?? fallback),
    llm_ok: !!parsed,
    llm_error: err,
    llm_raw: parsed ? '' : String(raw).slice(0, 400),
    llm_tokens_in:  item.json?.usage?.input_tokens  ?? 0,
    llm_tokens_out: item.json?.usage?.output_tokens ?? 0,
  } });
}
return out.length ? out : [{ json: { ...fallback, llm_ok: false, llm_error: 'ولا مخرَج' } }];`;

  return {
    nodes: [
      at(0, 0, node(name, 'n8n-nodes-base.httpRequest', 4.2, [0, 0], {
        method: 'POST',
        url: 'https://api.anthropic.com/v1/messages',
        authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth',
        sendHeaders: true,
        headerParameters: {
          parameters: [
            { name: 'anthropic-version', value: '2023-06-01' },
            { name: 'content-type', value: 'application/json' },
          ],
        },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: body,
        options: { timeout: 30000, retry: { retry: { maxTries: 2, waitBetweenTries: 1000 } } },
      }, {
        credentials: { httpHeaderAuth: CRED.anthropic ?? { id: 'REPLACE_ME', name: 'Anthropic x-api-key' } },
        onError: 'continueErrorOutput',
      })),
      js(`فكّك مخرَج ${name}`, parse, 1),
      stop(`وقف: فشل نداء ${name}`, 1, 1),
    ],
    wires: [
      [name, `فكّك مخرَج ${name}`],
      [name, `وقف: فشل نداء ${name}`, { output: 1 }],
    ],
    entry: name,
    exit: `فكّك مخرَج ${name}`,
    width: 2,
  };
};

// ═══ ٦ · الأفعال ═══════════════════════════════════════════════════════════

/**
 * http — نداء خارجي بفرع خطأ صريح.
 * 🔴 onError='continueErrorOutput' ماشي 'continueRegularOutput'. الثاني يخلّي
 *    الرفض (401، 429، 500) يمشي فـ نفس المسار كأنه نجاح — أخضر و ما وصل والو.
 * opts: { name, method='POST', url, headers={}, json='={{ ... }}', timeout=15000 }
 */
export const http = (o = {}) => {
  if (!o.name || !o.url) throw new Error('http: لازم name و url');
  const params = {
    method: o.method ?? 'POST',
    url: o.url,
    options: {
      timeout: o.timeout ?? 15000,
      retry: { retry: { maxTries: o.retries ?? 2, waitBetweenTries: 1000 } },
    },
  };
  if (o.headers && Object.keys(o.headers).length) {
    params.sendHeaders = true;
    params.headerParameters = {
      parameters: Object.entries(o.headers).map(([name, value]) => ({ name, value })),
    };
  }
  if (o.json) {
    params.sendBody = true;
    params.specifyBody = 'json';
    params.jsonBody = o.json;
  }
  const extra = { onError: 'continueErrorOutput' };
  if (o.credential) extra.credentials = o.credential;
  return {
    nodes: [
      at(0, 0, node(o.name, 'n8n-nodes-base.httpRequest', 4.2, [0, 0], params, extra)),
      stop(`فشل: ${o.name}`, 1, 1),
    ],
    wires: [[o.name, `فشل: ${o.name}`, { output: 1 }]],
    entry: o.name,
    exit: o.name,
    width: 1,
  };
};

/**
 * telegramAlert — التنبيه اللي يخلّي الفشل مسموعاً.
 * 🔴 الهروب يتمّ فـ الكود، ماشي فـ تعبير داخل العقدة. اسم مستخدم فيه `_` كسر
 *    أوّل تنبيه حقيقي — Telegram قرأها Markdown و رفض الرسالة كلها.
 * opts: { name, chatId, text: '={{ ... }}' أو دالة نصّية, token }
 */
export const telegramAlert = (o = {}) => {
  const name = o.name ?? 'نبّه تيليجرام';
  const build = `// 🔴 الهروب هنا فـ الكود. تعبير داخل العقدة ما يهربش الرموز،
//    و رمز واحد يرفض الرسالة كلها — فيصير الفشل صامتاً مرّتين.
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const out = [];
for (const item of $input.all()) {
  const j = item.json ?? {};
  out.push({ json: { ...j, alert_text: ${o.text
    ? `esc(${String(o.text).replace(/^=\{\{\s*|\s*\}\}$/g, '')})`
    : "'⚠️ ' + esc(j.reason ?? j.skip_reason ?? 'حدث بلا سبب مكتوب')"} } });
}
return out.length ? out : [{ json: { alert_text: '⚠️ تنبيه بلا محتوى' } }];`;

  return {
    nodes: [
      js(`صُغ ${name}`, build, 0),
      at(1, 0, node(name, 'n8n-nodes-base.httpRequest', 4.2, [0, 0], {
        method: 'POST',
        url: `=https://api.telegram.org/bot{{ ${o.token ?? '$env.TELEGRAM_BOT_TOKEN'} }}/sendMessage`,
        sendBody: true,
        specifyBody: 'json',
        jsonBody: `={{ JSON.stringify({ chat_id: ${o.chatId ? JSON.stringify(String(o.chatId)) : '$env.TELEGRAM_CHAT_ID'}, text: $json.alert_text, parse_mode: 'HTML' }) }}`,
        options: { timeout: 10000 },
      }, { onError: 'continueErrorOutput' })),
      stop(`فشل: ${name}`, 2, 1),
    ],
    wires: [
      [`صُغ ${name}`, name],
      [name, `فشل: ${name}`, { output: 1 }],
    ],
    entry: `صُغ ${name}`,
    exit: name,
    width: 2,
  };
};

/** respond — ردّ صريح على الـ webhook (لمّا respondNow=false). */
export const respond = (o = {}) => {
  const name = o.name ?? 'ردّ';
  return {
    nodes: [at(0, 0, node(name, 'n8n-nodes-base.respondToWebhook', 1.1, [0, 0], {
      respondWith: o.json ? 'json' : 'text',
      ...(o.json ? { responseBody: o.json } : { responseBody: o.body ?? 'ok' }),
      options: { responseCode: o.code ?? 200 },
    }))],
    wires: [], entry: name, exit: name, width: 1,
  };
};

// ═══ ٧ · المراقبة ══════════════════════════════════════════════════════════

/**
 * watchdog — الحارس اللي يسأل «واش وقع الأثر؟»، ماشي «واش العقدة نجحت؟».
 * 🔴 يُبنى كورك فلو مستقلّ بمشغّل جدولة. استعمالو: [schedule(...), watchdog({...})]
 * 🔴 و شرط النجاح لازم يكون **عرَضاً**: «صفر ردّ من ساعتين» ماشي «العقدة رجعت 200».
 * opts: { symptomSql, name='الحارس', alert: {chatId} }
 */
export const watchdog = (o = {}) => {
  if (!o.symptomSql) throw new Error('watchdog: لازم symptomSql — استعلام يرجّع صفاً واحداً فيه ok boolean و reason text');
  const alert = telegramAlert({ name: 'نبّه الحارس', chatId: o.chatId, text: '$json.reason' });
  return {
    nodes: [
      pg('افحص العرَض', o.symptomSql, o.params ?? null, 0),
      ifNode('كلشي مليح؟', '={{ $json.ok }}', IS_TRUE, 1),
      stop('سليم — ولا تنبيه', 2, 0),
      ...alert.nodes.map((n) => ({ ...n, _col: n._col + 2, _row: 1 })),
    ],
    wires: [
      ['افحص العرَض', 'كلشي مليح؟'],
      ['كلشي مليح؟', 'سليم — ولا تنبيه', { output: 0 }],
      ['كلشي مليح؟', alert.entry, { output: 1 }],
      ...alert.wires,
    ],
    entry: 'افحص العرَض',
    exit: null,          // نهائي — الحارس ما يكمّلش لبلوك بعدو
    width: 4,
  };
};

// ── الفهرس، للمُركّب و للتوثيق ───────────────────────────────────────────────
export const BLOCKS = {
  webhook, schedule, manual,
  killSwitch, dedupe, dailyCap, echoFilter, businessHours,
  sql, logAction,
  code, branch, route, wait,
  llm,
  http, telegramAlert, respond,
  watchdog,
};
