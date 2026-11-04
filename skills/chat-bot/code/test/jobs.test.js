import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, ensureChat, getChat, setChat, addMessage, logGuard } from '../src/db.js'
import {
  afterBotReply, afterStudent, backup, dueFollowUps, initJobs, retention, startJobs, promiseAt, remindAt, optedOut,
} from '../src/jobs.js'

const H = 3_600_000, DAY = 24 * H
// Algeria local 'YYYY-MM-DD HH:MM' => epoch ms (UTC+1)
const at = (s) => Date.parse(`${s.replace(' ', 'T')}:00Z`) - H
const P = '213555000001'
const setup = (stage) => {
  const db = openDb(); initJobs(db); ensureChat(db, P, 'x')
  if (stage) setChat(db, P, { stage })
  return db
}
const bot = (db, t, text = 'رد') => addMessage(db, { phone: P, role: 'bot', text, at: t })
const stu = (db, t, text = 'سلام') => addMessage(db, { phone: P, role: 'student', text, at: t })
const chat = (db) => getChat(db, P)

test('initJobs is idempotent', () => {
  const db = openDb(); initJobs(db); initJobs(db)
  assert.ok(db.prepare('PRAGMA table_info(chats)').all().some((c) => c.name === 'follow_kind'))
  assert.ok(!db.prepare('PRAGMA table_info(enrollments)').all().some((c) => c.name === 'asked_at'), 'no trial columns')
})

test('afterBotReply: +24h; not when handed off, ordered or round >= 2', () => {
  const db = setup(), t = at('2026-11-02 12:00')
  afterBotReply(db, P, t)
  assert.equal(chat(db).follow_at, t + DAY)
  setChat(db, P, { follow_at: null, follow_round: 2 }); afterBotReply(db, P, t)
  assert.equal(chat(db).follow_at, null)
  setChat(db, P, { follow_round: 0, handed_off: 1 }); afterBotReply(db, P, t)
  assert.equal(chat(db).follow_at, null)
  setChat(db, P, { handed_off: 0, stage: 'ordered' }); afterBotReply(db, P, t)
  assert.equal(chat(db).follow_at, null)
})

test('afterStudent: new content resets round, courtesy keeps it', () => {
  const db = setup(), t = at('2026-11-02 12:00')
  setChat(db, P, { follow_round: 1, follow_at: t })
  afterStudent(db, P, 'شكرا', t)
  assert.deepEqual([chat(db).follow_round, chat(db).follow_at], [1, null])
  afterStudent(db, P, 'merci', t); afterStudent(db, P, 'صحيت', t); afterStudent(db, P, 'ok', t)
  assert.equal(chat(db).follow_round, 1)
  afterStudent(db, P, 'شحال سعر الإنجليزية؟', t)
  assert.equal(chat(db).follow_round, 0)
  setChat(db, P, { follow_round: 1 }); afterStudent(db, P, 'نحب نسجل في الفرنسية', t)
  assert.equal(chat(db).follow_round, 0)
})

test('afterStudent: opt out stops everything (arabic, latin, french)', () => {
  for (const txt of ['ما نحبش', 'لا شكرا ما يهمنيش', 'non merci', 'matb3atlich']) {
    const db = setup(); setChat(db, P, { follow_at: 5 })
    afterStudent(db, P, txt, 1)
    assert.deepEqual([chat(db).follow_at, chat(db).follow_round], [null, 99], txt)
    afterBotReply(db, P, 1)
    assert.equal(chat(db).follow_at, null)
    afterStudent(db, P, 'شكرا', 1)
    assert.equal(chat(db).follow_round, 99)
  }
})

test('money objection: exactly one follow-up after 30 days, bot reply does not move it', async () => {
  for (const txt of ['ما عنديش الدراهم', 'ما عنديش المال', 'ma3andich drahem']) {
    const db = setup(), t = at('2026-11-02 12:00')
    stu(db, t, txt); afterStudent(db, P, txt, t)
    bot(db, t + 1000); afterBotReply(db, P, t + 1000)
    assert.equal(chat(db).follow_at, t + 30 * DAY, txt)
    assert.deepEqual(dueFollowUps(db, t + 29 * DAY), [])
    afterStudent(db, P, 'شكرا', t + 2000) // courtesy keeps the date
    assert.equal(chat(db).follow_at, t + 30 * DAY)
    const sent = []
    const due = dueFollowUps(db, t + 30 * DAY)
    assert.deepEqual(due, [{ phone: P, round: 1, kind: 'money' }])
    const stop = startJobs({ db, writeAndSend: async (p, n) => { sent.push(n); return true }, every: 5, now: () => t + 30 * DAY })
    stop()
  }
})

