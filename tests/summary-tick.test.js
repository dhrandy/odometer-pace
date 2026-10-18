const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// Runs the weekly scheduler in-process with a local Telegram stand-in.
const day = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

test('tick: sends once per slot, skips a week with no readings, honours car picks', async () => {
  const seen = [];
  const tg = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { seen.push(JSON.parse(b)); res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}'); }); });
  await new Promise((r) => tg.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-tick-'));
  Object.assign(process.env, { DATA_DIR: dir, TZ: 'UTC', NOTIFY_TELEGRAM_API: 'http://127.0.0.1:' + tg.address().port, NOTIFY_1_NAME: 'Alex Telegram', NOTIFY_1_LINK: 'tgram://123456:ABCdefGHIjklMNOpqr/1' });
  const server = require('../server.js');
  const data = server.appData;
  const car = data.vehicles[0];
  car.settings = { vehicle: 'Demo SUV', startDate: day(-100), years: 3, totalMiles: 36000, startOdometer: 100 };
  data.options.summary = true;
  data.users.push({ id: 'aa11', username: 'alex', role: 'admin', notify: { on: true, day: 0, time: '08:00', cars: 'all', targets: ['Alex Telegram'] } });
  const at = new Date('2026-10-18T09:00:00Z'); // a Sunday
  await server.summaryTick(at);
  assert.strictEqual(seen.length, 0, 'no readings: skipped');
  assert.strictEqual(data.users[0].notify.last.result, 'skipped');
  car.readings.push({ date: day(-1), odometer: 1500, source: 'web:demo' });
  await server.summaryTick(at);
  assert.strictEqual(seen.length, 0, 'same slot is not retried after a skip');
  data.users[0].notify.lastSlot = null;
  await server.summaryTick(at);
  assert.strictEqual(seen.length, 1);
  await server.summaryTick(new Date('2026-10-18T09:05:00Z'));
  assert.strictEqual(seen.length, 1, 'once per slot');
  await server.summaryTick(new Date('2026-10-18T15:00:00Z'));
  assert.strictEqual(seen.length, 1, 'past the 6 hour catch-up');
  assert.strictEqual(data.users[0].notify.last.result, 'sent');
  data.options.summary = false;
  data.users[0].notify.lastSlot = null;
  await server.summaryTick(at);
  assert.strictEqual(seen.length, 1, 'off means nothing runs');
  tg.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
