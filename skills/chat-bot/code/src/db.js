import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chats(
  phone TEXT PRIMARY KEY, name TEXT, stage TEXT DEFAULT 'new', human_until INTEGER DEFAULT 0,
  handed_off INTEGER DEFAULT 0, handoff_reason TEXT, follow_at INTEGER, follow_round INTEGER DEFAULT 0, created_at INTEGER);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY, wa_id TEXT UNIQUE, phone TEXT,
  role TEXT CHECK(role IN ('student','bot','human')), text TEXT, at INTEGER, status TEXT);
CREATE INDEX IF NOT EXISTS messages_phone_at ON messages(phone, at);
CREATE TABLE IF NOT EXISTS costs(day TEXT PRIMARY KEY, usd REAL DEFAULT 0);
CREATE TABLE IF NOT EXISTS alerts(key TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS guard_log(id INTEGER PRIMARY KEY, phone TEXT, guard TEXT, action TEXT, at INTEGER);
CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY, phone TEXT, items TEXT, name TEXT, customer_phone TEXT, wilaya_n INTEGER, wilaya TEXT,
  address TEXT, delivery TEXT CHECK(delivery IN ('home','office')), fee INTEGER, total INTEGER,
  status TEXT DEFAULT 'draft' CHECK(status IN ('draft','confirmed','shipped','delivered','cancelled','returned')),
  created_at INTEGER, confirmed_at INTEGER);
CREATE INDEX IF NOT EXISTS orders_phone ON orders(phone, id);
CREATE TABLE IF NOT EXISTS ai_calls(id INTEGER PRIMARY KEY, phone TEXT, at INTEGER, kind TEXT, input INTEGER, output INTEGER,
  cache_read INTEGER, cache_write INTEGER, usd REAL);
