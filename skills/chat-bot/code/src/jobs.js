// Scheduled jobs: follow-ups (2 max, money case, opt-out), retention, backup.
// Algeria = UTC+1, no DST.
import { mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { isMeta, META_WINDOW_MS } from './meta.js'

const H = 3_600_000, DAY = 24 * H
export const FIRST_GAP = 24 * H, SECOND_GAP = 48 * H, MONEY_GAP = 30 * DAY
const THINK_GAP = 6 * H // «نخمم» with no time: back in 6 hours (at night the quiet hours make it the next morning)
const MONEY = 'money', PROMISE = 'promise' // promise: the customer gave a time («نشري بعد غدوة على 10»)

// ═══ text ═══
const low = (s) => String(s ?? '').replace(/[٠-٩]/g, (c) => c.charCodeAt(0) - 0x660).replace(/[ً-ْـ]/g, '')
  .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()
const word = (alts) => new RegExp(`(?<!\\p{L})[وف]?(?:${alts})(?!\\p{L})`, 'u')
const OPT_OUT = word('ما ?يهمنيش|ما ?نيش مهتم|ماشي مهتم|ما ?تبعثوليش|ما ?تبعتوليش|ما ?تكتبوليش|ما ?تعاودوش|pas interess\\p{L}*|matb3atlich|matb3tlich|matb3atoulich|matktboulich')
// «no» only when said alone or with thanks: «ما نحبش اللون الأحمر» is about a colour, not «stop writing to me»
const NO_ALTS = 'ما ?نحبش|ma ?(?:n|3)?(?:hebch|habch|7ebch)|ما ?نحتاج(?:ش|وش)|لا شكرا|لا مرسي|ما ?نزيدش|non merci|pas besoin|stop'
const NO = word(NO_ALTS), NO_ALL = new RegExp(word(NO_ALTS).source, 'gu')
const ABOUT_MESSAGES = /تبعث|تبعت|تكتب|رسائل|رسايل|ميساج|messag|envoy|send|[eé]cri/u // «ما نحبش تبعثولي», «stop sending me messages»
const MONEY_OBJ = word('غالي\\p{L}*|مغالي\\p{L}*|زوالي|ما ?عنديش (?:ال)?(?:دراهم|فلوس|مال|صوالح|باش)|ما ?كانش (?:ال)?(?:دراهم|فلوس|مال)|ما ?نقدرش (?:نخلص|ندفع)|ma ?3andi(?:ch|sh) (?:l ?)?(?:drahem|dra7em|flous|flouss|mal|sous)|pas les moyens|(?:trop|tres|très|c est) ch[eè]re?|cher pour moi')
// whole message made only of these words = courtesy (round is kept); anything else is new content.
const COURTESY = new Set(('شكرا جزيلا بزاف ياسر مرسي merci beaucoup bcp ok okay oki اوك اوكي accord dac تمام مليح باهي صافي حاضر ماشي صحيت صحا '
  + 'يعطيك الصحه بارك الله فيك فيكم ربي يحفظك يخليك جزاك خيرا ان شاء انشاء انشالله الحمد لله العفو خويا اختي استاذ استاذه '
  + 'نخمم نفكر نشاور نشوف نعاود نكتبلك نكتبلكم نقولك نقولكم من بعد مبعد plus tard').split(' '))
const QUESTION = /[؟?]|شحال|واش|وش|كيفاش|وين|علاش|combien|comment|quand/
export const optedOut = (t) => {
  const s = low(t)
  if (OPT_OUT.test(s)) return true
  if (!NO.test(s)) return false
  if (ABOUT_MESSAGES.test(s)) return true
  const rest = s.replace(NO_ALL, ' ').trim()
  return !rest || isCourtesy(rest)
}
export const priceObjected = (t) => MONEY_OBJ.test(low(t))
const isCourtesy = (t) => {
  const words = low(t).split(' ').filter((w) => w.length > 1 || /\d/.test(w))
  return !QUESTION.test(t) && words.length > 0 && words.every((w) => COURTESY.has(w) || (w.startsWith('و') && COURTESY.has(w.slice(1))))
}

// ═══ time (Algeria local) ═══
const iso = (now) => new Date(now + H).toISOString()
const dayOf = (now) => iso(now).slice(0, 10)
const hmOf = (now) => iso(now).slice(11, 16)
const hourOf = (now) => Number(hmOf(now).slice(0, 2))
const quiet = (now) => hourOf(now) >= 22 || hourOf(now) < 9
// Instagram / Messenger day-one follow-up: 23 h after the customer's last message, pulled back to 21:30 out of the night
const metaFirst = (now) => {
  const t = now + META_WINDOW_MS
  return quiet(t) ? Date.parse(`${dayOf(hourOf(t) >= 22 ? t : t - DAY)}T21:30:00Z`) - H : t
}

// ═══ schema (idempotent; db.js stays untouched) ═══
const ready = new WeakSet()
export function initJobs(db) {
  const add = (table, col, type) => {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`)
  }
  add('chats', 'follow_kind', 'TEXT')
  ready.add(db)
}
const init = (db) => { if (!ready.has(db)) initJobs(db) }
const getChat = (db, phone) => db.prepare('SELECT * FROM chats WHERE phone = ?').get(phone)

// ═══ follow-up schedule ═══
export function afterBotReply(db, phone, now) {
  init(db)
  const c = getChat(db, phone)
  if (!c || c.handed_off || c.stage === 'ordered' || c.follow_round >= 2) return
  if (c.follow_kind === MONEY || c.follow_kind === PROMISE) return // the 30-day message / the customer's time stay on their date
  // a late reply (a retry) must not push it past Meta's window: count from the customer's message (+30 min of reply time)
  const asked = isMeta(phone) ? db.prepare("SELECT MAX(at) at FROM messages WHERE phone = ? AND role = 'student'").get(phone).at ?? now : now
  db.prepare('UPDATE chats SET follow_at = ? WHERE phone = ?').run(isMeta(phone) ? metaFirst(Math.min(now, asked + 30 * 60_000)) : now + FIRST_GAP, phone)
}

export function afterStudent(db, phone, text, now) {
  init(db)
  const c = getChat(db, phone)
  if (!c) return {}
  const t = String(text ?? '')

  if (optedOut(t)) db.prepare('UPDATE chats SET follow_at = NULL, follow_round = 99, follow_kind = NULL WHERE phone = ?').run(phone)
  else if (c.follow_round >= 99) { /* stays opted out until a human resets it */ }
  else if (priceObjected(t)) db.prepare('UPDATE chats SET follow_at = ?, follow_round = 1, follow_kind = ? WHERE phone = ?').run(now + MONEY_GAP, MONEY, phone)
  else if (isCourtesy(t)) { if (!c.follow_kind) db.prepare('UPDATE chats SET follow_at = NULL WHERE phone = ?').run(phone) }
  else if (c.follow_kind === PROMISE && c.follow_at > now) { /* a question before the time he gave: that reminder stays */ }
  else db.prepare('UPDATE chats SET follow_at = NULL, follow_round = 0, follow_kind = NULL WHERE phone = ?').run(phone)
  return {} // the server reads { handoff } from here; nothing hands off by itself any more
}

// The time the customer gave, Algeria local: days from today + his hour (none = the hour he wrote at), kept within 09:00–21:00.
// No day and no hour (the usual «نخمم ونقولك») = THINK_GAP; an hour alone = today if still ahead, else tomorrow.
export function promiseAt(now, days = null, hour = null, minute = 0) {
  const ok = (v, max) => Number.isInteger(v) && v >= 0 && v <= max
  if (days == null && hour == null) return now + THINK_GAP
  if (days == null) return promiseAt(now, 0, hour, minute) ?? promiseAt(now, 1, hour, minute)
  if (!ok(days, 30) || (hour != null && !ok(hour, 23)) || !ok(minute, 59)) return null
  const h = Math.min(21, Math.max(9, hour ?? hourOf(now))), m = hour == null || h !== hour ? 0 : minute
  const t = Date.parse(`${dayOf(now)}T00:00:00Z`) - H + days * DAY + h * H + m * 60_000
  return t > now + 10 * 60_000 ? t : null
}

// false when the customer asked us to stop writing (round 99), or already ordered (follow-ups never go to those)
export function remindAt(db, phone, when) {
  init(db)
  return db.prepare(`UPDATE chats SET follow_at = ?, follow_round = 0, follow_kind = ? WHERE phone = ? AND follow_round < 99 AND stage IS NOT 'ordered'
    AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.phone = chats.phone AND o.status IN ('confirmed','shipped','delivered'))`).run(when, PROMISE, phone).changes > 0
}

// Claims in one UPDATE ... RETURNING so two ticks can never take the same chat.
export function dueFollowUps(db, now) {
  init(db)
  if (quiet(now)) return []
  return db.prepare(`UPDATE chats SET follow_at = NULL WHERE phone IN (
      SELECT c.phone FROM chats c WHERE c.follow_at <= ? AND c.handed_off = 0 AND c.human_until <= ? AND c.follow_round < 2
        AND c.stage IS NOT 'ordered'
        AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.phone = c.phone AND o.status IN ('confirmed','shipped','delivered'))
        AND (SELECT role FROM messages m WHERE m.phone = c.phone ORDER BY m.at DESC, m.id DESC LIMIT 1) = 'bot'
        AND (substr(c.phone, 1, 3) NOT IN ('fb:', 'ig:') OR (SELECT MAX(at) FROM messages s WHERE s.phone = c.phone AND s.role = 'student') > ?))
    RETURNING phone, follow_round AS round, follow_kind AS kind`).all(now, now, now - META_WINDOW_MS - 30 * 60_000).map((r) => ({ ...r }))
}

// ═══ the question before shipping (fewer refusals at the door) ═══
// The next 10:00 at least 6 h after the order; Instagram / Messenger: before Meta's 24 h from the customer's last message.
export function recheckAt(o, lastStudentAt = o.confirmed_at) {
  const from = o.confirmed_at + 6 * H
  let t = Date.parse(`${dayOf(from)}T10:00:00Z`) - H
  if (t < from) t += DAY
  return isMeta(o.phone) ? Math.min(t, metaFirst(lastStudentAt)) : t
}

// «no answer» 8 h after asking — but not in the night or early morning (he has not seen it yet): then noon
export function silentAt(askedAt) {
  const t = askedAt + 8 * H, h = hourOf(t)
  if (h >= 12 && h < 21) return t
  return Date.parse(`${dayOf(h >= 21 ? t + DAY : t)}T12:00:00Z`) - H
}

// claimed one by one (status and recheck in the WHERE): two ticks never ask twice.
// One question per customer at a time: with two orders waiting, a «لا» could cancel the wrong one.
export function dueRechecks(db, now) {
  init(db)
  if (quiet(now)) return []
  const last = db.prepare("SELECT MAX(at) at FROM messages WHERE phone = ? AND role = 'student'")
  const claim = db.prepare(`UPDATE orders SET recheck = 'asked', recheck_at = ? WHERE id = ? AND status = 'confirmed' AND recheck IS NULL
    AND NOT EXISTS (SELECT 1 FROM orders w WHERE w.phone = orders.phone AND w.status = 'confirmed' AND w.recheck = 'asked')`)
  return db.prepare("SELECT * FROM orders WHERE status = 'confirmed' AND recheck IS NULL ORDER BY id").all()
    .filter((o) => recheckAt(o, last.get(o.phone).at ?? o.confirmed_at) <= now && claim.run(now, o.id).changes)
    .map((o) => ({ ...o }))
}

// ═══ retention + backup ═══
export function retention(db, now, days = 60) {
  init(db)
  const cut = now - days * DAY
  return {
    messages: Number(db.prepare('DELETE FROM messages WHERE at < ?').run(cut).changes),
    guard_log: Number(db.prepare('DELETE FROM guard_log WHERE at < ?').run(cut).changes),
    ai_calls: Number(db.prepare('DELETE FROM ai_calls WHERE at < ?').run(cut).changes), // carries the customer number
  }
}

export function backup(db, dir, now) {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `bot-${dayOf(now)}.db`)
  if (!existsSync(file)) db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`)
  const all = readdirSync(dir).filter((f) => /^bot-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort()
  for (const f of all.slice(0, -7)) unlinkSync(join(dir, f))
  return file
}

