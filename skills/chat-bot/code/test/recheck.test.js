// Before shipping, the bot asks the customer once more — fewer refusals at the door (cash on delivery).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, ensureChat, addMessage } from '../src/db.js'
import { initJobs, recheckAt, dueRechecks, startJobs, silentAt } from '../src/jobs.js'
import { orderTools, recheckText, recheckPending } from '../src/shop.js'
import { nowBlock, TOOLS } from '../src/brain.js'

const card = JSON.parse(readFileSync(new URL('./card.sample.json', import.meta.url), 'utf8'))
const H = 3_600_000
const at = (s) => Date.parse(`${s.replace(' ', 'T')}:00Z`) - H // Algeria local
const P = '213555700001'
const ITEMS = JSON.stringify([{ id: 'p2', name: 'ساعة كلاسيك', variant: { 'اللون': 'أسود' }, qty: 2, unit: 4800, sum: 9600 }])
function setup() {
  const db = openDb(); initJobs(db); ensureChat(db, P)
  const order = (t, status = 'confirmed', phone = P) => Number(db.prepare(`INSERT INTO orders(phone, items, name, customer_phone, wilaya_n, wilaya, address, delivery, fee, total, status, created_at, confirmed_at)
    VALUES (?, ?, 'سمير', '0555123456', 16, 'الجزائر', 'حي النصر', 'home', 400, 10000, ?, ?, ?)`).run(phone, ITEMS, status, at(t), at(t)).lastInsertRowid)
  return { db, order }
}
const recheck = (db, id) => db.prepare('SELECT recheck, status FROM orders WHERE id = ?').get(id)

test('recheckAt: the next 10:00 at least 6 h after the order; Instagram / Messenger: inside Meta\'s 24 h', () => {
  assert.equal(recheckAt({ confirmed_at: at('2026-11-01 14:00'), phone: P }), at('2026-11-02 10:00'))
  assert.equal(recheckAt({ confirmed_at: at('2026-11-01 01:00'), phone: P }), at('2026-11-01 10:00'))
  assert.equal(recheckAt({ confirmed_at: at('2026-11-01 23:00'), phone: P }), at('2026-11-02 10:00'))
  // ordered 08:00 on Instagram: 10:00 next day is 26 h later — asked that evening instead
  assert.equal(recheckAt({ confirmed_at: at('2026-11-01 08:00'), phone: 'ig:7001' }, at('2026-11-01 08:00')), at('2026-11-01 21:30'))
  assert.equal(recheckAt({ confirmed_at: at('2026-11-01 14:00'), phone: 'ig:7001' }, at('2026-11-01 14:00')), at('2026-11-02 10:00'))
})

test('dueRechecks: confirmed orders whose time came, once; not shipped or already asked ones, not at night', () => {
  const { db, order } = setup()
  ensureChat(db, '213555700002')
  const a = order('2026-11-01 14:00'), b = order('2026-11-01 15:00', 'shipped'), c = order('2026-11-02 09:00', 'confirmed', '213555700002')
  assert.deepEqual(dueRechecks(db, at('2026-11-02 09:59')), [])
  assert.deepEqual(dueRechecks(db, at('2026-11-02 10:00')).map((o) => o.id), [a])
  assert.deepEqual(dueRechecks(db, at('2026-11-02 10:01')), [], 'claimed once')
  assert.equal(recheck(db, a).recheck, 'asked')
  assert.equal(recheck(db, b).recheck, null)
  assert.deepEqual(dueRechecks(db, at('2026-11-03 23:00')), [], 'quiet hours')
  assert.deepEqual(dueRechecks(db, at('2026-11-03 10:00')).map((o) => o.id), [c])
})

test('runner: asks through the code\'s own message; no answer in 8 h = «silent»; a failed send = «failed» (the owner phones)', async () => {
  const { db, order } = setup()
  const a = order('2026-11-01 14:00'), sent = []
  let clock = at('2026-11-02 10:00'), ok = true
  const stop = startJobs({ db, writeAndSend: async () => true, recheckSend: async (o) => (sent.push(o.id), ok), every: 5, now: () => clock, backupDir: mkdtempSync(join(tmpdir(), 'rb-')) })
  await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual(sent, [a])
  clock = at('2026-11-02 18:01'); await new Promise((r) => setTimeout(r, 30))
  assert.equal(recheck(db, a).recheck, 'silent')
  ok = false; const b = order('2026-11-02 14:00'); clock = at('2026-11-03 10:00'); await new Promise((r) => setTimeout(r, 30)); stop()
  assert.equal(recheck(db, b).recheck, 'failed')
})

test('recheckText: the order\'s own number, items and total, in the customer\'s letters', () => {
  const o = { id: 7, items: ITEMS, total: 10000 }
  assert.match(recheckText(o), /طلبيتك رقم 7 \(ساعة كلاسيك أسود × 2\) بـ 10000 دج.*«نعم»/)
  assert.match(recheckText(o, true), /^[\x00-\x7f°\u{1F31E}]+$/u)
  assert.match(recheckText(o, true), /N°7.*10000 DA/)
})

