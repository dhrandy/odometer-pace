const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Invented sample lease, not real household data.
const SETTINGS = { vehicle: 'Test car', startDate: '2030-03-01', years: 3, totalMiles: 36000, startOdometer: 10 };
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = 'http://127.0.0.1:' + PORT;
let proc, dir, cookie = '', apiKey = '';

async function call(method, url, body, headers) {
  const h = Object.assign({}, headers);
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (cookie) h.Cookie = cookie;
  const r = await fetch(BASE + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  let json = null;
  try { json = await r.clone().json(); } catch (e) { /* not json */ }
  return { status: r.status, json, headers: r.headers, res: r };
}
const agent = (method, url, body, key) => call(method, url, body, { Authorization: 'Bearer ' + (key || apiKey), Cookie: '' });

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-'));
  proc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: Object.assign({}, process.env, { PORT, DATA_DIR: dir, TZ: 'America/New_York' }) });
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/api/session'); return; } catch (e) { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
});
test.after(() => { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

test('everything is locked until a password is set and used', async () => {
  assert.strictEqual((await call('GET', '/api/status')).status, 401);
  assert.strictEqual((await call('GET', '/api/session')).json.setupNeeded, true);
  assert.strictEqual((await call('POST', '/api/setup', { username: 'admin1', password: 'short' })).status, 400);
  assert.strictEqual((await call('POST', '/api/setup', { username: 'a b', password: 'correct horse' })).status, 400);
  assert.strictEqual((await call('POST', '/api/setup', { username: 'admin1', password: 'correct horse' })).status, 200);
  assert.strictEqual((await call('POST', '/api/setup', { username: 'other', password: 'another one!' })).status, 400);
  assert.strictEqual((await call('GET', '/api/session')).json.me.role, 'admin');
  assert.strictEqual((await call('GET', '/api/status')).status, 200);
});

test('wrong password is refused, right one works after logout', async () => {
  await call('POST', '/api/logout', {});
  cookie = '';
  assert.strictEqual((await call('POST', '/api/login', { username: 'admin1', password: 'nope nope nope' })).status, 401);
  assert.strictEqual((await call('POST', '/api/login', { username: 'ADMIN1', password: 'correct horse' })).status, 200);
});

test('settings then readings', async () => {
  assert.strictEqual((await call('GET', '/api/status')).json.configured, false);
  assert.strictEqual((await call('PUT', '/api/settings', { startDate: 'bad' })).status, 400);
  assert.strictEqual((await call('PUT', '/api/settings', SETTINGS)).status, 200);
  const r = await call('POST', '/api/readings', { odometer: '1,000', date: '2030-03-31' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.latest.odometer, 1000);
  assert.strictEqual((await call('POST', '/api/readings', { odometer: 900, date: '2030-04-05' })).status, 400);
  assert.strictEqual((await call('POST', '/api/readings', { odometer: 5, date: '2029-01-01' })).status, 400);
});

test('admin adds a user, who can add readings but not manage anything', async () => {
  const adminCookie = cookie;
  assert.strictEqual((await call('POST', '/api/users', { username: 'wife', password: 'short' })).status, 400);
  assert.strictEqual((await call('POST', '/api/users', { username: 'wife', password: 'wife password' })).status, 200);
  assert.strictEqual((await call('POST', '/api/users', { username: 'Wife', password: 'wife password' })).status, 400);
  cookie = '';
  assert.strictEqual((await call('POST', '/api/login', { username: 'wife', password: 'wife password' })).status, 200);
  const wifeCookie = cookie;
  const st = await call('GET', '/api/status');
  assert.strictEqual(st.json.me.role, 'user');
  assert.strictEqual((await call('POST', '/api/readings', { odometer: 1200, date: '2030-04-03' })).status, 200);
  assert.strictEqual((await call('GET', '/api/status')).json.readings.find((r) => r.date === '2030-04-03').source, 'web:wife');
  for (const [m, u, b] of [['GET', '/api/settings'], ['PUT', '/api/settings', SETTINGS], ['GET', '/api/users'], ['POST', '/api/users', { username: 'x1', password: 'password123' }], ['DELETE', '/api/readings/2030-04-03', {}]]) {
    assert.strictEqual((await call(m, u, b)).status, 403, m + ' ' + u);
  }
  // Appearance belongs to each login.
  assert.strictEqual((await call('PUT', '/api/ui', { accent: 'pink', oled: true })).status, 200);
  assert.strictEqual((await call('GET', '/api/status')).json.ui.accent, 'pink');
  cookie = adminCookie;
  assert.strictEqual((await call('GET', '/api/status')).json.ui.accent, 'purple');
  cookie = wifeCookie;
  assert.strictEqual((await call('POST', '/api/me/password', { current: 'wrong', password: 'newpassword1' })).status, 400);
  assert.strictEqual((await call('POST', '/api/me/password', { current: 'wife password', password: 'newpassword1' })).status, 200);
  // clean up the extra reading and keep the admin session for later tests
  cookie = adminCookie;
  assert.strictEqual((await call('DELETE', '/api/readings/2030-04-03', {})).status, 200);
});

test('form posts without JSON are refused', async () => {
  const r = await fetch(BASE + '/api/readings', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'odometer=5' });
  assert.strictEqual(r.status, 415);
});

test('api key: shown once, can read and write readings only', async () => {
  const made = await call('POST', '/api/tokens', { name: 'Test agent' });
  assert.strictEqual(made.status, 200);
  apiKey = made.json.key;
  assert.ok(apiKey.startsWith('op_'));
  assert.ok(!fs.readFileSync(path.join(dir, 'odometer-pace.json'), 'utf8').includes(apiKey), 'key must be stored hashed');
  assert.ok(!JSON.stringify((await call('GET', '/api/tokens')).json).includes(apiKey));

  const st = await agent('GET', '/api/v1/status');
  assert.strictEqual(st.status, 200);
  assert.strictEqual(st.json.latest.pace_status, 'under');
  const w = await agent('POST', '/api/v1/readings', { odometer: 1100, date: '2030-04-02' });
  assert.strictEqual(w.status, 200);
  assert.strictEqual(w.json.saved.odometer, 1100);
  assert.strictEqual((await agent('POST', '/api/v1/readings', { odometer: 'abc' })).status, 400);
  assert.strictEqual((await agent('GET', '/api/v1/readings')).json.readings.length, 2);
  assert.strictEqual(JSON.stringify(st.json).includes('correct horse'), false);

  // The key does nothing on the web routes.
  for (const url of ['/api/settings', '/api/tokens', '/api/status']) {
    const r = await fetch(BASE + url, { headers: { Authorization: 'Bearer ' + apiKey } });
    assert.strictEqual(r.status, 401, url);
  }
  assert.strictEqual((await agent('GET', '/api/v1/status', undefined, 'op_wrong')).status, 401);
});

test('every user has their own keys; admin sees and revokes all', async () => {
  const adminCookie = cookie;
  cookie = '';
  await call('POST', '/api/login', { username: 'wife', password: 'newpassword1' });
  const mine = await call('POST', '/api/tokens', { name: 'Her AI' });
  assert.strictEqual(mine.status, 200);
  const herKey = mine.json.key;
  const herList = (await call('GET', '/api/tokens')).json.tokens;
  assert.strictEqual(herList.length, 1);
  assert.strictEqual(herList[0].name, 'Her AI');
  // Her key works on the agent API and the reading is stamped with her name.
  const w = await agent('POST', '/api/v1/readings', { odometer: 1300, date: '2030-04-04' }, herKey);
  assert.strictEqual(w.status, 200);
  assert.ok((await agent('GET', '/api/v1/readings', undefined, herKey)).json.readings.find((r) => r.date === '2030-04-04').source.includes('wife'));
  // She cannot see or revoke the admin's key.
  cookie = adminCookie;
  const adminList = (await call('GET', '/api/tokens')).json.tokens;
  assert.strictEqual(adminList.length, 2);
  const adminsOwn = adminList.find((x) => x.name === 'Test agent');
  cookie = '';
  await call('POST', '/api/login', { username: 'wife', password: 'newpassword1' });
  assert.strictEqual((await call('DELETE', '/api/tokens/' + adminsOwn.id, {})).status, 404);
  assert.strictEqual((await agent('GET', '/api/v1/status')).status, 200);
  // Admin can revoke hers.
  cookie = adminCookie;
  const hers = adminList.find((x) => x.name === 'Her AI');
  assert.strictEqual(hers.owner, 'wife');
  assert.strictEqual((await call('DELETE', '/api/tokens/' + hers.id, {})).status, 200);
  assert.strictEqual((await agent('GET', '/api/v1/status', undefined, herKey)).status, 401);
});

test('removing a user ends their sessions and keys', async () => {
  const adminCookie = cookie;
  cookie = '';
  await call('POST', '/api/login', { username: 'wife', password: 'newpassword1' });
  const wifeCookie = cookie;
  const k = (await call('POST', '/api/tokens', { name: 'temp' })).json.key;
  cookie = adminCookie;
  const users = (await call('GET', '/api/users')).json.users;
  const wife = users.find((u) => u.username === 'wife');
  assert.strictEqual((await call('DELETE', '/api/users/' + users.find((u) => u.role === 'admin').id, {})).status, 400);
  assert.strictEqual((await call('DELETE', '/api/users/' + wife.id, {})).status, 200);
  cookie = wifeCookie;
  assert.strictEqual((await call('GET', '/api/status')).status, 401);
  assert.strictEqual((await agent('GET', '/api/v1/status', undefined, k)).status, 401);
  cookie = adminCookie;
});

test('a session cookie does not work on the agent api', async () => {
  const r = await fetch(BASE + '/api/v1/status', { headers: { Cookie: cookie } });
  assert.strictEqual(r.status, 401);
});

test('revoked key stops working', async () => {
  const list = (await call('GET', '/api/tokens')).json.tokens;
  assert.strictEqual((await call('DELETE', '/api/tokens/' + list[0].id, {})).status, 200);
  assert.strictEqual((await agent('GET', '/api/v1/status')).status, 401);
});

test('docs need a login, robots and headers are set', async () => {
  const saved = cookie; cookie = '';
  assert.strictEqual((await call('GET', '/api/docs')).status, 302);
  cookie = saved;
  assert.strictEqual((await call('GET', '/api/docs')).status, 200);
  const robots = await call('GET', '/robots.txt');
  assert.ok((await robots.res.text()).includes('Disallow: /'));
  const home = await call('GET', '/');
  assert.ok(home.headers.get('x-robots-tag').includes('noindex'));
  assert.ok(home.headers.get('content-security-policy'));
  assert.strictEqual((await call('GET', '/docs.html')).status, 404);
  assert.strictEqual((await call('GET', '/..%2fserver.js')).status, 404);
});

test('readings survive a restart', async () => {
  proc.kill();
  await new Promise((r) => setTimeout(r, 300));
  proc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: Object.assign({}, process.env, { PORT, DATA_DIR: dir, TZ: 'America/New_York' }) });
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/api/session'); break; } catch (e) { await new Promise((r) => setTimeout(r, 100)); }
  }
  const s = await call('GET', '/api/status');
  assert.strictEqual(s.status, 200);
  assert.strictEqual(s.json.readings.length, 3);
});

