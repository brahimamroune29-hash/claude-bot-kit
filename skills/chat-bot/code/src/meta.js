// Instagram DMs and Messenger through the shop's Facebook Page: one Page token, one webhook, one app secret.
// Route chosen 2026-11-01 from Meta's docs: «Facebook Login + Page» serves both (the Instagram-Login route needs a
// second token refreshed every 60 days). Chats are «fb:<PSID>» / «ig:<IGSID>»; messages come out in the WhatsApp shape.
import { createHmac, timingSafeEqual } from 'node:crypto'

const GRAPH = 'https://graph.facebook.com/v26.0'
const MAX_AGE_MS = 24 * 3_600_000 // Meta retries after our downtime; past 24 h its reply window is closed anyway
export const isMeta = (id) => /^(?:fb|ig):/.test(String(id ?? ''))
// Meta allows no message 24 h after the customer's last one: we keep 1 h of margin
export const META_WINDOW_MS = 23 * 3_600_000

// X-Hub-Signature-256: «sha256=<hex>», HMAC of the raw body with the app secret
export function metaSigned(raw, header, secret) {
  if (!secret || typeof header !== 'string' || !header.startsWith('sha256=')) return false
  const want = Buffer.from(createHmac('sha256', secret).update(raw).digest('hex')), got = Buffer.from(header.slice(7))
  return got.length === want.length && timingSafeEqual(got, want)
}

// only Meta's own CDN is downloaded
const URL_OK = (u) => { try { return /(^|\.)(fbcdn\.net|fbsbx\.com|cdninstagram\.com|facebook\.com|instagram\.com)$/.test(new URL(u).hostname) && u.startsWith('https://') ? u : null } catch { return null } }
export function parseMeta(body, now = Date.now()) {
  const pre = body?.object === 'page' ? 'fb' : body?.object === 'instagram' ? 'ig' : null
  if (!pre) return []
  const out = []
  for (const e of (Array.isArray(body.entry) ? body.entry : []).slice(0, 40)) {
    for (const ev of (Array.isArray(e?.messaging) ? e.messaging : []).slice(0, 40)) {
      const m = ev?.message
      if (!m?.mid || m.is_deleted || m.is_unsupported) continue // reactions, reads, postbacks, ad clicks alone: nothing to answer
      const fromMe = m.is_echo === true
      // an echo (our send, or the owner typing in the Page inbox) is addressed to the customer
      const who = String((fromMe ? ev.recipient?.id : ev.sender?.id) ?? '')
      const at = Number(ev.timestamp) || now
      if (!/^\d+$/.test(who) || now - at > MAX_AGE_MS) continue
      const row = { waId: String(m.mid), phone: `${pre}:${who}`, fromMe, text: String(m.text ?? '').trim().slice(0, 1500), at, name: '' }
      const a = Array.isArray(m.attachments) ? m.attachments[0] : null, url = URL_OK(a?.payload?.url)
      const media = url ? { url } : {}
      if (a?.type === 'audio') out.push({ ...row, text: null, kind: 'voice', ...media })
      else if (a?.type === 'image' || a?.type === 'share') out.push({ ...row, text: row.text || null, kind: 'image', ...media }) // a shared post = its photo
      else if (row.text) out.push({ ...row, kind: 'text' })
      else if (['video', 'file', 'reel', 'ig_reel'].includes(a?.type)) out.push({ ...row, text: null, kind: 'other' })
      // story mentions, ephemeral media, stickers without a photo: nothing to answer
    }
  }
  return out
}

const call = async (fetchImpl, token, body) => {
  const res = await fetchImpl(`${GRAPH}/me/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
  return res.ok ? { ok: true, status: res.status }
    : { ok: false, status: res.status, error: String((await res.json().catch(() => ({})))?.error?.message ?? `http ${res.status}`).slice(0, 200) }
}

// A photo goes alone (Meta has no caption): the caller sends the caption as its own text.
export async function sendMeta({ token, to, text, imageUrl, fetchImpl = fetch }) {
  const message = imageUrl ? { attachment: { type: 'image', payload: { url: imageUrl, is_reusable: true } } } : { text }
  try {
    return await call(fetchImpl, token, { recipient: { id: String(to).slice(3) }, messaging_type: 'RESPONSE', message })
  } catch (e) {
    return { ok: false, status: 0, error: String(e?.message ?? e).slice(0, 200) }
  }
}

export async function metaTyping({ token, to, fetchImpl = fetch }) {
  try { await call(fetchImpl, token, { recipient: { id: String(to).slice(3) }, sender_action: 'typing_on' }) } catch { /* best effort */ }
}

// Instagram takes 1000 bytes a message (an Arabic letter is 2): split on lines, a longer line on letters.
export function fitBytes(text, max = 1000) {
  const out = []
  let cur = ''
  const push = (s) => { if (s) out.push(s) }
  for (const line of String(text ?? '').split('\n')) {
    const next = cur ? `${cur}\n${line}` : line
    if (Buffer.byteLength(next) <= max) { cur = next; continue }
    push(cur); cur = ''
    let piece = ''
    for (const ch of line) {
      if (Buffer.byteLength(piece + ch) > max) { push(piece); piece = '' }
      piece += ch
    }
    cur = piece
  }
  push(cur)
  return out.length ? out : ['']
}

// The page Meta asks for (privacy policy + data deletion instructions), from the card.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
export function privacyPage(card) {
  const shop = esc(card?.shop || 'المتجر'), phone = esc(card?.phone || '')
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${shop} — سياسة الخصوصية</title><style>body{font:16px/1.7 system-ui,sans-serif;max-width:720px;margin:24px auto;padding:0 16px;color:#222}h2{margin-top:28px}</style></head><body>
<h1>${shop} — سياسة الخصوصية</h1>
<p>نجيب على رسائلكم في واتساب وإنستغرام وماسنجر بمساعد آلي، ونأخذ طلباتكم للتوصيل والدفع عند الاستلام.</p>
<h2>ما نحفظه ولماذا</h2>
<p>نص رسائلكم معنا (والفويس محوّلاً إلى نص)، واسمكم ورقم هاتفكم وعنوانكم حين تطلبون، لنجيب ونوصل الطلبية فقط. لا نبيع شيئاً منها ولا نستعملها للإعلانات.</p>
<p>الرسائل تُحذف وحدها بعد 60 يوماً. الطلبيات تبقى للمحاسبة والتوصيل.</p>
<h2>من يراها</h2>
<p>صاحب المتجر، وشركة التوصيل (الاسم والهاتف والعنوان فقط)، ومزوّدو الذكاء الاصطناعي الذين يكتبون الرد أو يحوّلون الفويس إلى نص، لهذا الغرض فقط.</p>
<h2>حذف بياناتكم</h2>
<p>اكتبوا لنا «احذف بياناتي» في نفس المحادثة${phone ? ` أو اتصلوا على ${phone}` : ''}، فيحذف صاحب المتجر رسائلكم وبياناتكم من النظام خلال 30 يوماً. الطلبيات التي أكدتموها تبقى للمحاسبة.</p>
</body></html>`
}
