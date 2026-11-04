import { readFileSync } from 'node:fs'
import { isMeta, META_WINDOW_MS } from './meta.js'
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 24 * HOUR
const SESSION_MS = 7 * DAY
const HUMAN_QUIET = 20 * MIN
const BODY_LIMIT = 64 * 1024
const MAX_FAILS = 5
const FAIL_WINDOW = 15 * MIN
const INDEX = readFileSync(new URL('../public/index.html', import.meta.url))

const sha = (s) => createHash('sha256').update(String(s)).digest()
const sameSecret = (a, b) => timingSafeEqual(sha(a), sha(b))

export class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status }
}

export function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new HttpError(413, 'too large')); req.pause() } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export async function readJson(req, limit = BODY_LIMIT) {
  if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) throw new HttpError(415, 'content-type')
  const buf = await readBody(req, limit)
  try {
    const v = JSON.parse(buf.toString('utf8') || '{}')
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw 0
    return v
  } catch { throw new HttpError(400, 'bad json') }
}

export function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
  res.end(JSON.stringify(body))
}

const cookieOf = (req, name) => {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return null
}

// handoff reasons in Arabic: internal codes (guard:number) and English model text never reach the screen
export const reasonLabel = (r) => !r ? '' : r.startsWith('guard:') ? 'رد فيه معلومة ليست في البطاقة'
  : /[a-z]/i.test(r) ? 'سبب آخر، راجع المحادثة' : r