test('money message goes out once through the runner and then stops', async () => {
  const db = setup(), t = at('2026-11-02 12:00'), sent = []
  stu(db, t, 'ma3andich drahem'); afterStudent(db, P, 'ma3andich drahem', t); bot(db, t + 1); afterBotReply(db, P, t + 1)
  let clock = t + 30 * DAY
  const stop = startJobs({ db, writeAndSend: async (p, n) => (sent.push(n), true), every: 5, now: () => clock, backupDir: mkdtempSync(join(tmpdir(), 'b-')) })
  await new Promise((r) => setTimeout(r, 40)); clock += 40 * DAY; await new Promise((r) => setTimeout(r, 40)); stop()
  assert.equal(sent.length, 1)
  assert.match(sent[0], /شهر/)
  assert.deepEqual([chat(db).follow_round, chat(db).follow_at], [2, null])
})

test('normal rounds: 24h check-in, then +48h last message, then stop', async () => {
  const db = setup(), t = at('2026-11-02 10:00'), sent = []
  bot(db, t); afterBotReply(db, P, t)
  let clock = t + DAY
  const stop = startJobs({ db, writeAndSend: async (p, n) => (sent.push(n), true), every: 5, now: () => clock, backupDir: mkdtempSync(join(tmpdir(), 'b-')) })
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(sent.length, 1); assert.match(sent[0], /مرّ يوم/)
  assert.deepEqual([chat(db).follow_round, chat(db).follow_at], [1, clock + 2 * DAY])
  clock += 2 * DAY
  await new Promise((r) => setTimeout(r, 30)); stop()
  assert.equal(sent.length, 2); assert.match(sent[1], /آخر رسالة/)
  assert.deepEqual([chat(db).follow_round, chat(db).follow_at], [2, null])
})

test('dueFollowUps: filters (handoff, human typing, last role, ordered) and no double claim', () => {
  const db = setup(), t = at('2026-11-02 12:00')
  setChat(db, P, { follow_at: t })
  stu(db, t - 10)
  assert.deepEqual(dueFollowUps(db, t), [], 'last is student')
  bot(db, t - 5)
  setChat(db, P, { human_until: t + 1 }); assert.deepEqual(dueFollowUps(db, t), [])
  setChat(db, P, { human_until: 0, handed_off: 1 }); assert.deepEqual(dueFollowUps(db, t), [])
  setChat(db, P, { handed_off: 0, stage: 'ordered' }); assert.deepEqual(dueFollowUps(db, t), [])
  setChat(db, P, { stage: 'new' })
  assert.equal(dueFollowUps(db, t - 1).length, 0, 'not yet due')
  assert.equal(dueFollowUps(db, t).length, 1)
  assert.equal(dueFollowUps(db, t).length, 0, 'second tick gets nothing')
  assert.equal(chat(db).follow_at, null)
})

test('quiet hours: due at night waits for 09:00 and is not claimed meanwhile', () => {
  const db = setup()
  setChat(db, P, { follow_at: at('2026-11-02 21:30') }); bot(db, at('2026-11-01 21:30'))
  assert.deepEqual(dueFollowUps(db, at('2026-11-02 22:00')), [])
  assert.deepEqual(dueFollowUps(db, at('2026-11-03 08:59')), [])
  assert.equal(dueFollowUps(db, at('2026-11-03 09:00')).length, 1)
})

const order = (db, status) => db.prepare(`INSERT INTO orders(phone, items, status, total, created_at, confirmed_at) VALUES (?, '[]', ?, 1000, 1, 1)`).run(P, status)

