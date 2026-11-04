// Daily shop report: the five numbers + what needs a look. `npm run report` (on the server: same, in /opt/shop-bot).
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(process.env.DB_PATH ?? './bot.db', { readOnly: true });
const H = 3_600_000, DAY = 24 * H;
const now = Date.now();
const dayStart = now - ((now + H) % DAY); // Algeria midnight (UTC+1)
const one = (sql, ...a) => db.prepare(sql).get(...a);

// shipped/delivered count orders CONFIRMED in the range by their status now (orders has no shipped_at)
function numbers(from) {
  const o = one(`SELECT COUNT(*) n, COALESCE(SUM(status IN ('shipped','delivered')),0) s, COALESCE(SUM(status = 'delivered'),0) d,
    COALESCE(SUM(CASE WHEN status = 'delivered' THEN total END),0) m FROM orders WHERE confirmed_at >= ?`, from);
  return `محادثات ${one('SELECT COUNT(*) n FROM chats WHERE created_at >= ?', from).n} · طلبات مؤكدة ${o.n}`
    + ` · شُحنت ${o.s} · استُلمت ${o.d} · المبلغ المستلم ${o.m} دج`;
}

// a photo alone is not an answer: if the text after it failed, the customer still waits (and the sweep retries)
const ANSWERED = "MAX(CASE WHEN role != 'student' AND media IS NULL AND (status IS NULL OR status = 'sent') THEN id END)";
const testNumbers = (process.env.TEST_NUMBERS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const problems = [
  ['زبائن بلا رد منذ أكثر من 30 دقيقة', db.prepare(`SELECT c.phone FROM chats c WHERE c.handed_off = 0 AND c.human_until <= ?
    AND (SELECT MAX(id) FROM messages WHERE phone = c.phone AND role = 'student' AND at < ? AND at > ?)
      > COALESCE((SELECT ${ANSWERED} FROM messages WHERE phone = c.phone), 0)`).all(now, now - 30 * 60_000, now - DAY)
    .filter((r) => !testNumbers.length || testNumbers.includes(r.phone)).length],
  ['محادثات محوّلة تنتظر إنساناً', one('SELECT COUNT(*) n FROM chats WHERE handed_off = 1').n],
  ['رسائل فشل إرسالها اليوم', one("SELECT COUNT(*) n FROM messages WHERE status = 'failed' AND at >= ?", dayStart).n],
  ['طلبات مؤكدة لم تُشحن بعد', one("SELECT COUNT(*) n FROM orders WHERE status = 'confirmed'").n],
  ['ادعاءات تأكيد طلب كاذبة أوقفها الحارس اليوم', one("SELECT COUNT(*) n FROM guard_log WHERE guard = 'false-order' AND at >= ?", dayStart).n],
  ['فويسات لم تُفهم اليوم (طلب البوت إعادتها)', one("SELECT COUNT(*) n FROM guard_log WHERE guard = 'voice' AND action != 'cap' AND at >= ?", dayStart).n],
  ['أخطاء الذكاء اليوم', one("SELECT COUNT(*) n FROM guard_log WHERE guard = 'ai-error' AND at >= ?", dayStart).n],
  // a word mixing Arabic and Latin letters («Dورة»): counted, not guarded yet (3 of ~28 bubbles in the 2026-11-01 test)
  ['ردود بحروف مختلطة اليوم', db.prepare("SELECT text FROM messages WHERE role = 'bot' AND media IS NULL AND at >= ?").all(dayStart)
    .filter((r) => /[؀-ۿ][A-Za-z]|[A-Za-z][؀-ۿ]/.test(r.text)).length],
].filter(([, n]) => n > 0);

const GUARD = { number: 'رقم أو كلمة ممنوعة', contact: 'هاتف أو رابط', time: 'تاريخ أو ساعة', 'false-order': 'تأكيد طلب كاذب',
  short: 'رد ناقص', script: 'حروف غير حروف الزبون',
  darja: 'كلمات غير جزائرية', 'ai-error': 'خطأ الذكاء', scheduled: 'رسالة مجدولة' };
const ACTION = { retry: 'أعاد الكتابة', handoff: 'حوّل لإنسان', trimmed: 'حذف', skipped: 'تخطّى' };
const guards = db.prepare('SELECT guard, action, COUNT(*) n FROM guard_log WHERE at >= ? GROUP BY guard, action ORDER BY n DESC')
  .all(dayStart).map((g) => `${GUARD[g.guard] ?? g.guard} (${ACTION[g.action] ?? g.action}): ${g.n}`);
const cost = one('SELECT usd FROM costs WHERE day = ?', new Date().toISOString().slice(0, 10))?.usd ?? 0;

console.log(`اليوم: ${numbers(dayStart)}`);
console.log(`آخر 7 أيام: ${numbers(dayStart - 6 * DAY)}`);
console.log(`كلفة اليوم: ${cost.toFixed(3)} دولار`);
if (guards.length) console.log(`الحرّاس اليوم: ${guards.join(' · ')}`);
console.log(problems.length ? problems.map(([t, n]) => `⚠️ ${t}: ${n}`).join('\n') : 'البوت سليم.');
