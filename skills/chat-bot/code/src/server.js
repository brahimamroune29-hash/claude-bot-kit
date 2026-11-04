import http from 'node:http';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  openDb, ensureChat, getChat, setChat, addMessage, claimEcho, history,
  addCost, costOn, logGuard, firstTime,
} from './db.js';
import { parseWasender, sameSecret, send, sendPresence, typingMs } from './wa.js';
import { answer, splitReply, orBalance, studentScript } from './brain.js';
import { orderTools, pendingSummary, recheckText, recheckPending, checkCard } from './shop.js';
import { dashboard, reasonLabel } from './dashboard.js';
import { initJobs, startJobs, afterStudent, afterBotReply } from './jobs.js';
import { tryRoutes } from './try.js';
import { voiceText, fetchUrl, mediaRoutes } from './media.js';
import { parseMeta, metaSigned, sendMeta, metaTyping, fitBytes, isMeta, privacyPage } from './meta.js';

const env = process.env;
const MIN = 60_000;
const HUMAN_QUIET = 20 * MIN;
const SEND_GAP = Number(env.SEND_GAP_MS ?? 5000); // Wasender account protection: 1 send / 5s
const TYPING = { cps: Number(env.TYPING_CPS ?? 4), max: Number(env.TYPING_MAX_MS ?? 15_000) };
const cardPath = env.CARD_PATH ?? './card.json';
const mediaDir = env.MEDIA_DIR ?? './media';
// the owner edits card.json by hand: a broken card stops the boot with the reason, never a half-working bot
let card;
try { card = JSON.parse(readFileSync(cardPath, 'utf8')); } catch (e) {
  console.error(`card.json cannot be read (${cardPath}): ${e.message}`);
  process.exit(1);
}
const cardProblems = checkCard(card, name => existsSync(join(mediaDir, name)));
if (cardProblems.length) { console.error(`card.json needs fixing:\n${cardProblems.join('\n')}`); process.exit(1); }

const production = env.NODE_ENV === 'production';
if (card.test && production) {
  console.error('card.json is a TEST card ("test": true) — refusing to run in production: put the real shop in it and remove "test"');
  process.exit(1);
}
// keys not there yet: the bot runs, stores messages and stays silent (/health says so) until they are set
const missingKeys = ['WASENDER_API_KEY', 'WASENDER_WEBHOOK_SECRET', 'OPENROUTER_API_KEY'].filter(k => !env[k]);
const silent = () => production && missingKeys.length > 0;
const META = ['META_PAGE_TOKEN', 'META_APP_SECRET', 'META_VERIFY_TOKEN'];
const metaOn = !!env.META_PAGE_TOKEN;
const dryRun = env.DRY_RUN === '1';
// production is the real thing: keys set, client data under data/ (deploy.sh replaces everything else), no test page
if (production) {
  const problems = [
    ...((env.DASHBOARD_PASSWORD ?? '').length < 12 ? ['DASHBOARD_PASSWORD must be 12+ characters'] : []),
    ...['DB_PATH', 'CARD_PATH', 'MEDIA_DIR', 'BACKUP_DIR'].filter(k => !/(^|\/)data\//.test(env[k] ?? '')).map(k => `${k} must be under ./data/ (deploy.sh overwrites the rest)`),
    ...(dryRun ? ['DRY_RUN=1: nothing would be sent and the test page would be public'] : []),
    // Instagram / Messenger: all three or none
    ...(env.META_PAGE_TOKEN || env.META_APP_SECRET ? META.filter(k => !env[k]).map(k => `${k} is empty (Instagram / Messenger need all of ${META.join(', ')})`) : []),
  ];
  if (problems.length) { console.error(`refusing to start in production:\n${problems.join('\n')}`); process.exit(1); }
  if (missingKeys.length) console.warn(`silent until these are set: ${missingKeys.join(', ')}`);
}

const db = openDb(env.DB_PATH ?? './bot.db');
initJobs(db); // adds the jobs columns before any order is written
const digits = s => String(s ?? '').replace(/\D/g, '');
const testNumbers = (env.TEST_NUMBERS ?? '').split(',').map(s => s.trim()).filter(Boolean);
if (testNumbers.some(n => !/^\d{9,20}$/.test(n))) { // WhatsApp numbers, or the digits of an Instagram / Messenger id
  console.error('TEST_NUMBERS must be full numbers (digits only, comma-separated) or empty for everyone');
  process.exit(1);
}
// Wasender fetches product photos by URL: they must be reachable from the internet
if (!dryRun && !/^https:\/\/[^/]+$/.test(env.PUBLIC_URL ?? '')) {
  console.error('PUBLIC_URL=https://<host> (no trailing slash) is needed to send product photos');
  process.exit(1);
}
if (!env.OPENAI_API_KEY) console.error('OPENAI_API_KEY is empty: voice notes will not be understood');
if (dryRun) console.warn('DRY RUN: nothing is sent to WhatsApp (DRY_RUN=1)');
if (testNumbers.length) console.warn(`TEST_NUMBERS: only ${testNumbers.length} number(s) get replies`);
// alerts (orders, handoffs, problems) go to the owner's WhatsApp
const agentPhone = () => digits(env.AGENT_PHONE);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);
const mask = phone => `…${digits(phone).slice(-3)}`; // logs never carry a full student number

