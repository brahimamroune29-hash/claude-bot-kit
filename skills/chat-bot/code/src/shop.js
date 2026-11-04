// Shop logic: wilaya lookup, phone check, pricing, summary (pure) and the order tool executor. All money is computed here from the card.
import { saveDraft, latestDraft, confirmOrder, setChat } from './db.js'
import { promiseAt, remindAt } from './jobs.js'
import { isMeta, META_WINDOW_MS } from './meta.js'
import { PHOTO } from './media.js' // the names /media serves

const DIGITS = (s) => String(s ?? '').replace(/[٠-٩]/g, (c) => c.charCodeAt(0) - 0x660).replace(/[۰-۹]/g, (c) => c.charCodeAt(0) - 0x6f0)
// Loose form: no diacritics, أ/إ/آ -> ا, ة -> ه, lower case, no punctuation, «ال» (also after ب/ل/و/ف) dropped from every word.
const loose = (s) => DIGITS(s).replace(/[ً-ْـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').toLowerCase()
  .replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean).map((w) => w.replace(/^[بلوف]?ال(?=\p{L}{2})/u, '')).join(' ')

export function findWilaya(text, card) {
  const list = card?.delivery?.wilayas ?? []
  const t = loose(text)
  if (!t) return null
  // a bare number counts only as the whole answer («16», «ولاية 16»): numbers inside an address («حي 20 اوت») are not wilayas
  const alone = /^(?:ولايه |wilaya |w )?(\d{1,2})$/.exec(t)
  if (alone) return list.find((w) => w.n === Number(alone[1])) ?? null
  const hay = ` ${t} `
  const hits = list.flatMap((w) => [w.name, ...(w.aliases ?? [])].map((k) => ({ w, k: loose(k) })).filter(({ k }) => k && hay.includes(` ${k} `)))
  // «تيزي» inside «تيزي وزو» is the same hit; a key that is part of a longer hit of another wilaya is dropped
  const keep = hits.filter((a) => !hits.some((b) => b.w !== a.w && b.k.length > a.k.length && b.k.includes(a.k)))
  const ns = new Set(keep.map((h) => h.w.n))
  return ns.size === 1 ? keep[0].w : null
}

export function normPhone(text) {
  const d = DIGITS(text).replace(/[\s.\-()]/g, '')
  const m = /(?<!\d)(?:\+|00)?(?:213)?0?([5-7]\d{8})(?!\d)/.exec(d)
  if (!m) return null
  const whole = m[0].replace(/^\+|^00/, '')
  // local form must start with 0; international form with 213; a bare 9 digits is not enough
  return /^(?:213|0)/.test(whole) ? `0${m[1]}` : null
}

// What is wrong in a hand-edited card.json, one Arabic sentence each (the bot refuses to start on any). Empty = ready.
// hasPhoto(name): the photo file is in MEDIA_DIR.
export function checkCard(c, hasPhoto = () => true) {
  const e = [], str = (v) => (typeof v === 'string' ? v.trim() : '')
  if (str(c?.shop).length < 2) e.push('اسم المتجر ناقص (shop)')
  if (!/^(0\d{8,9}|213\d{8,9})$/.test(str(c?.phone).replace(/\D/g, ''))) e.push('هاتف المتجر ناقص أو غير صحيح (phone)')
  const products = Array.isArray(c?.products) ? c.products : []
  if (!products.length) e.push('أضف منتجاً واحداً على الأقل (products)')
  const ids = new Set()
  products.forEach((p, i) => {
    const at = `المنتج ${i + 1}${str(p?.name) ? ` (${p.name})` : ''}`
    if (!/^p\d{1,4}$/.test(p?.id ?? '') || ids.has(p.id)) e.push(`${at}: الرقم (id) مكرر أو غير صحيح، مثل p1`)
    ids.add(p?.id)
    if (str(p?.name).length < 2) e.push(`${at}: الاسم ناقص`)
    if (!Number.isInteger(p?.price) || p.price <= 0) e.push(`${at}: السعر ناقص أو ليس عدداً صحيحاً`)
    for (const [k, vs] of Object.entries(p?.variants ?? {})) if (!Array.isArray(vs) || !vs.length) e.push(`${at}: الخيار ${k} بلا قيم`)
    for (const f of p?.photos ?? []) if (!PHOTO.test(f) || !hasPhoto(f)) e.push(`${at}: الصورة ${f} غير موجودة في مجلد الصور (اسم بلا مسافات، jpg أو png)`)
  })
  const wilayas = Array.isArray(c?.delivery?.wilayas) ? c.delivery.wilayas : []
  if (!str(c?.delivery?.delay)) e.push('مدة التوصيل ناقصة (delivery.delay)')
  if (!wilayas.some((w) => Number.isInteger(w?.home) || Number.isInteger(w?.office))) e.push('أضف سعر التوصيل لولاية واحدة على الأقل (delivery.wilayas)')
  if (str(c?.policy).length < 5) e.push('سياسة الاستبدال والإرجاع ناقصة (policy)')
  return e
}

const fail = (error) => ({ ok: false, error })
export function priceOrder(card, { items, wilaya, delivery } = {}) {
  if (!Array.isArray(items) || !items.length) return fail('items: لا يوجد منتج في الطلب')
  const lines = []
  for (const it of items) {
    const p = (card?.products ?? []).find((x) => x.id === it?.product_id)
    if (!p) return fail(`منتج غير موجود في البطاقة: ${it?.product_id}`)
    if (p.out) return fail(`المنتج ${p.name} نفذ من المخزون: قل هذا للزبون واقترح منتجاً آخر من البطاقة`)
    const qty = typeof it.qty === 'string' && /^\d+$/.test(it.qty) ? Number(it.qty) : it.qty
    if (!Number.isInteger(qty) || qty < 1 || qty > 20) return fail(`الكمية يجب أن تكون عدداً صحيحاً من 1 إلى 20 (qty ${it.qty}) للمنتج ${p.name}`)
    const keys = Object.keys(p.variants ?? {}), v = it.variant && typeof it.variant === 'object' ? it.variant : {}
    if (!keys.length && Object.keys(v).length) return fail(`المنتج ${p.name} ليس له خيارات، احذف الخيار ${Object.keys(v).join('، ')}`)
    for (const k of keys) {
      if (v[k] == null) return fail(`المنتج ${p.name} يحتاج اختيار ${k}: ${p.variants[k].join(' / ')}`)
      if (!p.variants[k].includes(v[k])) return fail(`${k} "${v[k]}" غير متوفر للمنتج ${p.name}، المتوفر: ${p.variants[k].join(' / ')}`)
      if (p.soldOut?.[k]?.includes(v[k])) return fail(`${k} "${v[k]}" نفذ للمنتج ${p.name}، المتوفر: ${p.variants[k].filter((x) => !p.soldOut[k].includes(x)).join(' / ') || 'لا شيء'}`)
    }
    const extra = Object.keys(v).filter((k) => !keys.includes(k))
    if (extra.length) return fail(`المنتج ${p.name} ليس له خيار ${extra.join('، ')}، الخيارات: ${keys.join('، ')}`)
    lines.push({ id: p.id, name: p.name, variant: Object.fromEntries(keys.map((k) => [k, v[k]])), qty, unit: p.price, sum: p.price * qty })
  }
  const w = findWilaya(wilaya, card)
  if (!w) return fail(`ولاية غير معروفة أو غير واضحة (wilaya "${wilaya ?? ''}"): اسأل الزبون عن رقم الولاية أو اسمها`)
  if (delivery !== 'home' && delivery !== 'office') return fail('نوع التوصيل (delivery) يجب أن يكون home (للمنزل) أو office (للمكتب)')
  const fee = w[delivery]
  if (fee == null) return fail(`لا يوجد توصيل ${delivery === 'home' ? 'للمنزل' : 'للمكتب'} إلى ${w.name}: قل هذا للزبون${w[delivery === 'home' ? 'office' : 'home'] != null ? ' واقترح عليه التوصيل ' + (delivery === 'home' ? 'للمكتب' : 'للمنزل') : ''}`)
  return { ok: true, lines, fee, total: lines.reduce((s, l) => s + l.sum, 0) + fee, wilaya: w.name, wilaya_n: w.n, delivery }
}

export function summaryText(order, card) {
  const lines = order.lines.map((l) => {
    const v = Object.entries(l.variant ?? {}).map(([k, x]) => `${k}: ${x}`).join('، ')
    return `- ${l.name}${v ? ` (${v})` : ''}: ${l.unit} دج × ${l.qty} = ${l.sum} دج`
  })
  const where = order.delivery === 'home' ? 'للمنزل' : 'للمكتب'
  return ['ملخص الطلب:', ...lines, `التوصيل إلى ${order.wilaya} (${where}): ${order.fee} دج`,
    `المجموع: ${order.total} دج، ${card?.delivery?.pay ?? 'الدفع عند الاستلام'}.`].join('\n')
}

// The draft a «نعم» can confirm: the bot's last turn showed it (its total is there). Once the chat moved on
// (a photo, another question), a «نعم» answers that, not the summary: prepare_order shows it again first.
function shownDraft(db, phone) {
  const d = latestDraft(db, phone)
  if (!d) return null
  const turn = db.prepare(`SELECT text FROM messages WHERE phone = ? AND role = 'bot' AND status = 'sent' AND id > COALESCE((
      SELECT MAX(id) FROM messages WHERE phone = ? AND role = 'student' AND id < (SELECT MAX(id) FROM messages WHERE phone = ? AND role = 'bot' AND status = 'sent')), 0)`).all(phone, phone, phone)
  const total = new RegExp(`(?<!\\d)${d.total}(?!\\d)`)
  return turn.some((r) => total.test(DIGITS(r.text).replace(/(\d)[\s.,](?=\d{3}(?!\d))/g, '$1'))) ? d : null
}

// The saved draft waiting for the customer's «نعم», as text for the model's per-turn block (it never sees its own earlier tool calls).
export function pendingSummary(db, card, phone) {
  const d = shownDraft(db, phone)
  return d ? `${summaryText({ lines: JSON.parse(d.items), fee: d.fee, total: d.total, wilaya: d.wilaya, delivery: d.delivery }, card)}\n${who({ name: d.name, phone: d.customer_phone, address: d.address })}` : null
}

// «ورّيني», «صورة», «تصويرة», «نشوفها», «شكلها», photo, tswira, wrini…
const PHOTO_ASK = /صور|تصوير|فطو|فوطو|فوتو|ورّ?ي|نشوف|تشوف|شكل|photo|foto|pic|image|tswir|tsawer|sour|wri|nchouf|chkel/i
// our note for a customer photo («📷 [صورة من الزبون]») is not a request: only his caption (the next lines) counts
const asksPhoto = (t) => PHOTO_ASK.test(t.startsWith('📷') ? t.split('\n').slice(1).join(' ') : t)
const who = (o) => `الاسم: ${o.name}\nالهاتف: ${o.phone}\nالعنوان: ${o.address}`

// The question before shipping: written by the code from the stored order (numbers never from the model)
const itemsLine = (o) => JSON.parse(o.items).map((l) => `${l.name}${Object.values(l.variant ?? {}).length ? ` ${Object.values(l.variant).join(' ')}` : ''} × ${l.qty}`).join('، ')
export const recheckText = (o, latin = false) => (latin
  ? `Sbah el khir 🌞 Commande N°${o.id} (${o.total} DA) rahi wajda tkhroj l livraison. Nab3atouha? Jawebna b "oui" wela goulna ida beddelt ra2yek.`
  : `صباح الخير 🌞 طلبيتك رقم ${o.id} (${itemsLine(o)}) بـ ${o.total} دج راهي واجدة تخرج للتوصيل. نبعثوها؟ جاوبنا بـ«نعم»، ولا قولنا إذا بدّلت رأيك.`)
// 'failed' is not here: a question that never reached him cannot be what his «لا» answers
const waiting = (db, phone) => db.prepare("SELECT * FROM orders WHERE phone = ? AND status = 'confirmed' AND recheck IN ('asked','silent') ORDER BY id DESC LIMIT 1").get(phone)
// for the model's per-turn block: the order whose «نبعثوها؟» waits for his answer
export function recheckPending(db, phone) {
  const o = waiting(db, phone)
  return o ? `#${o.id}: ${itemsLine(o)}، ${o.total} دج` : null
}

// Tool executor for one chat. The model only passes what the customer said; every number comes from the card.
// Built once per turn: a draft prepared in this turn cannot be confirmed in the same turn — the customer has not seen it yet.
export function orderTools({ db, card, phone, alertAgent, now = () => Date.now() }) {
  let preparedNow = false
  const run = async (name, input = {}) => {
    if (name === 'prepare_order') {
      // one line and capped: these fields go into the client's alert, a newline could forge «المجموع: …»
      const line = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
      const customer = line(input.name, 60), cphone = normPhone(input.phone), address = line(input.address, 200)
      const priced = priceOrder(card, input)
      const errs = [
        ...(customer.length < 2 ? ['الاسم ناقص: اطلب من الزبون اسمه الكامل'] : []),
        ...(cphone ? [] : ['الهاتف غير صحيح: اطلب رقماً جزائرياً من 10 أرقام يبدأ بـ 05 أو 06 أو 07']),
        ...(address.length < 5 ? ['العنوان ناقص: اطلب عنواناً واضحاً (الحي والشارع)'] : []),
        ...(priced.ok ? [] : [priced.error]),
      ]
      if (errs.length) return { ok: false, message: errs.join('؛ ') }
      preparedNow = true
      saveDraft(db, { phone, items: priced.lines, name: customer, customerPhone: cphone, wilayaN: priced.wilaya_n, wilaya: priced.wilaya, address, delivery: priced.delivery, fee: priced.fee, total: priced.total })
      const summary = `${summaryText(priced, card)}\n${who({ name: customer, phone: cphone, address })}`
      return { ok: true, summary, message: `${summary}\nاعرض الملخص على الزبون واطلب منه يأكد بـ"نعم". لا تنادِ confirm_order قبل موافقته.` }
    }
    if (name === 'confirm_order') {
      if (preparedNow) return { ok: false, message: 'اعرض الملخص على الزبون أولاً واستنَّ رده بـ«نعم» في رسالته القادمة' }
      const d = shownDraft(db, phone)
      if (!d) return { ok: false, message: latestDraft(db, phone) ? 'آخر رسالة منك لم تكن الملخص: نادِ prepare_order من جديد بنفس المعلومات واعرض الملخص، ثم انتظر «نعم»' : 'لا يوجد طلب جاهز: نادِ prepare_order أولاً' }
      // stock may have changed since the summary (a draft lives 24 h): check again before confirming
      const gone = JSON.parse(d.items).find((l) => {
        const p = (card?.products ?? []).find((x) => x.id === l.id)
        return !p || p.out || Object.entries(l.variant ?? {}).some(([k, v]) => p.soldOut?.[k]?.includes(v))
      })
      if (gone) return { ok: false, message: `${gone.name}${Object.keys(gone.variant ?? {}).length ? ` (${Object.values(gone.variant).join(' ')})` : ''} نفذ من المخزون بعد الملخص: اعتذر للزبون واقترح بديلاً من البطاقة` }
      if (!confirmOrder(db, d.id)) return { ok: false, message: 'لا يوجد طلب جاهز: نادِ prepare_order أولاً' }
      setChat(db, phone, { stage: 'ordered' })
      const order = { lines: JSON.parse(d.items), fee: d.fee, total: d.total, wilaya: d.wilaya, delivery: d.delivery }
      // a customer who refused a delivery before: the client decides before shipping
      const refused = db.prepare("SELECT COUNT(*) n FROM orders WHERE status = 'returned' AND id != ? AND (customer_phone = ? OR phone = ?)").get(d.id, d.customer_phone, phone).n
      try {
        await alertAgent(`طلب جديد #${d.id}\n${summaryText(order, card)}\n${who({ name: d.name, phone: d.customer_phone, address: d.address })}${refused ? `\nتنبيه: هذا الزبون رفض ${refused} طلبية من قبل.` : ''}`)
      } catch (e) {
        console.error(`order #${d.id}: client alert failed (${e?.message ?? e}) — the order is in the dashboard`)
      }
      return { ok: true, message: `confirmed #${d.id}` }
    }
    if (name === 'show_photos') {
      // photos only when the customer asks — checked here too, not only in the prompt
      const last = db.prepare("SELECT text FROM messages WHERE phone = ? AND role = 'student' ORDER BY id DESC LIMIT 1").get(phone)?.text ?? ''
      if (!asksPhoto(last)) return { ok: false, message: 'الزبون لم يطلب صورة: لا ترسل صوراً إلا إذا طلبها' }
      const p = (card?.products ?? []).find((x) => x.id === input.product_id)
      if (!p) return { ok: false, message: `منتج غير موجود في البطاقة: ${input.product_id}` }
      if (!p.photos?.length) return { ok: true, message: 'لا توجد صور لهذا المنتج: اعتذر بلطف وصِف المنتج من البطاقة' }
      // two per product per turn, at most 4 per turn; a photo already sent (or on its way) to this customer is not sent again
      const had = new Set(db.prepare("SELECT media FROM messages WHERE phone = ? AND media IS NOT NULL AND (status IS NULL OR status != 'failed')").all(phone).map((r) => r.media))
      const fresh = p.photos.filter((f) => !had.has(f) && !run.photos.some((x) => x.name === f)).slice(0, Math.min(2, 4 - run.photos.length))
      if (!fresh.length) return { ok: true, message: run.photos.length >= 4 ? 'لا مزيد من الصور في هذا الرد' : 'كل صور هذا المنتج أُرسلت للزبون من قبل: لا تعدها' }
      // caption from the card (code, not the model): the first photo carries name and price
      run.photos.push(...fresh.map((f, i) => ({ name: f, caption: i === 0 ? `${p.name} - ${p.price} دج` : p.name })))
      return { ok: true, message: `${fresh.length} صورة لـ${p.name} تصل الزبون قبل ردك (هو يراها الآن)` }
    }
    if (name === 'recheck_order') {
      const o = waiting(db, phone)
      if (!o) return { ok: false, message: 'لا توجد طلبية تنتظر تأكيد الشحن: إن طلب شيئاً عن طلبيته حوّله لإنسان' }
      if (input.answer === 'yes') {
        db.prepare("UPDATE orders SET recheck = 'yes' WHERE id = ?").run(o.id)
        return { ok: true, message: `الطلبية #${o.id} تخرج للتوصيل. اشكره في جملة وقل له إنها تخرج، والدفع عند الاستلام.` }
      }
      if (input.answer === 'no') {
        db.prepare("UPDATE orders SET recheck = 'no', status = 'cancelled' WHERE id = ? AND status = 'confirmed'").run(o.id)
        try { await alertAgent(`الزبون ألغى الطلبية #${o.id} قبل الشحن (${o.total} دج): لا تشحنها.`) } catch { /* the dashboard shows it cancelled */ }
        return { ok: true, message: 'ألغينا الطلبية. قل له بلطف إنها ألغيت وإنه مرحب به متى أراد، بلا سؤال.' }
      }
      return { ok: false, message: 'answer يجب أن يكون yes أو no' }
    }
    if (name === 'remind_later') {
      const int = (v) => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v)
      // «نخمم» after he already gave a time (or said «غالي»: the 30-day message): that date stays
      const c = db.prepare('SELECT * FROM chats WHERE phone = ?').get(phone) // * : follow_kind is added by initJobs
      if (input.days == null && input.hour == null && c?.follow_kind && c.follow_at > now()) return { ok: true, message: 'موعد الرجوع له محفوظ من قبل. قل له «على راحتك» بلا ضغط ولا سؤال، ولا تذكر له موعداً.' }
      const when = promiseAt(now(), input.days == null ? null : int(input.days), input.hour == null ? null : int(input.hour), input.minute == null ? 0 : int(input.minute))
      if (!when) return { ok: false, message: 'الموعد غير صالح: days من 0 إلى 30، hour من 0 إلى 23، والموعد بعد الآن. إن لم يذكر الزبون وقتاً فنادِها بلا أي خانة.' }
      if (isMeta(phone) && when > now() + META_WINDOW_MS) return { ok: false, message: 'في إنستغرام وماسنجر لا نقدر نكتب للزبون بعد 24 ساعة من آخر رسالة له: لا تعده بموعد، قل له «على راحتك، كي تقرر ابعثلنا».' }
      if (!remindAt(db, phone, when)) return { ok: false, message: 'لا نكتب لهذا الزبون (طلب ألا نكتب له، أو عنده طلبية مؤكدة): لا تعده بأي رسالة' }
      if (input.days == null && input.hour == null) return { ok: true, message: 'سجّلت: البوت يرجع له بعد حوالي 6 ساعات (أو صباح الغد إن كان الليل). قل له «على راحتك» بلا ضغط ولا سؤال، ولا تذكر له موعداً.' }
      const d = new Date(when + 3_600_000).toISOString()
      return { ok: true, message: `سجّلت: البوت يكتب للزبون ${d.slice(0, 10)} على ${d.slice(11, 16)} (توقيت الجزائر). قل له في جملة قصيرة إنك تكتبلو في هذاك الوقت إن شاء الله، بلا ضغط.` }
    }
    return { ok: false, message: `أداة غير معروفة: ${name}` } // handoff is handled inside answer(), never here
  }
  run.photos = [] // photos to send before this turn's reply
  return run
}
