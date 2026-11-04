import test from 'node:test'
import assert from 'node:assert/strict'
import { parseWasender, sameSecret, send, sendPresence } from '../src/wa.js'

const NOW = 1_800_000_000_000
const sec = (ms) => Math.floor(ms / 1000)
const ev = (data, extra = {}) => ({ event: 'messages.upsert', timestamp: sec(NOW), data, ...extra })
const msg = (over = {}) => ({
  key: { id: 'A1', fromMe: false, remoteJid: '213555000011@s.whatsapp.net', cleanedSenderPn: '213555000011' },
  pushName: 'Student One',
  messageTimestamp: sec(NOW - 5000),
  messageBody: 'salam',
  message: { conversation: 'salam' },
  ...over,
})

test('shape 1: data.messages array', () => {
  const r = parseWasender(ev({ messages: [msg()] }), NOW)
  assert.deepEqual(r, [{ waId: 'A1', phone: '213555000011', fromMe: false, text: 'salam', at: (sec(NOW - 5000)) * 1000, name: 'Student One', kind: 'text' }])
})

test('shape 2: data.messages single object', () => {
  const r = parseWasender(ev({ messages: msg() }), NOW)
  assert.equal(r.length, 1)
  assert.equal(r[0].phone, '213555000011')
})

test('shape 3: data.key directly, time from top-level timestamp in ms', () => {
  const { messageTimestamp, ...m } = msg()
  const r = parseWasender({ event: 'messages.upsert', timestamp: NOW - 1000, data: m }, NOW)
  assert.equal(r.length, 1)
  assert.equal(r[0].at, NOW - 1000)
})

test('text falls back to extendedTextMessage, then caption; ephemeral is unwrapped', () => {
  const ext = msg({ messageBody: undefined, message: { extendedTextMessage: { text: 'hello ext' } } })
  const cap = msg({ key: { ...msg().key, id: 'A2' }, messageBody: undefined, message: { imageMessage: { caption: 'pic cap' } } })
  const eph = msg({ key: { ...msg().key, id: 'A3' }, messageBody: undefined, message: { ephemeralMessage: { message: { viewOnceMessage: { message: { conversation: 'deep' } } } } } })
  const r = parseWasender(ev({ messages: [ext, cap, eph] }), NOW)
  assert.deepEqual(r.map((x) => x.text), ['hello ext', 'pic cap', 'deep'])
  assert.deepEqual(r.map((x) => x.kind), ['text', 'image', 'text']) // caption no longer turns an image into text
})

test('fromMe: phone comes from remoteJid, flag is kept', () => {
  const m = msg({ key: { id: 'B1', fromMe: true, remoteJid: '213555000012@s.whatsapp.net', cleanedSenderPn: '213555000099' } })
  const r = parseWasender(ev({ messages: [m] }), NOW)
  assert.equal(r[0].fromMe, true)
  assert.equal(r[0].phone, '213555000012')
})

test('@lid fallback when no phone field exists', () => {
  const m = msg({ key: { id: 'C1', fromMe: false, remoteJid: '99887766@lid' } })
  const r = parseWasender(ev({ messages: [m] }), NOW)
  assert.equal(r[0].phone, '99887766@lid')
})

test('remoteJidAlt gives the phone when remoteJid is a lid', () => {
  const m = msg({ key: { id: 'C2', fromMe: false, remoteJid: '99887766@lid', remoteJidAlt: '213555000013@s.whatsapp.net' } })
  assert.equal(parseWasender(ev({ messages: [m] }), NOW)[0].phone, '213555000013')
})

test('skips groups, broadcasts, newsletters, old messages, other events', () => {
  const k = (jid, id) => ({ id, fromMe: false, remoteJid: jid })
  const list = [
    msg({ key: k('1203@g.us', 'G1') }),
    msg({ key: k('status@broadcast', 'G2') }),
    msg({ key: k('120@newsletter', 'G3') }),
    msg({ key: { ...msg().key, id: 'OLD' }, messageTimestamp: sec(NOW - 11 * 60_000) }),
  ]
  assert.deepEqual(parseWasender(ev({ messages: list }), NOW), [])
  assert.deepEqual(parseWasender({ ...ev({ messages: [msg()] }), event: 'message.sent' }, NOW), [])
  assert.deepEqual(parseWasender(null, NOW), [])
})

test('caps at 40 messages', () => {
  const list = Array.from({ length: 50 }, (_, i) => msg({ key: { ...msg().key, id: `M${i}` } }))
  assert.equal(parseWasender(ev({ messages: list }), NOW).length, 40)
})

// a sticker is like a reaction: nothing to answer (replay: «(تم تجاهل الرسالة)» was sent for a sticker)
test('media without caption: text null + kind; stickers and reactions are dropped', () => {
  const mk = (id, message) => msg({ key: { ...msg().key, id }, messageBody: undefined, message })
  const r = parseWasender(ev({ messages: [
    mk('V', { audioMessage: { ptt: true } }),
    mk('I', { imageMessage: {} }),
    mk('S', { stickerMessage: {} }),
    mk('R', { reactionMessage: {} }),
  ] }), NOW)
  assert.deepEqual(r.map((x) => [x.waId, x.text, x.kind]), [['V', null, 'voice'], ['I', null, 'image']])
})

