# فهرس البلوكات — الخيارات الكاملة

كل بلوك يرجّع `{ nodes, wires, entry, exit, width }`. المُركّب يربط
`exit` تاع الواحد بـ `entry` تاع اللي بعدو، و يحسب المواضع.

الجداول المذكورة هي المتوقَّعة افتراضياً — كلها قابلة للتبديل بـ `table`.

---

## ١ · المشغّلات

### `webhook`
```js
['webhook', {
  path: 'lead',              // إلزامي عملياً — يصير /webhook/lead
  methods: ['POST'],         // أكثر من واحد ⇒ multipleMethods
  respondNow: true,          // ردّ 200 قبل أي معالجة (الافتراضي)
  body: 'EVENT_RECEIVED',    // جسم الردّ الفوري
  name: 'Webhook',
}]
```
🔴 `respondNow: true` يخلق عقدة `ردّ 200 فوراً` **قبل** المعالجة. المزوّد
ما ينتظرش ⇒ ما يعيدش الإرسال ⇒ ما تتضاعفش الأحداث. Meta تسحب الاشتراك إذا
تأخّر الردّ — و السحب صامت: تلقى ٣ أيام بلا حدث واحد و كلشي أخضر.

تخلّيها `false` فقط إذا كنت تريد ترجّع نتيجة المعالجة نفسها — و ساعتها
لازم بلوك `respond` فـ آخر كل مسار.

### `schedule`
```js
['schedule', { minutes: 5 }]              // كل ٥ دقائق
['schedule', { hours: 2 }]                // كل ساعتين
['schedule', { cron: '0 9 * * *' }]       // تعبير cron
```
التوقيت يجي من `meta.tz` (ولا `TIMEZONE` فـ `.env`). ⚠️ الافتراضي `UTC` —
حدّدو صراحةً و إلا «التاسعة صباحاً» تصير العاشرة ليلاً عند العميل.

### `manual`
للتجربة. **ما يتركش فـ ورك فلو إنتاج** — يعطيك إحساس أنه يخدم و هو ما ينطلقش
وحدو أبداً. (نظام حقيقي لقى ٤١ تنفيذاً كلها يدوية و ولا تسليمة واحدة.)

---

## ٢ · الحُرّاس

`killSwitch` و`dedupe` و`dailyCap` يخرّجو العنصر **كما دخل**: عقدة Postgres تستبدلو بنتيجة
الاستعلام، فكل حارس يمسكو عند الدخول و يرجّعو عند الخروج. يعني `$json` بعد الحارس = نفس `$json` قبلو.

### `killSwitch`
```js
['killSwitch', { key: 'bot_enabled', table: 'app_config' }]
```
```sql
create table app_config (key text primary key, value text not null);
insert into app_config values ('bot_enabled', 'true');
```
🔴 مفتاح **واحد**. لا `shadow_mode` ولا نافذة ثقة ولا أعلام متفرّقة يناقض
بعضها بعضاً — لأن ساعة العطل ما عندكش وقت تفهم أي علم يغلب أيّاً.

🔴 و لاحظ الاستعلام: `select coalesce((select value …), 'false') = 'true' as enabled`
— **select عارٍ يرجّع صفاً واحداً دائماً**، حتى لو المفتاح غير موجود.
`select value from app_config where key=$1` ترجّع صفر صفوف عند الغياب ⇒
الفرع يموت أخضر و البوت يسكت بلا سبب مكتوب.

الإيقاف: `update app_config set value='false' where key='bot_enabled';`
— بلا ما تطفي الورك فلو (الإطفاء يخسّر كل حدث داخل).

### `dedupe`
```js
['dedupe', { key: '={{ $json.body.id }}', table: 'seen_events' }]
```
```sql
create table seen_events (
  event_key text primary key,
  seen_at   timestamptz not null default now()
);
create index on seen_events (seen_at);          -- للتنظيف
```
🔴 `key` لازم يكون **المعرّف الفريد للحدث من المزوّد**، ماشي معرّف المستخدم
ولا الوقت. `mid` تاع الرسالة، `id` تاع التعليق، `event_id` تاع الويبهوك.

