import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, ensureChat, getChat, setChat, addMessage, claimEcho, history, saveDraft, latestDraft, confirmOrder, addCost, costOn, logGuard, firstTime } from '../src/db.js'

const P = '213555000011'
const fresh = () => openDb()

test('ensureChat inserts once and fills a missing name', () => {
  const db = fresh()
  ensureChat(db, P, null)
  assert.equal(getChat(db, P).stage, 'new')
  ensureChat(db, P, 'Student')
  ensureChat(db, P, 'Other')
  assert.equal(getChat(db, P).name, 'Student')
  assert.equal(getChat(db, 'nope'), undefined)
})

test('setChat updates whitelisted columns, rejects unknown', () => {
  const db = fresh()
  ensureChat(db, P, 'S')
  setChat(db, P, { stage: 'price', human_until: 5 })
  assert.deepEqual([getChat(db, P).stage, getChat(db, P).human_until], ['price', 5])
  assert.throws(() => setChat(db, P, { evil: 1 }), /unknown/)
  assert.throws(() => setChat(db, P, { 'stage=1;--': 1 }), /unknown/)
})

test('addMessage: duplicate waId returns null', () => {
  const db = fresh()
  ensureChat(db, P, 'S')
  const id = addMessage(db, { waId: 'W1', phone: P, role: 'student', text: 'a' })
  assert.equal(typeof id, 'number')
  assert.equal(addMessage(db, { waId: 'W1', phone: P, role: 'student', text: 'a' }), null)
  assert.equal(typeof addMessage(db, { phone: P, role: 'bot', text: 'b' }), 'number')
  assert.equal(typeof addMessage(db, { phone: P, role: 'bot', text: 'c' }), 'number') // null waId never collides
})

test('claimEcho: true once per row, then false', () => {
  const db = fresh()
  const now = 1_000_000_000
  addMessage(db, { phone: P, role: 'bot', text: 'hello', at: now - 1000 })
  assert.equal(claimEcho(db, { phone: P, text: 'hello', waId: 'E1', now }), true)
  assert.equal(claimEcho(db, { phone: P, text: 'hello', waId: 'E2', now }), false)
})

test('claimEcho: two identical sends are claimed one each, newest first', () => {
  const db = fresh()
  const now = 1_000_000_000
  addMessage(db, { phone: P, role: 'bot', text: 'x', at: now - 2000 })
  addMessage(db, { phone: P, role: 'human', text: 'x', at: now - 1000 })
  assert.equal(claimEcho(db, { phone: P, text: 'x', waId: 'E1', now }), true)
  assert.equal(claimEcho(db, { phone: P, text: 'x', waId: 'E2', now }), true)
  assert.equal(claimEcho(db, { phone: P, text: 'x', waId: 'E3', now }), false)
})

test('claimEcho: false after 10 minutes, different text, other chat, student rows', () => {
  const db = fresh()
  const now = 1_000_000_000
  addMessage(db, { phone: P, role: 'bot', text: 'old', at: now - 10 * 60_000 - 1 })
  addMessage(db, { phone: P, role: 'bot', text: 'real', at: now - 1000 })
  addMessage(db, { phone: P, role: 'student', text: 'stu', at: now - 1000 })
  assert.equal(claimEcho(db, { phone: P, text: 'old', waId: 'E1', now }), false)
  assert.equal(claimEcho(db, { phone: P, text: 'different', waId: 'E2', now }), false)
  assert.equal(claimEcho(db, { phone: '213555000012', text: 'real', waId: 'E3', now }), false)
  assert.equal(claimEcho(db, { phone: P, text: 'stu', waId: 'E4', now }), false)
})

test('history: oldest to newest, limited, skips null text', () => {
  const db = fresh()
  for (let i = 1; i <= 5; i++) addMessage(db, { phone: P, role: i % 2 ? 'student' : 'bot', text: `m${i}`, at: i * 10 })
  addMessage(db, { phone: P, role: 'student', text: null, at: 60 })
  assert.deepEqual(history(db, P, 3).map((m) => m.text), ['m3', 'm4', 'm5'])
  assert.deepEqual(history(db, P).map((m) => m.text), ['m1', 'm2', 'm3', 'm4', 'm5'])
  assert.deepEqual(Object.keys(history(db, P, 1)[0]), ['role', 'text', 'at'])
})

