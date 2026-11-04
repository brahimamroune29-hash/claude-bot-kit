// Instagram DMs and Messenger through the Facebook Page.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { parseMeta, metaSigned, sendMeta, metaTyping, fitBytes, isMeta, privacyPage } from '../src/meta.js'

const NOW = Date.UTC(2026, 10, 1, 12, 0)
const ev = (message, extra = {}) => ({ sender: { id: '7001' }, recipient: { id: '9001' }, timestamp: NOW - 1000, message, ...extra })
const body = (object, ...messaging) => ({ object, entry: [{ id: '9001', time: NOW, messaging }] })

test('parseMeta: Messenger and Instagram text become chats «fb:<id>» / «ig:<id>» in the WhatsApp message shape', () => {
  assert.deepEqual(parseMeta(body('page', ev({ mid: 'm1', text: ' سلام ' })), NOW),
    [{ waId: 'm1', phone: 'fb:7001', fromMe: false, text: 'سلام', at: NOW - 1000, name: '', kind: 'text' }])
  assert.equal(parseMeta(body('instagram', ev({ mid: 'm2', text: 'شحال؟' })), NOW)[0].phone, 'ig:7001')
  assert.deepEqual(parseMeta({ object: 'whatsapp_business_account', entry: [] }, NOW), [])
  assert.deepEqual(parseMeta(null, NOW), [])
})

test('parseMeta: voice note, photo and a shared post carry their URL; video / reel = other; reactions, reads, deleted, story mentions = nothing to answer', () => {
  const att = (type, url = 'https://scontent.xx.fbcdn.net/x') => ({ mid: `m-${type}`, attachments: [{ type, payload: { url } }] })
  const got = parseMeta(body('instagram',
    ev(att('audio')), ev(att('image')), ev({ ...att('share'), text: 'شحال هذا؟' }), ev(att('ig_reel')), ev(att('story_mention')),
    ev(att('image', 'http://not-https/x')), ev(att('audio', 'https://evil.example/x.mp4')), ev({ mid: 'gone', is_deleted: true }),
    { sender: { id: '7001' }, recipient: { id: '9001' }, timestamp: NOW, reaction: { mid: 'm1', action: 'react', emoji: '❤️' } },
    { sender: { id: '7001' }, recipient: { id: '9001' }, timestamp: NOW, read: { mid: 'm1' } }), NOW)
  assert.deepEqual(got.map((m) => [m.kind, m.text, m.url ?? null]), [
    ['voice', null, 'https://scontent.xx.fbcdn.net/x'], ['image', null, 'https://scontent.xx.fbcdn.net/x'], ['image', 'شحال هذا؟', 'https://scontent.xx.fbcdn.net/x'], ['other', null, null],
    ['image', null, null], // a photo we cannot fetch: the bot asks for a clearer one
    ['voice', null, null], // only Meta's own CDN is downloaded
  ])
})

test('parseMeta: an echo (our send or the owner typing in the page inbox) is fromMe, for the customer on the other side', () => {
  const [m] = parseMeta(body('page', { sender: { id: '9001' }, recipient: { id: '7001' }, timestamp: NOW, message: { mid: 'e1', is_echo: true, app_id: 263902037430900, text: 'مرحبا' } }), NOW)
  assert.deepEqual([m.phone, m.fromMe, m.text], ['fb:7001', true, 'مرحبا'])
})

test('parseMeta: older than 24 h (Meta retrying after our downtime, outside its reply window) is dropped; at most 40 per entry', () => {
  assert.equal(parseMeta(body('page', { ...ev({ mid: 'old', text: 'x' }), timestamp: NOW - 25 * 3_600_000 }), NOW).length, 0)
  const many = Array.from({ length: 50 }, (_, i) => ev({ mid: `m${i}`, text: 'x' }))
  assert.equal(parseMeta(body('page', ...many), NOW).length, 40)
})

test('metaSigned: sha256 HMAC of the raw body with the app secret; anything else is refused', () => {
  const raw = JSON.stringify(body('page', ev({ mid: 'm1', text: 'سلام' })))
  const sig = `sha256=${createHmac('sha256', 'S3CRET').update(raw).digest('hex')}`
  assert.equal(metaSigned(raw, sig, 'S3CRET'), true)
  assert.equal(metaSigned(raw + ' ', sig, 'S3CRET'), false)
  assert.equal(metaSigned(raw, sig, 'other'), false)
  assert.equal(metaSigned(raw, undefined, 'S3CRET'), false)
  assert.equal(metaSigned(raw, sig, ''), false)
})

test('sendMeta: text and image by URL to the Page Send API; typing is best effort', async () => {
  const calls = []
  const fetchImpl = async (url, o) => { calls.push({ url, auth: o.headers.authorization, body: JSON.parse(o.body) }); return { ok: true, status: 200, json: async () => ({ message_id: 'x' }) } }
  assert.deepEqual(await sendMeta({ token: 'T', to: 'ig:7001', text: 'سلام', fetchImpl }), { ok: true, status: 200 })
  await sendMeta({ token: 'T', to: 'fb:7001', imageUrl: 'https://bot/media/a.jpg', fetchImpl })
  await metaTyping({ token: 'T', to: 'fb:7001', fetchImpl })
  assert.match(calls[0].url, /^https:\/\/graph\.facebook\.com\/v\d+\.0\/me\/messages$/)
  assert.equal(calls[0].auth, 'Bearer T')
  assert.deepEqual(calls[0].body, { recipient: { id: '7001' }, messaging_type: 'RESPONSE', message: { text: 'سلام' } })
  assert.deepEqual(calls[1].body.message, { attachment: { type: 'image', payload: { url: 'https://bot/media/a.jpg', is_reusable: true } } })
  assert.deepEqual(calls[2].body, { recipient: { id: '7001' }, sender_action: 'typing_on' })
  const failing = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: '(#10) outside the allowed window' } }) })
  assert.deepEqual(await sendMeta({ token: 'T', to: 'fb:7001', text: 'x', fetchImpl: failing }), { ok: false, status: 400, error: '(#10) outside the allowed window' })
  assert.equal((await sendMeta({ token: 'T', to: 'fb:7001', text: 'x', fetchImpl: async () => { throw new Error('net') } })).ok, false)
  await metaTyping({ token: 'T', to: 'fb:7001', fetchImpl: async () => { throw new Error('net') } }) // never throws
})

test('fitBytes: Instagram takes 1000 bytes a message (an Arabic letter is 2): long text splits on lines, then on letters', () => {
  assert.deepEqual(fitBytes('سلام'), ['سلام'])
  const line = 'ب'.repeat(300) // 600 bytes
  assert.deepEqual(fitBytes(`${line}\n${line}`), [line, line])
  const long = 'ب'.repeat(700)
  const parts = fitBytes(long)
  assert.ok(parts.every((p) => Buffer.byteLength(p) <= 1000) && parts.join('') === long)
})

test('isMeta / privacyPage: the page Meta asks for names the shop and how to delete data', () => {
  assert.deepEqual(['fb:1', 'ig:2', '213555', 'x@lid'].map(isMeta), [true, true, false, false])
  const html = privacyPage({ shop: 'متجر <النور>', phone: '0555 12 34 56' })
  assert.match(html, /متجر &lt;النور&gt;/)
  assert.match(html, /0555 12 34 56/)
  assert.match(html, /حذف بياناتي/)
  assert.ok(!/[a-z]{4,}/i.test(html.replace(/<style>[\s\S]*<\/style>/, '').replace(/<[^>]*>/g, '').replace(/&\w+;/g, '')), 'Arabic only')
})