🔴 و السبب اللي خلّى الاستعلام CTE:
```sql
insert … on conflict do nothing returning 1     -- ⛔️ صفر صفوف عند التكرار
with attempt as (insert … returning 1)
select (select count(*) from attempt) > 0 as is_new   -- ✅ صفّ دائماً
```
الأولى تقتل الفرع بصمت عند كل تكرار — و هذا يبان «يخدم» لأن أوّل حدث يمرّ.

التنظيف (بلاه الجدول يكبر بلا حدّ):
```sql
delete from seen_events where seen_at < now() - interval '7 days';
```

### `dailyCap`
```js
['dailyCap', { cap: 200, kind: 'send', table: 'actions_log' }]
```
🔴 العدّ من القاعدة، ماشي عدّاد فـ الذاكرة. عدّاد فـ الذاكرة يتصفّر مع كل
إعادة تشغيل ⇒ الحدّ يختفي و ما يعرف حدّ.

⚠️ و انتبه للحقل اللي يجي من المستخدم: `parseInt('٣', 10)` = `NaN`، و`NaN`
يطيح للافتراضي — و إذا الافتراضي `0` معناه «بلا حدّ»، فطلب سقفاً فصار بلا
سقف. أسوأ عكس ممكن، و اللوحة قالت «انحفظ ✓».

### `echoFilter`
```js
['echoFilter', { senderPath: '$json.sender_id', ourIds: ['17841400000000000'] }]
```
🔴 ردّنا يرجع من المزوّد كحدث داخل. بلا هذا الحارس: ردّ ⇒ حدث ⇒ ردّ ⇒ حلقة
لانهائية تبان **نشاطاً** فـ اللوحة، ماشي عطلاً.

### `businessHours`
```js
['businessHours', { tz: 'Africa/Algiers', from: 9, to: 18, days: [0,1,2,3,4] }]
```
`days`: 0=الأحد … 6=السبت. الافتراضي الأحد–الخميس (أسبوع خليجي).
🔴 الوقت محسوب بـ `Intl.DateTimeFormat` بتوقيت صريح — `new Date().getHours()`
فـ n8n يعطي توقيت **الخادم**.

---

## ٣ · البيانات

### `sql`
```js
['sql', {
  name: 'خزّن الطلب',
  query: `with ins as (
    insert into orders (ref, amount) values ($1, $2) returning id
  )
  select coalesce((select id from ins)::text, 'duplicate') as row_id`,
  params: '={{ [$json.ref, $json.amount] }}',
  continueOnFail: false,
}]
```
`$1, $2…` تُملأ بالترتيب من مصفوفة `params`.

🔴 أي `insert`/`update`/`delete` لازم يُلفّ فـ CTE و يُختم بـ **select عارٍ**.
`returning` وحدها ترجّع صفر صفوف عند `on conflict do nothing` ⇒ كل ما بعدها
يموت بصمت. البلوك ينبّهك إذا نسيتها.

### `logAction`
```js
['logAction', { kind: 'send', ref: '$json.user_id', detail: 'JSON.stringify($json)' }]
```
```sql
create table actions_log (
  id         bigserial primary key,
  kind       text not null,
  ref        text,
  detail     jsonb,
  created_at timestamptz not null default now()
);
create index on actions_log (kind, created_at desc);
```
🔴 هذا ماشي زينة. بلا سجل أفعال، سؤال «ليش ما ردّش على هذا الزبون؟» ما عندو
جواب — لا فـ n8n (التنفيذات تنمحي) ولا فـ القاعدة. و هو نفس الجدول اللي
يقرا منّو `dailyCap` و `watchdog`.

سجّل **التوقّفات** كيما النجاحات: `kind: 'skipped'` مع السبب.

---

## ٤ · المنطق

### `code`
```js
['code', { name: 'طبّع', code: '…', mode: 'runOnceForAllItems' }]
```
`mode` يُستنتج: جسم فيه `$input.all()` ولا `items` ⇒ `runOnceForAllItems`،
و إلا `runOnceForEachItem`.