const HANDOFF_LINE = 'مرحبا بيك، واحد من الفريق راح يجاوبك قريب إن شاء الله.';
const MEDIA_LINE = 'سمحلي، ما نقدرش نشوف الصور هنا. اكتبلي اسم المنتج ولا واش راك تحوس من فضلك.';
const VOICE_LINE = 'سمحلي، ما سمعتش الفويس مليح. عاودو ولا اكتبلي من فضلك.';
const OTHER_LINE = 'سمحلي، ما نقدرش نفتح الفيديوهات والملفات هنا. اكتبلي واش راك تحوس من فضلك.';
const MEDIA_RE = /^\[(voice|image|other|media)\]$/;

// boot: bubbles that were queued when the process died were never sent
db.prepare("UPDATE messages SET status = 'failed' WHERE status = 'pending'").run();

// ponytail: one global send chain for the whole Wasender session; per-session queues if we add numbers
let sendChain = Promise.resolve();
let lastSend = 0;
let queuedSends = 0; // messages waiting for their 5 s Wasender slot
let sendFails = 0; // in a row: /health says 503 from 5 (an outside monitor alerts the owner — our own alerts go through the same WhatsApp)
function sendText(phone, text, photo = null, onSlot = () => {}) {
  queuedSends++;
  const job = sendChain.then(async () => {
    if (!isMeta(phone)) { // the 5 s gap protects the WhatsApp number; Meta does not need it
      await sleep(lastSend + SEND_GAP - Date.now());
      lastSend = Date.now();
    }
    onSlot();
    if (dryRun) { console.log(`[dry-run → ${mask(phone)}] ${photo ? `[صورة ${photo}] ` : ''}${text ?? ''}`); return { ok: true }; }
    const imageUrl = photo ? `${env.PUBLIC_URL}/media/${photo}` : undefined;
    const res = isMeta(phone) ? await sendMeta({ token: env.META_PAGE_TOKEN, to: phone, text, imageUrl })
      : await send({ apiKey: env.WASENDER_API_KEY, to: phone.includes('@') ? phone : `+${phone}`, text, imageUrl });
    if (!isMeta(phone)) sendFails = res.ok ? 0 : sendFails + 1; // /health watches the WhatsApp session
    return res;
  }).finally(() => { queuedSends--; });
  sendChain = job.catch(() => {});
  return job;
}