// ═══ notes for the model (answer({ note })) ═══
export const followNote = ({ round, kind }) => kind === MONEY
  ? 'مرّ شهر منذ قال الزبون إن الدراهم لا تسمح. هذه الرسالة الوحيدة: جملة أو جملتان بلا ضغط، تطمئن عليه، وإن أراد يكتب لنا متى شاء. بلا سؤال، بلا عروض، بلا أسعار.'
  : kind === PROMISE
    ? 'الزبون قال إنه يفكر أو يقرر لاحقاً (كلامه في المحادثة)، وهذا وقت الرجوع له. ذكّره بلطف بالمنتج الذي سأل عنه بالاسم، واسأله سؤالاً واحداً: واش قرر، أو إن كان عنده سؤال يعاونه يقرر. بلا ضغط ولا عروض.'
    : round === 0
      ? 'مرّ يوم ولم يرد الزبون. رسالة قصيرة بلا ضغط: ذكّره بالمنتج الذي سأل عنه بالاسم، واسأله سؤالاً واحداً: هل مازال مهتماً؟ بلا عروض، ولا تعد ملخصاً ولا قائمة.'
      : 'هذه آخر رسالة متابعة: جملة أو جملتان لطيفتان تذكّره بالمنتج بالاسم، وإن مازال حابه يكفي يكتبلنا. بلا سؤال ولا ضغط ولا عروض.'