🔴 الوضع الغلط ما يعطيش خطأ — يعطي **عنصراً واحداً بدل الكل**. الفلترة تبان
تخدم و هي تشوف الأوّل فقط.

🔴 و`return []` ممنوعة. البديل:
```js
return out.length ? out : [{ json: { empty: true, n: 0 } }];
```
ثم `branch` على `={{ $json.empty }}`.

### `branch`
```js
['branch', {
  name: 'ساخن؟',
  when: '={{ $json.hot }}',
  op: IS_TRUE,               // من kit.mjs — IS_TRUE · IS_FALSE · EQUALS · GT · NOT_EMPTY
  right: '',                 // للمقارنات اللي تحتاج طرفاً ثانياً
  yes: [ … ],                // خطّة فرعية
  no:  [ … ],
}]
```
**نهائي** — ما يجيش بعدو والو فـ نفس القائمة.
فرع فارغ ⇒ عقدة `وقف: ساخن؟ → لا` تلقائياً، ماشي حفرة.

### `route`
```js
['route', {
  name: 'وجّه',
  on: '={{ $json.intent }}',
  cases: { 'سعر': [ … ], 'شكوى': [ … ] },
  else: [ … ],               // ما يُكتبش ⇒ عقدة توقّف تلقائية
}]
```

### `wait`
```js
['wait', { seconds: 2 }]
```
لاحترام rate limit. ⚠️ الانتظار الطويل يخلّي التنفيذ معلّقاً — للمهل الطويلة
استعمل جدولة تقرا من جدول بدلها.

---

## ٥ · الـ AI

### `llm`
```js
['llm', {
  name: 'صنّف',
  model: 'claude-sonnet-5-5',     // الافتراضي
  maxTokens: 300,
  user: '={{ $json.message }}',
  system: 'ترجّع JSON فقط… الحقول: …',
  fallback: { intent: 'غير ذلك' },
}]
```
يخلق **٣ عقد**: النداء + `فكّك مخرَج …` + `وقف: فشل نداء …`.

🔴 الضمانة فـ عقدة التفكيك، ماشي فـ البرومبت. «رجّع JSON» فـ البرومبت
اقتراح — النموذج يرجّع نصّاً حرّاً مرّة من مية، و تلك المرّة توقف الفرع.
عقدة التفكيك تعطي `llm_ok: false` + `llm_raw` بدل ما تموت.

🔴 المفتاح من credential (`httpHeaderAuth` باسم `x-api-key`)، ما يُكتبش خام.
اضبطو فـ n8n مرّة، ثم:
```bash
export N8N_CREDENTIALS='{"anthropic":{"id":"abc","name":"Anthropic"},"postgres":{"id":"xyz","name":"PG"}}'
node $SKILL_DIR/kit.mjs --creds     # يكتشف الموجود فعلاً
```
بلاه تلقى `REPLACE_ME` — يُستورد بلا خطأ و يفشل وقت التنفيذ فقط.

`llm_tokens_in/out` تخرج مع كل عنصر — وصّلها لـ `logAction` باش التكلفة
تكون مقيسة ماشي مخمَّنة.

الضمانات اللي **ما تتركش للبرومبت أبداً**: منع التكرار · السقف اليومي ·
مَن يُحوَّل لإنسان · أي رقم ولا رابط يُقال. هذي فـ الكود، و البرومبت يقترح.

---

## ٦ · الأفعال

### `http`
```js
['http', {
  name: 'ابعث',
  method: 'POST',
  url: '={{ $json.endpoint }}',
  headers: { 'X-Key': '={{ $json.token }}' },
  json: '={{ JSON.stringify({ to: $json.phone, text: $json.reply }) }}',
  timeout: 15000,
  retries: 2,
  credential: { httpHeaderAuth: { id: '…', name: '…' } },
}]
```
🔴 `onError: 'continueErrorOutput'` مثبّت — و يخلق عقدة `فشل: <الاسم>`.
`continueRegularOutput` يخلّي 401/429/500 يمشي فـ نفس المسار كأنه نجاح.

