const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');
const Notify = require('../lib/notify.js');

const TG = 'tgram://123456:ABCdefGHIjklMNOpqr/-100555';
const day = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

test('telegram links: token with a colon, several chats, bad input', () => {
  const p = Notify.parseLink('tgram://123456:ABCdefGHIjklMNOpqr/-100555/@room_one');
  assert.strictEqual(p.type, 'telegram');
  assert.strictEqual(p.token, '123456:ABCdefGHIjklMNOpqr');
  assert.deepStrictEqual(p.chats, ['-100555', '@room_one']);
  assert.ok(Notify.parseLink('tgram://nonsense/1').error);
  assert.ok(Notify.parseLink('tgram://123456:ABCdefGHIjklMNOpqr').error);
  assert.ok(Notify.parseLink('ftp://x').error);
});

test('email links: known provider, from and to, encoded password, generic host', () => {
  const g = Notify.parseLink('mailto://sender:pa%40ss%2Fword@gmail.com/to.one@example.com/to.two@example.com');
  assert.strictEqual(g.smtp, 'smtp.gmail.com');
  assert.strictEqual(g.port, 587);
  assert.strictEqual(g.mode, 'starttls');
  assert.strictEqual(g.pass, 'pa@ss/word');
  assert.strictEqual(g.from, 'sender@gmail.com');
  assert.deepStrictEqual(g.to, ['to.one@example.com', 'to.two@example.com']);
  const o = Notify.parseLink('mailto://me@example.org:pw@outlook.com/x@example.com');
  assert.strictEqual(o.smtp, 'smtp-mail.outlook.com');
  assert.strictEqual(o.from, 'me@example.org');
  const self = Notify.parseLink('mailto://u:pw@gmail.com');
  assert.deepStrictEqual(self.to, ['u@gmail.com']);
  const gen = Notify.parseLink('mailto://u:pw@mail.example.com:2525/x@example.com?mode=none&name=Demo&from=a@example.com');
  assert.strictEqual(gen.smtp, 'mail.example.com');
  assert.strictEqual(gen.port, 2525);
  assert.strictEqual(gen.mode, 'none');
  assert.strictEqual(gen.from, 'a@example.com');
  assert.strictEqual(Notify.parseLink('mailto://u:pw@mail.example.com/x@example.com?mode=ssl').port, 465);
  assert.ok(Notify.parseLink('mailtos://u:pw@mail.example.com/x@example.com?mode=none').error);
  assert.ok(Notify.parseLink('mailto://u:pw@gmail.com/not-an-address').error);
  assert.ok(Notify.parseLink('mailto://gmail.com/x@example.com').error);
});

test('errors never repeat the link', () => {
  const bad = Notify.parseLink('mailto://user:SECRETPW@gmail.com/oops');
  assert.ok(bad.error && bad.error.indexOf('SECRETPW') < 0 && bad.error.indexOf('user') < 0);
});

test('targets come from env slots and the public view has no link', () => {
  const t = Notify.loadTargets({ NOTIFY_1_NAME: 'Alex Telegram', NOTIFY_1_LINK: TG, NOTIFY_2_NAME: 'Bad', NOTIFY_2_LINK: 'mailto://nope', NOTIFY_3_NAME: 'alex telegram', NOTIFY_3_LINK: TG });
  assert.strictEqual(t.length, 3);
  assert.strictEqual(t[0].ready, true);
  assert.strictEqual(t[1].ready, false);
  assert.strictEqual(t[2].ready, false);
  const pub = JSON.stringify(t.map(Notify.publicTarget));
  assert.ok(pub.indexOf('ABCdef') < 0 && pub.indexOf('tgram') < 0);
  assert.deepStrictEqual(Notify.loadTargets({}), []);
});