test('dueFollowUps: never for a chat with a confirmed, shipped or delivered order, even if stage is not ordered', () => {
  for (const status of ['confirmed', 'shipped', 'delivered']) {
    const db = setup(), t = at('2026-11-02 12:00')
    setChat(db, P, { follow_at: t }); bot(db, t - 5); order(db, status)
    assert.deepEqual(dueFollowUps(db, t), [], status)
  }
  for (const status of ['draft', 'cancelled', 'returned']) {
    const db = setup(), t = at('2026-11-02 12:00')
    setChat(db, P, { follow_at: t }); bot(db, t - 5); order(db, status)
    assert.equal(dueFollowUps(db, t).length, 1, `${status} does not block`)
  }
})

test('runner: an order confirmed between the two rounds stops the second follow-up', async () => {
  const db = setup(), t = at('2026-11-02 10:00'), sent = []
  bot(db, t); afterBotReply(db, P, t)
  let clock = t + DAY
  const stop = startJobs({ db, writeAndSend: async (p, n) => (sent.push(n), true), every: 5, now: () => clock, backupDir: mkdtempSync(join(tmpdir(), 'b-')) })
  await new Promise((r) => setTimeout(r, 30))
  order(db, 'confirmed'); setChat(db, P, { stage: 'ordered' })
  clock += 2 * DAY; await new Promise((r) => setTimeout(r, 30)); stop()
  assert.equal(sent.length, 1)
})

test('runner: a failing follow-up does not stop backup, and errors carry no phone', async () => {
  const db = setup(), errs = [], dir = mkdtempSync(join(tmpdir(), 'b-'))
  const orig = console.error; console.error = (...a) => errs.push(a.join(' '))
  setChat(db, P, { follow_at: at('2026-11-02 20:00') }); bot(db, at('2026-11-01 20:00'))
  const stop = startJobs({ db, writeAndSend: async () => { throw new Error('boom') }, every: 5, now: () => at('2026-11-02 20:30'), backupDir: dir })
  await new Promise((r) => setTimeout(r, 40)); stop(); console.error = orig
  assert.ok(errs.length >= 1 && errs.every((e) => !e.includes(P)))
  assert.deepEqual(readdirSync(dir), ['bot-2026-11-02.db'])
})

test('retention: deletes messages and guard_log older than 60 days, returns counts', () => {
  const db = setup(), t = at('2026-11-02 12:00')
  stu(db, t - 61 * DAY); stu(db, t - 70 * DAY); stu(db, t - 59 * DAY); bot(db, t)
  logGuard(db, { phone: P, guard: 'number', action: 'retry', at: t - 90 * DAY }); logGuard(db, { phone: P, guard: 'number', action: 'retry', at: t })
  assert.deepEqual(retention(db, t), { messages: 2, guard_log: 1, ai_calls: 0 })
  assert.equal(db.prepare('SELECT COUNT(*) n FROM messages').get().n, 2)
  assert.deepEqual(retention(db, t), { messages: 0, guard_log: 0, ai_calls: 0 })
})

test('backup: writes a dated copy once, keeps the newest 7', () => {
  const db = setup(), dir = join(mkdtempSync(join(tmpdir(), 'bk-')), 'nested')
  stu(db, 1)
  for (let d = 1; d <= 9; d++) backup(db, dir, at(`2026-11-0${d} 12:00`))
  const files = readdirSync(dir).sort()
  assert.equal(files.length, 7)
  assert.equal(files[0], 'bot-2026-11-03.db'); assert.equal(files.at(-1), 'bot-2026-11-09.db')
  writeFileSync(join(dir, 'bot-2026-11-09.db'), 'keep')
  backup(db, dir, at('2026-11-09 18:00')) // exists => skipped
  assert.equal(readdirSync(dir).length, 7)
})

test('runner: retention and backup run once per Algeria day', async () => {
  const db = setup(), dir = mkdtempSync(join(tmpdir(), 'bk-'))
  let clock = at('2026-11-02 03:00')
  const stop = startJobs({ db, writeAndSend: async () => true, every: 5, now: () => clock, backupDir: dir })
  await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual(readdirSync(dir), ['bot-2026-11-02.db'])
  clock = at('2026-11-03 03:00'); await new Promise((r) => setTimeout(r, 30)); stop()
  assert.deepEqual(readdirSync(dir).sort(), ['bot-2026-11-02.db', 'bot-2026-11-03.db'])
})

