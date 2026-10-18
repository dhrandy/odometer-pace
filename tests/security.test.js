const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 19000 + Math.floor(Math.random() * 1000);
const BASE = 'http://127.0.0.1:' + PORT;
let proc, dir;

async function call(method, url, body, headers) {
  const h = Object.assign({}, headers);
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(BASE + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await r.clone().json(); } catch (e) { /* not json */ }
  return { status: r.status, json, headers: r.headers };
}
const cookieOf = (r) => r.headers.get('set-cookie').split(';')[0];

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-sec-'));
  proc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: Object.assign({}, process.env, { PORT, DATA_DIR: dir, TRUST_PROXY: 'true', COOKIE_SECURE: 'true' }) });
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/api/session'); return; } catch (e) { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
});
test.after(() => { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

test('a forged first X-Forwarded-For entry does not dodge the rate limit', async () => {
  await call('POST', '/api/setup', { username: 'admin1', password: 'long-enough-1' });
  let last;
  for (let i = 0; i < 11; i++) {
    last = await call('POST', '/api/login', { username: 'admin1', password: 'wrong-' + i }, { 'X-Forwarded-For': 'forged-' + i + ', 203.0.113.9' });
  }
  assert.strictEqual(last.status, 429);
});

test('changing your password signs out your other sessions, and logout clears a Secure cookie', async () => {
  const a = cookieOf(await call('POST', '/api/login', { username: 'admin1', password: 'long-enough-1' }, { 'X-Forwarded-For': '198.51.100.1' }));
  const b = cookieOf(await call('POST', '/api/login', { username: 'admin1', password: 'long-enough-1' }, { 'X-Forwarded-For': '198.51.100.1' }));
  assert.strictEqual((await call('GET', '/api/status', undefined, { Cookie: b })).status, 200);
  const ch = await call('POST', '/api/me/password', { current: 'long-enough-1', password: 'long-enough-2' }, { Cookie: a });
  assert.strictEqual(ch.status, 200);
  assert.strictEqual((await call('GET', '/api/session', undefined, { Cookie: a })).json.loggedIn, true);
  assert.strictEqual((await call('GET', '/api/session', undefined, { Cookie: b })).json.loggedIn, false);
  const out = await call('POST', '/api/logout', {}, { Cookie: a });
  assert.match(out.headers.get('set-cookie'), /Max-Age=0; Secure/);
});