test('slot timing: on time, 6h catch-up, too late, wrong day, past midnight', () => {
  const tz = 'UTC';
  const at = (s) => new Date(s + 'Z');
  // 2026-10-18 is a Sunday.
  assert.strictEqual(Notify.dueSlot(at('2026-10-18T08:00:30'), tz, 0, '08:00'), '2026-10-18 08:00');
  assert.strictEqual(Notify.dueSlot(at('2026-10-18T13:59:00'), tz, 0, '08:00'), '2026-10-18 08:00');
  assert.strictEqual(Notify.dueSlot(at('2026-10-18T14:01:00'), tz, 0, '08:00'), null);
  assert.strictEqual(Notify.dueSlot(at('2026-10-18T07:59:00'), tz, 0, '08:00'), null);
  assert.strictEqual(Notify.dueSlot(at('2026-10-19T08:00:00'), tz, 0, '08:00'), null);
  assert.strictEqual(Notify.dueSlot(at('2026-10-19T01:30:00'), tz, 0, '22:00'), '2026-10-18 22:00');
  assert.strictEqual(Notify.dueSlot(at('2026-10-19T04:30:00'), tz, 0, '22:00'), null);
  assert.strictEqual(Notify.dueSlot(at('2026-10-18T12:00:00'), 'America/New_York', 0, '08:00'), '2026-10-18 08:00');
});

