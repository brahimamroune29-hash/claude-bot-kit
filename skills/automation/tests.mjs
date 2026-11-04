#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tests.mjs — تفحص أن **الحُرّاس يطلقون فعلاً**.
//
//   node tests.mjs
//
// حارس ما يطلقش أسوأ من بلا حارس: يعطيك ثقة بلا تغطية. فكل قاعدة مكتوبة فـ
// المكتبة عندها هنا تست يكسرها عمداً و يتأكّد أن البناء يرفض.
// ═══════════════════════════════════════════════════════════════════════════

import { build } from './assemble.mjs';
import { runChecks, warnGuards } from './kit.mjs';

let pass = 0, fail = 0;

const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  🔴 ${name}${detail ? `\n       ${detail}` : ''}`); }
};

const throws = (name, fn, match) => {
  try { fn(); ok(name, false, 'ما رماش خطأ — الحارس ما طلقش'); }
  catch (e) {
    ok(name, !match || e.message.includes(match), `الرسالة: ${e.message.slice(0, 120)}`);
  }
};

console.log('\n═══ ١ · الرفض المتعمَّد ═══');

throws('webhook بلا dedupe يُرفض',
  () => build([['webhook', { path: 'x' }], ['code', { name: 'c', code: 'return $input.all();' }]], {}),
  'dedupe');

ok('… و يمرّ لمّا يُكتب السبب',
  (() => {
    try {
      build([['webhook', { path: 'x' }], ['code', { name: 'c', code: 'return $input.all();' }]],
        { noDedupe: 'المزوّد يضمن مرّة واحدة' });
      return true;
    } catch { return false; }
  })());

throws('تفريع فـ وسط القائمة يُرفض',
  () => build([
    ['schedule', { minutes: 5 }],
    ['branch', { name: 'b', when: '={{ true }}', yes: [], no: [] }],
    ['code', { name: 'بعد التفريع', code: 'return $input.all();' }],
  ], {}),
  'نهائي');

throws('بلوك ما كاينش يُرفض بقائمة الموجود',
  () => build([['schedule', {}], ['blockMakanch', {}]], {}),
  'الموجود');

throws('dedupe بلا key يُرفض',
  () => build([['webhook', {}], ['dedupe', {}]], {}),
  'key');

throws('llm بلا system يُرفض',
  () => build([['schedule', {}], ['llm', { name: 'x' }]], {}),
  'system');

console.log('\n═══ ٢ · الفرع الميّت يتحوّل لعقدة توقّف مسمّاة ═══');

const emptyBranch = build([
  ['schedule', { minutes: 10 }],
  ['branch', { name: 'شرط', when: '={{ $json.x }}', yes: [['code', { name: 'خدمة', code: 'return $input.all();' }]], no: [] }],
], {});
ok('الفرع الفارغ يولّد عقدة توقّف',
  emptyBranch.nodes.some((n) => n.name.startsWith('وقف: شرط →')),
  emptyBranch.nodes.map((n) => n.name).join(' · '));
ok('… و المخرَج مربوط بها فعلاً',
  (emptyBranch.connections['شرط']?.main?.[1] ?? []).length === 1);

console.log('\n═══ ٣ · الفحوص البنيوية ═══');

const bad = build([
  ['schedule', { minutes: 5 }],
  ['code', { name: 'يرجّع فارغ', code: 'if (!$input.all().length) return [];\nreturn $input.all();' }],
], {});
ok('return [] تُمسَك',
  runChecks(bad.nodes, bad.connections).some((p) => p.includes('تُرجع []')),
  runChecks(bad.nodes, bad.connections).join(' | '));

const refBad = build([
  ['schedule', { minutes: 5 }],
  ['code', { name: 'مرجع طائر', code: "return [{ json: { v: $('عقدة ما كاينش').first().json.x } }];" }],
], {});
ok('مرجع $() لعقدة غير موجودة يُمسَك',
  runChecks(refBad.nodes, refBad.connections).some((p) => p.includes('مرجع مكسور')));

const twoTriggers = build([['schedule', { minutes: 5 }], ['code', { name: 'c', code: 'return $input.all();' }]], {});
twoTriggers.nodes.push({ id: 'x', name: 'trigger ثانٍ', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 900], parameters: {} });
ok('trigger ثانٍ يُمسَك',
  runChecks(twoTriggers.nodes, twoTriggers.connections).some((p) => p.includes('triggers')));

const orphan = build([['schedule', { minutes: 5 }], ['code', { name: 'c', code: 'return $input.all();' }]], {});
orphan.nodes.push({ id: 'y', name: 'يتيمة', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [0, 900], parameters: {} });
ok('عقدة يتيمة (فرع ميّت) تُمسَك',
  runChecks(orphan.nodes, orphan.connections).some((p) => p.includes('فرع ميّت')));

const secret = build([['schedule', { minutes: 5 }],
  ['code', { name: 'c', code: "return [{ json: { k: 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAA' } }];" }]], {});
ok('سرّ مكتوب خام يُمسَك',
  runChecks(secret.nodes, secret.connections).some((p) => p.includes('سرّ')));

console.log('\n═══ ٤ · قواعد البلوكات نفسها ═══');

const guards = build([
  ['webhook', { path: 'p' }], ['killSwitch', {}], ['dedupe', { key: '={{ $json.id }}' }],
  ['code', { name: 'c', code: 'return $input.all();' }],
], {});

ok('webhook يردّ 200 قبل المعالجة',
  guards.nodes.some((n) => n.type === 'n8n-nodes-base.respondToWebhook')
  && guards.connections['Webhook']?.main?.[0]?.[0]?.node === 'ردّ 200 فوراً');

ok('dedupe يستعمل CTE تختم بـ select (صفّ دائماً)',
  /with attempt as \([\s\S]*\)\s*select/i.test(
    guards.nodes.find((n) => n.name === 'حارس التكرار · استعلام').parameters.query));

// Postgres يستبدل العنصر بنتيجتو — بلا الاسترجاع، الحارس الموالي يقرا مفتاحو من {enabled:true}.
const nextOf = (from) => guards.connections[from]?.main?.[0]?.[0]?.node;
ok('العنصر يخرج من كل حارس كما دخل (ماشي نتيجة الاستعلام)',
  nextOf('مفتاح الإيقاف · رجّع العنصر') === 'حارس التكرار'
  && nextOf('حارس التكرار · رجّع العنصر') === 'c'
  && ['مفتاح الإيقاف', 'حارس التكرار'].every((h) =>
    guards.nodes.find((n) => n.name === `${h} · رجّع العنصر`)?.parameters.jsCode.includes(`$('${h}').item`)));

ok('كل حارس عندو مسار توقّف مسمّى',
  ['وقف: bot_enabled=false', 'وقف: حدث مكرّر'].every((s) => guards.nodes.some((n) => n.name === s)));

ok('ولا حارس يستعمل continueRegularOutput',
  !guards.nodes.some((n) => n.onError === 'continueRegularOutput'));

const withLlm = build([['schedule', {}], ['llm', { name: 'L', system: 'رجّع JSON' }]], {});
ok('llm عندو فرع خطأ صريح (continueErrorOutput)',
  withLlm.nodes.find((n) => n.name === 'L')?.onError === 'continueErrorOutput');
ok('llm عندو fallback فـ عقدة التفكيك',
  /llm_ok/.test(withLlm.nodes.find((n) => n.name === 'فكّك مخرَج L')?.parameters?.jsCode ?? ''));
ok('llm ما يكتبش المفتاح خام — credential',
  !!withLlm.nodes.find((n) => n.name === 'L')?.credentials?.httpHeaderAuth);

const noKill = build([['schedule', { minutes: 5 }], ['code', { name: 'c', code: 'return $input.all();' }]], {});
ok('غياب مفتاح الإيقاف يعطي تحذير (ماشي رفض)',
  warnGuards(noKill.nodes).some((w) => w.includes('مفتاح إيقاف')));

console.log(`\n${'═'.repeat(40)}`);
console.log(fail === 0 ? `✅ ${pass} تست · كلها مرّت` : `🔴 ${fail} فشل من ${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