test('voice and image carry the exact node as media; seconds only on voice', () => {
  const mk = (id, message) => msg({ key: { ...msg().key, id }, messageBody: undefined, message })
  const aud = { ptt: true, seconds: 7, mimetype: 'audio/ogg; codecs=opus', mediaKey: 'SECRET' }
  const img = { mimetype: 'image/jpeg', caption: 'هذا', mediaKey: 'SECRET2' }
  const [v, i, n] = parseWasender(ev({ messages: [
    mk('V', { audioMessage: aud }), mk('I', { imageMessage: img }), mk('N', { audioMessage: { ptt: true } }),
  ] }), NOW)
  assert.deepEqual(v.media, { key: { id: 'V' }, message: { audioMessage: aud } })
  assert.equal(v.media.message.audioMessage, aud)
  assert.deepEqual([v.kind, v.text, v.seconds], ['voice', null, 7])
  assert.deepEqual(i.media, { key: { id: 'I' }, message: { imageMessage: img } })
  assert.deepEqual([i.kind, i.text, 'seconds' in i], ['image', 'هذا', false])
  assert.equal(n.seconds, 0)
})

test('sameSecret', () => {
  assert.equal(sameSecret('abc123', 'abc123'), true)
  assert.equal(sameSecret('abc123', 'abc124'), false)
  assert.equal(sameSecret('abc', 'abcd'), false)
  assert.equal(sameSecret('', ''), false)
  assert.equal(sameSecret(undefined, 'x'), false)
})

// fake fetch: replies from a queue, records calls
const fakeFetch = (replies) => {
  const calls = []
  const f = async (url, init) => {
    calls.push({ url, init })
    const r = replies[Math.min(calls.length - 1, replies.length - 1)]
    if (r instanceof Error) throw r
    return { ok: r.status < 300, status: r.status, json: async () => r.body ?? {} }
  }
  return { f, calls }
}
const sleeps = []
const sleep = async (ms) => { sleeps.push(ms) }

test('send: success posts the right request', async () => {
  const { f, calls } = fakeFetch([{ status: 200, body: { success: true } }])
  const r = await send({ apiKey: 'K', to: '213555000011', text: 'hi', fetchImpl: f, sleep })
  assert.equal(r.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://www.wasenderapi.com/api/send-message')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer K')
  assert.deepEqual(JSON.parse(calls[0].init.body), { to: '+213555000011', text: 'hi' })
})

test('send: lid target is passed raw', async () => {
  const { f, calls } = fakeFetch([{ status: 200 }])
  await send({ apiKey: 'K', to: '998877@lid', text: 'hi', fetchImpl: f, sleep })
  assert.equal(JSON.parse(calls[0].init.body).to, '998877@lid')
})

test('send: 429 then success retries after 6s', async () => {
  sleeps.length = 0
  const { f, calls } = fakeFetch([{ status: 429, body: { retry_after: 5 } }, { status: 200 }])
  const r = await send({ apiKey: 'K', to: '213555000011', text: 'hi', fetchImpl: f, sleep })
  assert.equal(r.ok, true)
  assert.equal(calls.length, 2)
  assert.deepEqual(sleeps, [6000])
})

test('send: 429 forever stops at 4 attempts', async () => {
  const { f, calls } = fakeFetch([{ status: 429 }])
  const r = await send({ apiKey: 'K', to: '213555000011', text: 'hi', fetchImpl: f, sleep })
  assert.equal(r.ok, false)
  assert.equal(r.status, 429)
  assert.equal(calls.length, 4)
})

test('send: 500 is not retried', async () => {
  const { f, calls } = fakeFetch([{ status: 500, body: { message: 'boom' } }])
  const r = await send({ apiKey: 'K', to: '213555000011', text: 'hi', fetchImpl: f, sleep })
  assert.deepEqual([r.ok, r.status, calls.length], [false, 500, 1])
  assert.match(r.error, /boom/)
})

test('send: network throw gives ok:false, never throws', async () => {
  const { f } = fakeFetch([new Error('ECONNRESET')])
  const r = await send({ apiKey: 'K', to: '213555000011', text: 'hi', fetchImpl: f, sleep })
  assert.equal(r.ok, false)
  assert.match(r.error, /ECONNRESET/)
})

test('sendPresence posts composing and swallows errors', async () => {
  const { f, calls } = fakeFetch([{ status: 200 }])
  await sendPresence({ apiKey: 'K', phone: '213555000011', fetchImpl: f })
  assert.equal(calls[0].url, 'https://www.wasenderapi.com/api/send-presence-update')
  assert.deepEqual(JSON.parse(calls[0].init.body), { jid: '213555000011@s.whatsapp.net', type: 'composing' })
  const bad = fakeFetch([new Error('x')])
  await sendPresence({ apiKey: 'K', phone: '213555000011', fetchImpl: bad.f })
})

// human pacing (owner, 2026-11-01): each bubble takes about as long as a person typing it, ~15 s for a normal line
test('typingMs: grows with length at ~4 chars/s, clamped, with jitter', async () => {
  const { typingMs } = await import('../src/wa.js')
  const still = { rand: () => 0.5 } // no jitter
  assert.equal(typingMs('x'.repeat(60), still), 15_000) // 60 chars / 4 cps
  assert.equal(typingMs('واه', still), 2_000) // floor
  assert.equal(typingMs('x'.repeat(400), still), 15_000) // ceiling
  assert.equal(typingMs('x'.repeat(40), { ...still, cps: 2 }), 15_000)
  const lo = typingMs('x'.repeat(40), { rand: () => 0 }), hi = typingMs('x'.repeat(40), { rand: () => 1 })
  assert.ok(lo < 10_000 && hi > 10_000 && lo >= 8_000 && hi <= 12_000, `${lo} ${hi}`)
})
