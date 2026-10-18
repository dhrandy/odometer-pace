// Weekly summary delivery. Targets come from environment variables, are parsed here, and never leave this module
// except as a name, a type and a ready flag. No dependencies: Telegram goes over HTTPS and email over a small SMTP client.
'use strict';
const net = require('net');
const tls = require('tls');
const https = require('https');
const crypto = require('crypto');

const SLOTS = 4;
const EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

// Known mail hosts need no port or mode in the link.
const PROVIDERS = {
  'gmail.com': { smtp: 'smtp.gmail.com', port: 587, mode: 'starttls' },
  'googlemail.com': { smtp: 'smtp.gmail.com', port: 587, mode: 'starttls' },
  'outlook.com': { smtp: 'smtp-mail.outlook.com', port: 587, mode: 'starttls' },
  'hotmail.com': { smtp: 'smtp-mail.outlook.com', port: 587, mode: 'starttls' },
  'live.com': { smtp: 'smtp-mail.outlook.com', port: 587, mode: 'starttls' },
  'msn.com': { smtp: 'smtp-mail.outlook.com', port: 587, mode: 'starttls' },
  'yahoo.com': { smtp: 'smtp.mail.yahoo.com', port: 465, mode: 'ssl' },
  'icloud.com': { smtp: 'smtp.mail.me.com', port: 587, mode: 'starttls' },
  'me.com': { smtp: 'smtp.mail.me.com', port: 587, mode: 'starttls' }
};

function dec(s) { try { return decodeURIComponent(s); } catch (e) { return null; } }
function query(q) {
  const out = {};
  String(q || '').split('&').forEach((pair) => {
    if (!pair) return;
    const i = pair.indexOf('=');
    const k = dec(i < 0 ? pair : pair.slice(0, i));
    const v = dec(i < 0 ? '' : pair.slice(i + 1));
    if (k !== null && v !== null) out[k.toLowerCase()] = v;
  });
  return out;
}

