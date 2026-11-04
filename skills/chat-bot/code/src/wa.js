import { timingSafeEqual } from 'node:crypto'

const WS = 'https://www.wasenderapi.com/api'
const MAX_AGE_MS = 10 * 60_000

const digitsOf = (s) => String(s ?? '').split('@')[0].split(':')[0].replace(/\D/g, '')
const isPn = (s) => /@(s\.whatsapp\.net|c\.us)$/.test(String(s ?? ''))
// timestamp in seconds or ms (number or {low}) -> ms, 0 if absent
const msOf = (v) => {
  const n = Number(v && typeof v === 'object' ? v.low : v)
  return Number.isFinite(n) && n > 0 ? (n > 1e12 ? n : n * 1000) : 0
}

// Wasender messages.upsert -> private-chat messages. Accepts data.messages (array | object) or data.key.
export function parseWasender(body, now = Date.now()) {
  const b = body ?? {}
  if (String(b.event ?? '').toLowerCase() !== 'messages.upsert') return []
  const data = b.data ?? {}
  const raw = data.messages ?? (data.key ? data : null)
  const list = (Array.isArray(raw) ? raw : raw ? [raw] : []).slice(0, 40)
  const out = []
  for (const d of list) {
    const key = d?.key ?? {}
    const waId = String(key.id ?? ''), jid = String(key.remoteJid ?? '')
    if (!waId || !jid || /@g\.us|broadcast|@newsletter/.test(jid)) continue
    const at = msOf(d.messageTimestamp) || msOf(b.timestamp)
    if (!at || now - at > MAX_AGE_MS) continue // WhatsApp replays old messages after a reconnect
    const fromMe = key.fromMe === true
    // fromMe: remoteJid is the student, "sender" is our own number
    let phone = fromMe
      ? (isPn(jid) ? digitsOf(jid) : '') || (isPn(key.remoteJidAlt) ? digitsOf(key.remoteJidAlt) : '')
      : digitsOf(key.cleanedSenderPn) || (isPn(key.senderPn) ? digitsOf(key.senderPn) : '')
        || (isPn(key.remoteJidAlt) ? digitsOf(key.remoteJidAlt) : '') || (isPn(jid) ? digitsOf(jid) : '')
    if (!phone && jid.endsWith('@lid') && digitsOf(jid)) phone = `${digitsOf(jid)}@lid`
    if (!phone) continue

    let msg = d.message ?? {}
    for (let i = 0; i < 3; i++) {
      const inner = msg.ephemeralMessage?.message ?? msg.viewOnceMessage?.message ?? msg.viewOnceMessageV2?.message ?? msg.documentWithCaptionMessage?.message
      if (!inner) break
      msg = inner
    }
    const text = String(
      (typeof d.messageBody === 'string' && d.messageBody.trim()) ? d.messageBody
        : msg.conversation ?? msg.extendedTextMessage?.text ?? msg.imageMessage?.caption ?? msg.videoMessage?.caption ?? msg.documentMessage?.caption ?? '',
    ).trim().slice(0, 1500)
    const row = { waId, phone, fromMe, text, at, name: fromMe ? '' : String(d.pushName ?? '').slice(0, 64) }
    // media = the node exactly as received: decrypt-media needs it. Never log it (holds mediaKey)
    if (msg.audioMessage) {
      out.push({ ...row, text: null, kind: 'voice', seconds: Number(msg.audioMessage.seconds) || 0, media: { key: { id: waId }, message: { audioMessage: msg.audioMessage } } })
    } else if (msg.imageMessage) {
      out.push({ ...row, text: text || null, kind: 'image', media: { key: { id: waId }, message: { imageMessage: msg.imageMessage } } })
    } else if (text) {
      out.push({ ...row, kind: 'text' })
    } else if (msg.videoMessage || msg.documentMessage) {
      out.push({ ...row, text: null, kind: 'other' }) // stickers, reactions, system messages: nothing to answer
    }
  }
  return out
}

export function sameSecret(a, b) {
  if (!a || !b || typeof a !== 'string' || typeof b !== 'string') return false
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

const post = async (fetchImpl, apiKey, path, body) => {
  const res = await fetchImpl(`${WS}/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) }
}

// Retries only on rate limit (429 / retry_after); any other failure is final so we never double-send.
export async function send({ apiKey, to, text, imageUrl, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const target = String(to).includes('@') ? String(to) : `+${digitsOf(to)}`
  let last = { ok: false, status: 0, error: 'no attempt' }
  for (let i = 0; i < 4; i++) {
    let r
    try {
      r = await post(fetchImpl, apiKey, 'send-message', { to: target, text, ...(imageUrl ? { imageUrl } : {}) }) // image: text is its caption
    } catch (e) {
      return { ok: false, status: 0, error: String(e?.message ?? e) }
    }
    if (r.status === 429 || Number(r.body?.retry_after ?? 0) > 0) {
      last = { ok: false, status: r.status, error: String(r.body?.message ?? 'rate limited') }
      if (i < 3) await sleep(6000)
      continue
    }
    if (r.ok) return { ok: true, status: r.status }
    return { ok: false, status: r.status, error: String(r.body?.message ?? `http ${r.status}`).slice(0, 200) }
  }
  return last
}

export async function sendPresence({ apiKey, phone, fetchImpl = fetch }) {
  try {
    await post(fetchImpl, apiKey, 'send-presence-update', { jid: `${digitsOf(phone)}@s.whatsapp.net`, type: 'composing' })
  } catch { /* typing indicator is best effort */ }
}

// How long a person would take to type this bubble: length / chars-per-second, clamped, ±20% jitter.
// ponytail: 4 chars/s is an assumed phone typing speed (not measured); TYPING_CPS / TYPING_MAX_MS are the calibration knobs
export function typingMs(text, { cps = 4, min = 2_000, max = 15_000, rand = Math.random } = {}) {
  const base = Math.min(max, Math.max(min, (String(text ?? '').length / cps) * 1000))
  return Math.round(Math.min(max, Math.max(min, base * (0.8 + 0.4 * rand()))))
}
