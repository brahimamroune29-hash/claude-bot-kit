import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { findWilaya, normPhone, priceOrder, summaryText, orderTools, pendingSummary, checkCard } from '../src/shop.js'
import { renderCard } from '../src/brain.js'
import { openDb, ensureChat, getChat, addMessage } from '../src/db.js'

const card = JSON.parse(readFileSync(new URL('./card.sample.json', import.meta.url), 'utf8'))
const n = (t) => findWilaya(t, card)?.n ?? null

test('findWilaya: by number, with filler words', () => {
  assert.equal(n('16'), 16)
  assert.equal(n('wilaya 16'), 16)
  assert.equal(n('ولاية 31'), 31)
  assert.equal(n('Wilaya 09'), 9)
  assert.equal(n('59'), null)
  assert.equal(n('0'), null)
})

test('findWilaya: Arabic names with/without «ال», alef and ta marbuta variants', () => {
  assert.equal(n('الشلف'), 2)
  assert.equal(n('شلف'), 2)
  assert.equal(n('الأغواط'), 3)
  assert.equal(n('اغواط'), 3)
  assert.equal(n('إليزي'), 33)
  assert.equal(n('اليزي'), 33)
  assert.equal(n('بسكره'), 7) // ة -> ه
  assert.equal(n('سيدي بلعباس'), 22)
  assert.equal(n('عين الدفلى'), 44)
  assert.equal(n('بالبليدة'), 9)
})

test('findWilaya: aliases and Latin names, any case', () => {
  assert.equal(n('العاصمة'), 16)
  assert.equal(n('دزاير'), 16)
  assert.equal(n('Alger'), 16)
  assert.equal(n('ALGER centre'), 16)
  assert.equal(n('الجزائر العاصمة'), 16)
  assert.equal(n('oran'), 31)
  assert.equal(n('Setif'), 19)
  assert.equal(n('tizi'), 15)
})

test('findWilaya: unknown, empty or ambiguous => null', () => {
  assert.equal(n('باريس'), null)
  assert.equal(n(''), null)
  assert.equal(n(null), null)
  assert.equal(n('وهران و سطيف'), null)
  assert.equal(n('16 و 31'), null)
})

test('normPhone: Algerian mobile forms; invalid => null', () => {
  for (const t of ['0555 12 34 56', '+213555123456', '00213555123456', '0555-12-34-56', '٠٥٥٥١٢٣٤٥٦', 'رقمي 0555123456'])
    assert.equal(normPhone(t), '0555123456', t)
  assert.equal(normPhone('0771234567'), '0771234567')
  assert.equal(normPhone('0655123456'), '0655123456')
  assert.equal(normPhone('0455123456'), null) // not a mobile prefix
  assert.equal(normPhone('055512345'), null) // short
  assert.equal(normPhone('05551234567'), null) // long
  assert.equal(normPhone('555123456'), null) // 9 digits without 0 or 213
  assert.equal(normPhone('+33612345678'), null)
  assert.equal(normPhone(''), null)
  assert.equal(normPhone(undefined), null)
})

const base = { wilaya: 'العاصمة', delivery: 'home' }
test('priceOrder: product x qty + fee from the card, never from input', () => {
  const r = priceOrder(card, { ...base, items: [{ product_id: 'p2', variant: { 'اللون': 'فضي' }, qty: 1 }] })
  assert.deepEqual(r, {
    ok: true, fee: 400, total: 5200, wilaya: 'الجزائر', wilaya_n: 16, delivery: 'home',
    lines: [{ id: 'p2', name: 'ساعة كلاسيك رجالية', variant: { 'اللون': 'فضي' }, qty: 1, unit: 4800, sum: 4800 }],
  })
  const two = priceOrder(card, { wilaya: '31', delivery: 'office', items: [{ product_id: 'p4', variant: { 'المقاس': 'L', 'اللون': 'أزرق' }, qty: 2 }, { product_id: 'p1', qty: 1 }] })
  assert.equal(two.fee, 450)
  assert.equal(two.total, 2 * 2600 + 3500 + 450)
  assert.deepEqual(two.lines.map((l) => l.sum), [5200, 3500])
  assert.deepEqual(two.lines[1].variant, {})
})