// Reads one link. Returns { type, ... } or { error }. Errors never repeat any part of the link.
function parseLink(link) {
  const raw = String(link || '').trim();
  const m = /^([a-z]+):\/\/(.*)$/i.exec(raw);
  if (!m) return { error: 'Not a link this app understands.' };
  const scheme = m[1].toLowerCase();
  let rest = m[2];
  let q = '';
  const qi = rest.indexOf('?');
  if (qi >= 0) { q = rest.slice(qi + 1); rest = rest.slice(0, qi); }
  const opts = query(q);

  if (scheme === 'tgram' || scheme === 'telegram') {
    const parts = rest.split('/').filter((x) => x !== '');
    const token = parts.shift() || '';
    if (!/^\d{3,}:[A-Za-z0-9_-]{10,}$/.test(token)) return { error: 'Telegram link: the bot token looks wrong.' };
    if (!parts.length) return { error: 'Telegram link: add a chat ID after the token.' };
    const chats = [];
    for (const c of parts) {
      const id = dec(c);
      if (id === null || !/^(-?\d+|@[A-Za-z0-9_]{3,})$/.test(id)) return { error: 'Telegram link: a chat ID looks wrong.' };
      chats.push(id);
    }
    return { type: 'telegram', token: token, chats: chats };
  }

  if (scheme === 'mailto' || scheme === 'mailtos') {
    const si = rest.indexOf('/');
    const authority = si < 0 ? rest : rest.slice(0, si);
    const path = si < 0 ? '' : rest.slice(si + 1);
    const at = authority.lastIndexOf('@');
    if (at < 0) return { error: 'Email link: add USER:PASSWORD@host.' };
    const cred = authority.slice(0, at);
    let hostPart = authority.slice(at + 1).toLowerCase();
    let port = null;
    const pm = /^(.*):(\d{1,5})$/.exec(hostPart);
    if (pm) { hostPart = pm[1]; port = Number(pm[2]); }
    if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(hostPart)) return { error: 'Email link: the host looks wrong.' };
    const ci = cred.indexOf(':');
    const user = dec(ci < 0 ? cred : cred.slice(0, ci));
    const pass = ci < 0 ? '' : dec(cred.slice(ci + 1));
    if (!user || pass === null || pass === '') return { error: 'Email link: needs USER:PASSWORD before the @.' };
    const preset = PROVIDERS[hostPart];
    let smtp = opts.smtp || (preset ? preset.smtp : hostPart);
    let mode = opts.mode ? opts.mode.toLowerCase() : null;
    if (mode && ['ssl', 'starttls', 'none'].indexOf(mode) < 0) return { error: 'Email link: mode must be ssl, starttls or none.' };
    if (!port && opts.port) port = Number(opts.port);
    if (port !== null && !(port >= 1 && port <= 65535)) return { error: 'Email link: the port looks wrong.' };
    if (!port) port = preset && !opts.smtp ? preset.port : (mode === 'ssl' ? 465 : mode === 'none' ? 25 : 587);
    if (!mode) mode = preset && !opts.smtp && port === preset.port ? preset.mode : (port === 465 ? 'ssl' : 'starttls');
    if (scheme === 'mailtos' && mode === 'none') return { error: 'Email link: mailtos:// needs a secure mode.' };
    if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(smtp)) return { error: 'Email link: the smtp host looks wrong.' };
    // The account in the link is the sender (FROM). The path is who gets it (TO).
    const from = opts.from || (user.indexOf('@') >= 0 ? user : (preset ? user + '@' + hostPart : user + '@' + hostPart));
    if (!EMAIL.test(from)) return { error: 'Email link: the sender address looks wrong.' };
    const to = [];
    for (const seg of path.split('/')) {
      for (const one of String(dec(seg) || '').split(',')) {
        const t = one.trim();
        if (!t) continue;
        if (!EMAIL.test(t)) return { error: 'Email link: a recipient address looks wrong.' };
        to.push(t);
      }
    }
    if (!to.length) to.push(from);
    return { type: 'email', smtp: smtp, port: port, mode: mode, user: user, pass: pass, from: from, name: String(opts.name || '').replace(/[\r\n"<>]/g, '').slice(0, 60), to: to, verify: String(opts.verify || '').toLowerCase() !== 'no' };
  }
  return { error: 'Not a link this app understands. Use tgram:// or mailto://.' };
}

// Reads NOTIFY_n_NAME and NOTIFY_n_LINK. Returns [{ id, name, type, ready, problem, parsed }]. Keep parsed on the server.
function loadTargets(env) {
  const out = [];
  const seen = {};
  for (let n = 1; n <= SLOTS; n++) {
    const name = String(env['NOTIFY_' + n + '_NAME'] || '').trim().slice(0, 40);
    const link = String(env['NOTIFY_' + n + '_LINK'] || '').trim();
    if (!name && !link) continue;
    const t = { id: 'n' + n, name: name || 'Target ' + n, type: null, ready: false, problem: '', parsed: null };
    if (!name) t.problem = 'Add NOTIFY_' + n + '_NAME.';
    else if (seen[name.toLowerCase()]) t.problem = 'Two targets share this name.';
    else if (!link) t.problem = 'Add NOTIFY_' + n + '_LINK.';
    seen[name.toLowerCase()] = true;
    if (link) {
      const p = parseLink(link);
      if (p.error) { t.problem = t.problem || p.error; } else { t.type = p.type; if (!t.problem) { t.parsed = p; t.ready = true; } }
    }
    out.push(t);
  }
  return out;
}
// What the browser may see about a target.
function publicTarget(t) {
  return { id: t.id, name: t.name, type: t.type, ready: t.ready, problem: t.ready ? '' : t.problem };
}

// ---------- sending ----------

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function sendTelegram(p, msg, opts) {
  const base = new URL((opts && opts.base) || 'https://api.telegram.org');
  const lib = base.protocol === 'http:' ? require('http') : https;
  const one = (chat) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id: chat, text: msg.telegram, parse_mode: 'HTML', disable_web_page_preview: true });
    const req = lib.request({ hostname: base.hostname, port: base.port || undefined, path: '/bot' + p.token + '/sendMessage', method: 'POST', timeout: 15000, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let buf = '';
      res.on('data', (c) => { if (buf.length < 4000) buf += c; });
      res.on('end', () => {
        let j = null; try { j = JSON.parse(buf); } catch (e) { /* ignore */ }
        if (res.statusCode === 200 && j && j.ok) return resolve();
        const why = j && j.description ? String(j.description).replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot***').slice(0, 100) : 'HTTP ' + res.statusCode;
        reject(new Error('Telegram said: ' + why));
      });
    });
    req.on('timeout', () => { req.destroy(new Error('x')); });
    req.on('error', (e) => reject(new Error(e && e.message === 'x' ? 'Telegram did not answer in time.' : 'Could not reach Telegram.')));
    req.end(body);
  });
  return p.chats.reduce((chain, c) => chain.then(() => one(c)), Promise.resolve());
}