// store first (so the echo can be recognised), then send; the row says whether it really went out
async function say(phone, text, role = 'bot', photo = null) {
  const id = addMessage(db, { phone, role, text, status: 'pending', media: photo });
  // the row's time = when it really left (the queue can hold it minutes): the echo is matched within 10 min of that
  const res = await sendText(phone, text, photo, () => db.prepare('UPDATE messages SET at = ? WHERE id = ?').run(Date.now(), id));
  // a timed-out send whose echo already came back did go out
  const ok = res.ok || !!db.prepare('SELECT wa_id FROM messages WHERE id = ?').get(id)?.wa_id;
  db.prepare('UPDATE messages SET status = ? WHERE id = ?').run(ok ? 'sent' : 'failed', id);
  if (!ok) console.error(`send failed → ${mask(phone)}: ${res.status ?? ''} ${String(res.error ?? '').replace(/\d{6,}/g, '…')}`);
  return ok;
}

async function alertAgent(text) {
  if (agentPhone()) await sendText(agentPhone(), text);
}
async function alertOnce(key, text) {
  if (!firstTime(db, `${key}:${today()}`)) return; // kept in the database: a restart does not repeat it
  await alertAgent(text);
}

const presence = phone => {
  if (dryRun || phone.includes('@')) return;
  if (isMeta(phone)) metaTyping({ token: env.META_PAGE_TOKEN, to: phone });
  else sendPresence({ apiKey: env.WASENDER_API_KEY, phone });
};
// "typing…": WhatsApp presence lapses after ~10 s, so it is refreshed while we wait (per chat, other chats are not held)
const typing = new Map(); // phone -> until (ms), also shown on the local try page
async function typeFor(phone, ms) {
  typing.set(phone, Date.now() + Math.max(ms, 0));
  for (let left = ms; left > 0; left -= 10_000) {
    presence(phone);
    await sleep(Math.min(left, 10_000));
  }
}

// one reply at a time per chat
const chains = new Map();
function enqueue(phone, fn) {
  const next = (chains.get(phone) ?? Promise.resolve()).then(fn).catch(e => console.error('reply error', mask(phone), e))
    .finally(() => { if (chains.get(phone) === next) chains.delete(phone); });
  chains.set(phone, next);
  return next;
}

// wait for the student to finish typing: newer messages reset the timer
const timers = new Map();
function schedule(phone, text) {
  clearTimeout(timers.get(phone));
  const wait = text && (text.length > 40 || /[?؟]\s*$/.test(text)) ? 6000 : 12000;
  timers.set(phone, setTimeout(() => { timers.delete(phone); enqueue(phone, () => reply(phone)); }, Number(env.REPLY_WAIT_MS ?? wait)));
}

const canTalk = phone => {
  const c = getChat(db, phone);
  return !!c && !c.handed_off && c.human_until <= Date.now();
};
// id of the last student message when nothing (sent) came after it, else 0 — by id, not by time
// a photo alone is not an answer: if the text after it failed, the customer still waits (and the sweep retries)
const ANSWERED = "MAX(CASE WHEN role != 'student' AND media IS NULL AND (status IS NULL OR status = 'sent') THEN id END)";
function unanswered(phone) {
  const r = db.prepare(`SELECT MAX(CASE WHEN role = 'student' THEN id END) s, ${ANSWERED} o FROM messages WHERE phone = ?`).get(phone);
  return (r.s ?? 0) > (r.o ?? 0) ? r.s : 0;
}
const overCap = () => costOn(db, today()) >= Number(env.DAILY_COST_CAP_USD ?? 3);

const runToolFor = phone => orderTools({ db, card, phone, alertAgent });

async function handoff(phone, reason, line = HANDOFF_LINE) {
  const talking = canTalk(phone); // a human already in the chat: no bot line
  setChat(db, phone, { handed_off: 1, handoff_reason: reason });
  if (talking) await say(phone, line);
  await alertAgent(`محادثة محوّلة إليك: ${reasonLabel(reason)}. افتح اللوحة.`);
}

