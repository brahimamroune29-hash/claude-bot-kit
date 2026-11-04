import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fetchMedia, transcribe, voiceText, STT_PROMPT, mediaRoutes } from '../src/media.js'

// fake fetch: replies from a queue, records calls; bytes -> file download, else JSON
const fakeFetch = (replies) => {
  const calls = []
  const f = async (url, init) => {
    calls.push({ url, init })
    const r = replies[Math.min(calls.length - 1, replies.length - 1)]
    if (r instanceof Error) throw r
    const len = r.bytes ? r.bytes.length : 0
    return {
      ok: r.status < 300, status: r.status,
      json: async () => r.body ?? {},
      headers: { get: (h) => (h.toLowerCase() === 'content-length' && r.bytes ? String(len) : null) },
      arrayBuffer: async () => r.bytes ?? new Uint8Array(),
    }
  }
  return { f, calls }
}
const node = { key: { id: 'A1' }, message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', mediaKey: 'S' } } }
const okDecrypt = { status: 200, body: { publicUrl: 'https://cdn.example/x.ogg' } }

test('fetchMedia: decrypt then download -> base64 + mime', async () => {
  const { f, calls } = fakeFetch([okDecrypt, { status: 200, bytes: Buffer.from('hello') }])
  const r = await fetchMedia({ apiKey: 'K', media: node, fetchImpl: f })
  assert.deepEqual(r, { b64: Buffer.from('hello').toString('base64'), mime: 'audio/ogg; codecs=opus', bytes: 5 })
  assert.equal(calls[0].url, 'https://www.wasenderapi.com/api/decrypt-media')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer K')
  assert.deepEqual(JSON.parse(calls[0].init.body), { data: { messages: node } })
  assert.equal(calls[1].url, 'https://cdn.example/x.ogg')
})

test('fetchMedia: mime falls back by node type', async () => {
  const img = { key: { id: 'I' }, message: { imageMessage: {} } }
  const { f } = fakeFetch([okDecrypt, { status: 200, bytes: Buffer.from('x') }])
  assert.equal((await fetchMedia({ apiKey: 'K', media: img, fetchImpl: f })).mime, 'image/jpeg')
  const aud = { key: { id: 'A' }, message: { audioMessage: {} } }
  const g = fakeFetch([okDecrypt, { status: 200, bytes: Buffer.from('x') }])
  assert.equal((await fetchMedia({ apiKey: 'K', media: aud, fetchImpl: g.f })).mime, 'audio/ogg')
})

test('fetchMedia: non-https publicUrl -> null, no download', async () => {
  const { f, calls } = fakeFetch([{ status: 200, body: { publicUrl: 'http://cdn.example/x' } }])
  assert.equal(await fetchMedia({ apiKey: 'K', media: node, fetchImpl: f }), null)
  assert.equal(calls.length, 1)
})

test('fetchMedia: download larger than maxBytes -> null', async () => {
  const { f } = fakeFetch([okDecrypt, { status: 200, bytes: Buffer.alloc(11) }])
  assert.equal(await fetchMedia({ apiKey: 'K', media: node, fetchImpl: f, maxBytes: 10 }), null)
})

test('fetchMedia: decrypt 500, download 404 and network error -> null', async () => {
  assert.equal(await fetchMedia({ apiKey: 'K', media: node, fetchImpl: fakeFetch([{ status: 500 }]).f }), null)
  assert.equal(await fetchMedia({ apiKey: 'K', media: node, fetchImpl: fakeFetch([okDecrypt, { status: 404 }]).f }), null)
  assert.equal(await fetchMedia({ apiKey: 'K', media: node, fetchImpl: fakeFetch([new Error('down')]).f }), null)
})

// OpenAI gpt-transcribe (chosen 2026-11-01 on 30 real darja voice notes: 0.75 vs 0.81 for Gemini Flash against the
// Gemini Pro reference; 0 dropped, 0 made-up, 0 repeated). Billed by the second: 0.0045 USD per minute.
test('transcribe: OpenAI form upload, returns trimmed text + cost from the seconds billed', async () => {
  const { f, calls } = fakeFetch([{ status: 200, body: { text: '  سلام  ', usage: { type: 'duration', seconds: 20 } } }])
  const r = await transcribe({ apiKey: 'OA', b64: 'QUJD', mime: 'audio/ogg; codecs=opus', fetchImpl: f })
  assert.deepEqual(r, { text: 'سلام', usd: 0.0015 })
  assert.equal(calls[0].url, 'https://api.openai.com/v1/audio/transcriptions')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer OA')
  const form = calls[0].init.body
  assert.equal(form.get('model'), 'gpt-transcribe')
  assert.equal(form.get('prompt'), STT_PROMPT)
  assert.equal(form.get('file').name, 'voice.ogg')
  assert.equal(Buffer.from(await form.get('file').arrayBuffer()).toString(), 'ABC')
})

test('transcribe: the file name tells OpenAI the format (webm from the try page, m4a from iPhone)', async () => {
  for (const [mime, name] of [['audio/webm;codecs=opus', 'voice.webm'], ['audio/mp4', 'voice.m4a'], ['audio/mpeg', 'voice.mp3']]) {
    const { f, calls } = fakeFetch([{ status: 200, body: { text: 'x' } }])
    await transcribe({ apiKey: 'OA', b64: 'x', mime, fetchImpl: f })
    assert.equal(calls[0].init.body.get('file').name, name, mime)
  }
})

test('transcribe: caps text at 2000 chars', async () => {
  const { f } = fakeFetch([{ status: 200, body: { text: 'ا'.repeat(3000) } }])
  assert.equal((await transcribe({ apiKey: 'OA', b64: 'x', mime: 'audio/mpeg', fetchImpl: f })).text.length, 2000)
})

test('transcribe: API error, network error, no key -> { error }', async () => {
  const a = await transcribe({ apiKey: 'OA', b64: 'x', mime: 'audio/ogg', fetchImpl: fakeFetch([{ status: 502, body: {} }]).f })
  assert.deepEqual(a, { error: 'http 502', usd: 0 })
  const b = await transcribe({ apiKey: 'OA', b64: 'x', mime: 'audio/ogg', fetchImpl: fakeFetch([new Error('timeout')]).f })
  assert.deepEqual(b, { error: 'timeout', usd: 0 })
  const { f, calls } = fakeFetch([{ status: 200 }])
  assert.deepEqual(await transcribe({ apiKey: '', b64: 'x', mime: 'audio/ogg', fetchImpl: f }), { error: 'no key', usd: 0 })
  assert.equal(calls.length, 0)
})

test('transcribe: unsupported format -> error, zero calls', async () => {
  const { f, calls } = fakeFetch([{ status: 200 }])
  assert.deepEqual(await transcribe({ apiKey: 'OA', b64: 'x', mime: 'audio/amr', fetchImpl: f }), { error: 'format', usd: 0 })
  assert.equal(calls.length, 0)
})

// ═══ voiceText: what the bot stores for a voice note ═══
const sttOk = (text, seconds = 12) => ({ status: 200, body: { text, usage: { type: 'duration', seconds } } })
const voice = (replies, extra = {}) => {
  const { f, calls } = fakeFetch(replies)
  return voiceText({ wasenderKey: 'W', apiKey: 'K', media: node, seconds: 12, fetchImpl: f, ...extra }).then((r) => ({ ...r, calls }))
}

test('voiceText: the transcript, marked as a voice note, with its cost', async () => {
  const r = await voice([okDecrypt, { status: 200, bytes: Buffer.from('ogg') }, sttOk('سلام، شحال الساعة؟')])
  assert.equal(r.text, '🎤 سلام، شحال الساعة؟')
  assert.equal(r.usd, 0.0009) // 12 s at 0.0045 USD / min
  assert.equal(r.calls[0].init.headers.Authorization, 'Bearer W') // Wasender key for the file
  assert.equal(r.calls[2].init.headers.Authorization, 'Bearer K') // OpenAI key for the transcript
})

test('voiceText: nothing usable = null (the bot then asks to repeat or write)', async () => {
  for (const t of [' . ', '']) {
    const r = await voice([okDecrypt, { status: 200, bytes: Buffer.from('ogg') }, sttOk(t)])
    assert.equal(r.text, null, JSON.stringify(t))
  }
  assert.equal((await voice([{ status: 500 }])).text, null) // download failed
  assert.equal((await voice([okDecrypt, { status: 200, bytes: Buffer.from('ogg') }, { status: 502 }])).text, null)
})

test('voiceText: a file already in hand (local try page) skips the download', async () => {
  const r = await voice([sttOk('واش كاين التوصيل لوهران؟')], { media: undefined, file: { b64: 'b2dn', mime: 'audio/webm;codecs=opus' } })
  assert.equal(r.text, '🎤 واش كاين التوصيل لوهران؟')
  assert.equal(r.calls.length, 1)
  assert.match(r.calls[0].url, /api\.openai\.com/)
})

test('voiceText: the style prompt echoed back is not the customer speaking; cost falls back to the WhatsApp duration', async () => {
  const echo = await voice([okDecrypt, { status: 200, bytes: Buffer.from('ogg') }, sttOk(STT_PROMPT)])
  assert.equal(echo.text, null)
  const noUsage = await voice([okDecrypt, { status: 200, bytes: Buffer.from('ogg') }, { status: 200, body: { text: 'سلام' } }], { seconds: 20 })
  assert.equal(noUsage.usd, 0.0015)
})

test('voiceText: longer than 3 minutes is not sent for transcription', async () => {
  const r = await voice([okDecrypt], { seconds: 181 })
  assert.equal(r.text, null)
  assert.equal(r.calls.length, 0)
})

test('media: serves product photos by plain name only, never other files', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'media-'))
  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)])
  writeFileSync(join(dir, 'p2-black.jpg'), JPEG)
  writeFileSync(join(dir, 'card.json'), '{}')
  const route = mediaRoutes(dir)
  const server = http.createServer(async (req, res) => { if (!(await route(req, res, new URL(req.url, 'http://x')))) { res.writeHead(404); res.end() } })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  const r = await fetch(`${base}/media/p2-black.jpg`)
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'image/jpeg')
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), JPEG)
  for (const bad of ['/media/..%2Fcard.json', '/media/../card.json', '/media/card.json', '/media/missing.jpg', '/media/.p2-black.jpg']) {
    assert.equal((await fetch(base + bad)).status, 404, bad)
  }
})