test('priceOrder: money fields in the input are ignored', () => {
  const r = priceOrder(card, { ...base, total: 1, fee: 0, items: [{ product_id: 'p1', qty: 1, price: 1, unit: 1, sum: 1 }] })
  assert.equal(r.total, 3500 + 400)
})

test('priceOrder: precise errors', () => {
  const bad = (input, re) => { const r = priceOrder(card, input); assert.equal(r.ok, false); assert.match(r.error, re) }
  bad({ ...base, items: [{ product_id: 'p9', qty: 1 }] }, /p9/)
  bad({ ...base, items: [{ product_id: 'p2', qty: 1 }] }, /اللون/) // variant required
  bad({ ...base, items: [{ product_id: 'p2', variant: { 'اللون': 'أحمر' }, qty: 1 }] }, /أحمر/)
  bad({ ...base, items: [{ product_id: 'p4', variant: { 'اللون': 'أزرق' }, qty: 1 }] }, /المقاس/) // all keys required
  bad({ ...base, items: [{ product_id: 'p2', variant: { 'اللون': 'أسود', 'المقاس': 'L' }, qty: 1 }] }, /المقاس/) // extra key
  bad({ ...base, items: [{ product_id: 'p1', variant: { 'اللون': 'أسود' }, qty: 1 }] }, /p1|خيارات/) // product without variants
  for (const q of [0, 21, 1.5, -1, 'x', null, undefined]) bad({ ...base, items: [{ product_id: 'p1', qty: q }] }, /qty|الكمية/)
  bad({ ...base, wilaya: 'باريس', items: [{ product_id: 'p1', qty: 1 }] }, /ولاية|wilaya/)
  bad({ ...base, delivery: 'drone', items: [{ product_id: 'p1', qty: 1 }] }, /delivery|التوصيل/)
  bad({ ...base, items: [] }, /items|منتج/)
  bad({ ...base }, /items|منتج/)
})

test('summaryText: products with variant and qty, wilaya, home/office, fee, total, payment on delivery', () => {
  const r = priceOrder(card, { wilaya: 'wilaya 31', delivery: 'office', items: [{ product_id: 'p4', variant: { 'المقاس': 'L', 'اللون': 'أزرق' }, qty: 2 }] })
  const s = summaryText(r, card)
  for (const part of ['قميص قطني رجالي', 'المقاس: L', 'اللون: أزرق', '× 2', '2600', '5200', 'وهران', 'للمكتب', '450', '5650', 'دج', 'الدفع عند الاستلام']) assert.ok(s.includes(part), part)
  assert.match(summaryText({ ...r, delivery: 'home' }, card), /للمنزل/)
  assert.ok(!/\d [\d]{3}|\d,\d{3}/.test(s)) // plain digits, no thousand separators
})

// ═══ tool executor ═══
const PH = '213555700001'
const setup = () => {
  const db = openDb(), alerts = []
  ensureChat(db, PH, 'تجربة')
  // each call is a new turn, as in a real chat (a draft cannot be confirmed in the turn that prepared it)
  const run = (name, input) => orderTools({ db, card, phone: PH, alertAgent: async (t) => { alerts.push(t) } })(name, input)
  return { db, alerts, run }
}
const IN = { items: [{ product_id: 'p2', variant: { 'اللون': 'فضي' }, qty: 1 }], name: 'أحمد بن علي', phone: '0555 12 34 56', wilaya: 'العاصمة', address: 'شارع ديدوش مراد 12', delivery: 'home' }
// the bot showed the summary (its last turn carries the total): only then can «نعم» confirm it
const showed = (db, phone = PH) => { const d = db.prepare("SELECT total FROM orders WHERE phone = ? AND status = 'draft'").get(phone); addMessage(db, { phone, role: 'bot', text: `المجموع: ${d.total} دج. نأكدو؟`, status: 'sent' }) }