test('message: sections per car, escaping, no red or green', () => {
  const m = Notify.buildSummary([
    { name: 'Demo <SUV>', odometer: 12000, date: '2026-10-15', over: -134, week: 400, projectedVsLimit: -900, daysSince: 3 },
    { name: 'Demo Sedan', odometer: 9000, date: '2026-09-01', over: 56, week: -10, projectedVsLimit: 300, daysSince: 40 }
  ], 'sam', 'Oct 18');
  assert.ok(m.text.indexOf('134 mi under pace') > 0 && m.text.indexOf('56 mi over pace') > 0);
  assert.ok(m.text.indexOf('Add a fresh one') > 0);
  assert.ok(m.html.indexOf('Demo &lt;SUV&gt;') > 0 && m.telegram.indexOf('Demo &lt;SUV&gt;') > 0);
  assert.ok(!/#(dc2626|16a34a|ef4444|22c55e|b91c1c)/i.test(m.html));
  const one = Notify.buildSummary([{ name: 'Only', odometer: 5, date: 'd', over: 0, week: 10, projectedVsLimit: 0, daysSince: 1 }], 'sam', 'Oct 18');
  assert.ok(one.text.indexOf('ONLY') < 0 && one.text.indexOf('Right on pace') > 0);
});

// A tiny SMTP server that records the message.
function fakeSmtp(onMail, opts) {
  const o = opts || {};
  const srv = net.createServer((s) => {
    let buf = '', data = false, body = '', from = '', to = [], authed = false;
    s.write('220 hi\r\n');
    s.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (data) {
          if (line === '.') { data = false; onMail({ from: from, to: to, body: body }); s.write('250 ok\r\n'); } else body += line + '\n';
          continue;
        }
        if (/^EHLO/.test(line)) s.write('250-hi\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (/^AUTH PLAIN/.test(line)) {
          const cred = Buffer.from(line.slice(11), 'base64').toString().split('\0');
          if (cred[1] === 'sender@example.com' && cred[2] === 'pw-1' && !o.reject) { authed = true; s.write('235 ok\r\n'); } else s.write('535 5.7.8 nope\r\n');
        } else if (/^MAIL FROM/.test(line)) { from = line.slice(10); s.write('250 ok\r\n'); }
        else if (/^RCPT TO/.test(line)) { to.push(line.slice(8)); s.write('250 ok\r\n'); }
        else if (line === 'DATA') { if (!authed) s.write('530 auth\r\n'); else { data = true; s.write('354 go\r\n'); } }
        else if (line === 'QUIT') s.end('221 bye\r\n');
        else s.write('250 ok\r\n');
      }
    });
    s.on('error', () => {});
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

test('smtp: sends from the account in the link to the recipient', async () => {
  let got = null;
  const srv = await fakeSmtp((m) => { got = m; });
  const link = 'mailto://sender%40example.com:pw-1@127.0.0.1:' + srv.address().port + '/to.demo@example.com?mode=none&name=Odometer';
  const t = Notify.loadTargets({ NOTIFY_1_NAME: 'Sam email', NOTIFY_1_LINK: link })[0];
  assert.ok(t.ready, t.problem);
  const msg = Notify.buildSummary([{ name: 'Demo', odometer: 100, date: '2026-10-15', over: 5, week: 10, projectedVsLimit: 1, daysSince: 1 }], 'sam', 'Oct 18');
  await Notify.sendTo(t, msg);
  srv.close();
  assert.ok(got.from.indexOf('sender@example.com') >= 0);
  assert.deepStrictEqual(got.to.map((x) => x.replace(/[<>]/g, '')), ['to.demo@example.com']);
  assert.ok(/To: <to.demo@example.com>/.test(got.body) && /Subject: Weekly mileage: Oct 18/.test(got.body));
});

test('smtp: a refused sign-in gives a clean error without the password', async () => {
  const srv = await fakeSmtp(() => {}, { reject: true });
  const link = 'mailto://sender%40example.com:pw-1@127.0.0.1:' + srv.address().port + '/x@example.com?mode=none';
  const t = Notify.loadTargets({ NOTIFY_1_NAME: 'X', NOTIFY_1_LINK: link })[0];
  await assert.rejects(Notify.sendTo(t, { subject: 's', text: 't', html: 'h' }), (e) => /rejected the sign-in/.test(e.message) && e.message.indexOf('pw-1') < 0);
  srv.close();
});

test('telegram: posts HTML to each chat and hides the token in errors', async () => {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      seen.push({ url: req.url, body: JSON.parse(b) });
      res.setHeader('Content-Type', 'application/json');
      if (req.url.indexOf('FAIL') >= 0) { res.statusCode = 401; res.end(JSON.stringify({ ok: false, description: 'Unauthorized bot123456:FAILtokenFAILtoken' })); } else res.end('{"ok":true}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const t = Notify.loadTargets({ NOTIFY_1_NAME: 'T', NOTIFY_1_LINK: 'tgram://123456:ABCdefGHIjklMNOpqr/1/2' })[0];
  await Notify.sendTo(t, { telegram: '<b>hi</b>' }, { base: base });
  assert.strictEqual(seen.length, 2);
  assert.strictEqual(seen[0].body.parse_mode, 'HTML');
  const f = Notify.loadTargets({ NOTIFY_1_NAME: 'T', NOTIFY_1_LINK: 'tgram://123456:FAILtokenFAILtoken/1' })[0];
  await assert.rejects(Notify.sendTo(f, { telegram: 'x' }, { base: base }), (e) => /Unauthorized/.test(e.message) && e.message.indexOf('FAILtoken') < 0);
  srv.close();
});

// ---- the running app ----
const PORT = 22000 + Math.floor(Math.random() * 1000);
const BASE = 'http://127.0.0.1:' + PORT;
let proc, dir, tg, tgSeen = [];
const jar = {};
async function call(who, method, url, body) {
  const h = {};
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (who && jar[who]) h.Cookie = jar[who];
  const r = await fetch(BASE + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc && who) jar[who] = sc.split(';')[0];
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: r.status, json, text };
}

test('app: setup', async () => {
  tg = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { tgSeen.push(JSON.parse(b)); res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}'); }); });
  await new Promise((r) => tg.listen(0, '127.0.0.1', r));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-notify-'));
  proc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: dir, TZ: 'UTC', COOKIE_SECURE: 'false', NOTIFY_TELEGRAM_API: 'http://127.0.0.1:' + tg.address().port, NOTIFY_1_NAME: 'Alex Telegram', NOTIFY_1_LINK: TG, NOTIFY_2_NAME: 'Broken', NOTIFY_2_LINK: 'mailto://zz:SECRETPW@gmail.com/bad' }), stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/session'); break; } catch (e) { await new Promise((r) => setTimeout(r, 100)); } }
  assert.strictEqual((await call('admin', 'POST', '/api/setup', { username: 'demo', password: 'demo-password-1' })).status, 200);
  await call('admin', 'PUT', '/api/settings', { vehicle: 'Test SUV', startDate: day(-100), years: 3, totalMiles: 36000, startOdometer: 100 });
  await call('admin', 'POST', '/api/readings', { date: day(-1), odometer: 1500 });
  await call('admin', 'POST', '/api/users', { username: 'sam', password: 'sam-password-1' });
  await call('sam', 'POST', '/api/login', { username: 'sam', password: 'sam-password-1' });
});

