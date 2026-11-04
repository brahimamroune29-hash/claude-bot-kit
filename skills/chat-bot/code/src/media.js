import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const WS = 'https://www.wasenderapi.com/api'

// OpenAI gpt-transcribe, chosen on 30 real darja voice notes (voice is kept off OpenRouter): 0.75 vs 0.81 for
// Gemini Flash against the Gemini Pro reference, 0 of 30 dropped / made up / repeated / turned into formal Arabic.
export const STT_PROMPT = 'تسجيل صوتي بالدارجة الجزائرية. اكتب الكلام كما قيل بالحروف العربية، والكلمات الفرنسية بحروف لاتينية. لا تترجم إلى الفصحى.'
const STT_MODEL = 'gpt-transcribe'
const USD_PER_MIN = 0.0045 // OpenAI pricing page, 2026-11-01; billed by the second
const STT_EXT = { 'video/mp4': 'mp4', 'audio/ogg': 'ogg', 'audio/opus': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'webm' }

// Wasender decrypts the media and returns a 1-hour https link; we download it. Any failure -> null (caller asks the customer to write).
export async function fetchMedia({ apiKey, media, fetchImpl = fetch, maxBytes = 9 * 1024 * 1024, timeoutMs = 20_000 }) {
  try {
    const dec = await fetchImpl(`${WS}/decrypt-media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ data: { messages: media } }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const url = String((await dec.json().catch(() => ({}))).publicUrl ?? '')
    if (!dec.ok || !url.startsWith('https://')) return null
    const node = media.message?.audioMessage ?? media.message?.imageMessage
    return fetchUrl({ url, mime: String(node?.mimetype || (media.message?.imageMessage ? 'image/jpeg' : 'audio/ogg')), fetchImpl, maxBytes, timeoutMs })
  } catch {
    return null
  }
}

// Download a public https link (Wasender's decrypted file, or the Meta CDN link of an Instagram / Messenger attachment).
// mime: what we know it is; else the response's own type, else fallback. Any failure -> null.
export async function fetchUrl({ url, mime = null, fallback = 'application/octet-stream', fetchImpl = fetch, maxBytes = 9 * 1024 * 1024, timeoutMs = 20_000 }) {
  try {
    const got = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!got.ok || Number(got.headers?.get?.('content-length') ?? 0) > maxBytes) return null
    const buf = Buffer.from(await got.arrayBuffer())
    if (!buf.length || buf.length > maxBytes) return null
    const type = String(got.headers?.get?.('content-type') ?? '').split(';')[0].trim().toLowerCase()
    return { b64: buf.toString('base64'), mime: mime ?? (/^(audio|image|video)\//.test(type) ? type : fallback), bytes: buf.length }
  } catch {
    return null
  }
}

// No retry: a second long wait is worse than asking the customer to write.
// seconds: the duration WhatsApp reported, used for the cost only if OpenAI's answer has none
export async function transcribe({ apiKey, b64, mime, seconds = 0, fetchImpl = fetch, timeoutMs = 60_000 }) {
  const ext = STT_EXT[String(mime ?? '').toLowerCase().split(';')[0].trim()]
  if (!ext) return { error: 'format', usd: 0 }
  if (!apiKey) return { error: 'no key', usd: 0 }
  try {
    const form = new FormData()
    form.append('file', new Blob([Buffer.from(b64, 'base64')], { type: mime }), `voice.${ext}`) // the name tells OpenAI the format
    form.append('model', STT_MODEL)
    form.append('prompt', STT_PROMPT)
    const res = await fetchImpl('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal: AbortSignal.timeout(timeoutMs),
    })
    const out = await res.json().catch(() => ({}))
    if (!res.ok) return { error: `http ${res.status}`, usd: 0 }
    const usd = Math.round((Number(out.usage?.seconds ?? seconds) / 60) * USD_PER_MIN * 1e6) / 1e6
    const text = String(out.text ?? '').trim().slice(0, 2000)
    return text ? { text, usd } : { error: 'empty', usd }
  } catch (e) {
    return { error: String(e?.message ?? e).slice(0, 200), usd: 0 }
  }
}

const MAX_VOICE_S = 180
// What the bot stores for a customer's voice note: «🎤 transcript», or null when nothing usable came out
// (too long, download or transcription failed, silence, all unclear) — the bot then asks to repeat or write.
export async function voiceText({ wasenderKey, apiKey, media, file: given, seconds = 0, fetchImpl = fetch }) {
  if (seconds > MAX_VOICE_S) return { text: null, usd: 0, why: 'long' }
  const file = given ?? await fetchMedia({ apiKey: wasenderKey, media, fetchImpl })
  if (!file) return { text: null, usd: 0, why: 'download' }
  const t = await transcribe({ apiKey, b64: file.b64, mime: file.mime, seconds, fetchImpl })
  if (t.error) return { text: null, usd: t.usd, why: t.error }
  // our own style prompt coming back is not the customer speaking (silence and noise came back empty: 6 of 6, 2026-11-01)
  if (!t.text.replace(/[\s.,،؟?!]/g, '') || t.text.includes(STT_PROMPT.slice(0, 30))) return { text: null, usd: t.usd, why: 'unclear' }
  return { text: `🎤 ${t.text}`, usd: t.usd }
}

// Product photos, public: Wasender and Meta fetch them by URL to send them to customers. The owner drops the files in
// MEDIA_DIR and lists their names in card.json; a plain name only (no folders, no dots), so no other file is ever served.
export const PHOTO = /^[a-z0-9][a-z0-9_-]{0,63}\.(jpg|jpeg|png)$/i
export function mediaRoutes(mediaDir) {
  return async (req, res, url) => {
    if (req.method !== 'GET' || !url.pathname.startsWith('/media/')) return false
    const name = url.pathname.slice('/media/'.length)
    const file = join(mediaDir, name)
    if (!PHOTO.test(name) || !existsSync(file)) { res.writeHead(404); res.end(); return true }
    res.writeHead(200, {
      'content-type': /\.png$/i.test(name) ? 'image/png' : 'image/jpeg',
      'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff',
    })
    res.end(readFileSync(file))
    return true
  }
}