test('prepare_order: stores a draft with card-computed money and returns the summary plus the confirm instruction', async () => {
  const { db, run } = setup()
  const r = await run('prepare_order', { ...IN, total: 1, fee: 0 })
  assert.equal(r.ok, true)
  assert.ok(r.message.includes('5200 دج') && r.message.includes('400 دج') && r.message.includes('نعم'))
  assert.ok(r.message.includes('أحمد بن علي') && r.message.includes('0555123456') && r.message.includes('شارع ديدوش مراد 12'))
  const d = db.prepare('SELECT * FROM orders').all()
  assert.equal(d.length, 1)
  assert.deepEqual([d[0].status, d[0].total, d[0].fee, d[0].customer_phone, d[0].wilaya_n, d[0].delivery, d[0].phone], ['draft', 5200, 400, '0555123456', 16, 'home', PH])
  assert.equal(JSON.parse(d[0].items)[0].sum, 4800)
})

test('prepare_order: a second call replaces the draft (one per chat)', async () => {
  const { db, run } = setup()
  await run('prepare_order', IN)
  const r = await run('prepare_order', { ...IN, delivery: 'office', items: [{ product_id: 'p1', qty: 2 }] })
  assert.equal(r.ok, true)
  const rows = db.prepare('SELECT total, delivery FROM orders').all()
  assert.deepEqual(rows.map((x) => ({ ...x })), [{ total: 7300, delivery: 'office' }])
})

test('prepare_order: precise errors per field, nothing stored', async () => {
  const { db, run } = setup()
  const err = async (patch, re) => { const r = await run('prepare_order', { ...IN, ...patch }); assert.equal(r.ok, false); assert.match(r.message, re); return r }
  await err({ name: 'أ' }, /الاسم/)
  await err({ name: '' }, /الاسم/)
  await err({ phone: '0555 12 34' }, /الهاتف/)
  await err({ phone: '0455123456' }, /الهاتف/)
  await err({ address: 'حي' }, /العنوان/)
  await err({ wilaya: 'باريس' }, /ولاية/)
  await err({ delivery: 'x' }, /delivery/)
  await err({ items: [{ product_id: 'p2', qty: 1 }] }, /اللون/)
  const many = await err({ name: '', phone: '1' }, /الاسم[\s\S]*الهاتف/) // all problems at once
  assert.ok(many.message.length)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM orders').get().n, 0)
})

test('confirm_order: confirms the latest draft, stage ordered, alerts the client with summary and customer data', async () => {
  const { db, alerts, run } = setup()
  await run('prepare_order', IN); showed(db)
  const r = await run('confirm_order', {})
  assert.deepEqual(r, { ok: true, message: 'confirmed #1' })
  const o = db.prepare('SELECT status, confirmed_at FROM orders').get()
  assert.equal(o.status, 'confirmed')
  assert.ok(o.confirmed_at > 0)
  assert.equal(getChat(db, PH).stage, 'ordered')
  assert.equal(alerts.length, 1)
  for (const x of ['طلب جديد', 'ساعة كلاسيك رجالية', 'فضي', '5200', 'أحمد بن علي', '0555123456', 'شارع ديدوش مراد 12', 'الجزائر']) assert.ok(alerts[0].includes(x), x)
  const again = await run('confirm_order', {}) // double yes: no second order, no second alert
  assert.equal(again.ok, false)
  assert.equal(alerts.length, 1)
})

test('confirm_order: no draft => ok:false; unknown tool => ok:false', async () => {
  const { db, alerts, run } = setup()
  const r = await run('confirm_order', {})
  assert.equal(r.ok, false)
  assert.match(r.message, /prepare_order/)
  assert.equal(alerts.length, 0)
  assert.equal(getChat(db, PH).stage, 'new')
  assert.equal((await run('enroll_trial', {})).ok, false)
})

test('pendingSummary: the saved draft as a summary, null when none or after confirmation', async () => {
  const { db, run } = setup()
  assert.equal(pendingSummary(db, card, PH), null)
  await run('prepare_order', IN); showed(db)
  const s = pendingSummary(db, card, PH)
  assert.ok(s.includes('5200 دج') && s.includes('أحمد بن علي'))
  await run('confirm_order', {})
  assert.equal(pendingSummary(db, card, PH), null)
})