export function dashboard({ db, say, card, saveCard = () => {}, password, secureCookie = false, now = () => Date.now() }) {
  const sessions = new Map() // token -> expiry. ponytail: in-memory, logins lost on restart; fine for one agent
  const fails = new Map() // ip -> failure timestamps. ponytail: never pruned for idle IPs; tiny
  const ip = (req) => String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || '?'

  const authed = (req) => {
    const t = cookieOf(req, 's')
    const exp = t && sessions.get(t)
    if (!exp) return false
    if (exp < now()) { sessions.delete(t); return false }
    return true
  }

  // Algeria = UTC+1, no DST
  const dayStart = () => Math.floor((now() + HOUR) / DAY) * DAY - HOUR

  const q = (sql, ...p) => db.prepare(sql).all(...p).map((r) => ({ ...r }))
  const one = (sql, ...p) => { const r = db.prepare(sql).get(...p); return r ? { ...r } : undefined }

  // ponytail: orders has no shipped_at, so the three order numbers count orders CONFIRMED in the range by their status now
  function numbers(from) {
    const o = one(`SELECT COUNT(*) n, COALESCE(SUM(status IN ('shipped','delivered')),0) s, COALESCE(SUM(status = 'delivered'),0) d,
      COALESCE(SUM(CASE WHEN status = 'delivered' THEN total END),0) m FROM orders WHERE confirmed_at >= ?`, from)
    const statuses = { confirmed: 0, shipped: 0, delivered: 0, returned: 0, cancelled: 0 } // the ring on the home page
    for (const r of q('SELECT status, COUNT(*) n FROM orders WHERE confirmed_at >= ? GROUP BY status', from)) if (r.status in statuses) statuses[r.status] = r.n
    return {
      conversations: one('SELECT COUNT(*) n FROM chats WHERE created_at >= ?', from).n,
      confirmed: o.n, shipped: o.s, delivered: o.d, amount: o.m, statuses,
    }
  }

  const MOVES = { confirmed: ['shipped', 'cancelled'], shipped: ['delivered', 'returned', 'cancelled'] }
  const RANK = "CASE status WHEN 'confirmed' THEN 0 WHEN 'shipped' THEN 1 ELSE 2 END"
  function orders() {
    // refused = returned orders of the same customer (his number or his chat): the client decides before shipping
    return q(`SELECT id, phone, items, name, customer_phone, wilaya, delivery, total, status, confirmed_at, recheck,
      (SELECT COUNT(*) FROM orders r WHERE r.status = 'returned' AND r.id != o.id AND (r.customer_phone = o.customer_phone OR r.phone = o.phone)) refused
      FROM orders o WHERE status IN ('confirmed', 'shipped') OR (status NOT IN ('draft', 'confirmed', 'shipped') AND confirmed_at >= ?) ORDER BY ${RANK}, confirmed_at DESC, id DESC`, now() - 30 * DAY)
      .map((o) => ({ ...o, items: (() => { try { return JSON.parse(o.items) } catch { return [] } })() }))
  }

  // «on its way»: the customer knows the parcel is coming and how much to have ready (fewer refusals at the door)
  // returns what the owner must do himself, or '' when the message went to the queue
  function onTheWay(id) {
    const o = one('SELECT phone, total, customer_phone FROM orders WHERE id = ?', id)
    // Instagram / Messenger refuse any message 24 h after the customer's last one: the owner phones him instead
    const last = one("SELECT MAX(at) at FROM messages WHERE phone = ? AND role = 'student'", o.phone)?.at ?? 0
    if (isMeta(o.phone) && now() - last > META_WINDOW_MS) return `إنستغرام وماسنجر لا يسمحان برسالة بعد 24 ساعة: اتصل بالزبون على ${o.customer_phone} وقل له إن طلبيته خرجت.`
    const delay = card?.delivery?.delay
    say(o.phone, `طلبيتك رقم ${id} خرجت للتوصيل 📦\n${delay ? `توصلك ${delay}، و` : ''}المبلغ ${o.total} دج تخلصو عند الاستلام.\nخلّي هاتفك مفتوح باش يعيطلك الموصّل.`, 'bot')
      .then((ok) => { if (!ok) console.error(`order #${id}: on-its-way message not delivered`) }, (e) => console.error(`order #${id}: on-its-way message failed`, e?.message))
    return ''
  }

  // the orders to ship, as a spreadsheet file for the delivery company (BOM: Excel reads Arabic right)
  const RECHECK = { yes: 'أكد', asked: 'ينتظر رده', silent: 'لم يرد', failed: 'السؤال لم يصل' }
  function sendCsv(res) {
    const cell = (v) => {
      const s = String(v ?? '').replace(/^[=+\-@\t\r]/, "'$&") // a name like «=…» must not run as a formula (OWASP list)
      return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const day = (ms) => new Date(ms + HOUR).toISOString().slice(0, 16).replace('T', ' ') // Algeria = UTC+1
    const rows = q("SELECT id, items, name, customer_phone, wilaya, wilaya_n, address, delivery, total, confirmed_at FROM orders WHERE status = 'confirmed' ORDER BY id")
      .map((o) => {
        let items = []; try { items = JSON.parse(o.items) } catch { /* shown empty */ }
        const prods = items.map((i) => `${i.name}${Object.keys(i.variant ?? {}).length ? ` ${Object.values(i.variant).join(' ')}` : ''} × ${i.qty}`).join('؛ ')
        return [o.id, day(o.confirmed_at), o.name, o.customer_phone, o.wilaya, o.wilaya_n, o.address, o.delivery === 'office' ? 'مكتب' : 'منزل', prods, o.total, RECHECK[o.recheck] ?? '']
      })
    const csv = [['رقم الطلب', 'التاريخ', 'الاسم', 'الهاتف', 'الولاية', 'رقم الولاية', 'العنوان', 'التوصيل', 'المنتجات', 'المجموع (دج)', 'تأكيد الشحن'], ...rows]
      .map((r) => r.map(cell).join(';')).join('\r\n') // ponytail: «;» assumes Excel in French/Algerian settings — check on the client's PC
    const date = day(now()).slice(0, 10)
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store',
      'content-disposition': `attachment; filename="orders-${date}.csv"; filename*=UTF-8''${encodeURIComponent(`طلبات-${date}.csv`)}`,
    })
    res.end('\ufeff' + csv + '\r\n')
  }

  function state() {
    const waiting = q(`SELECT c.phone, c.name, c.handoff_reason reason,
        (SELECT text FROM messages m WHERE m.phone = c.phone AND m.text IS NOT NULL ORDER BY m.at DESC, m.id DESC LIMIT 1) last,
        COALESCE((SELECT MAX(at) FROM messages m WHERE m.phone = c.phone), c.created_at, 0) at
      FROM chats c WHERE c.handed_off = 1 ORDER BY at DESC`)
    for (const w of waiting) { w.last = (w.last ?? '').slice(0, 120); w.reason = reasonLabel(w.reason) }
    const today = dayStart()
    // the chart: orders confirmed each Algeria day, the last 7 days oldest first (counted as numbers() counts them)
    const days = Array.from({ length: 7 }, (_, i) => today - (6 - i) * DAY).map((from) => ({
      day: new Date(from + HOUR).toISOString().slice(0, 10),
      orders: one('SELECT COUNT(*) n FROM orders WHERE confirmed_at >= ? AND confirmed_at < ?', from, from + DAY).n,
    }))
    return {
      shop: card?.shop ?? '',
      waiting,
      numbers: { today: numbers(today), week: numbers(today - 6 * DAY) },
      days,
      toShip: one("SELECT COUNT(*) n FROM orders WHERE status = 'confirmed'").n,
    }
  }

  const phoneOf = (b) => {
    if (typeof b.phone !== 'string' || !b.phone || b.phone.length > 64) throw new HttpError(400, 'phone')
    if (!one('SELECT 1 x FROM chats WHERE phone = ?', b.phone)) throw new HttpError(404, 'no chat')
    return b.phone
  }

  async function api(req, res, url) {
    const path = url.pathname
    if (path === '/api/login' && req.method === 'POST') {
      const b = await readJson(req)
      const t = now()
      const key = ip(req)
      const recent = (fails.get(key) ?? []).filter((x) => x > t - FAIL_WINDOW)
      fails.set(key, recent)
      if (recent.length >= MAX_FAILS) return send(res, 429, { error: 'too many attempts' })
      if (!password || typeof b.password !== 'string' || !sameSecret(b.password, password)) {
        recent.push(t)
        return send(res, 401, { error: 'wrong password' })
      }
      const token = randomBytes(32).toString('hex')
      sessions.set(token, t + SESSION_MS)
      return send(res, 200, { ok: true }, {
        'set-cookie': `s=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secureCookie ? '; Secure' : ''}`,
      })
    }
    if (!authed(req)) return send(res, 401, { error: 'login required' })

    if (req.method === 'GET') {
      if (path === '/api/state') return send(res, 200, state())
      if (path === '/api/orders') return send(res, 200, { orders: orders() })
      if (path === '/api/orders.csv') return sendCsv(res)
      if (path === '/api/stock') {
        return send(res, 200, {
          products: (card?.products ?? []).map((p) => ({
            id: p.id, name: p.name, out: !!p.out,
            variants: Object.fromEntries(Object.entries(p.variants ?? {}).map(([k, vs]) => [k, vs.map((v) => ({ v, out: !!p.soldOut?.[k]?.includes(v) }))])),
          })),
        })
      }
      if (path === '/api/chat') {
        const phone = url.searchParams.get('phone') ?? ''
        const chat = one('SELECT * FROM chats WHERE phone = ?', phone)
        if (!chat) return send(res, 404, { error: 'no chat' })
        return send(res, 200, {
          chat,
          messages: q('SELECT role, text, at, status, media FROM messages WHERE phone = ? AND text IS NOT NULL ORDER BY at, id', phone),
          orders: orders().filter((o) => o.phone === phone),
        })
      }
      return send(res, 404, { error: 'not found' })
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'method' })

    const b = await readJson(req)
    if (path === '/api/logout') {
      const t = cookieOf(req, 's'); sessions.delete(t)
      return send(res, 200, { ok: true }, { 'set-cookie': `s=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie ? '; Secure' : ''}` })
    }
    if (path === '/api/reply') {
      const phone = phoneOf(b)
      const text = typeof b.text === 'string' ? b.text.trim() : ''
      if (!text || text.length > 1500 || (isMeta(phone) && Buffer.byteLength(text) > 1000)) throw new HttpError(400, 'text') // Instagram: 1000 bytes
      if ((await say(phone, text, 'human')) === false) throw new HttpError(502, 'send failed')
      db.prepare('UPDATE chats SET handed_off = 0, human_until = ? WHERE phone = ?').run(now() + HUMAN_QUIET, phone)
      return send(res, 200, { ok: true })
    }
    // the customer asked to delete his data (the privacy page promises it): his messages and AI logs go; confirmed orders stay for accounting
    if (path === '/api/forget') {
      const phone = phoneOf(b)
      for (const t of ['messages', 'ai_calls', 'guard_log']) db.prepare(`DELETE FROM ${t} WHERE phone = ?`).run(phone)
      db.prepare('UPDATE chats SET name = NULL WHERE phone = ?').run(phone)
      return send(res, 200, { ok: true })
    }
    if (path === '/api/release') {
      db.prepare('UPDATE chats SET handed_off = 0, human_until = 0 WHERE phone = ?').run(phoneOf(b))
      return send(res, 200, { ok: true })
    }
    if (path === '/api/order') {
      if (!Number.isInteger(b.id)) throw new HttpError(400, 'id')
      const o = one('SELECT status FROM orders WHERE id = ?', b.id)
      if (!o) throw new HttpError(404, 'no order')
      if (!MOVES[o.status]?.includes(b.status)) throw new HttpError(400, 'status')
      // the status in WHERE: two clicks cannot both move the same order
      if (!db.prepare('UPDATE orders SET status = ? WHERE id = ? AND status = ?').run(b.status, b.id, o.status).changes) throw new HttpError(400, 'status')
      const notice = b.status === 'shipped' ? onTheWay(b.id) : '' // the send is not awaited: the 5 s queue must not hold the click
      return send(res, 200, { ok: true, notice })
    }
    if (path === '/api/stock') {
      const p = (card?.products ?? []).find((x) => x.id === b.id)
      if (!p || typeof b.out !== 'boolean') throw new HttpError(400, 'stock')
      if (b.key === undefined) {
        if (b.out) p.out = true; else delete p.out
      } else {
        if (!Object.hasOwn(p.variants ?? {}, b.key) || !p.variants[b.key].includes(b.value)) throw new HttpError(400, 'stock')
        const rest = (p.soldOut?.[b.key] ?? []).filter((v) => v !== b.value)
        p.soldOut = { ...p.soldOut, [b.key]: b.out ? [...rest, b.value] : rest }
        if (!p.soldOut[b.key].length) delete p.soldOut[b.key]
        if (!Object.keys(p.soldOut).length) delete p.soldOut
      }
      saveCard()
      return send(res, 200, { ok: true })
    }
    return send(res, 404, { error: 'not found' })
  }

  return async function handle(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(INDEX)
      return true
    }
    if (!url.pathname.startsWith('/api/')) return false
    try { await api(req, res, url) } catch (e) {
      if (e instanceof HttpError) send(res, e.status, { error: e.message })
      else { console.error('dashboard error', e?.message); send(res, 500, { error: 'server error' }) }
    }
    return true
  }
}
