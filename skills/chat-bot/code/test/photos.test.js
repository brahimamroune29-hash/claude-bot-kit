import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { send } from '../src/wa.js'
import { openDb, ensureChat, addMessage, claimEcho, history } from '../src/db.js'
import { orderTools } from '../src/shop.js'
import { TOOLS, buildSystem } from '../src/brain.js'

const base = JSON.parse(readFileSync(new URL('./card.sample.json', import.meta.url), 'utf8'))
const card = {
  ...base,
  products: [
    { ...base.products[1], photos: ['a000000000000001.jpg', 'a000000000000002.jpg', 'a000000000000003.jpg'] },
    { ...base.products[0], photos: [] },
    { ...base.products[2], photos: ['b000000000000001.jpg', 'b000000000000002.jpg'] },
  ],
}
const P = '213555700001'
const W = card.products[0] // the watch, 4800

test('send: an image goes with its caption in one message', async () => {
  const calls = []
  const fetchImpl = async (url, init) => { calls.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }) }
  const r = await send({ apiKey: 'K', to: P, text: 'ساعة - 4800 دج', imageUrl: 'https://h/media/a.jpg', fetchImpl })
  assert.equal(r.ok, true)
  assert.deepEqual(calls[0], { to: `+${P}`, text: 'ساعة - 4800 دج', imageUrl: 'https://h/media/a.jpg' })
})

test('db: a photo row keeps its file; history tells the model a photo was sent', () => {
  const db = openDb(); ensureChat(db, P)
  addMessage(db, { phone: P, role: 'student', text: 'ورّيني', at: 1 })
  addMessage(db, { phone: P, role: 'bot', text: 'ساعة - 4800 دج', media: 'a000000000000001.jpg', status: 'sent', at: 2 })
  assert.equal(db.prepare('SELECT media FROM messages WHERE role = ?').get('bot').media, 'a000000000000001.jpg')
  assert.deepEqual(history(db, P).map((m) => m.text), ['ورّيني', '[صورة] ساعة - 4800 دج'])
})

test('claimEcho: our photo echoed back without its caption is still ours (else the bot would go quiet 20 min)', () => {
  const db = openDb(); ensureChat(db, P)
  const now = Date.now()
  addMessage(db, { phone: P, role: 'bot', text: 'ساعة - 4800 دج', media: 'a000000000000001.jpg', status: 'sent', at: now })
  assert.equal(claimEcho(db, { phone: P, text: null, image: true, waId: 'E1', now }), true)
  assert.equal(claimEcho(db, { phone: P, text: null, image: true, waId: 'E2', now }), false)
  assert.equal(claimEcho(db, { phone: P, text: null, waId: 'E3', now }), false) // not an image: no match
})

test('claimEcho: a real photo from the owner is not taken for a failed photo of ours', () => {
  const db = openDb(); ensureChat(db, P)
  const now = Date.now()
  addMessage(db, { phone: P, role: 'bot', text: 'ساعة - 4800 دج', media: 'a000000000000001.jpg', status: 'failed', at: now })
  assert.equal(claimEcho(db, { phone: P, text: null, image: true, waId: 'H1', now }), false)
})

const turn = (db) => orderTools({ db, card, phone: P, alertAgent: async () => {} })
const asks = (db, text = 'ورّيني الصور') => { ensureChat(db, P); addMessage(db, { phone: P, role: 'student', text }) }
const sendAll = (db, run) => { for (const ph of run.photos) addMessage(db, { phone: P, role: 'bot', text: ph.caption, media: ph.name, status: 'sent' }) }

test('show_photos: two at a time, caption from the card, never the same photo twice', async () => {
  const db = openDb(); asks(db)
  let run = turn(db)
  assert.equal((await run('show_photos', { product_id: W.id })).ok, true)
  assert.deepEqual(run.photos, [
    { name: 'a000000000000001.jpg', caption: `${W.name} - ${W.price} دج` },
    { name: 'a000000000000002.jpg', caption: W.name },
  ])
  sendAll(db, run)
  run = turn(db)
  await run('show_photos', { product_id: W.id })
  assert.deepEqual(run.photos.map((p) => p.name), ['a000000000000003.jpg'])
  sendAll(db, run)
  run = turn(db)
  const r = await run('show_photos', { product_id: W.id })
  assert.deepEqual(run.photos, [])
  assert.match(r.message, /من قبل/)
})

test('show_photos: a failed send can be sent again; one still on its way is not sent twice', async () => {
  const db = openDb(); asks(db)
  addMessage(db, { phone: P, role: 'bot', text: 'x', media: 'a000000000000001.jpg', status: 'failed' })
  const run = turn(db)
  addMessage(db, { phone: P, role: 'bot', text: 'x', media: 'a000000000000002.jpg', status: 'pending' })
  await run('show_photos', { product_id: W.id })
  assert.deepEqual(run.photos.map((p) => p.name), ['a000000000000001.jpg', 'a000000000000003.jpg'])
})

test('show_photos: refused when the customer did not ask for a photo (only on request)', async () => {
  for (const ask of ['📷 [صورة من الزبون]\nعندك صور أخرى؟', 'ورّيني', 'وريني الساعة', 'عندك تصويرة؟', 'نشوفها؟', 'كيفاش شكلها', '🎤 ورّيلي الصور', 'wrili photo', 'nchouf tswira', 'ابعثلي الفطو نتاعو', 'ab3athli foto']) {
    const db = openDb(); asks(db, ask)
    const run = turn(db)
    assert.equal((await run('show_photos', { product_id: W.id })).ok, true, ask)
  }
  for (const no of ['شحال الساعة؟', 'نحب نطلب', 'chhal', '📷 [صورة من الزبون]', '📷 [صورة من الزبون]\nبشحال؟']) {
    const db = openDb(); asks(db, no)
    const run = turn(db)
    const r = await run('show_photos', { product_id: W.id })
    assert.equal(r.ok, false, no)
    assert.deepEqual(run.photos, [])
  }
})

test('show_photos: unknown product, product without photos, at most 4 per turn', async () => {
  const db = openDb(); asks(db)
  const run = turn(db)
  assert.equal((await run('show_photos', { product_id: 'p99' })).ok, false)
  const none = await run('show_photos', { product_id: card.products[1].id })
  assert.match(none.message, /لا توجد صور/)
  await run('show_photos', { product_id: card.products[0].id })
  await run('show_photos', { product_id: card.products[2].id })
  await run('show_photos', { product_id: card.products[0].id })
  assert.equal(run.photos.length, 4)
})

test('brain: show_photos is offered, and only on request', () => {
  const t = TOOLS.find((x) => x.name === 'show_photos')
  assert.ok(t)
  assert.deepEqual(t.input_schema.required, ['product_id'])
  assert.match(buildSystem(card), /show_photos/)
  assert.match(buildSystem(card), /صورة.*إلا إذا طلب|إلا إذا طلب.*صور/)
})