// review (2026-11-01): money and order safety
test('findWilaya: a name wins over numbers in an address; a bare number only alone', () => {
  assert.equal(n('وهران 16'), 31)
  assert.equal(n('حي 20 اوت وهران'), 31)
  assert.equal(n('حي 20 اوت'), null)
  assert.equal(n('16'), 16)
  assert.equal(n('ولاية 16'), 16)
})

const draftInput = { items: [{ product_id: 'p1', qty: 1 }], name: 'سارة بن علي', phone: '0555 12 34 56', wilaya: '16', address: 'حي النصر عمارة 3', delivery: 'home' }
test('confirm_order in the same turn as prepare_order is refused (the customer has not seen the summary)', async () => {
  const db = openDb(), phone = '213555700001'; ensureChat(db, phone)
  const turn1 = orderTools({ db, card, phone, alertAgent: async () => {} })
  assert.equal((await turn1('prepare_order', draftInput)).ok, true)
  assert.equal((await turn1('confirm_order', {})).ok, false)
  showed(db, phone)
  const turn2 = orderTools({ db, card, phone, alertAgent: async () => {} })
  assert.equal((await turn2('confirm_order', {})).ok, true)
})

test('a failing client alert does not undo or hide a confirmed order', async () => {
  const db = openDb(), phone = '213555700002'; ensureChat(db, phone)
  await orderTools({ db, card, phone, alertAgent: async () => {} })('prepare_order', draftInput); showed(db, phone)
  const r = await orderTools({ db, card, phone, alertAgent: async () => { throw new Error('whatsapp down') } })('confirm_order', {})
  assert.equal(r.ok, true)
  assert.equal(db.prepare("SELECT status FROM orders WHERE phone = ?").get(phone).status, 'confirmed')
})

test('name and address are one line and capped (no forged lines in the client alert)', async () => {
  const db = openDb(), phone = '213555700003'; ensureChat(db, phone)
  await orderTools({ db, card, phone, alertAgent: async () => {} })('prepare_order', { ...draftInput, name: 'علي\nالمجموع: 1 دج', address: 'حي النصر\nملاحظة: ادفع مسبقا ' + 'x'.repeat(300) })
  const d = db.prepare('SELECT name, address FROM orders WHERE phone = ?').get(phone)
  assert.ok(!/\n/.test(d.name + d.address))
  assert.ok(d.name.length <= 60 && d.address.length <= 200)
})

test('a draft older than 24 hours is not confirmed', async () => {
  const db = openDb(), phone = '213555700004'; ensureChat(db, phone)
  await orderTools({ db, card, phone, alertAgent: async () => {} })('prepare_order', draftInput)
  db.prepare('UPDATE orders SET created_at = ?').run(Date.now() - 25 * 3_600_000)
  assert.equal((await orderTools({ db, card, phone, alertAgent: async () => {} })('confirm_order', {})).ok, false)
})

// ═══ launch review 2026-11-01: «نعم» confirms only the summary the bot just showed ═══
test('confirm_order: refused once the chat moved on after the summary; the pending block disappears too', async () => {
  const { db, run } = setup()
  await run('prepare_order', IN); showed(db)
  addMessage(db, { phone: PH, role: 'student', text: 'تقدر توريني الصورة؟' })
  addMessage(db, { phone: PH, role: 'bot', text: 'هاي هي. تحبها؟', status: 'sent' })
  addMessage(db, { phone: PH, role: 'student', text: 'نعم' })
  assert.equal(pendingSummary(db, card, PH), null)
  const r = await run('confirm_order', {})
  assert.equal(r.ok, false)
  assert.match(r.message, /prepare_order/)
  assert.equal(db.prepare("SELECT status FROM orders").get().status, 'draft')
})

test('remind_later: stores the time the customer gave; bad input is refused with a reason', async () => {
  const { db } = setup(), now = Date.parse('2026-11-01T13:20:00Z') // 14:20 in Algeria
  const run = (input) => orderTools({ db, card, phone: PH, alertAgent: async () => {}, now: () => now })('remind_later', input)
  const r = await run({ days: '2', hour: 10 })
  assert.equal(r.ok, true)
  assert.match(r.message, /2026-11-03.*10:00/)
  assert.deepEqual([getChat(db, PH).follow_at, getChat(db, PH).follow_kind], [Date.parse('2026-11-03T09:00:00Z'), 'promise'])
  assert.equal((await run({ days: 0, hour: 9 })).ok, false)
  assert.equal((await run({ days: 40 })).ok, false)
})