function think(phone, note) {
  typing.set(phone, Date.now() + 60_000); // "typing…" while the model thinks
  const runTool = runToolFor(phone);
  return answer({
    card, history: history(db, phone, 30), note, pending: pendingSummary(db, card, phone), recheck: recheckPending(db, phone),
    apiKey: env.OPENROUTER_API_KEY, model: env.MODEL, runTool,
  }).then(out => {
    out.photos = runTool.photos; // product photos the customer asked for, sent before the reply
    addCost(db, out.usd ?? 0, today());
    for (const c of out.calls ?? []) {
      db.prepare('INSERT INTO ai_calls(phone, at, kind, input, output, cache_read, cache_write, usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(phone, Date.now(), note ? 'scheduled' : 'reply', c.input ?? 0, c.output ?? 0, c.cacheRead ?? 0, c.cacheWrite ?? 0, c.usd ?? 0);
    }
    for (const g of out.guards ?? []) logGuard(db, { phone, guard: g.guard, action: g.action });
    if (out.handoff === 'ai-error') {
      console.error('ai error', mask(phone), out.error);
      logGuard(db, { phone, guard: 'ai-error', action: 'skipped' });
      alertOnce('ai', 'البوت لا يستطيع الرد: خطأ تقني في الذكاء. التفاصيل في سجل الخادم.');
    }
    return out;
  });
}

// Busy queue: one message instead of up to 3 bubbles. Load test 2026-11-01: 50 students at once = 127 bubbles,
// the last full reply came after ~17 min at 1 send / 5 s; merged it is ~50 sends.
const MERGE_AT = Number(env.MERGE_AT ?? 3);
const lastStudentId = phone => db.prepare("SELECT COALESCE(MAX(id), 0) id FROM messages WHERE phone = ? AND role = 'student'").get(phone).id;
async function sendBubbles(phone, text, since = Date.now(), asked = lastStudentId(phone), photos = []) {
  let bubbles = splitReply(text);
  if (queuedSends >= MERGE_AT && bubbles.length > 1) bubbles = [bubbles.join('\n')];
  // Instagram / Messenger: a photo has no caption (it goes as the next text, the photo row has no text so a text echo
  // can never claim it), and a message is at most 1000 bytes
  const meta = isMeta(phone);
  const items = [
    ...photos.flatMap(p => (meta ? [{ text: null, photo: p.name }, { text: p.caption }] : [{ text: p.caption, photo: p.name }])),
    ...bubbles.flatMap(b => (meta ? fitBytes(b) : [b]).map(text => ({ text }))),
  ];
  try {
    for (const [i, it] of items.entries()) {
      await typeFor(phone, (it.photo ? 2000 : typingMs(it.text, TYPING)) - (i === 0 ? Date.now() - since : 0));
      if (!canTalk(phone)) return false; // a human took over while we were "typing"
      if (lastStudentId(phone) !== asked) return false; // the student wrote again: that message's timer answers both
      // stop at the first failed text; a failed photo still lets the text go
      if (!(await say(phone, it.text, 'bot', it.photo ?? null))) {
        if (!it.photo) return false;
        alertOnce('photo', 'صور المنتجات لا تصل للزبائن: تحقق من عنوان الخادم في الإعدادات.');
      }
    }
    return true;
  } finally {
    typing.delete(phone);
  }
}
const lastStudentAt = phone => db.prepare("SELECT MAX(at) at FROM messages WHERE phone = ? AND role = 'student'").get(phone).at ?? Date.now();

async function reply(phone) {
  if (!canTalk(phone) || hearing.has(phone)) return; // a voice note still being transcribed: its end calls schedule again
  const asked = unanswered(phone);
  if (!asked) return;
  if (overCap()) {
    return alertOnce('cap', `البوت توقف: كلفة اليوم وصلت السقف ${env.DAILY_COST_CAP_USD ?? 3} دولار.`);
  }
  // only voice notes / images since the last answer: ask for text, no AI
  const fresh = db.prepare(`SELECT text FROM messages WHERE phone = ? AND role = 'student' AND id > COALESCE(
    (SELECT ${ANSWERED} FROM messages WHERE phone = ?), 0)`).all(phone, phone);
  if (fresh.every(r => MEDIA_RE.test(r.text))) {
    const has = k => fresh.some(r => r.text === `[${k}]`);
    return void await say(phone, has('voice') ? VOICE_LINE : has('image') ? MEDIA_LINE : OTHER_LINE);
  }

  presence(phone);
  const out = await think(phone);
  typing.delete(phone);
  if (out.handoff === 'ai-error') return; // stays unanswered: the sweep retries
  // while the model was thinking: a human took over, or the student wrote again (that message has its own timer)
  if (!canTalk(phone) || unanswered(phone) !== asked) return;
  if (out.handoff) return handoff(phone, out.handoff, out.reply ?? HANDOFF_LINE);
  if (await sendBubbles(phone, out.reply, lastStudentAt(phone), asked, out.photos)) afterBotReply(db, phone, Date.now());
}

// scheduled messages (follow-ups): never hand off, just skip
async function writeAndSend(phone, note) {
  if (!canTalk(phone) || overCap() || unanswered(phone)) return false;
  const asked = lastStudentId(phone);
  const out = await enqueue(phone, () => think(phone, note));
  typing.delete(phone);
  if (out?.handoff || !out?.reply || !canTalk(phone) || unanswered(phone)) {
    logGuard(db, { phone, guard: 'scheduled', action: 'skipped' });
    return false;
  }
  return enqueue(phone, () => sendBubbles(phone, out.reply, Date.now(), asked, out.photos));
}

function onMessage(m) {
  if (agentPhone() && digits(m.phone) === agentPhone()) return; // our alerts to the agent, and the agent's own chat
  if (m.fromMe) {
    if (claimEcho(db, { phone: m.phone, text: m.text, image: m.kind === 'image', waId: m.waId })) return;
    // a human typed on the phone: store it and keep the bot quiet
    ensureChat(db, m.phone);
    if (addMessage(db, { waId: m.waId, phone: m.phone, role: 'human', text: m.text, at: m.at }) === null) return;
    setChat(db, m.phone, { human_until: Date.now() + HUMAN_QUIET });
    return;
  }
  ensureChat(db, m.phone, m.name);
  // the bot does not see photos: a captioned one becomes our note + his caption (so it is not answered blind),
  // a bare one stays «[image]» and gets the fixed line asking him to write
  const text = m.kind === 'image' && m.text ? `📷 [صورة من الزبون]\n${m.text}` : m.text ?? `[${m.kind ?? 'media'}]`;
  const id = addMessage(db, { waId: m.waId, phone: m.phone, role: 'student', text, at: m.at });
  if (id === null) return; // duplicate
  if (testNumbers.length && !testNumbers.includes(digits(m.phone))) return;
  if (silent()) return; // stored, answered by the sweep once the keys are set (if still within 24 h)
  if (m.kind === 'voice' && (m.media || m.file || m.url)) return void hear(m, id).catch(e => console.error('voice error', mask(m.phone), e?.message));
  next(m.phone, m.kind === 'image' ? m.text ?? '[image]' : text); // follow-up logic reads his words, never our photo note
}

function next(phone, text) {
  const r = afterStudent(db, phone, text, Date.now());
  if (r.handoff) return void enqueue(phone, () => handoff(phone, r.handoff));
  schedule(phone, text);
}

// Instagram / Messenger attachments are public CDN links; WhatsApp media goes through Wasender's decrypt
async function understand(m) {
  const file = m.file ?? (m.url ? await fetchUrl({ url: m.url, fallback: 'audio/mp4' }) : undefined);
  if (m.url && !file) return { text: null, usd: 0, why: 'download' };
  return voiceText({ wasenderKey: env.WASENDER_API_KEY, apiKey: env.OPENAI_API_KEY, media: m.media, file, seconds: m.seconds });
}

// voice note -> «🎤 transcript», in the same row, then the normal path.
// Failed: the row keeps «[voice]» and the bot asks to repeat or write.
// While one runs, no reply goes out for that chat (else the placeholder is answered and the result is lost).
const hearing = new Map(); // phone -> voice notes still being transcribed
async function hear(m, id) {
  hearing.set(m.phone, (hearing.get(m.phone) ?? 0) + 1);
  let text = null;
  try {
    const out = overCap() ? { text: null, usd: 0, why: 'cap' } : await understand(m);
    addCost(db, out.usd ?? 0, today());
    db.prepare('INSERT INTO ai_calls(phone, at, kind, input, output, cache_read, cache_write, usd) VALUES (?, ?, ?, 0, 0, 0, 0, ?)')
      .run(m.phone, Date.now(), m.kind, out.usd ?? 0);
    if (!out.text) logGuard(db, { phone: m.phone, guard: m.kind, action: out.why ?? 'failed' });
    // a key or balance problem hits every customer: the owner hears about it once a day
    if (/^(no key|http 40[12]|http 429)$/.test(out.why ?? '')) alertOnce('openai', 'الرسائل الصوتية لا تُفهم الآن: مشكلة في مفتاح أوبن إي آي أو رصيده.');
    text = out.text;
    if (text) db.prepare('UPDATE messages SET text = ? WHERE id = ?').run(text, id);
  } finally {
    const left = (hearing.get(m.phone) ?? 1) - 1;
    if (left) hearing.set(m.phone, left); else hearing.delete(m.phone);
    next(m.phone, text ?? '[voice]'); // the last one to finish sets the timer that answers them all
  }
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// the dashboard's stock switches write the card back: atomic, so the bot never reads half a card
const saveCard = () => {
  writeFileSync(`${cardPath}.tmp`, JSON.stringify(card, null, 2));
  renameSync(`${cardPath}.tmp`, cardPath);
};
const dash = dashboard({
  db, say, card, saveCard, password: env.DASHBOARD_PASSWORD, secureCookie: !!env.COOKIE_SECURE || env.NODE_ENV === 'production',
});

const media = mediaRoutes(mediaDir);

const tryPage = dryRun ? tryRoutes({ db, onMessage, isTyping: phone => (typing.get(phone) ?? 0) > Date.now() }) : null; // local trial chat, never in production

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400); return res.end(); }
  if (req.method === 'GET' && url.pathname === '/health') {
    if (sendFails >= 5) res.writeHead(503);
    return res.end(sendFails >= 5 ? 'whatsapp sends failing' : silent() ? 'waiting for keys' : 'ok');
  }

  if (req.method === 'POST' && url.pathname === '/wa') {
    if (!sameSecret(req.headers['x-webhook-signature'], env.WASENDER_WEBHOOK_SECRET)) {
      res.writeHead(401); return res.end();
    }
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { res.writeHead(400); return res.end(); }
    res.end('ok'); // answer Wasender fast, work after
    for (const m of parseWasender(body)) {
      try { onMessage(m); } catch (e) { console.error('inbound error', e); }
    }
    return;
  }
  // Instagram / Messenger webhook: the GET handshake, then signed POSTs
  if (metaOn && url.pathname === '/meta') {
    if (req.method === 'GET') {
      const ok = url.searchParams.get('hub.mode') === 'subscribe' && sameSecret(url.searchParams.get('hub.verify_token'), env.META_VERIFY_TOKEN);
      res.writeHead(ok ? 200 : 403, { 'content-type': 'text/plain' });
      return res.end(ok ? String(url.searchParams.get('hub.challenge') ?? '') : '');
    }
    let raw;
    try { raw = await readBody(req); } catch { res.writeHead(413); return res.end(); }
    if (req.method !== 'POST' || !metaSigned(raw, req.headers['x-hub-signature-256'], env.META_APP_SECRET)) { res.writeHead(401); return res.end(); }
    let body;
    try { body = JSON.parse(raw); } catch { res.writeHead(400); return res.end(); }
    res.end('ok');
    for (const m of parseMeta(body)) {
      try { onMessage(m); } catch (e) { console.error('inbound error', e); }
    }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/privacy') { // Meta asks for it (privacy policy + data deletion)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(privacyPage(card));
  }
  try {
    if (await media(req, res, url)) return;
    if (tryPage && await tryPage(req, res, url)) return;
    if (await dash(req, res, url)) return;
  } catch (e) {
    console.error('dashboard error', e?.message);
    if (!res.headersSent) res.writeHead(500);
    return res.end();
  }
  res.writeHead(404); res.end();
});

