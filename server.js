import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT) || 3000;
const AI_URL = process.env.AI_URL || 'http://192.168.6.52:1883/api/v1/chat';
const AI_MODEL = process.env.AI_MODEL || 'prism-ml/bonsai-27b';
const SESSION_MS = 7 * 24 * 3600 * 1000;
const MAX_INPUT = 8000;
const MAX_DOC = 50_000;
const INDEX_HTML = readFileSync(new URL('./public/index.html', import.meta.url));
const LOGO_SVG = readFileSync(new URL('./public/logo.svg', import.meta.url));

const db = new DatabaseSync(process.env.DB_FILE || fileURLToPath(new URL('./data.db', import.meta.url)));
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    pass_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'user'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT OR IGNORE INTO settings VALUES ('system_prompt', 'Bạn là trợ lý AI nội bộ của công ty. Trả lời ngắn gọn, chính xác, bằng tiếng Việt.');
`);
// Added after the first release: upgrade existing data.db in place.
if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'full_name')) {
  db.exec("ALTER TABLE users ADD COLUMN full_name TEXT NOT NULL DEFAULT ''; ALTER TABLE users ADD COLUMN department TEXT NOT NULL DEFAULT '';");
}

const hashPassword = (pw) => {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(pw, salt, 64).toString('hex')}`;
};
const checkPassword = (pw, stored) => {
  const [salt, hash] = stored.split(':');
  return timingSafeEqual(scryptSync(pw, salt, 64), Buffer.from(hash, 'hex'));
};

if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
  if (!process.env.ADMIN_PASS) throw new Error('Lần chạy đầu: hãy đặt biến môi trường ADMIN_PASS (và tuỳ chọn ADMIN_USER) để tạo tài khoản admin.');
  db.prepare("INSERT INTO users (username, pass_hash, role) VALUES (?, ?, 'admin')")
    .run(process.env.ADMIN_USER || 'admin', hashPassword(process.env.ADMIN_PASS));
}

// LM Studio-style response: { output: [{ type: 'message', content: '...' }] }; anything else is returned raw so no answer is lost.
export function extractAnswer(data) {
  const parts = Array.isArray(data?.output) ? data.output.filter((o) => o?.type === 'message').map((o) => o.content) : [];
  if (parts.length) return parts.join('\n');
  return typeof data === 'string' ? data : JSON.stringify(data);
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function readJson(req, max = 64 * 1024) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > max) throw new HttpError(413, 'Dữ liệu quá lớn');
  }
  try { return body ? JSON.parse(body) : {}; } catch { throw new HttpError(400, 'JSON không hợp lệ'); }
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');

const sidOf = (req) => /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];

function currentUser(req) {
  const token = sidOf(req);
  if (!token) return null;
  return db.prepare(`SELECT u.id, u.username, u.role FROM sessions s JOIN users u ON u.id = s.user_id
                     WHERE s.token = ? AND s.expires > ?`).get(token, Date.now()) || null;
}