function encWord(s) { return /^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?='; }
function b64Lines(s) { return Buffer.from(s, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'); }
function clean1(s) { return String(s).replace(/[\r\n]+/g, ' ').trim(); }

function mimeMessage(p, msg, now) {
  const boundary = 'op-' + crypto.randomBytes(8).toString('hex');
  const fromName = p.name ? '"' + encWord(p.name) + '" ' : '';
  const head = [
    'From: ' + fromName + '<' + p.from + '>',
    'To: ' + p.to.map((a) => '<' + a + '>').join(', '),
    'Subject: ' + encWord(clean1(msg.subject)),
    'Date: ' + (now || new Date()).toUTCString().replace('GMT', '+0000'),
    'Message-ID: <' + crypto.randomBytes(12).toString('hex') + '@odometer-pace>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="' + boundary + '"'
  ].join('\r\n');
  const part = (type, body) => '--' + boundary + '\r\nContent-Type: ' + type + '; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' + b64Lines(body) + '\r\n';
  return head + '\r\n\r\n' + part('text/plain', msg.text) + part('text/html', msg.html) + '--' + boundary + '--\r\n';
}

// A small SMTP client: ssl, starttls or none, AUTH PLAIN or LOGIN.
function sendEmail(p, msg, opts) {
  return new Promise((resolve, reject) => {
    let sock = null, buf = '', waiting = null, done = false;
    const fail = (text) => { if (done) return; done = true; try { sock && sock.destroy(); } catch (e) { /* ignore */ } reject(new Error(text)); };
    const timer = setTimeout(() => fail('The mail server did not answer in time.'), 25000);
    const finish = () => { if (done) return; done = true; clearTimeout(timer); try { sock.write('QUIT\r\n'); sock.end(); } catch (e) { /* ignore */ } resolve(); };
    const pump = () => {
      if (!waiting) return;
      const lines = buf.split('\r\n');
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i]) || /^\d{3}$/.test(lines[i])) {
          const text = lines.slice(0, i + 1);
          buf = lines.slice(i + 1).join('\r\n');
          const w = waiting; waiting = null;
          return w({ code: Number(text[i].slice(0, 3)), lines: text.map((l) => l.slice(4)) });
        }
      }
    };
    const attach = (s) => {
      sock = s;
      s.setEncoding('utf8');
      s.on('data', (d) => { buf += d; pump(); });
      s.on('error', (e) => fail(e && e.code === 'ERR_TLS_CERT_ALTNAME_INVALID' || (e && /certificate|self.signed/i.test(e.message)) ? 'The mail server certificate was not trusted. Add verify=no only for a server you control.' : 'Could not connect to the mail server.'));
      s.on('close', () => fail('The mail server closed the connection.'));
    };
    const read = () => new Promise((r) => { waiting = r; pump(); });
    const say = (line) => { sock.write(line + '\r\n'); return read(); };
    const expect = (r, ok, what) => { if (ok.indexOf(r.code) < 0) throw new Error(what + ' (' + r.code + ' ' + clean1(r.lines[r.lines.length - 1] || '').replace(/[^\x20-\x7e]/g, '').slice(0, 90) + ')'); return r; };
    const tlsOpts = { host: p.smtp, servername: p.smtp, rejectUnauthorized: p.verify };
    const run = async () => {
      expect(await read(), [220], 'The mail server did not greet us');
      const ehlo = 'EHLO odometer-pace';
      let r = expect(await say(ehlo), [250], 'The mail server refused EHLO');
      if (p.mode === 'starttls') {
        expect(await say('STARTTLS'), [220], 'The mail server refused STARTTLS');
        const plain = sock; plain.removeAllListeners('data'); plain.removeAllListeners('close'); plain.removeAllListeners('error');
        buf = '';
        await new Promise((ok, no) => {
          const t = tls.connect(Object.assign({ socket: plain }, tlsOpts), () => ok());
          attach(t); t.once('error', no);
        });
        r = expect(await say(ehlo), [250], 'The mail server refused EHLO after STARTTLS');
      }
      const caps = r.lines.join(' ').toUpperCase();
      if (/AUTH[ =].*PLAIN/.test(caps)) {
        expect(await say('AUTH PLAIN ' + Buffer.from('\0' + p.user + '\0' + p.pass).toString('base64')), [235], 'The mail server rejected the sign-in');
      } else if (/AUTH[ =].*LOGIN/.test(caps)) {
        expect(await say('AUTH LOGIN'), [334], 'The mail server does not take this sign-in');
        expect(await say(Buffer.from(p.user).toString('base64')), [334], 'The mail server rejected the sign-in');
        expect(await say(Buffer.from(p.pass).toString('base64')), [235], 'The mail server rejected the sign-in');
      } else if (p.mode !== 'none') {
        throw new Error('The mail server offers no sign-in method.');
      }
      expect(await say('MAIL FROM:<' + p.from + '>'), [250], 'The mail server refused the sender');
      for (const to of p.to) expect(await say('RCPT TO:<' + to + '>'), [250, 251], 'The mail server refused a recipient');
      expect(await say('DATA'), [354], 'The mail server refused the message');
      const body = mimeMessage(p, msg, opts && opts.now).replace(/\r\n\./g, '\r\n..').replace(/^\./, '..');
      expect(await say(body + '.'), [250], 'The mail server refused the message');
      finish();
    };
    const go = (s) => { attach(s); run().catch((e) => fail(e.message)); };
    if (p.mode === 'ssl') go(tls.connect(Object.assign({ port: p.port }, tlsOpts)));
    else go(net.connect({ host: p.smtp, port: p.port }));
  });
}

