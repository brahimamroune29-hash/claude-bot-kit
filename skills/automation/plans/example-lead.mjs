// ═══════════════════════════════════════════════════════════════════════════
// مثال كامل — التقاط lead من webhook، تصنيفو بـ Claude، و توجيهو.
//
//   node $SKILL_DIR/assemble.mjs plans/example-lead.mjs
//
// يبني: webhook → ردّ 200 فوراً → مفتاح إيقاف → حارس تكرار → تطبيع
//        → تصنيف بـ Claude → تفريع (ساخن / بارد)
//
// اقراه كقالب: بدّل الـ system prompt و الـ SQL و خلاص.
// ═══════════════════════════════════════════════════════════════════════════

export const meta = {
  name: 'مثال · التقاط lead',
  out: 'workflow.json',
  tz: 'Africa/Algiers',
  note: `## التقاط lead

**المدخل:** POST على \`/lead\` — {id, name, phone, message} (id = رقم الإرسال اللي يعطيه الفورم)
**المخرَج:** صفّ فـ \`leads\` + تنبيه تيليجرام إذا كان ساخناً

الحُرّاس: مفتاح إيقاف · تكرار · سقف يومي
الإيقاف: \`update app_config set value='false' where key='bot_enabled'\`

**الجداول** (مرّة وحدة، مع جداول الحرّاس فـ references/catalogue.md):
\`create table leads (id serial primary key, lead_id text unique not null, name text, phone text, message text, intent text, hot boolean, created_at timestamptz default now());\``,
};

export const plan = [
  ['webhook', { path: 'lead', methods: ['POST'] }],

  // ── الحُرّاس. الترتيب مقصود: الأرخص أوّلاً ────────────────────────────
  ['killSwitch', {}],
  ['dedupe', { key: '={{ $json.body.id }}' }],
  // يعدّ نفس الـ kind اللي تكتبو logAction تحت — kind مختلف = سقف ما يطلقش أبداً.
  ['dailyCap', { cap: 200, kind: 'lead' }],

  // ── التطبيع. كل حقل يُقرأ مرّة و يُحمَل مع العنصر ─────────────────────
  ['code', {
    name: 'طبّع المدخل',
    code: `// 🔴 الحقول تُقرأ مرّة هنا و تُحمَل مع العنصر. القراءة المتأخّرة عبر
//    $('عقدة بعيدة') هي أوّل ما ينكسر لمّا يتبدّل اسم عقدة.
const out = [];
for (const item of $input.all()) {
  const b = item.json?.body ?? item.json ?? {};
  out.push({ json: {
    lead_id: String(b.id ?? ''),
    name:    String(b.name ?? '').trim().slice(0, 120),
    phone:   String(b.phone ?? '').replace(/[^0-9+]/g, ''),
    message: String(b.message ?? '').trim().slice(0, 2000),
    received_at: new Date().toISOString(),
  } });
}
return out.length ? out : [{ json: { empty: true, n: 0 } }];`,
  }],

  // ── التصنيف. الضمانة فـ عقدة التفكيك، ماشي فـ البرومبت ────────────────
  ['llm', {
    name: 'صنّف الـ lead',
    model: 'claude-sonnet-5-5',
    maxTokens: 300,
    user: '={{ $json.message }}',
    system: `أنت مصنّف طلبات. تقرا رسالة زبون و ترجّع JSON فقط، بلا أي نصّ آخر.

الحقول:
  "intent"  — واحد من: "شراء" | "سؤال" | "شكوى" | "غير ذلك"
  "hot"     — true إذا الزبون ذكر ميزانية ولا وقت محدّد ولا طلب سعر صراحةً
  "summary" — سطر واحد بالدارجة، أقلّ من 15 كلمة

ما تخترعش معلومة ما كانتش فـ الرسالة.`,
    fallback: { intent: 'غير ذلك', hot: false, summary: '' },
  }],

  // ── التفريع نهائي: كل استمرار يدخل داخل الفرع ─────────────────────────
  ['branch', {
    name: 'lead ساخن؟',
    when: '={{ $json.hot }}',
    yes: [
      ['sql', {
        name: 'خزّن الساخن',
        query: `with ins as (
  insert into leads (lead_id, name, phone, message, intent, hot, created_at)
  values ($1, $2, $3, $4, $5, true, now())
  on conflict (lead_id) do nothing
  returning id
)
select coalesce((select id from ins)::text, 'duplicate') as row_id`,
        params: "={{ [$('طبّع المدخل').item.json.lead_id, $('طبّع المدخل').item.json.name, $('طبّع المدخل').item.json.phone, $('طبّع المدخل').item.json.message, $json.intent] }}",
      }],
      ['telegramAlert', {
        name: 'نبّه على lead ساخن',
        text: "'🔥 lead ساخن — ' + $('طبّع المدخل').item.json.name + ' · ' + $('طبّع المدخل').item.json.phone",
      }],
      ['logAction', { name: 'سجّل: lead ساخن', kind: 'lead', ref: "$('طبّع المدخل').item.json.lead_id" }],
    ],
    no: [
      ['sql', {
        name: 'خزّن العادي',
        query: `with ins as (
  insert into leads (lead_id, name, phone, message, intent, hot, created_at)
  values ($1, $2, $3, $4, $5, false, now())
  on conflict (lead_id) do nothing
  returning id
)
select coalesce((select id from ins)::text, 'duplicate') as row_id`,
        params: "={{ [$('طبّع المدخل').item.json.lead_id, $('طبّع المدخل').item.json.name, $('طبّع المدخل').item.json.phone, $('طبّع المدخل').item.json.message, $json.intent] }}",
      }],
      ['logAction', { name: 'سجّل: lead عادي', kind: 'lead', ref: "$('طبّع المدخل').item.json.lead_id" }],
    ],
  }],
];
