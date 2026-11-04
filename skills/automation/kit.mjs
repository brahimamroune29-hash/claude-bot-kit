// ═══════════════════════════════════════════════════════════════════════════
// kit.mjs — الطبقة الأولى: عقدة، ربط، فحص، إخراج، دفع.
//
// هذي الطبقة **ما تعرفش شنو تبني**. تعرف فقط كيفاش تُبنى عقدة صحيحة، وكيفاش
// يُمسك الخطأ قبل ما يوصل لـ instance حيّة. البلوكات فوقها (`blocks.mjs`).
//
// 🔴 ليش ملف بناء بدل الرسم باليد فـ n8n
//    ١. «Import from File» يُسقط كتلة settings بصمت — يُستورد أخضر وبإعدادات
//       غير اللي فـ الملف.
//    ٢. الرسم باليد ما فيه diff ولا تست ولا تراجع. «شنو اتبدّل؟» بلا جواب.
//
// 🔴 والفرق عن `deploy()` فـ auto/templates: هنا الإخراج لملف **ما يحتاجش
//    مفاتيح API**. تقدر تبني workflow.json و تستوردو باليد. الدفع اختياري.
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

// ── .env من مجلد الشغل الحالي، إذا كان ──────────────────────────────────────
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
  }
}

export const BASE = (process.env.N8N_BASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.N8N_API_KEY;
export const TZ = process.env.TIMEZONE || 'UTC';

// 🔴 معرّفات الـ credentials تُستخرَج من instance حيّة، ما تُخمَّنش. credential
//    غير موجود ما يعطيش خطأ عند الدفع — يعطي عقدة تفشل وقت التنفيذ فقط، وهذا
//    نفس صنف الفشل الصامت. اكتشفها بـ: node kit.mjs --creds
export const CRED = JSON.parse(process.env.N8N_CREDENTIALS || '{}');

// ── إعدادات الورك فلو ───────────────────────────────────────────────────────
// 🔴 saveDataSuccessExecution='all' أثناء البناء والتثبيت. نظام حقيقي كان على
//    'none' فجاء يسأل «وش سلّم المزوّد فعلاً؟» فلقى ٤١ تنفيذاً كلها يدوية —
//    كانوا يصلّحون أعمى لأسابيع.
export const SETTINGS = {
  executionOrder: 'v1',
  timezone: TZ,
  saveManualExecutions: true,
  saveDataErrorExecution: 'all',
  saveDataSuccessExecution: 'all',
  saveExecutionProgress: true,
};

// القائمة البيضاء لما يقبله الـ API. أي مفتاح خارجها = 400 يُفشل الدفعة كلها.
const KEEP = ['executionOrder', 'timezone', 'saveManualExecutions',
  'saveDataErrorExecution', 'saveDataSuccessExecution', 'saveExecutionProgress',
  'errorWorkflow', 'executionTimeout', 'availableInMCP'];

// ═══ بناء العقد ════════════════════════════════════════════════════════════

// معرّف ثابت مشتق من الاسم: إعادة الدفع تُبقي نفس العقدة بدل بديلة، فتُحفظ
// المواضع و pinned data عبر الدفعات.
const idOf = (name) => {
  const h = createHash('sha256').update(name).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

export function node(name, type, typeVersion, position, parameters = {}, extra = {}) {
  return { id: idOf(name), name, type, typeVersion, position, parameters, ...extra };
}

export function sticky(name, content, position, [width, height], color = 4) {
  return node(name, 'n8n-nodes-base.stickyNote', 1, position, { content, width, height, color });
}

// ── شرط IF — الصيغة v2، مأخوذة من عقد حيّة لا من التوثيق ───────────────────
export const IS_TRUE  = { type: 'boolean', operation: 'true',  singleValue: true };
export const IS_FALSE = { type: 'boolean', operation: 'false', singleValue: true };
export const EQUALS   = { type: 'string',  operation: 'equals' };
export const NOT_EMPTY = { type: 'string', operation: 'notEmpty', singleValue: true };
export const GT       = { type: 'number',  operation: 'gt' };

export const cond = (id, left, op, right = '') => ({
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
    conditions: [{ id, leftValue: left, rightValue: right, operator: op }],
    combinator: 'and',
  },
  options: {},
});

// ── الربط. يرفض الاسم غير الموجود وقت البناء بدل وقت التشغيل ───────────────
export function wire(nodes, pairs) {
  const names = new Set(nodes.map((n) => n.name));
  const conn = {};
  for (const [from, to, opts = {}] of pairs) {
    if (!names.has(from)) throw new Error(`ربط من عقدة غير موجودة: "${from}"`);
    const targets = Array.isArray(to) ? to : [to];
    for (const t of targets) {
      if (t !== null && !names.has(t)) throw new Error(`ربط إلى عقدة غير موجودة: "${t}"`);
    }
    const kind = opts.type ?? 'main';
    const out = opts.output ?? 0;
    conn[from] ??= {};
    conn[from][kind] ??= [];
    while (conn[from][kind].length <= out) conn[from][kind].push([]);
    for (const t of targets) {
      if (t === null) continue;
      conn[from][kind][out].push({ node: t, type: kind, index: opts.index ?? 0 });
    }
  }
  return conn;
}

// ═══ الفحوص البنيوية — تفشّل البناء قبل ما يموت حدث حقيقي ══════════════════

const TRIGGERS = new Set([
  'n8n-nodes-base.webhook', 'n8n-nodes-base.scheduleTrigger',
  'n8n-nodes-base.manualTrigger', 'n8n-nodes-base.cron',
  'n8n-nodes-base.emailReadImap', 'n8n-nodes-base.formTrigger',
  'n8n-nodes-base.executeWorkflowTrigger', 'n8n-nodes-base.errorTrigger',
]);

// 🔴 كل مرجع $('اسم') لازم يسمّي عقدة موجودة.
export function checkRefs(nodes) {
  const names = new Set(nodes.map((n) => n.name));
  const bad = [];
  for (const n of nodes) {
    if (n.type === 'n8n-nodes-base.stickyNote') continue;
    const p = n.parameters ?? {};
    const code = typeof p.jsCode === 'string'
      ? p.jsCode.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
      : '';
    const scan = JSON.stringify({ ...p, jsCode: code });
    for (const m of scan.matchAll(/\$\('([^']+)'\)/g)) {
      if (!names.has(m[1])) bad.push(`${n.name} → $('${m[1]}')`);
    }
  }
  return [...new Set(bad)];
}

// 🔴 وضع تنفيذ الـ Code node يطابق جسمه. `return []` تُتجاهَل **بصمت** فـ وضع
//    Each Item ⇒ الفلترة ما تشتغل إطلاقاً، والتنفيذ أخضر.
export function checkCodeMode(nodes) {
  const bad = [];
  for (const n of nodes) {
    if (n.type !== 'n8n-nodes-base.code') continue;
    const body = String(n.parameters?.jsCode ?? '');
    const mode = n.parameters?.mode ?? 'runOnceForAllItems';
    const needsAll = /\$input\s*\.\s*(first|all|last)\s*\(/.test(body)
      || /return\s*\[\s*\]/.test(body)
      || /\bitems\s*\.\s*map\b/.test(body);
    if (needsAll && mode !== 'runOnceForAllItems') {
      bad.push(`${n.name}: الجسم جماعي والوضع "${mode}" — لازم runOnceForAllItems`);
    }
    const eachItem = mode === 'runOnceForEachItem';
    if (eachItem && /\$input\s*\.\s*all\s*\(/.test(body)) {
      bad.push(`${n.name}: $input.all() فـ وضع Each Item — يرجّع عنصراً واحداً فقط`);
    }
  }
  return bad;
}

// 🔴 ولا عقدة تُرجع [] — الفرع يموت بلا أثر ولا سبب ولا خطأ.
export function checkEmptyReturn(nodes) {
  const bad = [];
  for (const n of nodes) {
    if (n.type !== 'n8n-nodes-base.code') continue;
    const body = String(n.parameters?.jsCode ?? '')
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    if (/return\s*\[\s*\]\s*;?/.test(body)) {
      bad.push(`${n.name}: return []  ← أرجع [{json:{empty:true,n:0}}] وافحصها بـ IF`);
    }
  }
  return bad;
}

// 🔴 لا "Never Error" على HTTP — يحوّل الرفض لعلامة خضراء.
export function checkNeverError(nodes, allowList = []) {
  const allow = new Set(allowList);
  const bad = [];
  for (const n of nodes) {
    if (n.onError !== 'continueRegularOutput') continue;
    if (allow.has(n.name)) continue;
    if (n.type === 'n8n-nodes-base.httpRequest') {
      bad.push(`${n.name}: continueRegularOutput على HTTP — يحوّل الرفض لعلامة خضراء`);
    }
  }
  return bad;
}

// أسرار مكتوبة خام داخل العقد.
const SECRET_RE = /(sk-ant-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}|\b[0-9a-f]{32}\b)/;
export function checkSecrets(nodes) {
  const bad = [];
  for (const n of nodes) {
    if (n.type === 'n8n-nodes-base.stickyNote') continue;
    const s = JSON.stringify(n.parameters ?? {});
    const m = s.match(SECRET_RE);
    if (m) bad.push(`${n.name}: قيمة تشبه سرّاً — «${m[0].slice(0, 12)}…»`);
  }
  return bad;
}

// 🔴 عقدة ما يوصلهاش والو وماشي trigger = فرع ميّت. يُستورد أخضر وما ينفّذش
//    أبداً — وهذا بالضبط شكل «كلشي أخضر وما صار والو».
export function checkOrphans(nodes, connections) {
  const reached = new Set();
  for (const kinds of Object.values(connections)) {
    for (const outs of Object.values(kinds)) {
      for (const list of outs ?? []) for (const c of list ?? []) reached.add(c.node);
    }
  }
  return nodes
    .filter((n) => n.type !== 'n8n-nodes-base.stickyNote')
    .filter((n) => !TRIGGERS.has(n.type) && !reached.has(n.name))
    .map((n) => `${n.name}: ما يوصلها ولا ربط — فرع ميّت`);
}

// 🔴 trigger واحد بالضبط. صفر = ما ينطلقش أبداً. أكثر من واحد = مسارات
//    متوازية تكتب نفس الصف مرّتين.
export function checkTrigger(nodes) {
  const t = nodes.filter((n) => TRIGGERS.has(n.type));
  if (t.length === 0) return ['ولا trigger — الورك فلو ما ينطلقش أبداً'];
  if (t.length > 1) return [`${t.length} triggers: ${t.map((n) => n.name).join(' · ')} — واحد فقط، ولا افصلهم فـ ملفّين`];
  return [];
}

// 🔴 webhook بـ responseMode='responseNode' بلا عقدة ردّ = المزوّد يستنّى حتى
//    ينتهي المهلة ثم يعتبرها فشلاً ويعيد الإرسال. Meta تسحب الاشتراك بعدها.
export function checkWebhookResponse(nodes) {
  const hooks = nodes.filter((n) => n.type === 'n8n-nodes-base.webhook');
  if (!hooks.length) return [];
  const hasRespond = nodes.some((n) => n.type === 'n8n-nodes-base.respondToWebhook');
  const bad = [];
  for (const h of hooks) {
    if (h.parameters?.responseMode === 'responseNode' && !hasRespond) {
      bad.push(`${h.name}: responseMode='responseNode' وما فيه عقدة Respond — المزوّد يستنّى ثم يعيد الإرسال`);
    }
  }
  return bad;
}

// ⚠️ تحذير لا مانع: مسار مدفوع بأحداث بلا حارس تكرار. الحدث يجي مرّتين من
//    كل مزوّد تقريباً — وبلا idempotency يتعالج مرّتين (٤٢ رسالة لزبون واحد).
export function warnGuards(nodes) {
  const warn = [];
  const hasWebhook = nodes.some((n) => n.type === 'n8n-nodes-base.webhook');
  const text = JSON.stringify(nodes.map((n) => n.parameters ?? {}));
  if (hasWebhook && !/on conflict|dedupe|idempot/i.test(text)) {
    warn.push('webhook بلا حارس تكرار — الحدث المُعاد يتعالج مرّتين. زيد بلوك dedupe');
  }
  if (!/bot_enabled|kill_switch|app_config/i.test(text)) {
    warn.push('ولا مفتاح إيقاف — ما عندكش كيفاش توقّفو بلا ما تطفي الورك فلو');
  }
  return warn;
}

export function runChecks(nodes, connections, { allowNeverError = [] } = {}) {
  const dupes = nodes.map((n) => n.name).filter((n, i, a) => a.indexOf(n) !== i);
  return [
    ...checkTrigger(nodes),
    ...checkRefs(nodes).map((s) => `مرجع مكسور: ${s}`),
    ...checkCodeMode(nodes).map((s) => `وضع تنفيذ: ${s}`),
    ...checkEmptyReturn(nodes).map((s) => `عقدة تُرجع []: ${s}`),
    ...checkNeverError(nodes, allowNeverError).map((s) => `Never Error: ${s}`),
    ...checkSecrets(nodes).map((s) => `سرّ فـ عقدة: ${s}`),
    ...checkOrphans(nodes, connections).map((s) => `فرع ميّت: ${s}`),
    ...checkWebhookResponse(nodes).map((s) => `webhook بلا ردّ: ${s}`),
    ...[...new Set(dupes)].map((d) => `اسم عقدة مكرّر: ${d}`),
  ];
}

// ═══ الإخراج لملف — ما يحتاجش مفاتيح ═══════════════════════════════════════
export function emit({ name, nodes, connections, settings = SETTINGS,
                       allowNeverError = [], out = 'workflow.json' }) {
  const problems = runChecks(nodes, connections, { allowNeverError });
  const warns = warnGuards(nodes);

  if (problems.length) {
    console.error(`🔴 ${problems.length} مشكلة بنيوية — ما كتبت والو:`);
    problems.forEach((p) => console.error(`     ${p}`));
    process.exit(1);
  }

  const body = {
    name, nodes, connections,
    settings: Object.fromEntries(Object.entries(settings).filter(([k]) => KEEP.includes(k))),
  };
  mkdirSync(dirname(out) === '' ? '.' : dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(body, null, 2));

  console.log(`✅ ${name} — ${nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote').length} عقدة · الفحوص مرّت`);
  console.log(`   ${out}`);
  if (warns.length) {
    console.log('');
    warns.forEach((w) => console.log(`   ⚠️  ${w}`));
  }
  return body;
}

// ═══ الدفع (اختياري — يحتاج N8N_BASE_URL و N8N_API_KEY) ════════════════════
const api = async (p, init = {}) => {
  const r = await fetch(`${BASE}/api/v1${p}`, {
    ...init,
    headers: {
      'X-N8N-API-KEY': KEY,
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(60000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} على ${p}\n   ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
};

const listAll = async () => {
  const out = [];
  let cursor = '';
  do {
    const { data, nextCursor } = await api(
      `/workflows?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    out.push(...data);
    cursor = nextCursor || '';
  } while (cursor);
  return out;
};

export async function deploy({ name, nodes, connections, settings = SETTINGS,
                               allowNeverError = [] }) {
  if (!BASE || !KEY) {
    console.error('🔴 الدفع يحتاج N8N_BASE_URL و N8N_API_KEY فـ .env — أو استعمل emit() واستورد باليد.');
    process.exit(2);
  }
  const problems = runChecks(nodes, connections, { allowNeverError });
  if (problems.length) {
    console.error(`🔴 ${problems.length} مشكلة بنيوية — ما دُفع والو:`);
    problems.forEach((p) => console.error(`     ${p}`));
    process.exit(1);
  }

  // 🔴 الحلّ بالاسم وقت التشغيل. ID مثبّت فـ الكود يصير قديماً بصمت.
  const all = await listAll();
  const live = all.filter((w) => w.name === name && !w.isArchived);
  if (live.length > 1) {
    console.error(`🔴 ${live.length} نسخة حيّة تحمل الاسم "${name}". ما نخمّنش أيّها.`);
    live.forEach((w) => console.error(`     ${w.id}`));
    process.exit(1);
  }

  const body = {
    name, nodes, connections,
    settings: Object.fromEntries(Object.entries(settings).filter(([k]) => KEEP.includes(k))),
  };

  // 🔴 PUT يطفئ الورك فلو. اكتُشف بعد ما صار ورك فلو جدولة idle بصمت.
  const wasActive = live.length > 0 && live[0].active === true;

  let id;
  if (live.length === 0) {
    id = (await api('/workflows', { method: 'POST', body: JSON.stringify(body) })).id;
    console.log(`   أُنشئ  ${name}  (${id})`);
  } else {
    id = live[0].id;
    await api(`/workflows/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    console.log(`   دُفع   ${name}  (${id})`);
  }

  // 🔴 «دفعتُ» ماشي «وصلت». يُعاد القراءة ويُقارَن.
  const back = await api(`/workflows/${id}`);
  const after = [];
  if (back.nodes.length !== nodes.length) {
    after.push(`عدد العقد: دفعت ${nodes.length}، رجع ${back.nodes.length}`);
  }
  for (const n of nodes) if (!back.nodes.some((b) => b.name === n.name)) after.push(`عقدة ضاعت: "${n.name}"`);
  for (const k of Object.keys(body.settings)) {
    if (JSON.stringify(back.settings?.[k]) !== JSON.stringify(body.settings[k])) {
      after.push(`إعداد "${k}": دفعت ${JSON.stringify(body.settings[k])}، رجع ${JSON.stringify(back.settings?.[k])}`);
    }
  }
  if (after.length) {
    console.error('   🔴 ما دُفع ماشي ما وصل:');
    after.forEach((p) => console.error(`        ${p}`));
    process.exit(1);
  }

  if (wasActive && back.active !== true) {
    await api(`/workflows/${id}/activate`, { method: 'POST' });
    const again = await api(`/workflows/${id}`);
    if (again.active !== true) {
      console.error('   🔴 كان يخدم، وطفّاه الدفع، وفشلت إعادة تشغيلو. الورك فلو واقف دابا.');
      process.exit(1);
    }
    console.log('   ↻ كان يخدم — أُعيد تشغيلو بعد الدفع.');
  }

  console.log(`   ✅ تأكيد: ${back.nodes.length} عقدة · الإعدادات مطابقة`);
  const hook = nodes.find((n) => n.type === 'n8n-nodes-base.webhook');
  if (hook) console.log(`   🔗 ${BASE}/webhook/${hook.parameters.path}`);
  console.log(`   🖥  ${BASE}/workflow/${id}`);
  console.log('   ⏸  التفعيل قرار المستخدم — من المتصفح.');
  return id;
}

// ── اكتشاف الـ credentials الموجودة فعلاً: node kit.mjs --creds ─────────────
if (process.argv.includes('--creds')) {
  const all = await listAll();
  const found = new Map();
  for (const w of all) {
    for (const n of w.nodes ?? []) {
      for (const [type, c] of Object.entries(n.credentials ?? {})) {
        found.set(`${type}:${c.id}`, { type, id: c.id, name: c.name, seenIn: w.name });
      }
    }
  }
  console.log(JSON.stringify([...found.values()], null, 2));
}

export { api, listAll };