function sendTo(target, msg, opts) {
  const p = target.parsed;
  if (!p) return Promise.reject(new Error(target.problem || 'This target is not ready.'));
  return p.type === 'telegram' ? sendTelegram(p, msg, opts) : sendEmail(p, msg, opts);
}

// ---------- the message ----------

// sections: [{ name, odometer, date, over (miles over pace, negative when under), week (miles to the pace line a week out, or null),
//              projectedVsLimit (or null), daysSince, noReading }]
function fmt(n) { return Math.round(Math.abs(n)).toLocaleString('en-US'); }
function paceLine(s) {
  if (s.over === 0) return 'Right on pace';
  return fmt(s.over) + ' mi ' + (s.over > 0 ? 'over' : 'under') + ' pace';
}
function weekLine(s) {
  if (s.week === null) return '';
  return s.week >= 0 ? 'You can drive about ' + fmt(s.week) + ' mi this week and stay on pace.' : 'You would still be ' + fmt(s.week) + ' mi over pace after a week of no driving. Keep trips light.';
}
function endLine(s) {
  if (s.projectedVsLimit === null || s.projectedVsLimit === undefined) return '';
  if (s.projectedVsLimit > 0) return 'At this pace you end ' + fmt(s.projectedVsLimit) + ' mi over the limit.';
  if (s.projectedVsLimit < 0) return 'At this pace you end ' + fmt(s.projectedVsLimit) + ' mi under the limit.';
  return 'At this pace you end right at the limit.';
}
function staleLine(s) { return s.daysSince !== null && s.daysSince >= 7 ? 'Last reading was ' + s.daysSince + ' days ago. Add a fresh one.' : ''; }