test('recheck_order: yes keeps it for shipping; no cancels it and tells the owner; nothing waiting = error', async () => {
  const { db, order } = setup(), alerts = []
  const run = (input) => orderTools({ db, card, phone: P, alertAgent: async (t) => { alerts.push(t) } })('recheck_order', input)
  assert.equal((await run({ answer: 'yes' })).ok, false)
  const a = order('2026-11-01 14:00'); db.prepare("UPDATE orders SET recheck = 'asked' WHERE id = ?").run(a)
  assert.match(recheckPending(db, P), new RegExp(`#${a}.*10000 دج`))
  assert.equal((await run({ answer: 'yes' })).ok, true)
  assert.deepEqual({ ...recheck(db, a) }, { recheck: 'yes', status: 'confirmed' })
  assert.equal(recheckPending(db, P), null)
  const b = order('2026-11-01 15:00'); db.prepare("UPDATE orders SET recheck = 'silent' WHERE id = ?").run(b)
  assert.equal((await run({ answer: 'no' })).ok, true)
  assert.deepEqual({ ...recheck(db, b) }, { recheck: 'no', status: 'cancelled' })
  assert.match(alerts[0], new RegExp(`ألغى الطلبية #${b}`))
  assert.equal((await run({ answer: 'maybe' })).ok, false)
})

test('brain: the waiting order is in the per-turn block with how to answer; recheck_order is a tool', () => {
  const b = nowBlock(new Date(at('2026-11-02 10:30')), 'arabic', true, null, '#7: ساعة كلاسيك أسود × 2، 10000 دج')
  assert.match(b, /تنتظر تأكيد الشحن[\s\S]*#7[\s\S]*recheck_order/)
  assert.ok(!/recheck_order/.test(nowBlock(new Date(at('2026-11-02 10:30')), 'arabic', true)))
  assert.deepEqual(TOOLS.find((t) => t.name === 'recheck_order').input_schema.properties.answer.enum, ['yes', 'no'])
})

// ═══ review fixes ═══
test('deploy: orders confirmed before this feature are never asked (no burst of old questions)', () => {
  const path = join(mkdtempSync(join(tmpdir(), "rc-")), "old.db")
  const old = openDb(path)
  old.exec('ALTER TABLE orders DROP COLUMN recheck_at; ALTER TABLE orders DROP COLUMN recheck')
  old.prepare("INSERT INTO orders(phone, items, status, total, created_at, confirmed_at) VALUES ('213555700001', '[]', 'confirmed', 1000, 1, 1)").run()
  old.close()
  const db = openDb(path); initJobs(db)
  assert.equal(db.prepare('SELECT recheck FROM orders').get().recheck, 'old')
  assert.deepEqual(dueRechecks(db, at('2026-11-02 10:00')), [])
})

test('silentAt: 8 h, but never «no answer» during the night or the early morning — he has not seen it yet', () => {
  assert.equal(silentAt(at('2026-11-02 10:00')), at('2026-11-02 18:00'))
  assert.equal(silentAt(at('2026-11-02 21:30')), at('2026-11-03 12:00'))
  assert.equal(silentAt(at('2026-11-02 14:00')), at('2026-11-03 12:00'))
})

test('two confirmed orders: one question at a time, so a «لا» cannot cancel the wrong one', () => {
  const { db, order } = setup()
  const a = order('2026-11-01 14:00'), b = order('2026-11-01 15:00')
  assert.deepEqual(dueRechecks(db, at('2026-11-02 10:00')).map((o) => o.id), [a])
  assert.deepEqual(dueRechecks(db, at('2026-11-02 10:05')), [])
  db.prepare("UPDATE orders SET recheck = 'yes' WHERE id = ?").run(a)
  assert.deepEqual(dueRechecks(db, at('2026-11-02 10:10')).map((o) => o.id), [b])
})

test('a question that never reached him is not waiting for his answer; one failing send does not strand the others', async () => {
  const { db, order } = setup()
  const a = order('2026-11-01 14:00'); db.prepare("UPDATE orders SET recheck = 'failed' WHERE id = ?").run(a)
  assert.equal(recheckPending(db, P), null)
  ensureChat(db, '213555700002'); ensureChat(db, '213555700003')
  const b = order('2026-11-01 14:00', 'confirmed', '213555700002'), c = order('2026-11-01 14:00', 'confirmed', '213555700003')
  const stop = startJobs({ db, writeAndSend: async () => true, recheckSend: async (o) => { if (o.id === b) throw new Error('bad'); return true }, every: 5, now: () => at('2026-11-02 10:00'), backupDir: mkdtempSync(join(tmpdir(), 'rb-')) })
  await new Promise((r) => setTimeout(r, 30)); stop()
  assert.equal(recheck(db, b).recheck, 'failed')
  assert.equal(recheck(db, c).recheck, 'asked')
})
