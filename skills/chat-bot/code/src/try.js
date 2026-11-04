// Local "try it as a student" page — mounted only in dry-run (nothing reaches WhatsApp).
// The student's text goes through the same onMessage path as a real Wasender message.
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../public/try.html', import.meta.url));
const TRY_PHONE = /^213555700\d{3}$/; // fake numbers for local trial chats

export function tryRoutes({ db, onMessage, isTyping = () => false }) {
  return async (req, res, url) => {
    if (url.pathname !== '/try' && !url.pathname.startsWith('/try/')) return false;
    if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress ?? '')) return false; // this machine only
    const json = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
      return true;
    };
    if (url.pathname === '/try') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page);
      return true;
    }
    const phone = url.searchParams.get('phone') ?? '';
    if (!TRY_PHONE.test(phone)) return json(400, { error: 'phone' });

    if (req.method === 'POST' && (url.pathname === '/try/voice' || url.pathname === '/try/image')) { // a voice note or photo from the try page
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > 9 * 1024 * 1024) return json(413, {}); chunks.push(c); }
      const kind = url.pathname === '/try/voice' ? 'voice' : 'image';
      const mime = String(req.headers['content-type'] ?? (kind === 'voice' ? 'audio/webm' : 'image/jpeg'));
      onMessage({ waId: `TRY${Date.now()}${Math.random()}`, phone, fromMe: false, text: null, at: Date.now(), name: 'تجربة', kind, file: { b64: Buffer.concat(chunks).toString('base64'), mime } });
      return json(200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/try/send') {
      let body = '';
      for await (const c of req) body += c;
      const text = String(JSON.parse(body || '{}').text ?? '').trim().slice(0, 1500);
      if (!text) return json(400, { error: 'text' });
      onMessage({ waId: `TRY${Date.now()}${Math.random()}`, phone, fromMe: false, text, at: Date.now(), name: 'تجربة', kind: 'text' });
      return json(200, { ok: true });
    }
    if (url.pathname === '/try/messages') {
      // pending bubbles are still "on their way", like in WhatsApp
      const messages = db.prepare(`SELECT role, text, at, status, media FROM messages WHERE phone = ? AND (status IS NULL OR status != 'pending')
        ORDER BY id`).all(phone).map((m) => ({ ...m }));
      const chat = db.prepare('SELECT handed_off FROM chats WHERE phone = ?').get(phone);
      return json(200, { messages, handedOff: !!chat?.handed_off, typing: isTyping(phone) });
    }
    return json(404, {});
  };
}