`

const CHAT_COLS = ['name', 'stage', 'human_until', 'handed_off', 'handoff_reason', 'follow_at', 'follow_round']

export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path)
  if (path !== ':memory:') db.exec('PRAGMA journal_mode=WAL')
  db.exec('PRAGMA foreign_keys=ON')
  db.exec(SCHEMA)
  // media = the product photo file a bot row sent (its text is the caption)
  if (!db.prepare('PRAGMA table_info(messages)').all().some((c) => c.name === 'media')) db.exec('ALTER TABLE messages ADD COLUMN media TEXT')
  // recheck = the question before shipping: asked / yes / no / silent (no answer in 8 h) / failed (did not reach him)
  if (!db.prepare('PRAGMA table_info(orders)').all().some((c) => c.name === 'recheck')) {
    db.exec('ALTER TABLE orders ADD COLUMN recheck TEXT; ALTER TABLE orders ADD COLUMN recheck_at INTEGER')
    db.exec("UPDATE orders SET recheck = 'old' WHERE status != 'draft'") // orders before this feature: never asked (no burst on deploy)
  }
  return db
}

export function ensureChat(db, phone, name) {
  db.prepare('INSERT OR IGNORE INTO chats(phone, name, created_at) VALUES (?, ?, ?)').run(phone, name ?? null, Date.now())
  if (name) db.prepare('UPDATE chats SET name = ? WHERE phone = ? AND name IS NULL').run(name, phone)
}

export const getChat = (db, phone) => db.prepare('SELECT * FROM chats WHERE phone = ?').get(phone)

export function setChat(db, phone, fields) {
  const keys = Object.keys(fields)
  for (const k of keys) if (!CHAT_COLS.includes(k)) throw new Error(`unknown chat column: ${k}`)
  if (!keys.length) return
  db.prepare(`UPDATE chats SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE phone = ?`).run(...keys.map((k) => fields[k]), phone)
}

// Returns the new row id, or null when waId was already stored (idempotency).
export function addMessage(db, { waId = null, phone, role, text, at = Date.now(), status = null, media = null }) {
  const r = db.prepare('INSERT OR IGNORE INTO messages(wa_id, phone, role, text, at, status, media) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(waId, phone, role, text, at, status, media)
  return r.changes ? Number(r.lastInsertRowid) : null
}

// A fromMe event is the echo of our own send if an unclaimed bot/human row with the same text is recent
// (10 min: the global send queue can delay a bubble for minutes). A photo may come back without its caption: matched as a photo.
export function claimEcho(db, { phone, text, image = false, waId, now = Date.now() }) {
  if (!text && !image) return false
  // a captionless photo: only our own photo still on its way or sent, never a failed one (a real photo from the owner's phone)
  const [match, ...arg] = text ? ['text = ?', text] : ["role = 'bot' AND media IS NOT NULL AND status IN ('pending','sent')"]
  const row = db.prepare(`SELECT id FROM messages WHERE phone = ? AND role IN ('bot','human') AND ${match}
    AND wa_id IS NULL AND at >= ? ORDER BY at DESC, id DESC LIMIT 1`).get(phone, ...arg, now - 10 * 60_000)
  if (!row) return false
  // the echo proves a send that timed out did go out: «failed» would make the sweep send a second reply
  return db.prepare("UPDATE messages SET wa_id = ?, status = CASE status WHEN 'failed' THEN 'sent' ELSE status END WHERE id = ? AND wa_id IS NULL").run(waId, row.id).changes > 0
}

// Unsent (pending/failed) bot bubbles are not part of what the student saw.
export function history(db, phone, limit = 30) {
  return db.prepare(`SELECT role, text, at, media FROM (
    SELECT id, role, text, at, media FROM messages WHERE phone = ? AND text IS NOT NULL AND (status IS NULL OR status = 'sent') ORDER BY at DESC, id DESC LIMIT ?
  ) ORDER BY at, id`).all(phone, limit).map((r) => ({ role: r.role, text: r.media ? `[صورة] ${r.text}` : r.text, at: r.at }))
}

// One draft per chat: a new draft overwrites the old one in place (same id). Confirmed orders are never touched.
export function saveDraft(db, { phone, items, name, customerPhone, wilayaN, wilaya, address, delivery, fee, total }) {
  const vals = [JSON.stringify(items), name, customerPhone, wilayaN, wilaya, address, delivery, fee, total]
  const old = db.prepare("SELECT id FROM orders WHERE phone = ? AND status = 'draft' ORDER BY id DESC LIMIT 1").get(phone)
  if (old) {
    db.prepare('UPDATE orders SET items = ?, name = ?, customer_phone = ?, wilaya_n = ?, wilaya = ?, address = ?, delivery = ?, fee = ?, total = ? WHERE id = ?').run(...vals, old.id)
    return old.id
  }
  return Number(db.prepare(`INSERT INTO orders(items, name, customer_phone, wilaya_n, wilaya, address, delivery, fee, total, phone, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...vals, phone, Date.now()).lastInsertRowid)
}

// a draft older than 24 h is stale: a «نعم» days later must not confirm a forgotten summary
export const latestDraft = (db, phone, now = Date.now()) =>
  db.prepare("SELECT * FROM orders WHERE phone = ? AND status = 'draft' AND created_at > ? ORDER BY id DESC LIMIT 1").get(phone, now - 86_400_000)

export const confirmOrder = (db, id, at = Date.now()) =>
  db.prepare("UPDATE orders SET status = 'confirmed', confirmed_at = ? WHERE id = ? AND status = 'draft'").run(at, id).changes > 0

export const addCost = (db, usd, day) =>
  void db.prepare('INSERT INTO costs(day, usd) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET usd = usd + excluded.usd').run(day, usd)

// true the first time a key is seen: an alert once per key, even across restarts (keys carry the day)
export const firstTime = (db, key) => db.prepare('INSERT OR IGNORE INTO alerts(key) VALUES (?)').run(key).changes > 0

export const costOn = (db, day) => db.prepare('SELECT usd FROM costs WHERE day = ?').get(day)?.usd ?? 0

export const logGuard = (db, { phone, guard, action, at = Date.now() }) =>
  void db.prepare('INSERT INTO guard_log(phone, guard, action, at) VALUES (?, ?, ?, ?)').run(phone, guard, action, at)