🔴 و العنوان يجي من الصف، ماشي مكتوباً فـ العقدة. عنوان مكتوب باليد هو
بالضبط الشكل اللي ينكسر أوّل ما تُضاف قناة ولا يتبدّل host.

### `telegramAlert`
```js
['telegramAlert', {
  name: 'نبّه',
  chatId: '123456',              // ولا يقرا $env.TELEGRAM_CHAT_ID
  token: '$env.TELEGRAM_BOT_TOKEN',
  text: "'🔥 ' + $json.name",    // جافاسكريبت، يُهرَّب تلقائياً
}]
```
🔴 الهروب فـ الكود ماشي فـ تعبير. اسم مستخدم فيه `_` كسر أوّل تنبيه حقيقي —
Telegram قرأها Markdown و رفض الرسالة كلها. فصار الفشل صامتاً **مرّتين**:
العملية فشلت، و التنبيه على الفشل فشل هو الآخر.

⚠️ `$env` ما يخدمش على كل instance (n8n Cloud تحجبو). إذا رجع فارغ، مرّر
`chatId` و `token` صراحةً ولا اقراهم من جدول إعدادات.

### `respond`
```js
['respond', { body: 'ok', code: 200 }]
['respond', { json: '={{ JSON.stringify({ ok: true }) }}' }]
```
لازم فقط لمّا `webhook` بـ `respondNow: false`.

---

## ٧ · المراقبة

### `watchdog`
```js
['schedule', { cron: '0 * * * *' }],
['watchdog', {
  symptomSql: `select count(*) > 0 as ok,
                      'ولا ردّ من ساعتين' as reason
               from actions_log
               where kind = 'send' and created_at > now() - interval '2 hours'`,
  chatId: '123456',
}]
```
لازم يرجّع صفاً واحداً فيه `ok` (boolean) و `reason` (text). `ok=false` ⇒ تنبيه.

🔴 الفرق اللي يخلّي الحارس ينفع: يفحص **العرَض** ماشي التنفيذ.

| ⛔️ يفحص التنفيذ | ✅ يفحص الأثر |
|---|---|
| العقدة رجعت 200 | صفّ انكتب فعلاً |
| الورك فلو خدم | زبون أخذ ردّاً بعد رسالتو |
| ما كانش خطأ | العدّاد تحرّك من أمس |

راجع أي سجل حوادث حقيقي: العطل الكبير **ما يظهرش أحمر**. اشتراك webhook طاح
⇒ ٣ أيام بلا حدث واحد و كلشي أخضر. الحارس هو الفرق بين «نعرف بعد ساعة» و
«نعرف كي يشتكي العميل».

**الحارس ورك فلو مستقلّ** — trigger واحد لكل ملف.

---

## دوال `kit.mjs` المفيدة

```js
import { node, cond, wire, IS_TRUE, IS_FALSE, EQUALS, GT, NOT_EMPTY, CRED } from './kit.mjs';
```
لبلوك ما كاينش، اكتب العقد بـ `node(name, type, typeVersion, [0,0], params, extra)`
و رجّع `{ nodes, wires, entry, exit, width }` — و `_col`/`_row` نسبية.

الأنواع المؤكَّدة من instance حيّة تخدم:

| النوع | typeVersion |
|---|---|
| `n8n-nodes-base.code` | 2 |
| `n8n-nodes-base.postgres` | 2.4 |
| `n8n-nodes-base.if` | 2.2 |
| `n8n-nodes-base.switch` | 3.2 |
| `n8n-nodes-base.httpRequest` | 4.2 |
| `n8n-nodes-base.webhook` | 2 |
| `n8n-nodes-base.respondToWebhook` | 1.1 |
| `n8n-nodes-base.scheduleTrigger` | 1.2 |
| `n8n-nodes-base.wait` | 1.1 |
| `n8n-nodes-base.noOp` · `manualTrigger` · `stickyNote` | 1 |

🔴 ما تخمّنش نسخة من التوثيق. نسخة غلط تستورد بخانات ناقصة **بلا أي خطأ** —
تشوف العقدة و تحسبها مضبوطة و هي فارغة من داخل.