async function askModel(input) {
  const { value: system_prompt } = db.prepare("SELECT value FROM settings WHERE key = 'system_prompt'").get();
  let res;
  try {
    res = await fetch(AI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: AI_MODEL, system_prompt, input }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    throw new HttpError(502, `Không kết nối được tới model: ${e.message}`);
  }
  if (!res.ok) throw new HttpError(502, `Model trả lỗi ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return extractAnswer(await res.json().catch(() => null));
}

async function route(req, res, send) {
  const { pathname } = new URL(req.url, 'http://x');
  const m = req.method;

  if (m === 'GET' && pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(INDEX_HTML);
  }

  if (m === 'GET' && pathname === '/logo.svg') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
    return res.end(LOGO_SVG);
  }

  if (m === 'POST' && pathname === '/api/login') {
    const { username, password } = await readJson(req);
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(str(username));
    if (!u || typeof password !== 'string' || !checkPassword(password, u.pass_hash)) throw new HttpError(401, 'Sai tên đăng nhập hoặc mật khẩu');
    const token = randomBytes(32).toString('hex');
    db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(token, u.id, Date.now() + SESSION_MS);
    res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`);
    return send(200, { id: u.id, username: u.username, role: u.role });
  }

  const user = currentUser(req);
  if (!user) throw new HttpError(401, 'Chưa đăng nhập');

  if (m === 'POST' && pathname === '/api/logout') {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(sidOf(req));
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return send(200, { ok: true });
  }
  if (m === 'GET' && pathname === '/api/me') return send(200, user);

  if (m === 'POST' && pathname === '/api/ask') {
    const body = await readJson(req, 256 * 1024);
    const input = str(body.input);
    if (!input) throw new HttpError(400, 'Câu hỏi trống');
    if (input.length > MAX_INPUT) throw new HttpError(400, `Câu hỏi tối đa ${MAX_INPUT} ký tự`);
    let prompt = input, question = input;
    if (body.document != null) {
      const name = str(body.document.name).slice(0, 200), text = str(body.document.text);
      if (!name || !text) throw new HttpError(400, 'Tài liệu trống');
      if (text.length > MAX_DOC) throw new HttpError(400, `Tài liệu tối đa ${MAX_DOC} ký tự`);
      prompt = `Tài liệu "${name}":\n"""\n${text}\n"""\n\nDựa vào tài liệu trên, trả lời: ${input}`;
      question = `📎 ${name}\n${input}`;
    }
    const answer = await askModel(prompt);
    db.prepare('INSERT INTO messages (user_id, question, answer) VALUES (?, ?, ?)').run(user.id, question, answer);
    return send(200, { answer });
  }
  if (m === 'GET' && pathname === '/api/history') {
    return send(200, db.prepare('SELECT question, answer, created_at FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(user.id).reverse());
  }

  // ---- Admin only ----
  if (!pathname.startsWith('/api/users') && !pathname.startsWith('/api/settings')) throw new HttpError(404, 'Không tìm thấy');
  if (user.role !== 'admin') throw new HttpError(403, 'Chỉ admin được phép');

  if (m === 'GET' && pathname === '/api/users') return send(200, db.prepare('SELECT id, username, full_name, department, role FROM users ORDER BY id').all());
  if (m === 'POST' && pathname === '/api/users') {
    const body = await readJson(req);
    const username = str(body.username), full_name = str(body.full_name), department = str(body.department);
    const role = body.role === 'admin' ? 'admin' : 'user';
    if (!full_name || !department) throw new HttpError(400, 'Cần họ tên và phòng ban');
    if (full_name.length > 100 || department.length > 100 || username.length > 50) throw new HttpError(400, 'Thông tin quá dài');
    if (!username || typeof body.password !== 'string' || body.password.length < 6) throw new HttpError(400, 'Cần tên đăng nhập và mật khẩu (≥ 6 ký tự)');
    try {
      db.prepare('INSERT INTO users (username, pass_hash, role, full_name, department) VALUES (?, ?, ?, ?, ?)')
        .run(username, hashPassword(body.password), role, full_name, department);
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'Tên đăng nhập đã tồn tại');
      throw e;
    }
    return send(201, { ok: true });
  }
  const idMatch = /^\/api\/users\/(\d+)(\/password)?$/.exec(pathname);
  if (idMatch) {
    const id = Number(idMatch[1]);
    if (m === 'DELETE' && !idMatch[2]) {
      if (id === user.id) throw new HttpError(400, 'Không thể tự xoá chính mình');
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
      return send(200, { ok: true });
    }
    if (m === 'POST' && idMatch[2]) {
      const { password } = await readJson(req);
      if (typeof password !== 'string' || password.length < 6) throw new HttpError(400, 'Mật khẩu ≥ 6 ký tự');
      if (!db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(password), id).changes) throw new HttpError(404, 'Không tìm thấy user');
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      return send(200, { ok: true });
    }
  }
  if (pathname === '/api/settings') {
    if (m === 'PUT') {
      const prompt = str((await readJson(req)).system_prompt);
      if (!prompt) throw new HttpError(400, 'System prompt trống');
      db.prepare("UPDATE settings SET value = ? WHERE key = 'system_prompt'").run(prompt);
    }
    if (m === 'GET' || m === 'PUT') return send(200, db.prepare("SELECT value AS system_prompt FROM settings WHERE key = 'system_prompt'").get());
  }
  throw new HttpError(404, 'Không tìm thấy');
}

export const server = http.createServer(async (req, res) => {
  const send = (status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  };
  try {
    await route(req, res, send);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    if (!res.headersSent) send(e.status || 500, { error: e instanceof HttpError ? e.message : 'Lỗi máy chủ' });
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, () => console.log(`Mở http://localhost:${PORT}  (model: ${AI_MODEL} @ ${AI_URL})`));
}