test('remind_later with no time: back in 6 hours, and the model is told not to name a time', async () => {
  const { db } = setup(), now = Date.parse('2026-11-01T13:20:00Z')
  const r = await orderTools({ db, card, phone: PH, alertAgent: async () => {}, now: () => now })('remind_later', {})
  assert.equal(r.ok, true)
  assert.match(r.message, /6 ساعات/)
  assert.ok(!/\d{2}:\d{2}/.test(r.message))
  assert.deepEqual([getChat(db, PH).follow_at, getChat(db, PH).follow_kind], [now + 6 * 3_600_000, 'promise'])
})

test('remind_later with no time keeps a time the customer gave before', async () => {
  const { db } = setup(), now = Date.parse('2026-11-01T13:20:00Z')
  const run = (input) => orderTools({ db, card, phone: PH, alertAgent: async () => {}, now: () => now })('remind_later', input)
  await run({ days: 1, hour: 10 })
  const kept = getChat(db, PH).follow_at
  assert.equal((await run({})).ok, true)
  assert.equal(getChat(db, PH).follow_at, kept)
})

test('remind_later on Instagram / Messenger: no promise past Meta\'s 24 h window; «نخمم» (6 h) is fine', async () => {
  const db = openDb(), phone = 'ig:7001', now = Date.parse('2026-11-01T13:20:00Z'); ensureChat(db, phone)
  const run = (input) => orderTools({ db, card, phone, alertAgent: async () => {}, now: () => now })('remind_later', input)
  const far = await run({ days: 2, hour: 10 })
  assert.equal(far.ok, false)
  assert.match(far.message, /24 ساعة/)
  assert.equal((await run({})).ok, true)
})

// ═══ card.json is edited by hand: the bot refuses to start on a broken one (checkCard at boot) ═══
test('checkCard: the sample card passes', () => {
  assert.deepEqual(checkCard(card), [])
})

test('checkCard: a blank card lists what is missing, one Arabic sentence each', () => {
  const e = checkCard({})
  for (const want of ['اسم المتجر', 'هاتف المتجر', 'منتجاً واحداً', 'مدة التوصيل', 'سعر التوصيل', 'سياسة']) {
    assert.ok(e.some((x) => x.includes(want)), `missing error about ${want}: ${e.join(' | ')}`)
  }
})

test('checkCard: each product problem names the product; a photo must be a plain name that is on disk', () => {
  const c = structuredClone(card)
  c.products.push({ id: 'p1', name: 'عطر', price: 12.5, variants: { 'اللون': [] }, photos: ['../card.json', 'gone.jpg', 'ok.jpg'] })
  const e = checkCard(c, (f) => f === 'ok.jpg')
  assert.ok(e.includes('المنتج 7 (عطر): الرقم (id) مكرر أو غير صحيح، مثل p1'), e.join(' | '))
  assert.ok(e.includes('المنتج 7 (عطر): السعر ناقص أو ليس عدداً صحيحاً'), e.join(' | '))
  assert.ok(e.includes('المنتج 7 (عطر): الخيار اللون بلا قيم'), e.join(' | '))
  assert.ok(e.some((x) => x.includes('../card.json')) && e.some((x) => x.includes('gone.jpg')))
  assert.ok(!e.some((x) => x.includes('ok.jpg')))
  assert.equal(e.length, 5)
})

test('a wilaya without a fee: no delivery there, said plainly', () => {
  const c = structuredClone(card)
  c.delivery.wilayas[0].home = null
  const r = priceOrder(c, { items: [{ product_id: 'p2', variant: { 'اللون': 'أسود' }, qty: 1 }], wilaya: 'أدرار', delivery: 'home' })
  assert.equal(r.ok, false)
  assert.match(r.error, /لا يوجد توصيل/)
  assert.match(renderCard(c), /أدرار \(1\)/) // still listed, with its office price
})
