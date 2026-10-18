const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Invented leases, not real household data.
const iso = (d) => d.toISOString().slice(0, 10);
const day = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const ONE = { vehicle: 'Test SUV', startDate: day(-100), years: 3, totalMiles: 36000, startOdometer: 100 };
const TWO = { vehicle: 'Test Sedan', startDate: day(-60), years: 2, totalMiles: 24000, startOdometer: 50 };
const PORT = 21000 + Math.floor(Math.random() * 1000);
const BASE = 'http://127.0.0.1:' + PORT;
let proc, dir;
const jar = { admin: '', sam: '' };
let car1, car2;

async function call(who, method, url, body, headers) {
  const h = Object.assign({}, headers);
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (who && jar[who]) h.Cookie = jar[who];
  const r = await fetch(BASE + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc && who) jar[who] = sc.split(';')[0];
  let json = null, text = '';
  try { text = await r.clone().text(); json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: r.status, json, text, headers: r.headers };
}
const key = (k, url, method, body) => call(null, method || 'GET', url, body, { Authorization: 'Bearer ' + k });

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-veh-'));
  // A data file from before multiple vehicles: one car stored at the top.
  fs.writeFileSync(path.join(dir, 'odometer-pace.json'), JSON.stringify({
    settings: ONE, readings: [{ date: day(-90), odometer: 1300, source: 'web:old', saved: new Date().toISOString() }], tokens: [], users: [], sessions: [], options: { history: true }
  }));
  proc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: Object.assign({}, process.env, { PORT, DATA_DIR: dir }) });
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/api/session'); break; } catch (e) { await new Promise((r) => setTimeout(r, 100)); }
  }
  await call('admin', 'POST', '/api/setup', { username: 'admin1', password: 'long-enough-1' });
});
test.after(() => { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

test('an older one-car data file becomes car one and nothing else changes', async () => {
  const st = (await call('admin', 'GET', '/api/status')).json;
  assert.strictEqual(st.lease.vehicle, 'Test SUV');
  assert.strictEqual(st.readings.length, 1);
  assert.strictEqual(st.vehicles, undefined, 'the picker list only exists when the feature is on');
  car1 = st.vehicle_id;
  assert.ok(car1);
  assert.strictEqual((await call('admin', 'GET', '/api/history')).json.history.length, 1);
  assert.strictEqual((await call('admin', 'GET', '/api/status?vehicle=nope')).status, 404);
});

test('with Multiple vehicles off, cars cannot be added', async () => {
  assert.strictEqual((await call('admin', 'POST', '/api/vehicles', TWO)).status, 400);
  const o = (await call('admin', 'GET', '/api/status')).json.options;
  assert.strictEqual(o.multi, false);
});

test('turning it on adds the picker list and lets the admin add a car', async () => {
  const r = await call('admin', 'PUT', '/api/options', { multi: true, backup: true, history: true });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.vehicles.length, 1);
  const add = await call('admin', 'POST', '/api/vehicles', TWO);
  assert.strictEqual(add.status, 200);
  car2 = add.json.id;
  assert.strictEqual(add.json.vehicles.length, 2);
  assert.strictEqual((await call('admin', 'POST', '/api/vehicles', { vehicle: 'x', startDate: 'bad' })).status, 400);
});

test('each car keeps its own lease, readings and history', async () => {
  assert.strictEqual((await call('admin', 'POST', '/api/readings?vehicle=' + car2, { date: day(-5), odometer: 900 })).status, 200);
  assert.strictEqual((await call('admin', 'POST', '/api/readings?vehicle=' + car1, { date: day(-5), odometer: 2000 })).status, 200);
  const a = (await call('admin', 'GET', '/api/status?vehicle=' + car1)).json;
  const b = (await call('admin', 'GET', '/api/status?vehicle=' + car2)).json;
  assert.strictEqual(a.lease.vehicle, 'Test SUV');
  assert.strictEqual(b.lease.vehicle, 'Test Sedan');
  assert.strictEqual(a.readings.length, 2);
  assert.strictEqual(b.readings.length, 1);
  assert.strictEqual(b.readings[0].odometer, 900);
  assert.strictEqual((await call('admin', 'GET', '/api/history?vehicle=' + car2)).json.history.length, 1);
  assert.strictEqual((await call('admin', 'GET', '/api/history?vehicle=' + car1)).json.history.length, 2);
  assert.strictEqual(a.vehicles.length, 2);
  assert.ok(a.vehicles.every((v) => v.name && v.id));
  // The lease form edits the car that was picked.
  assert.strictEqual((await call('admin', 'PUT', '/api/settings?vehicle=' + car2, Object.assign({}, TWO, { vehicle: 'Test Sedan 2' }))).status, 200);
  assert.strictEqual((await call('admin', 'GET', '/api/status?vehicle=' + car1)).json.lease.vehicle, 'Test SUV');
  assert.strictEqual((await call('admin', 'GET', '/api/status?vehicle=' + car2)).json.lease.vehicle, 'Test Sedan 2');
  // Deleting a reading only touches that car.
  assert.strictEqual((await call('admin', 'DELETE', '/api/readings/' + day(-5) + '?vehicle=' + car2, {})).status, 200);
  assert.strictEqual((await call('admin', 'GET', '/api/status?vehicle=' + car2)).json.readings.length, 0);
  assert.strictEqual((await call('admin', 'GET', '/api/status?vehicle=' + car1)).json.readings.length, 2);
  await call('admin', 'POST', '/api/readings?vehicle=' + car2, { date: day(-5), odometer: 900 });
});

test('a login only reaches the cars it is given, and new logins see all by default', async () => {
  assert.strictEqual((await call('admin', 'POST', '/api/users', { username: 'sam', password: 'sam-password-1' })).status, 200);
  const list = (await call('admin', 'GET', '/api/users')).json.users;
  const sam = list.find((u) => u.username === 'sam');
  assert.strictEqual(sam.access, 'all');
  assert.strictEqual((await call('sam', 'POST', '/api/login', { username: 'sam', password: 'sam-password-1' })).status, 200);
  assert.strictEqual((await call('sam', 'GET', '/api/status')).json.vehicles.length, 2);
  assert.strictEqual((await call('admin', 'PUT', '/api/users/' + sam.id + '/access', { vehicles: [car1] })).status, 200);
  const st = (await call('sam', 'GET', '/api/status')).json;
  assert.deepStrictEqual(st.vehicles.map((v) => v.id), [car1]);
  assert.strictEqual((await call('sam', 'GET', '/api/status?vehicle=' + car2)).status, 404);
  assert.strictEqual((await call('sam', 'POST', '/api/readings?vehicle=' + car2, { date: day(-1), odometer: 950 })).status, 404);
  assert.strictEqual((await call('sam', 'GET', '/api/history?vehicle=' + car2)).status, 404);
  assert.strictEqual((await call('sam', 'POST', '/api/readings?vehicle=' + car1, { date: day(-1), odometer: 2100 })).status, 200);
  // Only the admin manages cars and access.
  assert.strictEqual((await call('sam', 'POST', '/api/vehicles', TWO)).status, 403);
  assert.strictEqual((await call('sam', 'PUT', '/api/users/' + sam.id + '/access', { all: true })).status, 403);
  assert.strictEqual((await call('sam', 'PUT', '/api/settings?vehicle=' + car1, ONE)).status, 403);
  // A new login can be created with a list.
  assert.strictEqual((await call('admin', 'POST', '/api/users', { username: 'kim', password: 'kim-password-1', vehicles: [car2] })).status, 200);
  assert.deepStrictEqual((await call('admin', 'GET', '/api/users')).json.users.find((u) => u.username === 'kim').access, [car2]);
  assert.strictEqual((await call('admin', 'PUT', '/api/users/' + sam.id + '/access', { all: true })).status, 200);
});

test('an API key reaches one car only', async () => {
  const k1 = (await call('admin', 'POST', '/api/tokens', { name: 'Agent one', vehicle: car1 })).json.key;
  const k2 = (await call('admin', 'POST', '/api/tokens', { name: 'Agent two', vehicle: car2 })).json.key;
  assert.strictEqual((await key(k1, '/api/v1/status')).json.lease.vehicle, 'Test SUV');
  assert.strictEqual((await key(k2, '/api/v1/status')).json.lease.vehicle, 'Test Sedan 2');
  assert.strictEqual((await key(k2, '/api/v1/readings')).json.readings.length, 1);
  assert.strictEqual((await key(k2, '/api/v1/readings', 'POST', { odometer: 950 })).status, 200);
  assert.strictEqual((await key(k2, '/api/v1/readings')).json.readings.length, 2);
  assert.strictEqual((await key(k1, '/api/v1/readings')).json.readings.length, 3);
  // A key for a car the person cannot see is refused.
  assert.strictEqual((await call('admin', 'POST', '/api/tokens', { name: 'Bad', vehicle: 'ffffff' })).status, 400);
  const sam = (await call('admin', 'GET', '/api/users')).json.users.find((u) => u.username === 'sam');
  await call('admin', 'PUT', '/api/users/' + sam.id + '/access', { vehicles: [car1] });
  assert.strictEqual((await call('sam', 'POST', '/api/tokens', { name: 'Sam key', vehicle: car2 })).status, 400);
  const sk = (await call('sam', 'POST', '/api/tokens', { name: 'Sam key', vehicle: car1 })).json.key;
  assert.strictEqual((await key(sk, '/api/v1/status')).status, 200);
  // Losing access to the car stops the key.
  await call('admin', 'PUT', '/api/users/' + sam.id + '/access', { vehicles: [car2] });
  assert.strictEqual((await key(sk, '/api/v1/status')).status, 403);
  await call('admin', 'PUT', '/api/users/' + sam.id + '/access', { all: true });
  const listed = (await call('admin', 'GET', '/api/tokens')).json.tokens;
  assert.ok(listed.every((t) => t.vehicle));
  test.k2 = k2;
});

test('backup holds every car, and an older one-car backup only replaces car one', async () => {
  const b = (await call('admin', 'GET', '/api/backup')).json;
  assert.strictEqual(b.version, 2);
  assert.strictEqual(b.vehicles.length, 2);
  assert.ok(!JSON.stringify(b).includes('hash'));
  assert.strictEqual((await call('admin', 'POST', '/api/restore', b)).status, 200);
  assert.strictEqual((await call('admin', 'GET', '/api/status?vehicle=' + car2)).json.readings.length, 2);
  const v1 = { app: 'odometer-pace', version: 1, settings: ONE, readings: [{ date: day(-90), odometer: 1300 }], options: { multi: false, backup: true } };
  assert.strictEqual((await call('admin', 'POST', '/api/restore', v1)).status, 200);
  assert.strictEqual((await call('admin', 'GET', '/api/status?vehicle=' + car1)).json.readings.length, 1);
  assert.strictEqual((await call('admin', 'GET', '/api/status?vehicle=' + car2)).json.readings.length, 2);
  assert.strictEqual((await call('admin', 'GET', '/api/status')).json.options.multi, true, 'an old backup does not switch the feature off');
  const bad = JSON.parse(JSON.stringify(b));
  bad.vehicles[1].readings.push({ date: day(-200), odometer: 5 });
  const refused = await call('admin', 'POST', '/api/restore', bad);
  assert.strictEqual(refused.status, 400);
  assert.ok(/Vehicle 2/.test(refused.json.error));
});

test('CSV files are per car and named for the car', async () => {
  const r = await call('admin', 'GET', '/api/export.csv?vehicle=' + car2);
  assert.strictEqual(r.status, 200);
  assert.ok(/odometer-readings-test-sedan-2\.csv/.test(r.headers.get('content-disposition')));
  assert.strictEqual(r.text.trim().split('\n').length, 1 + 2);
  const h = await call('admin', 'GET', '/api/history.csv?vehicle=' + car1);
  assert.strictEqual(h.status, 200);
});

test('archive hides a car, delete is permanent and only after archiving', async () => {
  assert.strictEqual((await call('admin', 'DELETE', '/api/vehicles/' + car2, {})).status, 400);
  assert.strictEqual((await call('admin', 'POST', '/api/vehicles/' + car2 + '/archive', {})).status, 200);
  assert.strictEqual((await call('admin', 'GET', '/api/status')).json.vehicles.length, 1);
  assert.strictEqual((await call('admin', 'GET', '/api/status?vehicle=' + car2)).status, 404);
  assert.strictEqual((await key(test.k2, '/api/v1/status')).status, 403);
  assert.strictEqual((await call('admin', 'POST', '/api/vehicles/' + car1 + '/archive', {})).status, 400, 'keep one car');
  assert.strictEqual((await call('admin', 'POST', '/api/vehicles/' + car2 + '/restore', {})).status, 200);
  assert.strictEqual((await call('admin', 'GET', '/api/status?vehicle=' + car2)).status, 200);
  assert.strictEqual((await key(test.k2, '/api/v1/status')).status, 200);
  await call('admin', 'POST', '/api/vehicles/' + car2 + '/archive', {});
  assert.strictEqual((await call('sam', 'POST', '/api/vehicles/' + car2 + '/archive', {})).status, 403);
  assert.strictEqual((await call('admin', 'DELETE', '/api/vehicles/' + car2, {})).status, 200);
  assert.strictEqual((await call('admin', 'GET', '/api/vehicles')).json.vehicles.length, 1);
  assert.strictEqual((await key(test.k2, '/api/v1/status')).status, 401, 'its keys went with it');
});

test('turning the feature off goes back to the single-car app', async () => {
  const add = await call('admin', 'POST', '/api/vehicles', TWO);
  const id = add.json.id;
  const k = (await call('admin', 'POST', '/api/tokens', { name: 'Third', vehicle: id })).json.key;
  const off = await call('admin', 'PUT', '/api/options', { multi: false, backup: true, history: true });
  assert.strictEqual(off.json.vehicles, undefined);
  assert.strictEqual(off.json.lease.vehicle, 'Test SUV');
  assert.strictEqual((await call('admin', 'GET', '/api/status?vehicle=' + id)).status, 404);
  assert.strictEqual((await key(k, '/api/v1/status')).status, 403);
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.ok(html.includes('Multiple vehicles'));
});
