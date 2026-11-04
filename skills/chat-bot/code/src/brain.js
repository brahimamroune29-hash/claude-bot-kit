// Brain of the shop bot: prompt, tools, guards, LLM loop. Pure: no db, only the injected fetch and tool runner.
// Money comes from tool results (shop.js), never from the model.

const AI_URL = 'https://openrouter.ai/api/v1/messages'
// ponytail: fixed Haiku price (USD per million tokens) used only when the provider returns no cost. Override with the `price` option.
const PRICE = { input: 0.1, output: 0.5 }
// Handoff / closing lines follow the customer's script and carry the card phone (see handoffLine, closingLine).
const FR_HINT = /\b(bonjour|salut|je|vous|est|le|la|les|un|une|pour|merci|combien)\b/i

// ═══ Text helpers ═══
const asciiDigits = (s) => String(s ?? '').replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x660))
  .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x6f0)).replace(/٫/g, '.')
// Loose form for matching: no diacritics, unified alef/ta marbuta, no punctuation.
const flat = (s) => asciiDigits(s).replace(/[ً-ْـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه')
  .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()
const low = (s) => flat(s).toLowerCase()
const word = (alts) => new RegExp(`(?<!\\p{L})[وف]?(?:${alts})(?!\\p{L})`, 'u')
const arabic = (s) => /[؀-ۿ]/.test(s)
const cardPhone = (card) => (String(card?.phone ?? '').match(PHONE_RE) ?? [])[0]?.trim()
const lastStudent = (history) => [...(history ?? [])].reverse().find((r) => r.role === 'student')?.text ?? ''
// What the customer typed: a voice transcript («🎤 …») is not his writing, «[voice]»/«[image]» are placeholders,
// and our photo note («📷 [صورة …]») is ours — only its caption (next lines) is his.
const typed = (t) => {
  const s = String(t ?? '')
  return s.startsWith('🎤') || /^\[(voice|image|other|media)\]$/.test(s) ? '' : s.startsWith('📷') ? s.split('\n').slice(1).join('\n') : s
}
export const langOf = (history) => {
  const last = typed(lastStudent(history))
  // French needs 2+ French words across the last 3 student messages: one «la» or «merci» is common in Latin darja
  const recent = (history ?? []).filter((r) => r.role === 'student').slice(-3).map((r) => typed(r.text)).filter((t) => !arabic(t)).join(' ')
  return last && !arabic(last) && /[a-z]{3}/i.test(last) && (recent.match(new RegExp(FR_HINT.source, 'gi')) ?? []).length >= 2 ? 'fr' : studentScript(history) === 'latin' ? 'latin' : 'ar'
}
export function handoffLine(history, card) {
  const p = cardPhone(card)
  return {
    fr: `Un membre de l'équipe vous répond très bientôt${p ? `, ou appelez-nous au ${p}` : ''}.`,
    latin: `Wahed men el fariq yjawbek 9rib inchallah${p ? `, wla 3ayetlna 3la ${p}` : ''}.`,
    ar: `واحد من الفريق يجاوبك قريب إن شاء الله${p ? `، ولا عيّطلنا على ${p}` : ''}.`,
  }[langOf(history)]
}
// Thanks / goodbye only (no question inside): never a reason to hand off.
const CLOSE_ALL = new Set(('شكرا جزيلا بارك الله فيك جزاك خيرا صحيت صحه يعطيك الصحه يحفظك يسلمك مع السلامه بسلامه باي merci mercii beaucoup barakallah barak allah allahou fik saha sahit choukran shukran chokran bye baye bonne journee tres infiniment ok اوك اوكي okay').split(' '))
const CLOSE_STRONG = new Set('شكرا صحيت السلامه بسلامه باي جزاك بارك merci barakallah barak choukran shukran chokran bye baye saha sahit'.split(' '))
export function isClosing(text) {
  const t = low(text).split(' ').filter(Boolean)
  return t.length > 0 && t.length <= 6 && t.every((w) => CLOSE_ALL.has(w)) && t.some((w) => CLOSE_STRONG.has(w))
}
export const closingLine = (history) => ({
  fr: 'Avec plaisir, à tout moment 🙏',
  latin: 'Allah yselmek, ay wa9t t7taj chi kelmna 🙏',
  ar: 'الله يسلمك، وأي وقت تحتاج شي كلّمنا 🙏',
}[langOf(history)])

// Sent instead of a handoff when the order is already confirmed but the model reply keeps failing a guard.
export const orderDoneLine = (history) => ({
  fr: 'Votre commande est confirmée, merci.',
  latin: 'Talabiytek t2akdet, shokran 3la thiqtek.',
  ar: 'طلبيتك تأكدت، شكراً بيك.',
}[langOf(history)])

// ═══ Card rendering (stable text: same card => same string) ═══
const WEEKDAYS = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت']
const dayOf = (ymd) => WEEKDAYS[new Date(`${ymd.slice(0, 10)}T12:00:00Z`).getUTCDay()]
// Wilayas grouped by identical fees: 58 lines become ~6.
function feeTable(wilayas) {
  const groups = new Map()
  for (const w of wilayas ?? []) {
    const k = `${w.home ?? ''}|${w.office ?? ''}`
    groups.set(k, [...(groups.get(k) ?? []), `${w.name} (${w.n})`])
  }
  // no fee (null or missing) = no delivery of that kind there
  const fee = (where, v) => (v === '' ? `${where}: لا يوجد توصيل` : `${where} ${v} دج`)
  const homeFee = (k) => (k.startsWith('|') ? Infinity : Number(k.split('|')[0]))
  return [...groups].sort((a, b) => homeFee(a[0]) - homeFee(b[0]))
    .map(([k, names]) => {
      const [home, office] = k.split('|')
      return home === '' && office === '' ? `- لا يوجد توصيل: ${names.join('، ')}` : `- ${fee('للمنزل', home)} / ${fee('للمكتب', office)}: ${names.join('، ')}`
    })
}
export function renderCard(card) {
  const out = []
  const LABELS = { shop: 'المتجر', about: 'ماذا نبيع', city: 'المدينة', phone: 'رقم الهاتف', hours: 'أوقات الرد' }
  // owner = the shop's private numbers, if a card carries them: never for customers
  for (const [k, v] of Object.entries(card)) if (v != null && v !== '' && !['test', 'type', 'owner', 'products', 'delivery', 'policy', 'faq'].includes(k)) out.push(`${LABELS[k] ?? k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
  // no city = an online-only shop: say it, so «وين راكم؟» gets an answer
  if (!card.city) out.push('نبيع أونلاين بالتوصيل فقط: لا يوجد محل يزوره الزبون.')
  out.push('', 'المنتجات (الرقم بين القوسين للأداة فقط، لا تذكره للزبون):')
  for (const p of card.products ?? []) {
    const opts = Object.entries(p.variants ?? {}).map(([k, v]) => `${k}: ${v.map((x) => (p.soldOut?.[k]?.includes(x) ? `${x} (نفذ)` : x)).join(' / ')}`).join(' | ')
    out.push(`- [${p.id}] ${p.name} | السعر: ${p.price} دج` + (opts ? ` | الخيارات (كلها إجبارية): ${opts}` : '') + (p.desc ? ` | ${p.desc}` : '')
      + (p.out ? ' | نفذ من المخزون: لا تبعه، قل ذلك واقترح منتجاً آخر' : ''))
  }
  const d = card.delivery
  if (d) {
    out.push('', 'التوصيل:')
    if (d.pay) out.push(`- الدفع: ${d.pay}`)
    if (d.delay) out.push(`- المدة: ${d.delay}`)
    out.push('أسعار التوصيل حسب الولاية (الرقم بين القوسين رقم الولاية):', ...feeTable(d.wilayas))
  }
  if (card.policy) out.push('', `سياسة الاستبدال والإرجاع: ${card.policy}`)
  if (card.faq?.length) {
    out.push('', 'أسئلة متكررة:')
    for (const f of card.faq) out.push(f.q ? `- س: ${f.q}\n  ج: ${f.a}` : `- ${f.a}`)
  }
  return out.join('\n')
}
const factsOf = (card) => (typeof card === 'string' ? card : renderCard(card))

const RULES = `أنت مساعد مبيعات لمتجر، تجاوب الزبائن في الرسائل (واتساب أو إنستغرام أو ماسنجر). تتكلم كإنسان حقيقي، ماشي كاستمارة. هدفك: زبون يطلب ويأكد طلبه.

قواعد الرد:
- الجواب أولاً: جاوب بالضبط عما سأل عنه الزبون من البطاقة. سأل عن السعر ⇒ قل السعر الآن. سأل عن التوصيل ⇒ قل سعر ولايته ومدته. بعد الجواب، سؤال واحد قصير على الأكثر يقرّبه من الطلب. لا تستجوبه قبل أن تجاوب.
- سؤال واحد فقط في كل رد (الاسم والهاتف معاً سؤال واحد، والولاية والعنوان معاً سؤال واحد).
- الرد حتى 3 أسطر قصيرة، والسطر الواحد يصير رسالة واتساب مستقلة. بلا نجوم ولا عناوين ولا قوائم طويلة. الاستثناء الوحيد: ملخص الطلب الذي تعطيه الأداة.
- لا ترحّب ولا تسلّم مرة ثانية إذا بدأت المحادثة (سطر «الآن» يقول لك).
- اكتب بنفس حروف الزبون (تجدها في سطر «الآن»)، ولا تخلط حرفين في الكلمة الواحدة. إذا كتب بحروف لاتينية فاكتب أسماء المنتجات والخيارات والولايات بحروف لاتينية أيضاً (montre, chemise, noir, argent, Alger) ولا تنسخ كلمة عربية.
- دارجة جزائرية بسيطة فقط. ممنوع المغربية والتونسية والمصرية: ديال وديالك، دابا ودبا، شنو، كيداير، أنهي، فما وما فماش، برشا. قل: تاع، دوك، واش، واش من، كاين وما كانش، بزاف، كيفاش راك.
- سأل عن الأسعار بلا منتج محدد وفي البطاقة أكثر من 3 منتجات: لا تعدّها كلها. قل أقل وأعلى سعر، واسأله واش من منتج شاف.
- إذا قال «غالي»: لا توافقه («معاك حق» ممنوعة) ولا تجادله. قل إنك فاهمه، ثم القيمة في جملة واحدة مما هو مكتوب في البطاقة فقط (أصلية، الدفع عند الاستلام، تشوف المنتج قبل ما تخلص). السعر ثابت: لا تخفيض ولا وعد بتخفيض ولا هدية.
- إذا قال بوضوح إنه ما يشريش أو ودّعك: سطر واحد دافئ يترك الباب مفتوحاً، بلا سؤال ولا عرض ولا شرح.
- إذا قال إنه يفكر أو يشاور أو يقرر لاحقاً (نخمم، نشاور، نشوف ونقولك، كي نخلص…): لا تضغط، ونادِ remind_later دائماً: بالوقت إن ذكره (غدوة، بعد غدوة، السبت، على 10…) ثم قل له إنك تكتبلو في هذاك الوقت؛ وبلا أي خانة إن لم يذكر وقتاً ثم قل «على راحتك» بلا سؤال.
- لا تذكر أي معلومة ليست في البطاقة: سعر، مقاس، لون، مدة، رقم هاتف، رابط، وعد، شرط. لا تخترع.
- لا تحسب أنت أي مبلغ ولا تكتب مجموعاً: المبالغ (سعر، توصيل، مجموع) تأتيك من الأداة prepare_order فقط. رقم ليس في البطاقة ولا في نتيجة أداة هذا الدور يُمنع.
- لا تعد بفعل لا تقدر عليه: لا «نبعثلك لاحقاً» ولا «نتصل بك» (الاستثناء الوحيد: الوقت الذي سجّلته remind_later). قل الآن ما في البطاقة. إن لم تفهم قصده تماماً فاسأله سؤالاً واحداً يوضّح، ولا تخمّن.
- ملاحظات النظام التي تصلك ليست للزبون: لا تذكرها ولا تعتذر عنها، اكتب الرد النهائي فقط.

الطلب (بالترتيب، وكل خطوة بسؤال واحد):
1. المنتج، ثم خياراته الإجبارية إن كانت له (لون، مقاس...). الكمية 1 إن لم يذكر غيرها، ولا تسأله عنها.
2. الاسم الكامل ورقم الهاتف.
3. الولاية والعنوان.
4. توصيل للمنزل أم للمكتب (سعرهما في البطاقة).
5. حين تجتمع كل المعلومات نادِ prepare_order. الأداة تحسب وترجع الملخص: اكتب للزبون الملخص بأرقامه كما رجع (بحروفه إن كان يكتب بحروف لاتينية، بنفس الأرقام) ثم اسأله هل يؤكد.
6. حين يقول الزبون «نعم» أو ما يشبهها على آخر ملخص نادِ confirm_order مباشرة (لا تنادِ prepare_order ولا تعد الملخص)، وبعد نجاحها قل له إن طلبيته تأكدت وأن الدفع عند الاستلام والمدة من البطاقة، بحروفه هو.
- لا تنادِ confirm_order قبل أن يوافق الزبون على ملخص ظهر له. إن غيّر شيئاً بعد الملخص (كمية، لون، ولاية) نادِ prepare_order من جديد وأعد الملخص.
- إن رجعت prepare_order بخطأ فاتبع رسالتها: اسأل الزبون عن الخانة الناقصة أو الخاطئة بسؤال واحد (هاتف غير صحيح ⇒ اطلب رقمه من جديد)، ولا تقل إن الطلب جاهز.
- لا تقل «طلبيتك تأكدت» أو «تسجلت» أو «راهي في الطريق» أو ما يشبهها إلا بعد أن تنجح confirm_order في هذا الرد. بعد نجاحها لا تعد بموعد غير مذكور في البطاقة.
- صورة من الزبون تصلك كسطر «📷 [صورة من الزبون]» وتحته كلامه إن كتب شيئاً. أنت لا ترى الصورة: لا تخمّن ما فيها، واسأله بلطف عن اسم المنتج أو واش يحوس.
- الصور: لا ترسل صورة إلا إذا طلبها الزبون صراحة («ورّيني»، «صورة»، «تصويرة»، «نشوفها»، «photo»). عندها نادِ show_photos برقم المنتج: الكود يرسل الصور قبل ردك، فلا تكتب رابطاً، وكمّل بسؤال واحد. إن قالت الأداة لا توجد صور فاعتذر بلطف وصِف المنتج من البطاقة.
- بعد تأكيد الطلب إن كتب الزبون شيئاً جديداً (تعديل، إلغاء، سؤال عن طلبيته) حوّله لإنسان.

التحويل لإنسان (نادِ الأداة handoff بسبب قصير):
- أولاً جاوب من البطاقة إن كانت تغطي السؤال (سعر، توصيل، استبدال، أصلي...). حوّل فقط في:
- غضب أو شكوى.
- طلب إرجاع أو استبدال أو استرجاع مال.
- طلب جملة أو كمية كبيرة (أكثر من 20 قطعة).
- طلب صريح للحديث مع إنسان.
- سؤال خارج البطاقة فعلاً (منتج غير موجود، مقاس أو لون غير مذكور في البطاقة، خدمة غير مذكورة).
- خيار لم يحدده الزبون بعد (لون، مقاس) أو ولاية لم يذكرها ليس سبب تحويل: اسأله عنه.
- «شكراً» أو «صحيت» أو «merci» أو «باي» ليست سبب تحويل: ردّ بسطر واحد دافئ.
بعد التحويل لا تكتب شيئاً آخر.`

export function buildSystem(card) {
  return `${RULES}\n\n===== بطاقة المتجر (المصدر الوحيد للحقائق) =====\n${renderCard(card)}`
}

// Not cached: changes every call. Algeria is UTC+1 all year.
// pending: summary of the saved draft that waits for the customer's yes (the model never sees its own earlier tool calls).
export function nowBlock(now, script = null, started = false, pending = null, recheck = null) {
  const d = new Date(now.getTime() + 3600_000).toISOString()
  return `الآن: ${dayOf(d)} ${d.slice(0, 10)} ${d.slice(11, 16)} (توقيت الجزائر)` + (SCRIPT_LINE[script] ? `\n${SCRIPT_LINE[script]}` : '')
    + (started ? '\nالمحادثة بدأت من قبل: لا ترحّب ولا تسلّم مرة ثانية.' : '')
    + `\nأيام الأسبوع من اليوم (days في remind_later): ${[1, 2, 3, 4, 5, 6, 7].map((i) => `${WEEKDAYS[(new Date(`${d.slice(0, 10)}T12:00:00Z`).getUTCDay() + i) % 7]} ${i}`).join('، ')}`
    + (recheck ? `\nطلبية مؤكدة تنتظر تأكيد الشحن (سألناه «نبعثوها؟»): ${recheck}\nإن وافق ⇒ نادِ recheck_order بـ yes. إن رفض أو بدّل رأيه ⇒ recheck_order بـ no. إن طلب تعديلاً (لون، عنوان، كمية) ⇒ حوّل لإنسان. «نعم» و«لا» هنا ليستا سبب تحويل.` : '')
    + (pending ? `\nيوجد طلب محفوظ ينتظر موافقة الزبون (جهّزته prepare_order فعلاً):\n${pending}\nإن وافق بـ«نعم» أو ما يشبهها ⇒ نادِ confirm_order فقط. وإن غيّر شيئاً ⇒ نادِ prepare_order من جديد.` : '')
}

// ═══ Script follows the customer ═══
const SCRIPT_LINE = {
  arabic: 'الزبون يكتب بالحروف العربية: اكتب ردك بالحروف العربية فقط، بلا أي كلمة بحروف لاتينية.',
  latin: 'الزبون يكتب بحروف لاتينية (دارجة أو فرنسية): اكتب بنفس لغته وحروفه، بحروف لاتينية فقط.',
}
const AR_L = /[\u0600-\u06ff\u0750-\u077f]/gu, LA_L = /[a-zà-ÿ]/giu
const counts = (t) => [(String(t ?? '').match(AR_L) ?? []).length, (String(t ?? '').match(LA_L) ?? []).length]
export const scriptOf = (t) => { const [a, l] = counts(t); return a + l === 0 ? null : a >= l ? 'arabic' : 'latin' }
// By words, not letters: «سعر Photoshop» is Arabic. Courtesy-only («ok», «merci», «شكرا») and tiny messages do not count.
const scriptByWords = (t) => {
  const w = String(t ?? '').split(/\s+/u).map(scriptOf).filter(Boolean)
  const a = w.filter((x) => x === 'arabic').length
  return !w.length ? null : a >= w.length - a ? 'arabic' : 'latin'
}
const countable = (t) => {
  const [a, l] = counts(t)
  return a + l >= 3 && !low(t).split(' ').filter(Boolean).every((w) => CLOSE_ALL.has(w))
}
// The last countable student message decides; if it mixes both alphabets, the words of the last 3 decide.
export function studentScript(history) {
  const rows = (history ?? []).filter((r) => r.role === 'student').map((r) => typed(r.text)).filter(countable).slice(-3)
  const last = rows[rows.length - 1]
  if (!last) return null
  const [a, l] = counts(last)
  return !a || !l ? scriptOf(last) : scriptByWords(rows.join(' '))
}
// [] = fine. Else [script, ...mixed words]: reply script differs from the student's, or one word mixes both alphabets.
export function wrongScript(reply, script, card) {
  const known = new Set((factsOf(card ?? '').match(/[a-z][a-z0-9-]*/gi) ?? []).map((w) => w.toLowerCase()).concat('da'))
  const words = String(reply ?? '').split(/[\s.,!?؟،:;()"'«»\-/\\]+/u).filter(Boolean)
  const mixed = words.filter((w) => { const [a, l] = counts(w); return a && l && !known.has(w.toLowerCase()) })
  const [a, l] = counts(words.filter((w) => !known.has(w.toLowerCase())).join(' '))
  const other = a + l && (a >= l ? 'arabic' : 'latin')
  return mixed.length || (script && other && other !== script) ? [script, ...mixed] : []
}

export const TOOLS = [
  {
    name: 'prepare_order',
    description: 'جهّز الطلب: الأداة تتحقق من المعطيات وتحسب السعر والتوصيل والمجموع من البطاقة وترجع الملخص. نادِها فقط حين تكون كل المعلومات عند الزبون: المنتجات بخياراتها وكمياتها، الاسم، الهاتف، الولاية، العنوان، منزل أو مكتب. ترجع الملخص أو سبب الخطأ.',
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'المنتجات المطلوبة',
          items: {
            type: 'object',
            properties: {
              product_id: { type: 'string', description: 'رقم المنتج من البطاقة، مثل p2' },
              variant: { type: 'object', additionalProperties: { type: 'string' }, description: 'الخيارات كما في البطاقة، مثل {"اللون":"أسود"}؛ فارغ إن لم يكن للمنتج خيارات' },
              qty: { type: 'integer', description: 'الكمية من 1 إلى 20' },
            },
            required: ['product_id', 'qty'],
          },
        },
        name: { type: 'string', description: 'اسم الزبون الذي كتبه بنفسه' },
        phone: { type: 'string', description: 'رقم هاتف الزبون كما كتبه' },
        wilaya: { type: 'string', description: 'الولاية كما كتبها الزبون (رقم أو اسم)' },
        address: { type: 'string', description: 'العنوان كما كتبه الزبون' },
        delivery: { type: 'string', enum: ['home', 'office'], description: 'home للمنزل، office للمكتب' },
      },
      required: ['items', 'name', 'phone', 'wilaya', 'address', 'delivery'],
    },
  },
  {
    name: 'confirm_order',
    description: 'أكّد آخر طلب جهّزته prepare_order. نادِها فقط بعد أن يوافق الزبون على الملخص بـ«نعم» أو ما يشبهها.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'show_photos',
    description: 'أرسل صور منتج للزبون. فقط إذا طلب الزبون صورة صراحة. الكود يرسل الصور (بالاسم والسعر) قبل ردك.',
    input_schema: {
      type: 'object',
      properties: { product_id: { type: 'string', description: 'رقم المنتج من البطاقة، مثل p2' } },
      required: ['product_id'],
    },
  },
  {
    name: 'handoff',
    description: 'حوّل المحادثة لإنسان: غضب، شكوى، إرجاع أو استبدال، طلب جملة، سؤال خارج البطاقة، أو طلب إنسان.',
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'السبب في جملة قصيرة' } },
      required: ['reason'],
    },
  },
  {
    name: 'recheck_order',
    description: 'جواب الزبون على سؤالنا قبل الشحن «نبعثوها؟» (السطر «تنتظر تأكيد الشحن» في الآن). yes: يبعثوها. no: ألغى أو بدّل رأيه.',
    input_schema: { type: 'object', properties: { answer: { type: 'string', enum: ['yes', 'no'] } }, required: ['answer'] },
  },
  {
    name: 'remind_later',
    description: 'الزبون قال إنه يفكر أو يشاور أو يقرر أو يرد لاحقاً. البوت يرجع له وحده: في الوقت الذي ذكره (غدوة، بعد غدوة، السبت، على 10…)، أو بعد 6 ساعات إن لم يذكر وقتاً (اترك كل الخانات).',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'كم يوم من اليوم: 0 اليوم، 1 غدوة، 2 بعد غدوة؛ يوم من الأسبوع: الرقم في سطر «الآن». اتركها إن لم يذكر يوماً' },
        hour: { type: 'integer', description: 'الساعة التي قالها من 0 إلى 23 (على 10 الصباح = 10، على 8 الليل = 20)؛ اتركها إن لم يذكر ساعة' },
        minute: { type: 'integer', description: 'الدقائق إن ذكرها، وإلا اتركها' },
      },
      required: [],
    },
  },
]

// ═══ History => Anthropic messages ═══
// student => user, bot/human => assistant; same role merges; must start with user.
export function toMessages(history) {
  const out = []
  for (const r of history ?? []) {
    const text = String(r.text ?? '').trim()
    if (!text) continue
    const role = r.role === 'student' ? 'user' : 'assistant'
    const last = out[out.length - 1]
    if (last?.role === role) last.content += `\n${text}`
    else out.push({ role, content: text })
  }
  if (out[0]?.role === 'assistant') out.unshift({ role: 'user', content: '(بداية المحادثة)' })
  return out
}

// ═══ Guard: numbers and banned words not in the card ═══
const UNIT = String.raw`مليون|ملاين|ملايين|ألف|الف|آلاف|ألاف|الاف|دج|د\.ج|دينار|سنتيم|%|٪|da\b|dzd|dinars?|millions?|mille|centimes?|€`
const PRICE_RE = new RegExp(String.raw`(\d+(?:[.,]\d+)?)(\s*(?:${UNIT}))?`, 'gi')
const RANGE_RE = new RegExp(String.raw`(\d+(?:[.,]\d+)?)(\s*(?:حتى|ولا|و|إلى|الى|-|–|à|ou)\s*)(?=\d+(?:[.,]\d+)?\s*(${UNIT}))`, 'gi')
// «6 000», «6.000», «6,000» = one number (thousand separators); «3.5» stays decimal.
const joinThousands = (s) => asciiDigits(s).replace(/(\d)[\s  .,](?=\d{3}(?!\d))/g, '$1')
const numbersIn = (s) => (joinThousands(s).match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(',', '.'))
// Only numbers that look like a price: with a unit, or >= 1000. Ages, hours, counts do not count.
// Algerian conventions, both sides in dinars: «مليون» = a million centimes = 10 000 DA, «ألف» = 1000.
const pricesIn = (s) => [...joinThousands(s).replace(RANGE_RE, '$1 $3$2').matchAll(PRICE_RE)]
  .filter((m) => m[2] || Number(m[1].replace(',', '.')) >= 1000).map((m) => {
    const n = Number(m[1].replace(',', '.')), u = m[2] ?? ''
    return String(/مليون|ملاين|ملايين/.test(u) ? Math.round(n * 10000) : /ألف|الف|آلاف|ألاف|الاف/.test(u) ? n * 1000 : n)
  })
const MONTHS = ['جانفي', 'فيفري', 'مارس', 'أفريل', 'ماي', 'جوان', 'جويلية', 'أوت', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر',
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']
const DATE_RE = new RegExp(`\\d{1,2}\\s*(?:${MONTHS.join('|')})`, 'gi')
const ISO_RE = /\d{4}-\d{2}-\d{2}/g
const TIME_RE = /(?<!\d)\d{1,2}\s?(?::\s?\d{2}|h\s?\d{2}|h(?![a-z]))/gi
const PHONE_RE = /(?<!\d)\+?\d(?:[\s.\-]?\d){8,}(?!\d)/g
const REFUSED = /(?<!\p{L})[وف]?(?:ال)?(?:مجان\p{L}*|تخفيض\p{L}*|خصم\p{L}*|خصوم\p{L}*|بلاش)|gratuit\p{L}*|remise\p{L}*|promo\p{L}*|r[eé]duction\p{L}*/giu
const NEGATION = /(?<!\p{L})(?:ما|لا|ماكاش|ماكانش|ماكاينش|مكاش|ماشي|ليس|لايوجد|pas|non|aucune?)(?!\p{L})/u

// Dates, times and phones are not prices (phones go through foreignContact).
const stripNonPrice = (s) => asciiDigits(s).replace(ISO_RE, ' ').replace(TIME_RE, ' ').replace(DATE_RE, ' ').replace(PHONE_RE, ' ')

// Returns what is wrong in the reply (empty = fine): prices not in the card + banned words the card does not itself use.
// ponytail: a right number for a different course passes (4000 for the French course); fix = meaning checker.
// extra: tool results of this turn (fee, total), allowed like card facts.
export function checkReply(reply, card, extra = '') {
  const facts = asciiDigits(`${factsOf(card)}\n${extra}`).replace(/[ً-ْ]/g, '')
  const ok = new Set([...numbersIn(stripNonPrice(facts)), ...numbersIn(facts), ...pricesIn(facts)])
  const bad = pricesIn(stripNonPrice(reply).replace(/\s+/g, ' ')).filter((n) => !ok.has(n))
  // banned word passes when its sentence is negated («ما كاينش تخفيض») or the card states it outside FAQ questions
  // (a FAQ question like «هل يوجد تخفيض؟» must not whitelist «تخفيض»).
  const stated = typeof card === 'string' ? facts : asciiDigits(renderCard({ ...card, faq: (card.faq ?? []).map((f) => ({ a: f.a })) })).replace(/[ً-ْ]/g, '')
  const banned = asciiDigits(reply).replace(/[ً-ْ]/g, '').split(/(?<=[.!؟?\n،,])/).flatMap((sentence) =>
    NEGATION.test(sentence) ? [] : (sentence.match(REFUSED) ?? []).filter((w) => !stated.toLowerCase().includes(w.toLowerCase().replace(/^[وف]?(?:ال)?/, ''))))
  return [...new Set([...bad, ...banned])]
}

// After prepare_order the customer must see the code's numbers: the total is in the reply and every price comes from that summary.
// (Each number being somewhere in the card is not enough: «المجموع: 3500 دج» passes the card check when 3500 is a unit price.)
export function wrongSummary(reply, summary) {
  const total = /المجموع: (\d+)/.exec(summary)?.[1]
  return [...(total && !numbersIn(stripNonPrice(reply)).includes(total) ? [total] : []), ...checkReply(reply, summary)]
}

// ═══ Guard: dates and times not in the card ═══
const monthOf = (name) => MONTHS.findIndex((m) => low(m) === low(name)) % 12 + 1
const timesIn = (s) => new Set([...asciiDigits(s).matchAll(/(?<!\d)(\d{1,2})\s?(?::\s?(\d{2})|h\s?(\d{2})?)(?![\d\p{L}])/giu)]
  .map((m) => `${+m[1]}:${m[2] ?? m[3] ?? '00'}`))
const datesIn = (s) => {
  const t = asciiDigits(s), out = new Set()
  for (const m of t.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)) out.add(`${+m[3]}/${+m[2]}`)
  for (const m of t.matchAll(new RegExp(`(?<!\\d)(\\d{1,2})\\s*(${MONTHS.join('|')})`, 'giu'))) out.add(`${+m[1]}/${monthOf(m[2])}`)
  for (const m of t.replace(/\d{4}-\d{2}-\d{2}/g, ' ').matchAll(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/g)) if (+m[2] <= 12) out.add(`${+m[1]}/${+m[2]}`)
  return out
}
// Returns dates/times in the reply that are neither in the card (opening hours), in a tool result, nor today/tomorrow.
export function foreignTime(reply, card, now = new Date(), extra = '') {
  const facts = `${factsOf(card)}\n${extra}`
  const day = (ms) => { const d = new Date(ms + 3600_000); return `${d.getUTCDate()}/${d.getUTCMonth() + 1}` }
  const okDates = new Set([...datesIn(facts), day(now.getTime()), day(now.getTime() + 86_400_000)])
  const okTimes = timesIn(facts)
  return [...[...datesIn(reply)].filter((d) => !okDates.has(d)), ...[...timesIn(reply)].filter((t) => !okTimes.has(t))]
}

// ═══ Guard: phone numbers, links, handles not in the card ═══
const URL_RE = /https?:\/\/\S+|www\.\S+|(?<![\w@.])[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|dz|fr|io|me|app|co|info|tv|ly|ai|site|xyz|online)(?![a-z])\S*/gi
const HANDLE_RE = /(?<![\w.@])@\w{2,}/g
const natPhone = (d) => d.replace(/^(?:00)?213/, '0')
const phonesIn = (s) => [...asciiDigits(s).replace(ISO_RE, ' ').replace(TIME_RE, ' ').matchAll(PHONE_RE)].map((m) => natPhone(m[0].replace(/\D/g, '')))
const linkKey = (u) => u.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[.,!؟?،)\]]+$/, '').replace(/\/+$/, '')
export function foreignContact(reply, card, extra = '') {
  const facts = `${factsOf(card)}\n${extra}`
  const known = new Set(phonesIn(facts))
  const factLinks = [...(facts.match(URL_RE) ?? []), ...(facts.match(HANDLE_RE) ?? [])].map(linkKey)
  const badPhones = phonesIn(reply).filter((p) => !known.has(p))
  const links = [...(reply.match(URL_RE) ?? []), ...(reply.match(HANDLE_RE) ?? [])].map(linkKey)
    .filter((l) => !factLinks.some((f) => f === l || l.startsWith(`${f}/`)))
  return [...new Set([...badPhones, ...links])]
}

// ═══ Guard: «طلبيتك تأكدت» without a confirmed order ═══
// confirmed: confirm_order succeeded in this turn. Questions, negations and conditionals do not count.
// ponytail: known phrases only; a new phrasing is added here.
const ORDER_CLAIM = new RegExp(
  String.raw`(?<!\p{L})[وف]?(?:(?:طلبي[ةه]?|طلب|كوموند|commande)\S*(?: \S+){0,2}? (?:تاكد|تسجل|تثبت|تم|مؤكد|مأكد|مسجل|ثابت|كمل)\p{L}*`
  + String.raw`|تم (?:ال)?(?:تاكيد|تسجيل|تثبيت|شحن|ارسال)\p{L}* (?:ال)?(?:طلب|كوموند)\p{L}*`
  + String.raw`|(?:سجل|اكد|ثبت)(?:ت|نا)(?:ل)?(?:ك)? (?:ال)?(?:طلب|كوموند)\p{L}*`
  + String.raw`|(?:راه[يا]?|راها|راك|طلب\p{L}*|كوموند\p{L}*) (?:في|ف) (?:ال)?(?:طريق|توصيل)`
  + String.raw`|شحنا (?:ال)?(?:طلب|كوموند)\p{L}*`
  + String.raw`|راه[يا]? (?:مسجل|ثابت|مؤكد|متاكد)\p{L}* (?:ال)?(?:طلب|كوموند)\p{L}*`
  + String.raw`|(?:ال)?(?:طلب|كوموند)\p{L}*(?: تاع\p{L}*)? (?:ثبت|تثبت|تسجل|تاكد|وصلتنا|وصلنا|صار)\p{L}*`
  + String.raw`|تم (?:ال)?(?:طلب|كوموند)\p{L}*)(?!\p{L})`
  + String.raw`|(?:votre|ta|ton) commande (?:est |a [eé]t[eé] )?(?:bien )?(?:confirm|enregistr|valid|exp[eé]di|en route)\p{L}*`
  + String.raw`|commande (?:est )?(?:bien )?(?:confirm|enregistr|valid|exp[eé]di)\p{L}*`
  + String.raw`|(?:je|on) (?:vous |t )?(?:l )?(?:ai|a) (?:bien )?(?:confirm|enregistr|valid)\p{L}* (?:votre|ta|ton|la) commande`
  + String.raw`|(?<![a-z])talab\p{L}* (?:tsa+j+\p{L}*|t[a2]+k+d\p{L}*|t[a2]+kd\p{L}*|tconf\p{L}*|rahi? (?:f|fi) (?:tari9|tri9|trik|triq))`
  + String.raw`|(?<![a-z])(?:tsa+j+l\p{L}*|t[a2]+kd\p{L}*) talab\p{L}*`
  + String.raw`|(?<![a-z])ra(?:hi|ha|ni?) (?:f|fi) (?:tari9|tri9|trik|triq)`, 'u')
const NEGATED = /(?:^|\s)(?:ما|ما راني|ما رانا|مازال|مازال ما|لم|لن|ماشي|باش|اذا|لو|الا|si|pas|jamais|rien|ma|mazal)\s*$/u
const IF_BEFORE = /(?:^|\s)(?:اذا|لو|لما|si|quand|lorsque)\s/u // a condition earlier in the sentence: «اذا قلت نعم طلبيتك تتاكد»
export function falseOrder(text, confirmed = false) {
  if (confirmed) return []
  return String(text).split(/(?<=[.!؟?\n])/).map((s) => s.trim()).filter(Boolean).filter((s) => {
    if (/[؟?][\s\p{Extended_Pictographic}️]*$/u.test(s)) return false
    const t = low(s), m = ORDER_CLAIM.exec(t)
    return !!m && !NEGATED.test(t.slice(0, m.index)) && !IF_BEFORE.test(t.slice(0, m.index))
  }).map((s) => s.slice(0, 80))
}

// ═══ Shape of the reply ═══
// One thought per WhatsApp bubble, lists stay with the line before, at most 3 bubbles.
export function splitReply(text) {
  const parts = []
  for (const line of text.split('\n').map((l) => l.trim().replace(/(?<!\.)\.$/, '')).filter(Boolean)) {
    if (parts.length && /^([-•*]|\d+[.)])\s/.test(line)) parts[parts.length - 1] += `\n${line}`
    else parts.push(line)
  }
  return parts.length > 3 ? [parts[0], parts[1], parts.slice(2).join('\n')] : parts
}

// A bare greeting to a real question is an incomplete reply.
const ASKS = /[؟?]|شحال|واش|وش|كيفاش|وين|علاش|ما هي|ما هو|هل |combien|comment|est-ce|quel/
export const tooShort = (reply, asked) => reply.trim().length < 45 && !/[؟?]/.test(reply) && ASKS.test(asked ?? '')

// The corrected reply sometimes starts with a line about the reply itself («voici la même réponse…:»).
export const dropMeta = (text) => text.replace(/^[^\n]*(?:réponse|reponse|الرد|ردّ|reply|answer)[^\n]*:\s*\n/iu, '')
// Guard notes / script instructions echoed into the reply never reach the student.
const NOTE_LEAK = /ملاحظة من النظام|ماشي من (?:الطالب|الزبون)|بالحروف العربية فقط|بالعربي فقط|بحروف لاتينية فقط|note du syst[eè]me/iu
export const dropNote = (text) => text.split('\n').filter((l) => !NOTE_LEAK.test(l)).join('\n').trim()
// No «أهلا بيك» in the middle of a chat: only the first line, only when other lines remain and the student did not greet.
const GREET = /^(?:اهلا|مرحبا|bonjour|salut|salam|hello)(?!\p{L})/u
export function dropGreeting(text, history) {
  const rows = history ?? []
  if (!rows.some((r) => r.role !== 'student') || /سلام|اهلا|مرحبا|bonjour|salut|salam|hello/u.test(low(lastStudent(rows)))) return text
  const [first, ...rest] = text.split('\n')
  return rest.length && GREET.test(low(first)) && low(first).split(' ').length <= 3 && !/[\d؟?]/.test(first) ? rest.join('\n').trim() : text
}
// Moroccan (and Tunisian / Egyptian) words that Algerian customers do not use. Small and certain: «بزاف», «واش», «كيفاش», «ديما» are Algerian too.
// «أنهي» 3 of 4 turns and «ما فماش» 1 of 4 in one live chat, 2026-11-01.
const MOROCCAN = word('ديال\\p{L}*|دابا|دبا|شنو|كيداير|[اأ]نهي|فماش|فما|برشا|dyal\\p{L}*|daba|chno|barcha')
export const moroccan = (text) => low(text).split(' ').filter((w) => MOROCCAN.test(w))

// A tool acknowledgement repeated as its own line never reaches the student.
const TOOL_ECHO = /^(تسجّ?لت?|تحوّل|تم|ok)[.!،]?$/i
export const dropEcho = (text) => text.split('\n').filter((l) => !TOOL_ECHO.test(l.trim())).join('\n').trim()

// Near-duplicate lines (Dice on letter pairs; the digits must be identical).
const squash = (s) => low(s).replace(/ى/g, 'ي').replace(/\s/g, '')
function likeness(a, b) {
  const x = squash(a), y = squash(b)
  if (x === y) return 1
  if ((x.match(/\d+/g) ?? []).join() !== (y.match(/\d+/g) ?? []).join()) return 0
  const pairs = new Map()
  for (let i = 0; i < x.length - 1; i++) pairs.set(x.slice(i, i + 2), (pairs.get(x.slice(i, i + 2)) ?? 0) + 1)
  let both = 0
  for (let i = 0; i < y.length - 1; i++) {
    const n = pairs.get(y.slice(i, i + 2)) ?? 0
    if (n) { both++; pairs.set(y.slice(i, i + 2), n - 1) }
  }
  return (2 * both) / Math.max(1, x.length + y.length - 2)
}
export const nearSame = (a, b) => likeness(a, b) >= 0.8
// A question close to one the bot asked in the last 2 minutes is dropped, unless nothing else would be left.
// Rows need `at` (ISO or ms); without it nothing is dropped.
export function dropRepeats(text, rows, now = Date.now()) {
  const fresh = (rows ?? []).filter((r) => r.role === 'bot' && r.at && now - new Date(r.at).getTime() < 120_000).map((r) => r.text)
  if (!fresh.length) return text
  const kept = text.split('\n').filter((l) => !/[؟?]\s*$/.test(l) || !fresh.some((b) => nearSame(b, l)))
  return kept.some((l) => squash(l)) ? kept.join('\n').replace(/\n{3,}/g, '\n\n').trim() : text
}

// Tool call written as text (<invoke>): never reaches the student. Only handoff may run from text (it can only escalate).
const ATM = '(?:antml:)?'
const INVOKE = new RegExp(`<${ATM}invoke\\s+name="([^"]+)"\\s*>([\\s\\S]*?)</${ATM}invoke>`, 'g')
const PARAM = new RegExp(`<${ATM}parameter\\s+name="([^"]+)"\\s*>([\\s\\S]*?)</${ATM}parameter>`, 'g')
const TAG_NAMES = ['invoke', 'parameter', 'function_calls', 'tool_call', 'tool_use']
const isJsonLine = (l) => { const t = l.trim(); if (/^\{\s*"/.test(t)) return true; try { return typeof JSON.parse(t) === 'object' && JSON.parse(t) !== null } catch { return false } }
export const TEXT_SAFE_TOOLS = ['handoff']
export function textToolCalls(text) {
  const calls = []
  let clean = text.replace(INVOKE, (_, name, body) => {
    if (TEXT_SAFE_TOOLS.includes(name)) calls.push({ name, input: Object.fromEntries([...body.matchAll(PARAM)].map((m) => [m[1], m[2].trim()])) })
    return ''
  }).replace(PARAM, '')
    .replace(new RegExp(`<${ATM}(?:invoke|parameter)\\b[\\s\\S]*$`, 'i'), '') // unclosed (cut off): everything after is internal
    .replace(new RegExp(`</?${ATM}(?:${TAG_NAMES.join('|')}|br)\\b[^>]*>`, 'gi'), '')
  // tag cut at max_tokens: from the last «<» that starts a known tag name (no «>») to the end
  const cut = /<\/?([a-z_:]*)[^>]*$/i.exec(clean)
  if (cut) {
    const tok = cut[1].toLowerCase(), bare = tok.replace(/^antml:/, '')
    if (tok ? 'antml:'.startsWith(tok) || TAG_NAMES.some((n) => n.startsWith(bare)) : /^<\/?$/.test(cut[0])) clean = clean.slice(0, cut.index)
  }
  clean = clean.split('\n').filter((l) => !isJsonLine(l)).join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return { text: clean, calls }
}

// ═══ Cost ═══
// Provider cost wins; else tokens x price. Cache write 1h = 2x, 5m = 1.25x, read = 0.1x.
export const costOf = (u, price = PRICE) => {
  if (!u) return 0
  if (typeof u.cost === 'number') return u.cost
  const w = u.cache_creation_input_tokens ?? 0, w1h = Math.min(w, u.cache_creation?.ephemeral_1h_input_tokens ?? 0)
  return ((u.input_tokens ?? 0) * price.input + (u.cache_read_input_tokens ?? 0) * price.input * 0.1
    + (w - w1h) * price.input * 1.25 + w1h * price.input * 2 + (u.output_tokens ?? 0) * price.output) / 1e6
}

// New fields (provider, thinking, ttl) rejected with 4xx: retry once without them.
export const fieldReject = (status, message) => status >= 400 && status < 500 && status !== 429 && /provider|thinking|reasoning|ttl|cache_control/i.test(message)
export function softAi(body) {
  const { provider: _p, thinking: _t, ...rest } = body
  const system = Array.isArray(rest.system) ? rest.system.map((b) => (b.cache_control ? { ...b, cache_control: { type: 'ephemeral' } } : b)) : rest.system
  return { ...rest, system }
}

// ═══ LLM call ═══
async function post({ fetchImpl, apiKey }, body) {
  const go = (b) => fetchImpl(AI_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(b), signal: AbortSignal.timeout(60_000),
  })
  let res = await go(body)
  let out = await res.json().catch(() => ({}))
  if (!res.ok && fieldReject(res.status, String(out?.error?.message ?? ''))) {
    res = await go(softAi(body))
    out = await res.json().catch(() => ({}))
  }
  if (!res.ok) throw Object.assign(new Error(String(out?.error?.message ?? res.status)), { status: res.status })
  return out
}
// One retry on network error, 5xx or 429; 4xx is final.
async function callAi(env, body) {
  let last
  for (let i = 0; i < 2; i++) {
    try { return await post(env, body) } catch (e) {
      last = e
      if (e.status && e.status < 500 && e.status !== 429) break
    }
  }
  throw last
}

// ═══ Guards on the final text ═══
const NOTES = {
  time: (v) => `ردك فيه تاريخ أو ساعة ليست في البطاقة (${v.join('، ')}). استعمل ما في البطاقة فقط.`,
  number: (v) => `ردك فيه رقم أو كلمة ممنوعة ليست في البطاقة (${v.join('، ')}). أعد الكتابة بالأرقام التي في البطاقة أو في نتيجة الأداة فقط، أو بلا رقم.`,
  contact: (v) => `ردك فيه رقم هاتف أو رابط أو حساب ليس في البطاقة (${v.join('، ')}). احذفه، أو استعمل ما في البطاقة فقط.`,
  'false-order': () => 'ردك يقول إن الطلبية تأكدت أو تسجلت، ولم تنجح confirm_order في هذا الرد. لا تقل ذلك: إن كان الزبون وافق على الملخص نادِ confirm_order، وإلا اسأله عن المعلومة الناقصة أو أعد الملخص.',
  script: (v) => `ردك ما التزم بحروف الزبون أو خلط حرفين في كلمة (${v.slice(1).join('، ')}). ${SCRIPT_LINE[v[0]] ?? 'اكتب كل كلمة بحروف واحدة.'}`,
  darja: (v) => `ردك فيه كلمات مغربية (${v.join('، ')}). اكتب بدارجة جزائرية: تاع، دوك، واش.`,
  short: () => 'ردك فارغ أو ناقص. جاوب عن سؤال الزبون بجملة واضحة من البطاقة.',
  summary: (v) => `ملخصك فيه أرقام تخالف ملخص الأداة أو ينقصه المجموع (${v.join('، ')}). اكتب الملخص بأرقام prepare_order بالضبط: كل سعر والتوصيل والمجموع، ثم اسأله هل يؤكد.`,
}
function violationsOf(reply, card, confirmed, asked, now, script, extra, prepared) {
  const out = []
  if (prepared) { const s = wrongSummary(reply, prepared); if (s.length) out.push({ guard: 'summary', detail: s }) }
  if (script) { const w = wrongScript(reply, script, card); if (w.length) out.push({ guard: 'script', detail: w }) }
  const times = foreignTime(reply, card, now, extra)
  if (times.length) out.push({ guard: 'time', detail: times })
  const nums = checkReply(reply, card, extra), contact = foreignContact(reply, card, extra), claims = falseOrder(reply, confirmed)
  if (nums.length) out.push({ guard: 'number', detail: nums })
  if (contact.length) out.push({ guard: 'contact', detail: contact })
  if (claims.length) out.push({ guard: 'false-order', detail: claims })
  const mor = moroccan(reply)
  if (mor.length) out.push({ guard: 'darja', detail: mor })
  if (!reply.trim() || tooShort(reply, asked)) out.push({ guard: 'short', detail: [] })
  return out
}
const textOf = (blocks) => blocks.filter((b) => b.type === 'text').map((b) => (b.text ?? '').trim()).filter(Boolean).join('\n')

/**
 * @param {{card: object, history: {role: 'student'|'bot'|'human', text: string, at?: string}[], now?: Date, apiKey: string, model: string,
 *   note?: string, pending?: string, fetchImpl?: typeof fetch, runTool: (name: string, input: object) => Promise<{ok: boolean, message: string}>, price?: {input: number, output: number}}} o
 * @returns {Promise<{reply: string|null, handoff: string|null, error?: string, usd: number, calls: {input: number, output: number, cacheRead: number, cacheWrite: number, usd: number}[], guards: {guard: string, action: 'retry'|'handoff'|'trimmed'}[]}>}
 */
export async function answer({ card, history, note, pending, recheck = null, now = new Date(), apiKey, model, fetchImpl = fetch, runTool, price = PRICE }) {
  const guards = []
  let usd = 0
  const calls = []
  const script = studentScript(history)
  const env = { fetchImpl, apiKey }
  const system = [
    { type: 'text', text: buildSystem(card), cache_control: { type: 'ephemeral', ttl: '1h' } },
    { type: 'text', text: nowBlock(now, script, history.some((r) => r.role !== 'student'), pending, recheck) },
  ]
  const call = async (messages, tools) => {
    const out = await callAi(env, {
      model, max_tokens: 6000, system, messages, tools: TOOLS,
      tool_choice: { type: tools ? 'auto' : 'none' }, provider: { order: ['anthropic'], allow_fallbacks: true },
    })
    const u = out.usage ?? {}, c = costOf(out.usage, price)
    usd += c
    calls.push({ input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, usd: c })
    let blocks = Array.isArray(out.content) ? out.content : []
    // tool call written as text: only handoff survives
    if (!blocks.some((b) => b.type === 'tool_use')) {
      const raw = textOf(blocks), parsed = textToolCalls(raw)
      if (parsed.text !== raw) {
        blocks = [...(parsed.text ? [{ type: 'text', text: parsed.text }] : []),
          ...(tools ? parsed.calls.map((c, i) => ({ type: 'tool_use', id: `text_call_${i}`, name: c.name, input: c.input })) : [])]
      }
    }
    return blocks
  }
  const fail = (handoff) => ({ reply: handoffLine(history, card), handoff, usd, guards, calls })
  try {
    const messages = toMessages(history)
    if (note) { // scheduled message: system note as the last user turn (merged when history already ends with the student)
      const n = `(ملاحظة من النظام، ماشي من الزبون: ${note})`, last = messages[messages.length - 1]
      if (last?.role === 'user') last.content += `\n${n}`
      else messages.push({ role: 'user', content: n })
    }
    const asked = [...history].reverse().find((r) => r.role === 'student')?.text ?? ''
    // confirmed: confirm_order succeeded this turn. extra: this turn's tool results, the only source of fee/total besides the card.
    let confirmed = false, prepared = null, blocks
    // ponytail: tool text also holds the customer's own name/address digits; a reply could reuse one as a price — low risk, split the lines if it ever shows up
    const toolText = [pending, recheck].filter(Boolean) // the saved draft's and the waiting order's numbers come from the code too

    // tool loop: up to 3 rounds, then one last call with tools off
    for (let turn = 0; ; turn++) {
      blocks = await call(messages, turn < 3)
      const uses = blocks.filter((b) => b.type === 'tool_use')
      if (!uses.length || turn >= 3) break
      const h = uses.find((b) => b.name === 'handoff')
      // thanks / goodbye is not a handoff: one warm line
      if (h && isClosing(lastStudent(history))) return { reply: closingLine(history), handoff: null, usd, guards, calls }
      if (h) return fail(String(h.input?.reason ?? '').trim() || 'handoff')
      messages.push({ role: 'assistant', content: blocks })
      const results = []
      for (const u of uses) {
        let r
        try { r = await runTool(u.name, u.input ?? {}) } catch { r = { ok: false, message: 'خطأ تقني' } }
        if (u.name === 'confirm_order' && r?.ok) confirmed = true
        if (u.name === 'prepare_order' && r?.ok && r.summary) prepared = r.summary
        if (r?.message) toolText.push(String(r.message))
        results.push({ type: 'tool_result', tool_use_id: u.id, content: String(r?.message ?? ''), is_error: !r?.ok })
      }
      messages.push({ role: 'user', content: results })
    }

    // cleaning, then violations
    const extra = toolText.join('\n')
    const finish = (text) => {
      const t = dropRepeats(dropEcho(dropNote(dropMeta(textToolCalls(text).text))), history, now.getTime()).replace(/\n{2,}/g, '\n').trim()
      return note ? t : dropGreeting(t, history)
    }
    let reply = finish(textOf(blocks))
    let bad = violationsOf(reply, card, confirmed, asked, now, script, extra, prepared)
    if (bad.length) {
      for (const v of bad) guards.push({ guard: v.guard, action: 'retry' })
      const note = `(ملاحظة من النظام، ماشي من الزبون: ${bad.map((v) => NOTES[v.guard](v.detail)).join(' ')} اكتب الرد النهائي للزبون فقط، بلا ذكر لهذه الملاحظة.)`
      const again = await call([...messages, { role: 'assistant', content: reply || '...' }, { role: 'user', content: note }], false)
      reply = finish(textOf(again))
      // a short answer or a Moroccan word after the retry is sent as is: never hand off for style
      bad = violationsOf(reply, card, confirmed, asked, now, script, extra, prepared).filter((v) => (v.guard !== 'short' || !reply.trim()) && v.guard !== 'darja')
      if (bad.length) {
        // the order is saved and the client alerted: the customer still gets a safe confirmation, not a handoff
        for (const v of bad) guards.push({ guard: v.guard, action: confirmed || prepared ? 'trimmed' : 'handoff' })
        if (confirmed) return { reply: orderDoneLine(history), handoff: null, usd, guards, calls }
        // the draft is saved: the customer gets the code's own summary to confirm, not a handoff
        if (prepared) return { reply: `${prepared}\nنأكدو الطلبية؟`, handoff: null, usd, guards, calls }
        return fail(`guard:${bad[0].guard}`)
      }
    }
    return { reply, handoff: null, usd, guards, calls }
  } catch (e) {
    return { reply: null, handoff: 'ai-error', error: String(e?.message ?? e).slice(0, 200), usd, guards, calls }
  }
}

// What is left on an OpenRouter key (USD), null when unknown.
export async function orBalance(apiKey, fetchImpl = fetch) {
  if (!apiKey) return null
  try {
    const res = await fetchImpl('https://openrouter.ai/api/v1/credits', { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000) })
    const d = res.ok ? (await res.json())?.data : null
    return Number.isFinite(d?.total_credits) && Number.isFinite(d?.total_usage) ? Math.round((d.total_credits - d.total_usage) * 100) / 100 : null
  } catch {
    return null
  }
}
