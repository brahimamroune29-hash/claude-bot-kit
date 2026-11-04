import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { openDb, ensureChat, addMessage, getChat, setChat } from '../src/db.js'
import { dashboard } from '../src/dashboard.js'

const DAY = 86_400_000
const HOUR = 3_600_000
// 2026-11-01 12:00 UTC = 13:00 Algeria
const NOW = Date.UTC(2026, 10, 1, 12, 0)
const ALGIERS_MIDNIGHT = Date.UTC(2026, 10, 1, 0, 0) - HOUR // 2026-11-01 00:00 Algeria

async function boot({ password = 'pw', now = () => NOW } = {}) {
  const db = openDb()
  const said = []
  const say = async (phone, text, role) => { said.push({ phone, text, role }); addMessage(db, { phone, role, text, at: now() }); return true }
  const handle = dashboard({ db, say, password, now })
  const server = http.createServer(async (req, res) => {
    if (!(await handle(req, res, new URL(req.url, 'http://x')))) { res.writeHead(404); res.end() }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const call = (path, { method = 'GET', body, cookie, json = true, headers = {} } = {}) => fetch(base + path, {
    method, redirect: 'manual',
    headers: { ...(json && body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
  const login = async () => (await call('/api/login', { method: 'POST', body: { password } })).headers.get('set-cookie').split(';')[0]
  return { db, said, call, login, close: () => server.close() }
}

test('serves index and falls through for unknown paths', async (t) => {
  const s = await boot(); t.after(s.close)
  const r = await s.call('/')
  assert.equal(r.status, 200)
  assert.match(await r.text(), /dir="rtl"/)
  assert.equal((await s.call('/nope')).status, 404)
})

test('login: wrong, right, empty password, cookie flags', async (t) => {
  const s = await boot(); t.after(s.close)
  assert.equal((await s.call('/api/login', { method: 'POST', body: { password: 'bad' } })).status, 401)
  const ok = await s.call('/api/login', { method: 'POST', body: { password: 'pw' } })
  assert.equal(ok.status, 200)
  const c = ok.headers.get('set-cookie')
  assert.match(c, /^s=[0-9a-f]{64};/); assert.match(c, /HttpOnly/); assert.match(c, /SameSite=Strict/); assert.doesNotMatch(c, /Secure/)
  const e = await boot({ password: '' }); t.after(e.close)
  assert.equal((await e.call('/api/login', { method: 'POST', body: { password: '' } })).status, 401)
})

test('secure cookie flag', async (t) => {
  const db = openDb()
  const handle = dashboard({ db, say: async () => true, password: 'pw', secureCookie: true })
  const server = http.createServer((q, r) => handle(q, r, new URL(q.url, 'http://x')))
  await new Promise((r) => server.listen(0, r)); t.after(() => server.close())
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"password":"pw"}' })
  assert.match(r.headers.get('set-cookie'), /Secure/)
})

test('login rate limit: 5 failures then 429, even for the right password', async (t) => {
  const s = await boot(); t.after(s.close)
  for (let i = 0; i < 5; i++) assert.equal((await s.call('/api/login', { method: 'POST', body: { password: 'x' } })).status, 401)
  assert.equal((await s.call('/api/login', { method: 'POST', body: { password: 'pw' } })).status, 429)
  // another IP via x-forwarded-for is unaffected
  assert.equal((await s.call('/api/login', { method: 'POST', body: { password: 'pw' }, headers: { 'x-forwarded-for': '9.9.9.9, 1.1.1.1' } })).status, 200)
})

test('api needs a session; logout kills it', async (t) => {
  const s = await boot(); t.after(s.close)
  for (const p of ['/api/state', '/api/chat?phone=1']) assert.equal((await s.call(p)).status, 401)
  assert.equal((await s.call('/api/reply', { method: 'POST', body: { phone: '1', text: 'x' } })).status, 401)
  const cookie = await s.login()
  assert.equal((await s.call('/api/state', { cookie })).status, 200)
  assert.equal((await s.call('/api/logout', { method: 'POST', cookie, body: {} })).status, 200)
  assert.equal((await s.call('/api/state', { cookie })).status, 401)
})

test('POST without JSON content-type is rejected; oversize body too', async (t) => {
  const s = await boot(); t.after(s.close)
  const cookie = await s.login()
  const r = await s.call('/api/release', { method: 'POST', cookie, body: '{"phone":"1"}', json: false, headers: { 'content-type': 'text/plain' } })
  assert.equal(r.status, 415)
  const big = await s.call('/api/release', { method: 'POST', cookie, body: JSON.stringify({ phone: 'x'.repeat(70_000) }) })
  assert.equal(big.status, 413)
})

test('reply: says as human, clears handoff, bot quiet 20 minutes', async (t) => {
  const s = await boot(); t.after(s.close)
  ensureChat(s.db, '213550', 'سمير'); setChat(s.db, '213550', { handed_off: 1 })
  const cookie = await s.login()
  const r = await s.call('/api/reply', { method: 'POST', cookie, body: { phone: '213550', text: 'أهلا' } })
  assert.equal(r.status, 200)
  assert.deepEqual(s.said, [{ phone: '213550', text: 'أهلا', role: 'human' }])
  const c = getChat(s.db, '213550')
  assert.equal(c.handed_off, 0); assert.equal(c.human_until, NOW + 20 * 60_000)
})

test('reply validation: empty, too long, unknown chat, failed send', async (t) => {
  const s = await boot(); t.after(s.close)
  ensureChat(s.db, '1')
  const cookie = await s.login()
  const reply = (b) => s.call('/api/reply', { method: 'POST', cookie, body: b })
  assert.equal((await reply({ phone: '1', text: '   ' })).status, 400)
  assert.equal((await reply({ phone: '1', text: 'a'.repeat(1501) })).status, 400)
  assert.equal((await reply({ phone: '2', text: 'hi' })).status, 404)
  assert.equal(s.said.length, 0)
  const db = s.db; ensureChat(db, '3'); setChat(db, '3', { handed_off: 1 })
  const bad = dashboard({ db, say: async () => false, password: 'pw', now: () => NOW })
  const server = http.createServer((q, r) => bad(q, r, new URL(q.url, 'http://x')))
  await new Promise((r) => server.listen(0, r)); t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  const ck = (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"password":"pw"}' })).headers.get('set-cookie').split(';')[0]
  const f = await fetch(base + '/api/reply', { method: 'POST', headers: { 'content-type': 'application/json', cookie: ck }, body: '{"phone":"3","text":"x"}' })
  assert.equal(f.status, 502)
  assert.equal(getChat(db, '3').handed_off, 1)
})

test('release returns the chat to the bot', async (t) => {
  const s = await boot(); t.after(s.close)
  ensureChat(s.db, '1'); setChat(s.db, '1', { handed_off: 1, human_until: NOW + 999 })
  const cookie = await s.login()
  assert.equal((await s.call('/api/release', { method: 'POST', cookie, body: { phone: '1' } })).status, 200)
  const c = getChat(s.db, '1'); assert.equal(c.handed_off, 0); assert.equal(c.human_until, 0)
  assert.equal((await s.call('/api/release', { method: 'POST', cookie, body: { phone: '404' } })).status, 404)
})

const addOrder = (db, o = {}) => Number(db.prepare(`INSERT INTO orders(phone, items, name, customer_phone, wilaya_n, wilaya, address, delivery, fee, total, status, created_at, confirmed_at)
  VALUES (?, ?, ?, ?, 16, 'الجزائر', 'x', ?, 600, ?, ?, ?, ?)`).run(o.phone ?? '1', JSON.stringify(o.items ?? [{ id: 'p1', name: 'قميص', variant: 'L', qty: 2, unit: 2000, sum: 4000 }]),
  o.name ?? 'سمير', '0555', o.delivery ?? 'home', o.total ?? 4600, o.status ?? 'confirmed', o.at ?? NOW, o.confirmedAt === undefined ? (o.at ?? NOW) : o.confirmedAt).lastInsertRowid)

test('orders: confirmed first newest first, then shipped; drafts and old closed ones hidden, old open ones kept; items parsed', async (t) => {
  const s = await boot(); t.after(s.close)
  ensureChat(s.db, '1')
  const sh = addOrder(s.db, { status: 'shipped', at: NOW - 1000 })
  const c1 = addOrder(s.db, { at: NOW - 5000 }), c2 = addOrder(s.db, { at: NOW - 2000 })
  addOrder(s.db, { status: 'draft', confirmedAt: null })
  const old = addOrder(s.db, { status: 'confirmed', at: NOW - 31 * DAY }) // still to ship: stays visible
  addOrder(s.db, { status: 'delivered', at: NOW - 31 * DAY }) // closed and old: hidden
  const d = addOrder(s.db, { status: 'delivered', at: NOW - 10 })
  const cookie = await s.login()
  assert.equal((await s.call('/api/orders')).status, 401)
  const { orders } = await (await s.call('/api/orders', { cookie })).json()
  assert.deepEqual(orders.map((o) => o.id), [c2, c1, old, sh, d])
  assert.deepEqual(orders[0].items, [{ id: 'p1', name: 'قميص', variant: 'L', qty: 2, unit: 2000, sum: 4000 }])
  assert.equal(orders[0].total, 4600); assert.equal(orders[0].delivery, 'home')
})

test('order status: only allowed moves, everything else is 400/404', async (t) => {
  const s = await boot(); t.after(s.close)
  ensureChat(s.db, '1')
  const cookie = await s.login()
  const move = (id, status) => s.call('/api/order', { method: 'POST', cookie, body: { id, status } })
  const st = (id) => s.db.prepare('SELECT status FROM orders WHERE id = ?').get(id).status
  const a = addOrder(s.db)
  assert.equal((await move(a, 'delivered')).status, 400, 'confirmed cannot skip shipping')
  assert.equal((await move(a, 'returned')).status, 400)
  assert.equal((await move(a, 'bogus')).status, 400)
  assert.equal((await move(a, 'shipped')).status, 200); assert.equal(st(a), 'shipped')
  assert.equal((await move(a, 'confirmed')).status, 400)
  assert.equal((await move(a, 'delivered')).status, 200); assert.equal(st(a), 'delivered')
  assert.equal((await move(a, 'returned')).status, 400, 'delivered is final')
  const b = addOrder(s.db); assert.equal((await move(b, 'cancelled')).status, 200)
  const c = addOrder(s.db, { status: 'shipped' }); assert.equal((await move(c, 'returned')).status, 200)
  const d = addOrder(s.db, { status: 'shipped' }); assert.equal((await move(d, 'cancelled')).status, 200)
  const dr = addOrder(s.db, { status: 'draft', confirmedAt: null }); assert.equal((await move(dr, 'shipped')).status, 400)
  assert.equal((await move(999, 'shipped')).status, 404)
  assert.equal((await s.call('/api/order', { method: 'POST', cookie, body: { id: '1', status: 'shipped' } })).status, 400)
  assert.equal((await s.call('/api/order', { method: 'POST', body: { id: a, status: 'shipped' } })).status, 401)
  assert.equal((await s.call('/api/enrollment', { method: 'POST', cookie, body: { id: 1, paid: true } })).status, 404, 'enrollment api is gone')
})

test('state: waiting list, toShip and the five numbers with Algeria-day boundaries', async (t) => {
  const s = await boot(); t.after(s.close)
  const { db } = s
  const mk = (phone, name, createdAt) => { ensureChat(db, phone, name); db.prepare('UPDATE chats SET created_at = ? WHERE phone = ?').run(createdAt, phone) }
  mk('a', 'علي', ALGIERS_MIDNIGHT + 1)            // today
  mk('b', null, ALGIERS_MIDNIGHT - 1)             // yesterday Algeria (still 23:59 UTC+1) -> week only
  mk('c', 'قديم', ALGIERS_MIDNIGHT - 6 * DAY - 1) // outside the 7 days
  addOrder(db, { phone: 'a', status: 'delivered', total: 4000, confirmedAt: ALGIERS_MIDNIGHT + 5 })
  addOrder(db, { phone: 'a', status: 'shipped', total: 1111, confirmedAt: ALGIERS_MIDNIGHT + 6 })
  addOrder(db, { phone: 'a', status: 'confirmed', total: 2222, confirmedAt: ALGIERS_MIDNIGHT + 7 })
  addOrder(db, { phone: 'b', status: 'delivered', total: 3000, confirmedAt: ALGIERS_MIDNIGHT - 5 })
  addOrder(db, { phone: 'b', status: 'cancelled', total: 500, confirmedAt: ALGIERS_MIDNIGHT - 6 })
  addOrder(db, { phone: 'c', status: 'delivered', total: 9999, confirmedAt: ALGIERS_MIDNIGHT - 7 * DAY })
  addOrder(db, { phone: 'c', status: 'draft', total: 777, confirmedAt: null })
  setChat(db, 'a', { handed_off: 1, handoff_reason: 'غضب' }); setChat(db, 'b', { handed_off: 1, handoff_reason: 'سؤال' })
  addMessage(db, { phone: 'a', role: 'student', text: 'x'.repeat(200), at: NOW - 1000 })
  addMessage(db, { phone: 'b', role: 'student', text: 'قديمة', at: NOW - 5000 })
  const cookie = await s.login()
  const st = await (await s.call('/api/state', { cookie })).json()
  assert.deepEqual(st.waiting.map((w) => w.phone), ['a', 'b'])
  assert.equal(st.waiting[0].last.length, 120); assert.equal(st.waiting[0].reason, 'غضب'); assert.equal(st.waiting[0].name, 'علي'); assert.equal(st.waiting[0].at, NOW - 1000)
  assert.deepEqual(st.numbers.today, { conversations: 1, confirmed: 3, shipped: 2, delivered: 1, amount: 4000,
    statuses: { confirmed: 1, shipped: 1, delivered: 1, returned: 0, cancelled: 0 } })
  assert.deepEqual(st.numbers.week, { conversations: 2, confirmed: 5, shipped: 3, delivered: 2, amount: 7000,
    statuses: { confirmed: 1, shipped: 1, delivered: 2, returned: 0, cancelled: 1 } }) // the ring: confirmed orders of the period by their status now
  assert.equal(st.toShip, 1)
  assert.equal(st.upcoming, undefined)
  // the chart: orders confirmed per Algeria day, the last 7 days oldest first
  assert.deepEqual(st.days.map((d) => d.orders), [0, 0, 0, 0, 0, 2, 3])
  assert.deepEqual([st.days[0].day, st.days[6].day], ['2026-10-26', '2026-11-01'])
})

test('chat: messages oldest first with status, chat row and orders', async (t) => {
  const s = await boot(); t.after(s.close)
  ensureChat(s.db, '1', 'ن')
  addMessage(s.db, { phone: '1', role: 'bot', text: 'ثاني', at: 20, status: 'failed' })
  addMessage(s.db, { phone: '1', role: 'student', text: 'أول', at: 10 })
  addOrder(s.db, { phone: '1' }); addOrder(s.db, { phone: '2' })
  const cookie = await s.login()
  const c = await (await s.call('/api/chat?phone=1', { cookie })).json()
  assert.deepEqual(c.messages.map((m) => [m.role, m.text, m.status]), [['student', 'أول', null], ['bot', 'ثاني', 'failed']])
  assert.equal(c.chat.name, 'ن'); assert.deepEqual(c.orders.map((o) => o.phone), ['1'])
  assert.equal((await s.call('/api/chat?phone=zz', { cookie })).status, 404)
})

test('reasonLabel: internal codes and English text never reach the screen', async () => {
  const { reasonLabel } = await import('../src/dashboard.js')
  assert.equal(reasonLabel('guard:number'), 'رد فيه معلومة ليست في البطاقة')
  assert.equal(reasonLabel('customer asked for a human'), 'سبب آخر، راجع المحادثة')
  assert.equal(reasonLabel('الطالب يطلب إنساناً'), 'الطالب يطلب إنساناً')
})
