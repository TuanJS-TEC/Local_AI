import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

let mock, server, base, lastUpstreamBody;

before(async () => {
  mock = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    lastUpstreamBody = JSON.parse(body);
    res.end(JSON.stringify({ output: [{ type: 'reasoning', content: 'hmm' }, { type: 'message', content: `Đáp: ${lastUpstreamBody.input}` }] }));
  }).listen(0);
  Object.assign(process.env, {
    AI_URL: `http://localhost:${mock.address().port}/api/v1/chat`,
    DB_FILE: ':memory:',
    ADMIN_USER: 'admin',
    ADMIN_PASS: 'adminpw',
  });
  ({ server } = await import('./server.js'));
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => { server.close(); mock.close(); });

async function call(path, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body && { 'Content-Type': 'application/json' }), ...(cookie && { cookie }) },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, data: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
const login = async (username, password) => (await call('/api/login', { method: 'POST', body: { username, password } })).cookie;

test('extractAnswer handles LM Studio shape and falls back to raw JSON', async () => {
  const { extractAnswer } = await import('./server.js');
  assert.equal(extractAnswer({ output: [{ type: 'message', content: 'hi' }] }), 'hi');
  assert.equal(extractAnswer({ foo: 1 }), '{"foo":1}');
});

test('auth, roles, ask and history', async () => {
  assert.equal((await call('/api/login', { method: 'POST', body: { username: 'admin', password: 'wrong' } })).status, 401);
  assert.equal((await call('/api/me')).status, 401);
  assert.equal((await call('/api/ask', { method: 'POST', body: { input: 'x' } })).status, 401);

  const admin = await login('admin', 'adminpw');
  const nv1Body = { username: 'nv1', password: 'secret1', full_name: 'Nguyễn Văn A', department: 'Kế toán' };
  assert.equal((await call('/api/users', { method: 'POST', cookie: admin, body: { username: 'nv1', password: 'secret1' } })).status, 400);
  assert.equal((await call('/api/users', { method: 'POST', cookie: admin, body: nv1Body })).status, 201);
  assert.equal((await call('/api/users', { method: 'POST', cookie: admin, body: nv1Body })).status, 409);
  await call('/api/settings', { method: 'PUT', cookie: admin, body: { system_prompt: 'Rhymes only.' } });

  const user = await login('nv1', 'secret1');
  assert.deepEqual((await call('/api/me', { cookie: user })).data.role, 'user');
  assert.equal((await call('/api/users', { cookie: user })).status, 403);
  assert.equal((await call('/api/users', { method: 'POST', cookie: user, body: { ...nv1Body, username: 'hacker' } })).status, 403);
  assert.equal((await call('/api/settings', { method: 'PUT', cookie: user, body: { system_prompt: 'x' } })).status, 403);
  assert.equal((await call('/api/ask', { method: 'POST', cookie: user, body: { input: '  ' } })).status, 400);

  const ask = await call('/api/ask', { method: 'POST', cookie: user, body: { input: 'Màu gì?' } });
  assert.equal(ask.data.answer, 'Đáp: Màu gì?');
  assert.deepEqual(lastUpstreamBody, { model: 'prism-ml/bonsai-27b', system_prompt: 'Rhymes only.', input: 'Màu gì?' });
  assert.equal((await call('/api/history', { cookie: user })).data.length, 1);
  assert.equal((await call('/api/history', { cookie: admin })).data.length, 0);

  // Password reset kills the user's sessions; admin can't delete self.
  const users = (await call('/api/users', { cookie: admin })).data;
  const nv1 = users.find((u) => u.username === 'nv1'), self = users.find((u) => u.username === 'admin');
  assert.equal(nv1.full_name, 'Nguyễn Văn A');
  assert.equal(nv1.department, 'Kế toán');
  await call(`/api/users/${nv1.id}/password`, { method: 'POST', cookie: admin, body: { password: 'newpass' } });
  assert.equal((await call('/api/me', { cookie: user })).status, 401);
  assert.equal((await call(`/api/users/${self.id}`, { method: 'DELETE', cookie: admin })).status, 400);
  assert.equal((await call(`/api/users/${nv1.id}`, { method: 'DELETE', cookie: admin })).status, 200);
  assert.equal(await login('nv1', 'newpass'), undefined);
});

test('ask with an attached document', async () => {
  const cookie = await login('admin', 'adminpw');
  const ask = (document) => call('/api/ask', { method: 'POST', cookie, body: { input: 'Tóm tắt', document } });

  const ok = await ask({ name: 'a.txt', text: 'Nội dung ABC' });
  assert.equal(ok.status, 200);
  assert.match(lastUpstreamBody.input, /a\.txt[\s\S]*Nội dung ABC[\s\S]*Tóm tắt/);
  assert.equal((await call('/api/history', { cookie })).data.at(-1).question, '📎 a.txt\nTóm tắt');

  assert.equal((await ask({ name: 'a.txt', text: '  ' })).status, 400);
  assert.equal((await ask({ name: 'big.txt', text: 'x'.repeat(50_001) })).status, 400);
});

test('logo is served without login', async () => {
  const res = await fetch(base + '/logo.svg');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/svg+xml');
});
