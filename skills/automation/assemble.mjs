#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// assemble.mjs — المُركّب. ياخذ خطّة (قائمة بلوكات) و يرجّع ورك فلو صالح.
//
//   node assemble.mjs plans/my-flow.mjs                 → workflow.json
//   node assemble.mjs plans/my-flow.mjs --deploy        → يدفع للـ instance
//
// 🔴 المُركّب يرفض البناء فـ حالتين، ماشي ينبّه:
//    ١. webhook بلا حارس تكرار — الحدث المُعاد يتعالج مرّتين. الخروج منها
//       يكون بـ `noDedupe: 'السبب مكتوب'` فـ meta، ماشي بالسكوت.
//    ٢. مخرَج IF/Switch بلا ربط — الفرع يموت أخضر. المُركّب يحطّ عقدة توقّف
//       مسمّاة تلقائياً بدل ما يخلّي الحفرة.
// ═══════════════════════════════════════════════════════════════════════════

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { node, wire, sticky, emit, deploy, SETTINGS, TZ } from './kit.mjs';
import { BLOCKS } from './blocks.mjs';

const COL = 240;   // بكسل بين عمود و عمود
const ROW = 170;   // بكسل بين صفّ و صفّ

// ── تحويل خطوة إلى بلوك ────────────────────────────────────────────────────
const instantiate = (step) => {
  if (Array.isArray(step)) {
    const [name, opts = {}] = step;
    const fn = BLOCKS[name];
    if (!fn) {
      throw new Error(`بلوك ما كاينش: "${name}"\n   الموجود: ${Object.keys(BLOCKS).join(' · ')}`);
    }
    return { ...fn(opts), _blockName: name };
  }
  if (step && typeof step === 'object' && step.nodes) return step;   // بلوك جاهز
  throw new Error(`خطوة ماشي مفهومة: ${JSON.stringify(step)}`);
};

// ── البناء ─────────────────────────────────────────────────────────────────
export function build(plan, meta = {}) {
  const nodes = [];
  const wires = [];
  const used = [];                 // أسماء البلوكات المستعملة، للفحوص
  let maxRow = 0;

  const walk = (steps, col0, row) => {
    let col = col0;
    let prevExit = null;
    let prevOut = 0;
    let last = null;

    steps.forEach((step, i) => {
      const b = instantiate(step);
      used.push(b._blockName ?? 'custom');

      for (const n of b.nodes) {
        nodes.push({ ...n, _col: (n._col ?? 0) + col, _row: (n._row ?? 0) + row });
      }
      wires.push(...(b.wires ?? []));
      if (prevExit) wires.push([prevExit, b.entry, { output: prevOut }]);

      // ── تفريع: الفرعان خطّتان فرعيتان، و البلوك نهائي فـ هذي القائمة ──
      if (b.kind === 'branch' || b.kind === 'route') {
        if (i !== steps.length - 1) {
          throw new Error(
            `"${b.entry}" تفريع، و بعدو ${steps.length - i - 1} خطوة فـ نفس القائمة.\n` +
            '   التفريع نهائي — حطّ الاستمرار داخل الفرع نفسو (yes/no ولا cases).');
        }
        const sub = b.kind === 'branch'
          ? [['نعم', b.yes, 0], ['لا', b.no, 1]]
          : [...Object.entries(b.cases).map(([k, p], idx) => [k, p, idx]),
             ['غير ذلك', b.fallback, Object.keys(b.cases).length]];

        sub.forEach(([label, subPlan, output], idx) => {
          const subRow = idx === 0 ? row : ++maxRow;
          if (!subPlan || !subPlan.length) {
            // 🔴 مخرَج بلا ربط = فرع ميّت. عقدة توقّف مسمّاة بدل الحفرة.
            const stopName = `وقف: ${b.entry} → ${label}`;
            nodes.push({ ...node(stopName, 'n8n-nodes-base.noOp', 1, [0, 0]),
              _col: col + b.width, _row: subRow });
            wires.push([b.entry, stopName, { output }]);
            return;
          }
          const res = walk(subPlan, col + b.width, subRow);
          wires.push([b.entry, res.entry, { output }]);
        });
        last = b;
        prevExit = null;
        return;
      }

      prevExit = b.exit;
      prevOut = b.exitOutput ?? 0;
      col += b.width ?? 1;
      last = b;
      if (row > maxRow) maxRow = row;
    });

    return { entry: instantiate(steps[0]).entry, exit: prevExit, exitOut: prevOut, endCol: col, last };
  };

  walk(plan, 0, 0);

  // ── الرفض المتعمَّد ──────────────────────────────────────────────────────
  const hasWebhook = used.includes('webhook');
  if (hasWebhook && !used.includes('dedupe') && !meta.noDedupe) {
    throw new Error(
      'webhook بلا بلوك dedupe.\n' +
      '   كل مزوّد يعيد إرسال الحدث — و بلا حارس تكرار يتعالج مرّتين.\n' +
      '   (٤٢ رسالة لزبون واحد فـ ١٤ ساعة كانت هذي بالضبط.)\n' +
      "   زيد ['dedupe', { key: '={{ $json.body.id }}' }] — أو اكتب السبب:\n" +
      "   meta = { …, noDedupe: 'المزوّد يضمن مرّة واحدة، موثَّق فـ …' }");
  }

  // ── المواضع ──────────────────────────────────────────────────────────────
  const placed = nodes.map((n) => {
    const { _col, _row, ...rest } = n;
    return { ...rest, position: [_col * COL, _row * ROW] };
  });

  // ── الشرح كملاحظة لاصقة، إذا كُتب ───────────────────────────────────────
  if (meta.note) {
    placed.unshift(sticky('شرح', meta.note, [-COL - 40, -ROW], [220, 100 + maxRow * 40]));
  }

  const connections = wire(placed, wires);
  return { name: meta.name ?? 'workflow', nodes: placed, connections, used };
}

// ── CLI ────────────────────────────────────────────────────────────────────
const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  const file = process.argv[2];
  if (!file) {
    console.error('الاستعمال: node assemble.mjs plans/my-flow.mjs [--deploy]');
    process.exit(2);
  }
  const mod = await import(pathToFileURL(resolve(file)).href);
  const meta = mod.meta ?? {};
  const plan = mod.plan ?? mod.default;
  if (!Array.isArray(plan)) {
    console.error(`🔴 ${file}: لازم يُصدّر \`plan\` (مصفوفة خطوات) و \`meta\``);
    process.exit(2);
  }

  let built;
  try {
    built = build(plan, meta);
  } catch (e) {
    console.error(`🔴 ${e.message}`);
    process.exit(1);
  }

  const settings = { ...SETTINGS, timezone: meta.tz ?? TZ };
  if (process.argv.includes('--deploy')) {
    await deploy({ ...built, settings });
  } else {
    emit({ ...built, settings, out: meta.out ?? 'workflow.json' });
    console.log(`   البلوكات: ${built.used.join(' → ')}`);
  }
}