// ═══ runner ═══
export function startJobs({ db, writeAndSend, recheckSend = null, alertAgent = async () => {}, backupDir = './backups', every = 60_000, now = () => Date.now() }) {
  init(db)
  let busy = false, lastDay = null
  const guard = async (name, fn) => {
    try { await fn() } catch (e) { console.error(`job ${name} failed:`, e?.message ?? e); try { await alertAgent(`مهمة مجدولة فشلت: ${name}`) } catch {} }
  }
  const tick = async () => {
    if (busy) return
    busy = true
    try {
      const t = now()
      await guard('follow-up', async () => {
        for (const f of dueFollowUps(db, t)) {
          const ok = await writeAndSend(f.phone, followNote(f))
          // claimed (follow_at null): a nudge is dropped; the time we promised the customer is tried again in 30 min
          if (!ok) { if (f.kind === PROMISE) db.prepare("UPDATE chats SET follow_at = ? WHERE phone = ? AND follow_kind = 'promise' AND follow_round = 0 AND follow_at IS NULL").run(t + 30 * 60_000, f.phone); continue }
          if (f.kind === MONEY || f.round >= 1) db.prepare('UPDATE chats SET follow_round = 2, follow_at = NULL WHERE phone = ? AND follow_round = ?').run(f.phone, f.round)
          else db.prepare('UPDATE chats SET follow_round = 1, follow_at = ?, follow_kind = NULL WHERE phone = ? AND follow_round = 0 AND follow_at IS NULL').run(t + SECOND_GAP, f.phone)
        }
      })
      if (recheckSend) {
        await guard('recheck', async () => {
          for (const o of dueRechecks(db, t)) {
            let ok = false
            try { ok = await recheckSend(o) } catch (e) { console.error(`recheck #${o.id} failed:`, e?.message) }
            if (!ok) db.prepare("UPDATE orders SET recheck = 'failed' WHERE id = ?").run(o.id) // the owner phones (dashboard)
          }
          for (const o of db.prepare("SELECT id, recheck_at FROM orders WHERE recheck = 'asked'").all()) {
            if (silentAt(o.recheck_at) <= t) db.prepare("UPDATE orders SET recheck = 'silent' WHERE id = ? AND recheck = 'asked'").run(o.id)
          }
        })
      }
      if (dayOf(t) !== lastDay) {
        lastDay = dayOf(t)
        await guard('retention', async () => { retention(db, t) })
        await guard('backup', async () => { backup(db, backupDir, t) })
      }
    } finally { busy = false }
  }
  const timer = setInterval(tick, every)
  timer.unref?.()
  return () => clearInterval(timer)
}