// third review (2026-11-01): ai_calls carries the student number, so it follows the 60-day rule too
test('retention also deletes old ai_calls rows', () => {
  const db = setup(), t = at('2026-11-02 12:00')
  db.prepare('INSERT INTO ai_calls(phone, at, kind, input, output, cache_read, cache_write, usd) VALUES (?, ?, ?, 0, 0, 0, 0, 0)').run(P, t - 61 * DAY, 'reply')
  db.prepare('INSERT INTO ai_calls(phone, at, kind, input, output, cache_read, cache_write, usd) VALUES (?, ?, ?, 0, 0, 0, 0, 0)').run(P, t, 'reply')
  retention(db, t)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_calls').get().n, 1)
})

// ═══ «ما نحبش» about a colour is not a «stop writing to me» ═══
test('optedOut: a refusal alone (or with thanks) yes; a preference inside a sentence no', () => {
  for (const t of ['ما نحبش', 'لا شكرا', 'لا شكرا خويا بارك الله فيك', 'non merci', 'ma nhebch', 'ما تبعثوليش', 'ما نيش مهتم بصح شكرا', 'ما نحبش تبعثولي', 'ma nhebch les messages', 'non merci je ne veux pas de messages', 'stop sending me messages']) assert.equal(optedOut(t), true, t)
  for (const t of ['ما نحبش اللون الأحمر، عندكم الفضي؟', 'لا شكرا، شحال التوصيل لوهران؟', 'ma nhebch el k7al', 'ما نحتاجش جوج، واحدة برك']) assert.equal(optedOut(t), false, t)
})

// ═══ the customer gives a time («نشري بعد غدوة على 10») => the bot writes at that time ═══
test('promiseAt: days from today + hour in Algeria time; no hour = the hour he wrote at; 09:00–21:00; never in the past', () => {
  const now = at('2026-11-01 14:20') // Sunday
  assert.equal(promiseAt(now, 2, 10), at('2026-11-03 10:00'))
  assert.equal(promiseAt(now, 1, 18, 30), at('2026-11-02 18:30'))
  assert.equal(promiseAt(now, 2), at('2026-11-03 14:00'))
  assert.equal(promiseAt(at('2026-11-01 23:40'), 1), at('2026-11-02 21:00'))
  assert.equal(promiseAt(now, 1, 23), at('2026-11-02 21:00')) // no message at night
  assert.equal(promiseAt(now, 1, 7), at('2026-11-02 09:00'))
  assert.equal(promiseAt(now, 0, 17), at('2026-11-01 17:00'))
  for (const bad of [[0, 14], [0, 10], [0], [31, 10], [-1, 10], [1.5, 10], [1, 24], ['x', 10]]) assert.equal(promiseAt(now, ...bad), null, JSON.stringify(bad))
})

test('promise: kept through the bot reply, thanks and new questions before it; fires at its time, then one more after 48h', async () => {
  const db = setup(), t = at('2026-11-01 14:20'), when = at('2026-11-03 10:00'), sent = []
  stu(db, t, 'نخمم ونقولك بعد غدوة'); afterStudent(db, P, 'نخمم ونقولك بعد غدوة', t)
  assert.equal(remindAt(db, P, when), true)
  bot(db, t + 1); afterBotReply(db, P, t + 1)
  assert.deepEqual([chat(db).follow_at, chat(db).follow_kind], [when, 'promise'])
  afterStudent(db, P, 'شكرا', t + 2); afterStudent(db, P, 'شحال التوصيل لوهران؟', t + 3); bot(db, t + 4); afterBotReply(db, P, t + 4)
  assert.equal(chat(db).follow_at, when)
  let clock = when - 60_000
  const stop = startJobs({ db, writeAndSend: async (p, n) => (sent.push(n), true), every: 5, now: () => clock, backupDir: mkdtempSync(join(tmpdir(), 'b-')) })
  await new Promise((r) => setTimeout(r, 30)); assert.equal(sent.length, 0)
  clock = when; await new Promise((r) => setTimeout(r, 30))
  assert.equal(sent.length, 1); assert.match(sent[0], /وقت الرجوع له/)
  assert.deepEqual([chat(db).follow_round, chat(db).follow_at, chat(db).follow_kind], [1, when + 2 * DAY, null])
  clock += 2 * DAY; await new Promise((r) => setTimeout(r, 30)); stop()
  assert.equal(sent.length, 2); assert.match(sent[1], /آخر رسالة/)
})