test('app: off by default, then on; targets show names only', async () => {
  const early = await call('admin', 'GET', '/api/notify');
  assert.strictEqual(early.json.enabled, false);
  const users = (await call('admin', 'GET', '/api/users')).json.users;
  const sam = users.find((u) => u.username === 'sam');
  assert.strictEqual((await call('admin', 'POST', '/api/notify/' + sam.id + '/test', {})).status, 404);
  const st = (await call('admin', 'GET', '/api/status')).json;
  await call('admin', 'PUT', '/api/options', Object.assign({}, st.options, { summary: true }));
  const r = await call('admin', 'GET', '/api/notify');
  assert.strictEqual(r.json.enabled, true);
  assert.deepStrictEqual(r.json.targets.map((t) => [t.name, t.ready]), [['Alex Telegram', true], ['Broken', false]]);
  assert.ok(r.text.indexOf('ABCdef') < 0 && r.text.indexOf('SECRETPW') < 0 && r.text.indexOf('tgram') < 0);
});

test('app: admin sets a login up, test send, own view and turn-off', async () => {
  const users = (await call('admin', 'GET', '/api/users')).json.users;
  const sam = users.find((u) => u.username === 'sam');
  const put = await call('admin', 'PUT', '/api/notify/' + sam.id, { on: true, day: 3, time: '07:30', all: true, targets: ['alex telegram', 'Nope'] });
  assert.deepStrictEqual(put.json.notify.targets, ['Alex Telegram']);
  assert.strictEqual((await call('sam', 'PUT', '/api/notify/' + sam.id, { on: true })).status, 403);
  const t = await call('admin', 'POST', '/api/notify/' + sam.id + '/test', {});
  assert.strictEqual(t.status, 200);
  assert.deepStrictEqual(t.json.results, [{ name: 'Alex Telegram', ok: true }]);
  assert.ok(/sam/.test(tgSeen[0].text) && /pace/.test(tgSeen[0].text));
  const mine = await call('sam', 'GET', '/api/notify');
  assert.strictEqual(mine.json.users.length, 1);
  assert.strictEqual(mine.json.users[0].username, 'sam');
  assert.deepStrictEqual(mine.json.targets, []);
  assert.strictEqual((await call('sam', 'POST', '/api/notify/' + sam.id + '/off', {})).status, 200);
  assert.strictEqual((await call('sam', 'GET', '/api/notify')).json.users[0].notify.on, false);
  const admin = users.find((u) => u.role === 'admin');
  assert.strictEqual((await call('sam', 'POST', '/api/notify/' + admin.id + '/off', {})).status, 403);
});

test('app: links never reach the data file, backup, status or API', async () => {
  await call('admin', 'PUT', '/api/options', Object.assign({}, (await call('admin', 'GET', '/api/status')).json.options, { summary: true, backup: true }));
  const files = [fs.readFileSync(path.join(dir, 'odometer-pace.json'), 'utf8')];
  files.push((await call('admin', 'GET', '/api/backup')).text, (await call('admin', 'GET', '/api/status')).text, (await call('admin', 'GET', '/api/users')).text);
  files.forEach((f) => { assert.ok(f.indexOf('ABCdef') < 0 && f.indexOf('SECRETPW') < 0 && f.indexOf('tgram') < 0); });
});

test('app: cleanup', () => { proc.kill(); tg.close(); fs.rmSync(dir, { recursive: true, force: true }); });