test('theme choice is saved on the server and validated', async () => {
  assert.strictEqual((await call('GET', '/api/status')).json.ui.accent, 'purple');
  assert.strictEqual((await call('PUT', '/api/ui', { accent: 'red' })).status, 400);
  assert.strictEqual((await call('PUT', '/api/ui', { accent: 'green' })).status, 200);
  assert.strictEqual((await call('PUT', '/api/ui', { accent: 'blue', oled: true })).status, 200);
  const ui = (await call('GET', '/api/status')).json.ui;
  assert.strictEqual(ui.accent, 'blue');
  assert.strictEqual(ui.oled, true);
  // The agent API never carries theme data.
  assert.strictEqual(JSON.stringify((await agent('GET', '/api/v1/status', undefined, 'op_x')).json).includes('oled'), false);
});

test('fonts are served by the app, without a login', async () => {
  for (const f of ['inter', 'source-serif-4']) {
    const r = await fetch(BASE + '/fonts/' + f + '.woff2');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get('content-type'), 'font/woff2');
  }
  const css = await (await fetch(BASE + '/style.css')).text();
  assert.ok(!/https?:\/\//.test(css), 'the stylesheet must not load anything from another site');
});

test('an unreadable data file stops the server instead of starting empty', async () => {
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'op-bad-'));
  fs.writeFileSync(path.join(bad, 'odometer-pace.json'), '{ not json');
  const r = require('child_process').spawnSync('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: Object.assign({}, process.env, { PORT: '8499', DATA_DIR: bad }), timeout: 5000 });
  assert.notStrictEqual(r.status, 0);
  assert.strictEqual(fs.readFileSync(path.join(bad, 'odometer-pace.json'), 'utf8'), '{ not json');
});

test('the login page points AI assistants to a public llms.txt, with nothing private', async () => {
  const html = await (await fetch(BASE + '/')).text();
  assert.ok(html.includes('class="ai-note" aria-hidden="true"') && html.includes('/llms.txt'));
  const r = await fetch(BASE + '/llms.txt', { headers: { Cookie: '' } });
  assert.strictEqual(r.status, 200);
  assert.ok(r.headers.get('content-type').startsWith('text/plain'));
  const txt = await r.text();
  assert.ok(txt.includes('/api/v1/readings') && txt.includes('Authorization: Bearer'));
  assert.ok(!/op_[0-9a-f]{8}/.test(txt + html), 'no key may appear');
});