test('promise: never for a customer who asked us to stop; a past promise does not survive new content', () => {
  const db = setup(), t = at('2026-11-01 14:20')
  afterStudent(db, P, 'ما تبعثوليش', t)
  assert.equal(remindAt(db, P, t + DAY), false)
  assert.equal(chat(db).follow_at, null)
  const db3 = setup('ordered')
  assert.equal(remindAt(db3, P, t + DAY), false, 'ordered: follow-ups never reach him, so no promise')
  const db2 = setup()
  remindAt(db2, P, t + DAY)
  afterStudent(db2, P, 'سلام، مازال عندكم الساعة؟', t + 2 * DAY)
  assert.deepEqual([db2.prepare('SELECT follow_kind k FROM chats').get().k], [null])
})

test('promise: a send that fails is tried again 30 min later (a plain nudge is not)', async () => {
  const db = setup(), when = at('2026-11-03 10:00')
  bot(db, when - DAY); remindAt(db, P, when)
  const stop = startJobs({ db, writeAndSend: async () => false, every: 5, now: () => when, backupDir: mkdtempSync(join(tmpdir(), 'b-')) })
  await new Promise((r) => setTimeout(r, 30)); stop()
  assert.deepEqual([chat(db).follow_at, chat(db).follow_kind], [when + 30 * 60_000, 'promise'])
})

// ═══ customers rarely give a time — «نخمم» alone => the bot comes back 6 hours later ═══
test('promiseAt: no day and no hour = 6 hours from now (at night the 09:00 quiet rule takes it to the morning); an hour alone = today if still ahead, else tomorrow', () => {
  const now = at('2026-11-01 14:20')
  assert.equal(promiseAt(now), now + 6 * H)
  assert.equal(promiseAt(now, null, null), now + 6 * H)
  assert.equal(promiseAt(now, null, 18), at('2026-11-01 18:00'))
  assert.equal(promiseAt(now, null, 10), at('2026-11-02 10:00'))
})

// ═══ Instagram / Messenger: Meta allows no message 24 h after the customer's last one ═══
test('meta chats: the day-one follow-up is 23 h (pulled back to 21:30 out of the night); none once 24 h passed', () => {
  const IG = 'ig:7001'
  const db = openDb(); initJobs(db); ensureChat(db, IG)
  afterBotReply(db, IG, at('2026-11-01 12:00'))
  assert.equal(getChat(db, IG).follow_at, at('2026-11-02 11:00'))
  afterBotReply(db, IG, at('2026-11-01 23:30'))
  assert.equal(getChat(db, IG).follow_at, at('2026-11-02 21:30'))
  afterBotReply(db, IG, at('2026-11-02 08:00'))
  assert.equal(getChat(db, IG).follow_at, at('2026-11-02 21:30'))
  // due, last word is the bot's — but the customer last wrote 25 h ago: Meta would refuse it
  addMessage(db, { phone: IG, role: 'student', text: 'سلام', at: at('2026-11-01 10:00') })
  addMessage(db, { phone: IG, role: 'bot', text: 'مرحبا', at: at('2026-11-01 10:01') })
  setChat(db, IG, { follow_at: at('2026-11-02 09:00') })
  assert.deepEqual(dueFollowUps(db, at('2026-11-02 11:00')), [])
  assert.equal(dueFollowUps(db, at('2026-11-02 09:15')).length, 1)
})

test('meta chats: the 23 h count starts at the customer\'s last message even when the reply came late (a retry)', () => {
  const IG = 'ig:7002'
  const db = openDb(); initJobs(db); ensureChat(db, IG)
  addMessage(db, { phone: IG, role: 'student', text: 'سلام', at: at('2026-11-01 10:00') })
  afterBotReply(db, IG, at('2026-11-01 12:00')) // answered 2 h late
  assert.equal(getChat(db, IG).follow_at, at('2026-11-02 09:30'))
})