const DRAFT = { phone: P, items: [{ id: 'p1', qty: 1 }], name: 'أحمد', customerPhone: '0555987654', wilayaN: 16, wilaya: 'الجزائر', address: 'شارع ديدوش 12', delivery: 'home', fee: 400, total: 3900 }
test('orders: one draft per chat (a new draft replaces the old one), latestDraft reads it back', () => {
  const db = fresh()
  ensureChat(db, P, 'S')
  const a = saveDraft(db, DRAFT)
  const b = saveDraft(db, { ...DRAFT, total: 4300, fee: 800 })
  assert.equal(a, b) // same row, overwritten
  assert.equal(db.prepare("SELECT COUNT(*) n FROM orders WHERE phone = ?").get(P).n, 1)
  const d = latestDraft(db, P)
  assert.deepEqual([d.id, d.status, d.total, d.fee, d.name, d.customer_phone, d.wilaya_n, d.wilaya, d.address, d.delivery], [b, 'draft', 4300, 800, 'أحمد', '0555987654', 16, 'الجزائر', 'شارع ديدوش 12', 'home'])
  assert.deepEqual(JSON.parse(d.items), DRAFT.items)
  assert.equal(latestDraft(db, '213555000012'), undefined)
})
test('orders: confirmOrder sets status and confirmed_at; later drafts do not touch confirmed orders', () => {
  const db = fresh()
  ensureChat(db, P, 'S')
  const id = saveDraft(db, DRAFT)
  assert.equal(confirmOrder(db, id, 123), true)
  const row = db.prepare('SELECT status, confirmed_at FROM orders WHERE id = ?').get(id)
  assert.deepEqual({ ...row }, { status: 'confirmed', confirmed_at: 123 })
  assert.equal(latestDraft(db, P), undefined) // no draft left
  assert.equal(confirmOrder(db, id, 124), false) // already confirmed
  const next = saveDraft(db, DRAFT)
  assert.notEqual(next, id)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM orders WHERE phone = ?").get(P).n, 2)
})

test('costs accumulate per day', () => {
  const db = fresh()
  addCost(db, 0.25, '2026-11-01')
  addCost(db, 0.5, '2026-11-01')
  addCost(db, 1, '2026-11-02')
  assert.equal(costOn(db, '2026-11-01'), 0.75)
  assert.equal(costOn(db, '2026-11-02'), 1)
  assert.equal(costOn(db, '2026-11-03'), 0)
})

test('logGuard writes a row', () => {
  const db = fresh()
  logGuard(db, { phone: P, guard: 'price', action: 'rewrite' })
  const r = db.prepare('SELECT guard, action FROM guard_log').get()
  assert.deepEqual({ ...r }, { guard: 'price', action: 'rewrite' })
})

test('history: pending and failed bot bubbles are left out', () => {
  const db = openDb()
  addMessage(db, { phone: P, role: 'student', text: 'سلام', at: 1 })
  addMessage(db, { phone: P, role: 'bot', text: 'sent', at: 2, status: 'sent' })
  addMessage(db, { phone: P, role: 'bot', text: 'failed', at: 3, status: 'failed' })
  addMessage(db, { phone: P, role: 'bot', text: 'pending', at: 4, status: 'pending' })
  assert.deepEqual(history(db, P).map((r) => r.text), ['سلام', 'sent'])
})

test('claimEcho: the echo of a send that timed out proves it went out (no second reply)', () => {
  const db = openDb(), now = Date.now()
  ensureChat(db, P)
  const id = addMessage(db, { phone: P, role: 'bot', text: 'مرحبا', status: 'failed', at: now })
  assert.equal(claimEcho(db, { phone: P, text: 'مرحبا', waId: 'E1', now }), true)
  assert.equal(db.prepare('SELECT status FROM messages WHERE id = ?').get(id).status, 'sent')
})

test('firstTime: an alert key goes out once, even after a restart (it lives in the database)', () => {
  const db = openDb()
  assert.equal(firstTime(db, 'balance:2026-11-01'), true)
  assert.equal(firstTime(db, 'balance:2026-11-01'), false)
  assert.equal(firstTime(db, 'balance:2026-11-02'), true)
})
