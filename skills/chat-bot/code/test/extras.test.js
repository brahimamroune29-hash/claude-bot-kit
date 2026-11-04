// Four extras: stock, the «on its way» message, customers who refused before, orders export.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { openDb, ensureChat, addMessage } from '../src/db.js'
import { dashboard } from '../src/dashboard.js'
import { priceOrder, orderTools } from '../src/shop.js'
import { renderCard } from '../src/brain.js'

const base = JSON.parse(readFileSync(new URL('./card.sample.json', import.meta.url), 'utf8'))
const fresh = () => structuredClone(base)
const NOW = Date.UTC(2026, 10, 1, 12, 0)
const order = { items: [{ product_id: 'p2', variant: { 'اللون': 'أسود' }, qty: 1 }], wilaya: '16', delivery: 'home' }

async function boot(card = fresh()) {
  const db = openDb()
  const said = [], saves = []
  const say = async (phone, text, role) => { said.push({ phone, text, role }); return true }
  const handle = dashboard({ db, say, card, password: 'pw', now: () => NOW, saveCard: () => saves.push(structuredClone(card)) })
  const server = http.createServer(async (req, res) => {
    if (!(await handle(req, res, new URL(req.url, 'http://x')))) { res.writeHead(404); res.end() }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}`
  const cookie = (await fetch(url + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"password":"pw"}' })).headers.get('set-cookie').split(';')[0]
  const call = (path, body) => fetch(url + path, body === undefined ? { headers: { cookie } }
    : { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { db, card, said, saves, call, url, close: () => server.close() }
}
const addOrder = (db, o = {}) => Number(db.prepare(`INSERT INTO orders(phone, items, name, customer_phone, wilaya_n, wilaya, address, delivery, fee, total, status, created_at, confirmed_at)
  VALUES (?, ?, ?, ?, 16, 'الجزائر', ?, 'home', 400, ?, ?, ?, ?)`).run(o.phone ?? '213555700001', JSON.stringify([{ id: 'p2', name: 'ساعة', variant: { 'اللون': 'أسود' }, qty: 1, unit: 4800, sum: 4800 }]),
  o.name ?? 'سمير', o.customerPhone ?? '0555123456', o.address ?? 'حي النصر، عمارة 3', o.total ?? 5200, o.status ?? 'confirmed', NOW, NOW).lastInsertRowid)

// ═══ stock ═══
test('stock: an out-of-stock product or value cannot be ordered, and the card says so', () => {
  const c = fresh()
  c.products[1].soldOut = { 'اللون': ['أسود'] }
  const r = priceOrder(c, order)
  assert.equal(r.ok, false)
  assert.match(r.error, /أسود.*نفذ/)
  assert.equal(priceOrder(c, { ...order, items: [{ product_id: 'p2', variant: { 'اللون': 'فضي' }, qty: 1 }] }).ok, true)
  assert.match(renderCard(c), /اللون: أسود \(نفذ\) \/ فضي/)
  c.products[1].out = true
  assert.match(priceOrder(c, { ...order, items: [{ product_id: 'p2', variant: { 'اللون': 'فضي' }, qty: 1 }] }).error, /نفذ/)
  assert.match(renderCard(c), /\[p2\][^\n]*نفذ من المخزون/)
})

test('stock: the dashboard switches a product or a value, saves the card, and lists it', async (t) => {
  const s = await boot(); t.after(s.close)
  assert.equal((await s.call('/api/stock', { id: 'p2', out: true })).status, 200)
  assert.equal(s.card.products[1].out, true)
  assert.equal((await s.call('/api/stock', { id: 'p2', key: 'اللون', value: 'أسود', out: true })).status, 200)
  assert.deepEqual(s.card.products[1].soldOut, { 'اللون': ['أسود'] })
  assert.equal(s.saves.length, 2)
  const list = (await (await s.call('/api/stock')).json()).products
  assert.deepEqual(list.find((p) => p.id === 'p2'), { id: 'p2', name: base.products[1].name, out: true, variants: { 'اللون': [{ v: 'أسود', out: true }, { v: 'فضي', out: false }] } })
  await s.call('/api/stock', { id: 'p2', out: false })
  await s.call('/api/stock', { id: 'p2', key: 'اللون', value: 'أسود', out: false })
  assert.equal(s.card.products[1].out, undefined)
  assert.equal(s.card.products[1].soldOut, undefined)
  for (const bad of [{ id: 'p99', out: true }, { id: 'p2', key: 'المقاس', value: 'L', out: true }, { id: 'p2', key: 'اللون', value: 'أحمر', out: true }, { id: 'p2', out: 'yes' }]) {
    assert.equal((await s.call('/api/stock', bad)).status, 400, JSON.stringify(bad))
  }
})

// ═══ the «on its way» message ═══
test('shipped: the customer gets one message with the order number, delay and amount; other moves send nothing', async (t) => {
  const s = await boot(); t.after(s.close)
  ensureChat(s.db, '213555700001')
  const id = addOrder(s.db)
  assert.equal((await s.call('/api/order', { id, status: 'shipped' })).status, 200)
  assert.equal(s.said.length, 1)
  assert.equal(s.said[0].phone, '213555700001')
  assert.equal(s.said[0].role, 'bot')
  assert.match(s.said[0].text, new RegExp(`طلبيتك رقم ${id} خرجت`))
  assert.match(s.said[0].text, /5200 دج/)
  assert.match(s.said[0].text, new RegExp(base.delivery.delay))
  await s.call('/api/order', { id, status: 'delivered' })
  const other = addOrder(s.db)
  await s.call('/api/order', { id: other, status: 'cancelled' })
  assert.equal(s.said.length, 1)
})

// ═══ customers who refused before ═══
test('refused before: the order list marks a customer with a returned order', async (t) => {
  const s = await boot(); t.after(s.close)
  addOrder(s.db, { status: 'returned', customerPhone: '0661000000' })
  const again = addOrder(s.db, { customerPhone: '0661000000', phone: '213555700009' })
  const clean = addOrder(s.db, { customerPhone: '0770000000', phone: '213555700008' })
  const list = (await (await s.call('/api/orders')).json()).orders
  assert.equal(list.find((o) => o.id === again).refused, 1)
  assert.equal(list.find((o) => o.id === clean).refused, 0)
})

test('refused before: the new-order alert warns the client', async () => {
  const db = openDb(), phone = '213555700010', alerts = []
  ensureChat(db, phone)
  addOrder(db, { status: 'returned', customerPhone: '0661000000', phone: '213555700099' })
  const tools = (ph) => orderTools({ db, card: fresh(), phone: ph, alertAgent: async (t) => { alerts.push(t) } })
  await tools(phone)('prepare_order', { ...order, name: 'كريم', phone: '0661000000', address: 'حي النصر عمارة 3' })
  addMessage(db, { phone, role: 'bot', text: 'المجموع: 5200 دج', status: 'sent' })
  await tools(phone)('confirm_order', {})
  assert.match(alerts[0], /تنبيه: هذا الزبون رفض 1 طلبية من قبل/)
})

test('stock: a summary prepared before the item ran out cannot be confirmed', async () => {
  const db = openDb(), phone = '213555700011', alerts = [], card = fresh()
  ensureChat(db, phone)
  const tools = () => orderTools({ db, card, phone, alertAgent: async (t) => { alerts.push(t) } })
  await tools()('prepare_order', { ...order, name: 'كريم', phone: '0661000000', address: 'حي النصر عمارة 3' })
  addMessage(db, { phone, role: 'bot', text: 'المجموع: 5200 دج', status: 'sent' })
  card.products[1].soldOut = { 'اللون': ['أسود'] }
  const r = await tools()('confirm_order', {})
  assert.equal(r.ok, false)
  assert.match(r.message, /نفذ/)
  assert.equal(alerts.length, 0)
  delete card.products[1].soldOut
  assert.equal((await tools()('confirm_order', {})).ok, true) // back in stock: the same summary goes through
})

// ═══ export ═══
test('export: the orders to ship as a spreadsheet file (Arabic opens right in Excel); login needed', async (t) => {
  const s = await boot(); t.after(s.close)
  const id = addOrder(s.db, { name: 'سمير "الصغير"', address: 'حي النصر، عمارة 3' })
  addOrder(s.db, { status: 'shipped' })
  const r = await s.call('/api/orders.csv')
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type'), /text\/csv/)
  assert.match(r.headers.get('content-disposition'), /attachment/)
  const body = Buffer.from(await r.arrayBuffer())
  assert.deepEqual([...body.subarray(0, 3)], [0xef, 0xbb, 0xbf]) // so Excel reads it as UTF-8
  const lines = body.toString('utf8').slice(1).trim().split('\r\n')
  assert.equal(lines.length, 2) // header + the one confirmed order (shipped ones are not «to ship»)
  assert.match(lines[0], /^رقم الطلب;/) // «;»: Excel in French / Algerian settings splits on it
  assert.ok(lines[1].startsWith(`${id};`))
  assert.ok(lines[1].includes('"سمير ""الصغير"""'))
  assert.ok(lines[1].includes(';حي النصر، عمارة 3;'))
  assert.equal((await fetch(s.url + '/api/orders.csv')).status, 401)
})

test('export: a cell that starts like a formula is neutralised (incl. tab / return); phones stay intact', async (t) => {
  const s = await boot(); t.after(s.close)
  addOrder(s.db, { name: '=HYPERLINK("x")', address: '\t=1+1' })
  const line = Buffer.from(await (await s.call('/api/orders.csv')).arrayBuffer()).toString('utf8').split('\r\n')[1]
  assert.ok(line.includes(`"'=HYPERLINK(""x"")"`), line)
  assert.ok(line.includes("'\t=1+1"), line)
  assert.ok(line.includes(';0555123456;'), line)
})

// ═══ Instagram / Messenger (2026-11-01) ═══
test('shipped on Instagram / Messenger after 24 h: no message (Meta refuses it), the owner is told to phone', async (t) => {
  const s = await boot(); t.after(s.close)
  ensureChat(s.db, 'ig:7001')
  addMessage(s.db, { phone: 'ig:7001', role: 'student', text: 'سلام', at: NOW - 30 * 3_600_000 })
  const id = addOrder(s.db, { phone: 'ig:7001' })
  const r = await (await s.call('/api/order', { id, status: 'shipped' })).json()
  assert.equal(s.said.length, 0)
  assert.match(r.notice, /اتصل بالزبون على 0555123456/)
  const fresh = addOrder(s.db, { phone: 'ig:7001' })
  addMessage(s.db, { phone: 'ig:7001', role: 'student', text: 'وين وصلت؟', at: NOW - 3_600_000 })
  assert.equal((await (await s.call('/api/order', { id: fresh, status: 'shipped' })).json()).notice, '')
  assert.equal(s.said.length, 1)
})

test('forget: the customer asked to delete his data — messages and AI logs go, the order (accounting) stays', async (t) => {
  const s = await boot(); t.after(s.close)
  ensureChat(s.db, '213555700020', 'سمير')
  addMessage(s.db, { phone: '213555700020', role: 'student', text: 'احذف بياناتي' })
  s.db.prepare("INSERT INTO ai_calls(phone, at, kind) VALUES ('213555700020', 1, 'reply')").run()
  addOrder(s.db, { phone: '213555700020' })
  assert.equal((await s.call('/api/forget', { phone: '213555700020' })).status, 200)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM messages WHERE phone = '213555700020'").get().n, 0)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM ai_calls WHERE phone = '213555700020'").get().n, 0)
  assert.equal(s.db.prepare("SELECT name FROM chats WHERE phone = '213555700020'").get().name, null)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM orders WHERE phone = '213555700020'").get().n, 1)
})

test('a reply from the dashboard to Instagram over 1000 bytes is refused (Meta would)', async (t) => {
  const s = await boot(); t.after(s.close)
  ensureChat(s.db, 'ig:7003')
  assert.equal((await s.call('/api/reply', { phone: 'ig:7003', text: 'ب'.repeat(600) })).status, 400)
  assert.equal((await s.call('/api/reply', { phone: 'ig:7003', text: 'مرحبا' })).status, 200)
})