// unanswered students (last 24h): after a restart, an AI error, the cost cap lifting, or human silence ending
function sweepUnanswered() {
  try { sweep(); } catch (e) { console.error('sweep error', e?.message); } // a timer that throws would kill the process
}
function sweep() {
  const rows = db.prepare(`SELECT c.phone FROM chats c WHERE c.handed_off = 0 AND c.human_until <= ?
    AND (SELECT MAX(id) FROM messages WHERE phone = c.phone AND role = 'student' AND at > ?)
      > COALESCE((SELECT ${ANSWERED} FROM messages WHERE phone = c.phone), 0)
    AND (SELECT COUNT(*) FROM messages f WHERE f.phone = c.phone AND f.status = 'failed' AND f.at > ?
      AND f.id > (SELECT MAX(id) FROM messages WHERE phone = c.phone AND role = 'student')) < 3`).all(Date.now(), Date.now() - 24 * 60 * MIN, Date.now() - 30 * MIN);
  // 3 failures in 30 min: wait, then try again (a WhatsApp outage must not leave those customers unanswered for good)
  if (silent()) return;
  for (const { phone } of rows) {
    if (testNumbers.length && !testNumbers.includes(digits(phone))) continue;
    if (timers.has(phone) || chains.has(phone) || hearing.has(phone)) continue; // already on its way
    schedule(phone, '');
  }
}