function buildSummary(sections, who, dateLabel) {
  const subject = 'Weekly mileage: ' + dateLabel;
  const text = [];
  const html = [];
  const tg = [];
  const multi = sections.length > 1;
  sections.forEach((s) => {
    const lines = [paceLine(s) + ' (odometer ' + fmt(s.odometer) + ' on ' + s.date + ')', weekLine(s), endLine(s), staleLine(s)].filter(Boolean);
    const color = s.over > 0 ? '#b45309' : '#2563eb';
    if (multi) text.push(s.name.toUpperCase());
    text.push(lines.join('\n'), '');
    html.push('<div style="margin:0 0 18px"><div style="font-size:13px;color:#555">' + (multi ? esc(s.name) : '&nbsp;') + '</div>'
      + '<div style="font-size:22px;font-weight:700;color:' + color + '">' + esc(paceLine(s)) + '</div>'
      + lines.slice(1).map((l) => '<div style="font-size:15px;color:#222;margin-top:4px">' + esc(l) + '</div>').join('')
      + '<div style="font-size:12px;color:#777;margin-top:4px">Odometer ' + fmt(s.odometer) + ' on ' + esc(s.date) + '</div></div>');
    tg.push((multi ? '<b>' + esc(s.name) + '</b>\n' : '') + '<b>' + esc(paceLine(s)) + '</b>\n' + lines.slice(1).map(esc).join('\n'));
  });
  const greet = who ? 'Hi ' + who + ', your week in miles.' : 'Your week in miles.';
  return {
    subject: subject,
    text: greet + '\n\n' + text.join('\n').trim() + '\n',
    html: '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:16px"><div style="font-size:15px;margin-bottom:14px">' + esc(greet) + '</div>' + html.join('') + '</div>',
    telegram: esc(greet) + '\n\n' + tg.join('\n\n')
  };
}

// ---------- schedule ----------

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function zoneParts(date, tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
  const o = {};
  f.formatToParts(date).forEach((x) => { o[x.type] = x.value; });
  return o;
}
// The most recent slot (day and time) that is 0 to 360 minutes old, as "YYYY-MM-DD HH:MM", or null.
function dueSlot(date, tz, day, time) {
  const m = /^(\d\d):(\d\d)$/.exec(String(time || ''));
  if (!m || !(day >= 0 && day <= 6)) return null;
  const now = zoneParts(date, tz);
  const nowMin = Number(now.hour) * 60 + Number(now.minute);
  const want = Number(m[1]) * 60 + Number(m[2]);
  const nowDay = DAYS.indexOf(now.weekday);
  // Same day, already past the time.
  if (nowDay === day && nowMin >= want && nowMin - want <= 360) return now.year + '-' + now.month + '-' + now.day + ' ' + m[1] + ':' + m[2];
  // Slot was shortly before midnight and the catch-up window runs into the next day.
  if ((nowDay + 6) % 7 === day && nowMin + 1440 - want <= 360) {
    const prev = zoneParts(new Date(date.getTime() - 86400000), tz);
    return prev.year + '-' + prev.month + '-' + prev.day + ' ' + m[1] + ':' + m[2];
  }
  return null;
}

module.exports = { SLOTS, parseLink, loadTargets, publicTarget, sendTo, sendEmail, sendTelegram, buildSummary, dueSlot, mimeMessage, DAYS };
