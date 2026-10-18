const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const Lease = require('../lib/lease.js');

// Invented lease: 36,000 miles over 3 years, started 100 days ago.
const iso = (d) => d.toISOString().slice(0, 10);
const day = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const SETTINGS = { vehicle: 'Test car', startDate: day(-100), years: 3, totalMiles: 36000, startOdometer: 100 };
const PORT = 20000 + Math.floor(Math.random() * 1000);
const BASE = 'http://127.0.0.1:' + PORT;
let proc, dir, cookie = '', key = '';

async function call(method, url, body, headers) {
  const h = Object.assign({}, headers);
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (cookie && !(headers && 'Cookie' in headers)) h.Cookie = cookie;
  const r = await fetch(BASE + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc && !(headers && 'Cookie' in headers)) cookie = sc.split(';')[0];
  let json = null, text = '';
  try { text = await r.clone().text(); json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: r.status, json, text, headers: r.headers };
}

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-feat-'));
  proc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: Object.assign({}, process.env, { PORT, DATA_DIR: dir }) });
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/api/session'); break; } catch (e) { await new Promise((r) => setTimeout(r, 100)); }
  }
  await call('POST', '/api/setup', { username: 'admin1', password: 'long-enough-1' });
  await call('PUT', '/api/settings', SETTINGS);
  key = (await call('POST', '/api/tokens', { name: 'Test agent' })).json.key;
  await call('POST', '/api/readings', { date: day(-90), odometer: 1300 });
  await call('POST', '/api/readings', { date: day(-1), odometer: 4000 });
});
test.after(() => { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

const agent = (url) => call('GET', url, undefined, { Authorization: 'Bearer ' + key, Cookie: '' });

test('lease math: fee, trip what-if and glance numbers', () => {
  const plan = Lease.makePlan(SETTINGS);
  assert.strictEqual(Lease.fee(100, 0.25), 25);
  assert.strictEqual(Lease.fee(-5, 0.25), 0);
  assert.strictEqual(Lease.fee(100, null), null);
  const ev = { projected: plan.limit - 500, remaining: 30000, daysLeft: 900 };
  const w = Lease.whatIf(plan, ev, 800, 0.25);
  assert.strictEqual(w.projected_vs_limit, 300);
  assert.strictEqual(w.projected_fee, 75);
  assert.strictEqual(w.fee_added, 75);
  assert.strictEqual(w.miles_remaining, 29200);
  assert.strictEqual(Lease.whatIf(plan, ev, -1, 0.25), null);
  const real = Lease.evaluate(plan, [{ date: day(-1), odometer: 4000 }]);
  const g = Lease.glance(plan, real, day(0), { level: 'none', days_since_reading: 1 });
  assert.strictEqual(g.state, 'active');
  assert.ok(g.can_drive_week >= g.can_drive_today);
  assert.strictEqual(Lease.glance(plan, null, day(0), null).status, 'no_reading');
  assert.strictEqual(Lease.glance(plan, real, day(-200), null).state, 'not_started');
});

test('every optional feature is off by default and hidden from the status', async () => {
  const st = (await call('GET', '/api/status')).json;
  assert.deepStrictEqual([st.options.overage, st.options.whatif, st.options.glance, st.options.backup], [false, false, false, false]);
  assert.strictEqual(st.glance, undefined);
  assert.strictEqual(st.overage, undefined);
  assert.strictEqual((await agent('/api/v1/glance')).status, 404);
  assert.strictEqual((await call('GET', '/api/export.csv')).status, 404);
  assert.strictEqual((await call('GET', '/api/backup')).status, 404);
  assert.strictEqual((await call('POST', '/api/restore', {})).status, 404);
});

test('only the admin changes options, and a bad rate is refused', async () => {
  assert.strictEqual((await call('PUT', '/api/options', { overage: true, overageRate: 'abc' })).status, 400);
  assert.strictEqual((await call('PUT', '/api/options', { overage: true, overageRate: 99 })).status, 400);
  assert.strictEqual((await agent('/api/options')).status === 200, false);
  await call('POST', '/api/users', { username: 'wife1', password: 'long-enough-3' });
  const admin = cookie;
  await call('POST', '/api/login', { username: 'wife1', password: 'long-enough-3' });
  assert.strictEqual((await call('PUT', '/api/options', { glance: true })).status, 403);
  cookie = admin;
});

test('overage cost and glance appear once switched on', async () => {
  const r = await call('PUT', '/api/options', { overage: true, glance: true, whatif: true, backup: true, overageRate: '$0.25' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.options.overageRate, 0.25);
  assert.strictEqual(r.json.overage.rate_per_mile, 0.25);
  assert.strictEqual(typeof r.json.overage.projected_fee, 'number');
  const g = await agent('/api/v1/glance');
  assert.strictEqual(g.status, 200);
  assert.ok(['on_track', 'over'].includes(g.json.status));
  assert.ok(g.json.can_drive_week >= 0 && g.json.can_drive_today >= 0);
  assert.ok(!('readings' in g.json) && !('lease' in g.json));
  assert.strictEqual((await call('GET', '/api/v1/glance', undefined, { Cookie: '' })).status, 401);
});

test('CSV export lists readings', async () => {
  const csv = await call('GET', '/api/export.csv');
  assert.strictEqual(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const lines = csv.text.trim().split('\n');
  assert.strictEqual(lines[0], 'date,odometer,source');
  assert.strictEqual(lines.length, 3);
});

test('backup downloads without secrets and restores a clean copy', async () => {
  const b = await call('GET', '/api/backup');
  assert.strictEqual(b.status, 200);
  assert.ok(!b.text.includes(key) && !/hash|salt|password/i.test(b.text.replace(/odometer-pace/g, '')));
  const file = b.json;
  assert.strictEqual(file.app, 'odometer-pace');
  await call('DELETE', '/api/readings/' + day(-1));
  const restored = await call('POST', '/api/restore', file);
  assert.strictEqual(restored.status, 200);
  assert.strictEqual(restored.json.readings.length, file.readings.length);
  const bad = JSON.parse(JSON.stringify(file));
  bad.readings.push({ date: day(-50), odometer: 99999 });
  const refused = await call('POST', '/api/restore', bad);
  assert.strictEqual(refused.status, 400);
  assert.strictEqual((await call('GET', '/api/status')).json.readings.length, file.readings.length);
  assert.strictEqual((await call('POST', '/api/restore', { app: 'other' })).status, 400);
});

test('the page has a GitHub footer link and the new cards', async () => {
  const js = await (await fetch(BASE + '/app.js')).text();
  assert.ok(js.includes('https://github.com/dhrandy/odometer-pace') && js.includes('noopener'));
  assert.ok(js.includes('glanceCard') && js.includes('whatIfCard') && js.includes('featuresCard'));
});

test('history lists who entered each reading, person or API key, and replaced values', async () => {
  const h0 = (await call('GET', '/api/history')).json.history;
  assert.ok(h0.length >= 2);
  const d = day(-5);
  await call('POST', '/api/readings', { date: d, odometer: 2000 });
  await call('POST', '/api/v1/readings', { date: d, odometer: 2100 }, { Authorization: 'Bearer ' + key, Cookie: '' });
  const h = (await call('GET', '/api/history')).json.history;
  assert.strictEqual(h.length, h0.length + 2);
  assert.strictEqual(h[0].by, 'api');
  assert.strictEqual(h[0].name, 'Test agent');
  assert.strictEqual(h[0].owner, 'admin1');
  assert.strictEqual(h[0].odometer, 2100);
  assert.strictEqual(h[0].previous, 2000);
  assert.strictEqual(h[1].by, 'person');
  assert.strictEqual(h[1].name, 'admin1');
  assert.strictEqual(h[1].previous, null);
  const del = await call('DELETE', '/api/readings/' + d, {});
  assert.strictEqual(del.status, 200, del.text);
  const h2 = (await call('GET', '/api/history')).json.history;
  assert.strictEqual(h2[0].deleted, true);
});

test('history needs a login, a user sees it too, and the API key cannot read it', async () => {
  assert.strictEqual((await call('GET', '/api/history', undefined, { Cookie: '' })).status, 401);
  assert.strictEqual((await agent('/api/history')).status, 401);
  const mine = cookie;
  await call('POST', '/api/users', { username: 'helper1', password: 'long-enough-2' });
  await call('POST', '/api/login', { username: 'helper1', password: 'long-enough-2' });
  assert.strictEqual((await call('GET', '/api/history')).status, 200);
  assert.strictEqual((await call('GET', '/api/history.csv')).status, 403);
  cookie = mine;
});

test('history can be hidden in Settings and starts on', async () => {
  const st = (await call('GET', '/api/status')).json;
  assert.strictEqual(st.options.history, true);
  const o = Object.assign({}, st.options, { history: false });
  await call('PUT', '/api/options', o);
  assert.strictEqual((await call('GET', '/api/history')).status, 404);
  assert.strictEqual((await call('GET', '/api/status')).json.options.history, false);
  await call('PUT', '/api/options', Object.assign({}, o, { history: true }));
  assert.strictEqual((await call('GET', '/api/history')).status, 200);
});

test('backup and CSV carry the history and restore brings it back', async () => {
  const b = (await call('GET', '/api/backup')).json;
  assert.ok(Array.isArray(b.history) && b.history.length > 2);
  const csv = await call('GET', '/api/history.csv');
  assert.strictEqual(csv.status, 200);
  assert.strictEqual(csv.text.split('\n')[0], 'saved,date,odometer,previous,by,name,owner,deleted');
  const n = b.history.length;
  await call('POST', '/api/readings', { date: day(-3), odometer: 3000 });
  assert.strictEqual((await call('POST', '/api/restore', b)).status, 200);
  assert.strictEqual((await call('GET', '/api/history')).json.history.length, n);
  const old = JSON.parse(JSON.stringify(b)); delete old.history;
  assert.strictEqual((await call('POST', '/api/restore', old)).status, 200);
  const seeded = (await call('GET', '/api/history')).json.history;
  assert.strictEqual(seeded.length, old.readings.length);
});

test('the same value for the same date changes nothing and adds no history', async () => {
  const d = day(-4);
  await call('POST', '/api/readings', { date: d, odometer: 2500 });
  const n = (await call('GET', '/api/history')).json.history.length;
  const web = await call('POST', '/api/readings', { date: d, odometer: 2500 });
  assert.strictEqual(web.status, 200);
  assert.strictEqual(web.json.unchanged, true);
  const api = await call('POST', '/api/v1/readings', { date: d, odometer: 2500 }, { Authorization: 'Bearer ' + key, Cookie: '' });
  assert.strictEqual(api.status, 200);
  assert.strictEqual(api.json.unchanged, true);
  assert.strictEqual(api.json.replaced, false);
  assert.strictEqual((await call('GET', '/api/history')).json.history.length, n);
  // The same value on a different date is a normal new entry.
  await call('POST', '/api/readings', { date: day(-3), odometer: 2500 });
  assert.strictEqual((await call('GET', '/api/history')).json.history.length, n + 1);
  // A different value on the same date still replaces and logs.
  const r = await call('POST', '/api/v1/readings', { date: d, odometer: 2400 }, { Authorization: 'Bearer ' + key, Cookie: '' });
  assert.strictEqual(r.json.replaced, true);
  assert.strictEqual(r.json.unchanged, false);
});

test('the icons are the road mark and the manifest and page point at real files', async () => {
  const m = (await call('GET', '/manifest.webmanifest')).json;
  for (const i of m.icons) assert.strictEqual((await fetch(BASE + i.src)).status, 200, i.src);
  const html = await (await fetch(BASE + '/')).text();
  assert.ok(html.includes('/icon-180.png'));
  const svg = await (await fetch(BASE + '/icon.svg')).text();
  assert.ok(svg.includes('M17 40L21.5 8') && !svg.includes('#6d28d9'));
  const png = await fetch(BASE + '/icon-512.png');
  assert.strictEqual(png.headers.get('content-type'), 'image/png');
});

test('the page has the slim header, pace status, merged glance card, month and year calendar', async () => {
  const js = await (await fetch(BASE + '/app.js')).text();
  for (const k of ['summary-line', 'hero-status', 'merge-rule', 'month-nav', "'months year'", 'day-detail', 'touchstart']) assert.ok(js.includes(k), k);
  assert.ok(!js.includes('s.readings.slice().reverse()'), 'no readings list under the chart');
  assert.ok(js.includes('drawChart') || js.includes('function chart('), 'chart is kept');
  const css = await (await fetch(BASE + '/style.css')).text();
  assert.match(css, /\.stats\.tight/);
  assert.match(css, /\.month\.big \.day[^}]*min-height: 44px/);
});

test('delete lives on the History page only, and empty weeks are left out of the month grid', async () => {
  const js = await (await fetch(BASE + '/app.js')).text();
  const card = js.slice(js.indexOf("class: 'card day-detail'"), js.indexOf("class: 'card day-detail'") + 900);
  assert.ok(!card.includes("iconBtn('trash'"), 'no trash in the day card');
  const hist = js.slice(js.indexOf('function renderHistory'));
  assert.ok(hist.includes("iconBtn('trash'") && hist.includes("me.role === 'admin'"));
  assert.ok(js.includes('cells.splice(0, 7)'));
});