// warn the owner on WhatsApp before the OpenRouter balance runs out and the bot stops
const LOW_USD = Number(env.LOW_BALANCE_USD ?? 2);
async function checkBalance() {
  const left = await orBalance(env.OPENROUTER_API_KEY);
  if (left != null && left < LOW_USD) alertOnce('balance', `رصيد ردود البوت بقى ${left} دولار. اشحنه في أوبن راوتر باش ما يتوقفش البوت.`).catch(() => {});
}

process.on('unhandledRejection', e => console.error('unhandled', e?.message ?? e));

const port = Number(env.PORT ?? 3000);
server.listen(port, env.HOST ?? '127.0.0.1', () => {
  console.log(`shop bot on :${port}${dryRun ? ' (dry-run)' : ''}${card.test ? ' [TEST CARD]' : ''}`);
  // the question before shipping: the code's own message, in the customer's letters (RECHECK=0 turns it off for a shop that phones)
  const recheckSend = env.RECHECK === '0' ? null : o => canTalk(o.phone)
    ? say(o.phone, recheckText(o, studentScript(history(db, o.phone, 10)) === 'latin')) : Promise.resolve(false);
  startJobs({ db, card, writeAndSend, recheckSend, alertAgent, backupDir: env.BACKUP_DIR ?? './backups' });
  checkBalance();
  setInterval(checkBalance, 6 * 60 * MIN).unref();
  sweepUnanswered();
  setInterval(sweepUnanswered, 5 * MIN).unref();
});
