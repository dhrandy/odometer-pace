// Odometer Pace server. One file, no dependencies. Serves the page and a small JSON API.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Lease = require('./lib/lease.js');

const PORT = Number(process.env.PORT) || 8000;
const DATA_DIR = process.env.DATA_DIR || '/data';
const AUTH_MODE = process.env.AUTH_MODE === 'proxy' ? 'proxy' : 'app';
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const TRUST_PROXY = process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true';
const TZ = process.env.TZ || 'UTC';
const SESSION_DAYS = 90;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = path.join(DATA_DIR, 'odometer-pace.json');

// ---------- storage ----------

function emptyData() {
  return { settings: null, readings: [], tokens: [], auth: null, users: [], sessions: [], ui: { accent: 'purple', oled: false } };
}

function loadData() {
  try {
    return Object.assign(emptyData(), JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Could not read data file, starting empty:', e.message);
    return emptyData();
  }
}

// Write to a temp file and rename so a crash never leaves half a file.
function saveData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, DATA_FILE);
}

const data = loadData();

// ---------- helpers ----------

function todayKey() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return parts;
}

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function safeEqual(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || 'unknown';
}

// Failed logins and failed token tries: 10 per 15 minutes per address.
const failures = new Map();
function tooManyFailures(ip) {
  const f = failures.get(ip);
  return !!f && f.until > Date.now() && f.count >= 10;
}
function noteFailure(ip) {
  const f = failures.get(ip);
  if (!f || f.until <= Date.now()) failures.set(ip, { count: 1, until: Date.now() + 15 * 60 * 1000 });
  else f.count++;
}

function readCookie(req, name) {
  const parts = String(req.headers.cookie || '').split(';');
  for (const p of parts) {
    const i = p.indexOf('=');
    if (i > 0 && p.slice(0, i).trim() === name) return decodeURIComponent(p.slice(i + 1).trim());
  }
  return '';
}

function sendJson(res, status, body, headers) {
  const text = JSON.stringify(body);
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers));
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 20000) { reject(new Error('too big')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

// ---------- sessions ----------

// Returns the signed-in person for this request, or null.
function currentUser(req) {
  if (AUTH_MODE === 'proxy') return { id: 'proxy', username: 'proxy', role: 'admin' };
  const id = readCookie(req, 'op_session');
  if (!id) return null;
  const hash = sha256(id);
  const now = Date.now();
  const session = data.sessions.find((x) => x.hash === hash && x.expires > now);
  if (!session) return null;
  const user = data.users.find((u) => u.id === session.userId);
  return user ? { id: user.id, username: user.username, role: user.role } : null;
}

function startSession(userId) {
  const id = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  data.sessions = data.sessions.filter((x) => x.expires > now);
  data.sessions.push({ hash: sha256(id), expires: now + SESSION_DAYS * 86400000, userId: userId });
  saveData();
  const cookie = ['op_session=' + id, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=' + SESSION_DAYS * 86400];
  if (COOKIE_SECURE) cookie.push('Secure');
  return cookie.join('; ');
}

function endSession(req) {
  const id = readCookie(req, 'op_session');
  if (id) {
    data.sessions = data.sessions.filter((x) => x.hash !== sha256(id));
    saveData();
  }
}

const USERNAME = /^[A-Za-z0-9._-]{2,30}$/;

function makeUser(username, password, role) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { id: crypto.randomBytes(6).toString('hex'), username: username, role: role, salt: salt, hash: hashPassword(password, salt), created: new Date().toISOString() };
}

function findUser(username) {
  const name = String(username || '').toLowerCase();
  return data.users.find((u) => u.username.toLowerCase() === name) || null;
}

// Runs the same slow hash for unknown names so timing does not reveal which usernames exist.
const DUMMY = { salt: 'x'.repeat(32), hash: hashPassword('dummy', 'x'.repeat(32)) };
function passwordMatches(user, password) {
  const u = user || DUMMY;
  const ok = safeEqual(u.hash, hashPassword(password, u.salt));
  return !!user && ok;
}

// ---------- agent tokens ----------

function tokenFromRequest(req) {
  const m = /^Bearer\s+(op_[A-Za-z0-9_-]+)$/.exec(String(req.headers.authorization || ''));
  if (!m) return null;
  const hash = sha256(m[1]);
  const found = data.tokens.find((t) => safeEqual(t.hash, hash));
  return found || null;
}

// ---------- lease views ----------

function sortedReadings() {
  return data.readings.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
}

function round1(n) { return n === null ? null : Math.round(n * 10) / 10; }

// Clean JSON for the page and for agents.
function statusBody() {
  const plan = Lease.makePlan(data.settings);
  if (!plan) return { configured: false };
  const today = todayKey();
  const idx = Lease.dayIndex(plan, today);
  const readings = sortedReadings();
  const ev = Lease.evaluate(plan, readings);
  const body = {
    configured: true,
    today: today,
    lease: {
      vehicle: data.settings.vehicle || '',
      start_date: plan.startDate,
      end_date: plan.endDate,
      years: plan.years,
      total_miles: plan.totalMiles,
      miles_per_year: plan.perYear,
      start_odometer: plan.startOdometer,
      odometer_limit: plan.limit,
      day_of_lease: idx < 0 ? 0 : Math.min(idx + 1, plan.dayCount),
      days_total: plan.dayCount,
      state: idx < 0 ? 'not_started' : idx >= plan.dayCount ? 'complete' : 'active'
    },
    allowed_odometer_today: plan.startOdometer + Lease.allowedThrough(plan, idx),
    latest: null,
    readings: readings.map((r) => ({ date: r.date, odometer: r.odometer, source: r.source || 'web' }))
  };
  if (ev) {
    body.latest = {
      date: ev.date,
      odometer: ev.odometer,
      on_pace_odometer: ev.paceOdometer,
      miles_over_pace: ev.diff,
      pace_status: ev.diff > 0 ? 'over' : ev.diff < 0 ? 'under' : 'on_pace',
      miles_used: ev.milesUsed,
      miles_remaining: ev.remaining,
      miles_per_day_so_far: round1(ev.perDay),
      miles_per_day_to_stay_under: round1(ev.neededPerDay),
      projected_end_odometer: ev.projected,
      projected_vs_limit: ev.projected === null ? null : ev.projected - plan.limit,
      days_left: ev.daysLeft
    };
  }
  return body;
}

const ACCENTS = ['purple', 'blue', 'cyan', 'green', 'pink', 'orange'];

// Each login keeps its own look. The proxy "user" has no record, so it uses the shared one.
function uiBody(me) {
  const record = me && me.id !== 'proxy' ? data.users.find((u) => u.id === me.id) : null;
  const ui = (record ? record.ui : data.ui) || {};
  return { accent: ACCENTS.includes(ui.accent) ? ui.accent : 'purple', oled: ui.oled === true, accents: ACCENTS };
}

function addReading(date, odometer, source) {
  const plan = Lease.makePlan(data.settings);
  if (!plan) return 'Lease settings are not set up yet.';
  const others = data.readings.filter((r) => r.date !== date);
  const err = Lease.checkReading(plan, others, date, odometer);
  if (err) return err;
  data.readings = others.concat([{ date: date, odometer: odometer, source: source, saved: new Date().toISOString() }]);
  saveData();
  return '';
}

function cleanSettings(b) {
  const s = {
    vehicle: String(b.vehicle || '').trim().slice(0, 60),
    startDate: String(b.startDate || ''),
    years: Number(b.years),
    totalMiles: Number(b.totalMiles),
    startOdometer: Number(b.startOdometer)
  };
  return Lease.makePlan(s) ? s : null;
}

// ---------- routes ----------

async function handleApi(req, res, url) {
  const ip = clientIp(req);
  const method = req.method;
  const p = url.pathname;

  // Agent API: bearer token only, never a cookie.
  if (p.startsWith('/api/v1/')) {
    if (tooManyFailures(ip)) return sendJson(res, 429, { error: 'Too many failed attempts. Try again later.' });
    const token = tokenFromRequest(req);
    if (!token) {
      noteFailure(ip);
      return sendJson(res, 401, { error: 'Missing or invalid API key. Send it as: Authorization: Bearer <key>' });
    }
    token.last_used = new Date().toISOString();
    if (p === '/api/v1/status' && method === 'GET') return sendJson(res, 200, statusBody());
    if (p === '/api/v1/readings' && method === 'GET') return sendJson(res, 200, { readings: statusBody().readings || [] });
    if (p === '/api/v1/readings' && method === 'POST') {
      let b;
      try { b = await readBody(req); } catch (e) { return sendJson(res, 400, { error: 'Send a JSON body like {"odometer": 1234}.' }); }
      const odometer = Number(String(b.odometer).replace(/,/g, ''));
      const date = b.date ? String(b.date) : todayKey();
      const err = addReading(date, odometer, 'api:' + token.name + (token.ownerName ? ' (' + token.ownerName + ')' : ''));
      if (err) return sendJson(res, 400, { error: err });
      return sendJson(res, 200, { saved: { date: date, odometer: odometer }, status: statusBody() });
    }
    return sendJson(res, 404, { error: 'Not found.' });
  }

  // Everything below is the web app.
  if (p === '/api/session' && method === 'GET') {
    const me = currentUser(req);
    return sendJson(res, 200, {
      mode: AUTH_MODE,
      setupNeeded: AUTH_MODE !== 'proxy' && data.users.length === 0,
      loggedIn: !!me,
      me: me ? { username: me.username, role: me.role } : null
    });
  }

  if ((p === '/api/setup' || p === '/api/login') && method === 'POST') {
    if (AUTH_MODE === 'proxy') return sendJson(res, 400, { error: 'Login is handled by the reverse proxy.' });
    if (tooManyFailures(ip)) return sendJson(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
    let b;
    try { b = await readBody(req); } catch (e) { return sendJson(res, 400, { error: 'Bad request.' }); }
    const username = String(b.username || '').trim();
    const password = String(b.password || '');
    let user;
    if (p === '/api/setup') {
      if (data.users.length) return sendJson(res, 400, { error: 'An admin account already exists.' });
      if (!USERNAME.test(username)) return sendJson(res, 400, { error: 'Username: 2 to 30 letters, numbers, dots, dashes or underscores.' });
      if (password.length < 8) return sendJson(res, 400, { error: 'Use at least 8 characters.' });
      user = makeUser(username, password, 'admin');
      data.users.push(user);
    } else {
      user = findUser(username);
      if (!passwordMatches(user, password)) {
        noteFailure(ip);
        return sendJson(res, 401, { error: 'Wrong username or password.' });
      }
    }
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': startSession(user.id) });
  }

  if (p === '/api/logout' && method === 'POST') {
    endSession(req);
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': 'op_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' });
  }

  const me = currentUser(req);
  if (!me) return sendJson(res, 401, { error: 'Log in first.' });
  const isAdmin = me.role === 'admin';
  const adminOnly = () => sendJson(res, 403, { error: 'Only the admin can do that.' });

  // Mutations must be JSON, which a cross-site form cannot send.
  if (method !== 'GET' && !String(req.headers['content-type'] || '').startsWith('application/json')) {
    return sendJson(res, 415, { error: 'Send JSON.' });
  }

  if (p === '/api/status' && method === 'GET') return sendJson(res, 200, Object.assign(statusBody(), { ui: uiBody(me), me: { username: me.username, role: me.role } }));

  if (p === '/api/ui' && method === 'PUT') {
    let b;
    try { b = await readBody(req); } catch (e) { return sendJson(res, 400, { error: 'Bad request.' }); }
    if (!ACCENTS.includes(b.accent)) return sendJson(res, 400, { error: 'Unknown color.' });
    const next = { accent: b.accent, oled: b.oled === true };
    const record = me.id !== 'proxy' ? data.users.find((u) => u.id === me.id) : null;
    if (record) record.ui = next; else data.ui = next;
    saveData();
    return sendJson(res, 200, uiBody(me));
  }

  if (p === '/api/settings') {
    if (!isAdmin) return adminOnly();
    if (method === 'GET') return sendJson(res, 200, { settings: data.settings });
    if (method === 'PUT') {
      let b;
      try { b = await readBody(req); } catch (e) { return sendJson(res, 400, { error: 'Bad request.' }); }
      const s = cleanSettings(b);
      if (!s) return sendJson(res, 400, { error: 'Check the lease settings: a valid start date, 1 to 10 years, total miles and a starting odometer.' });
      data.settings = s;
      saveData();
      return sendJson(res, 200, { settings: s });
    }
  }

  if (p === '/api/readings' && method === 'POST') {
    let b;
    try { b = await readBody(req); } catch (e) { return sendJson(res, 400, { error: 'Bad request.' }); }
    const odometer = Number(String(b.odometer).replace(/,/g, ''));
    const date = String(b.date || todayKey());
    const err = addReading(date, odometer, 'web:' + me.username);
    if (err) return sendJson(res, 400, { error: err });
    return sendJson(res, 200, statusBody());
  }

  const del = /^\/api\/readings\/(\d{4}-\d{2}-\d{2})$/.exec(p);
  if (del && method === 'DELETE') {
    if (!isAdmin) return adminOnly();
    data.readings = data.readings.filter((r) => r.date !== del[1]);
    saveData();
    return sendJson(res, 200, statusBody());
  }

  // Your own password.
  if (p === '/api/me/password' && method === 'POST') {
    if (AUTH_MODE === 'proxy') return sendJson(res, 400, { error: 'Login is handled by the reverse proxy.' });
    let b;
    try { b = await readBody(req); } catch (e) { return sendJson(res, 400, { error: 'Bad request.' }); }
    const user = data.users.find((u) => u.id === me.id);
    if (!passwordMatches(user, String(b.current || ''))) return sendJson(res, 400, { error: 'Current password is wrong.' });
    if (String(b.password || '').length < 8) return sendJson(res, 400, { error: 'Use at least 8 characters.' });
    user.salt = crypto.randomBytes(16).toString('hex');
    user.hash = hashPassword(String(b.password), user.salt);
    saveData();
    return sendJson(res, 200, { ok: true });
  }

  // Logins for the household. Admin only.
  if (p === '/api/users' || p.startsWith('/api/users/')) {
    if (!isAdmin) return adminOnly();
    if (AUTH_MODE === 'proxy') return sendJson(res, 400, { error: 'Logins are handled by the reverse proxy.' });
    if (p === '/api/users' && method === 'GET') {
      return sendJson(res, 200, { users: data.users.map((u) => ({ id: u.id, username: u.username, role: u.role })) });
    }
    let b = {};
    if (method !== 'DELETE') {
      try { b = await readBody(req); } catch (e) { return sendJson(res, 400, { error: 'Bad request.' }); }
    }
    if (p === '/api/users' && method === 'POST') {
      const username = String(b.username || '').trim();
      if (!USERNAME.test(username)) return sendJson(res, 400, { error: 'Username: 2 to 30 letters, numbers, dots, dashes or underscores.' });
      if (findUser(username)) return sendJson(res, 400, { error: 'That username is taken.' });
      if (String(b.password || '').length < 8) return sendJson(res, 400, { error: 'Use at least 8 characters.' });
      data.users.push(makeUser(username, String(b.password), 'user'));
      saveData();
      return sendJson(res, 200, { ok: true });
    }
    const one = /^\/api\/users\/([a-f0-9]+)(\/password)?$/.exec(p);
    const target = one && data.users.find((u) => u.id === one[1]);
    if (!target) return sendJson(res, 404, { error: 'No such user.' });
    if (one[2] && method === 'POST') {
      if (String(b.password || '').length < 8) return sendJson(res, 400, { error: 'Use at least 8 characters.' });
      target.salt = crypto.randomBytes(16).toString('hex');
      target.hash = hashPassword(String(b.password), target.salt);
      data.sessions = data.sessions.filter((x) => x.userId !== target.id);
      saveData();
      return sendJson(res, 200, { ok: true });
    }
    if (!one[2] && method === 'DELETE') {
      if (target.id === me.id) return sendJson(res, 400, { error: 'You cannot remove your own login.' });
      if (target.role === 'admin') return sendJson(res, 400, { error: 'The admin login cannot be removed.' });
      data.users = data.users.filter((u) => u.id !== target.id);
      data.tokens = data.tokens.filter((t) => t.ownerId !== target.id);
      data.sessions = data.sessions.filter((x) => x.userId !== target.id);
      saveData();
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 404, { error: 'Not found.' });
  }

  if (p === '/api/tokens') {
    if (method === 'GET') {
      // Everyone sees their own keys. The admin sees all of them.
      const mine = data.tokens.filter((t) => isAdmin || t.ownerId === me.id);
      return sendJson(res, 200, { tokens: mine.map((t) => ({ id: t.id, name: t.name, owner: t.ownerName || '', own: t.ownerId === me.id, created: t.created, last_used: t.last_used || null })) });
    }
    if (method === 'POST') {
      let b;
      try { b = await readBody(req); } catch (e) { return sendJson(res, 400, { error: 'Bad request.' }); }
      const name = String(b.name || '').trim().slice(0, 40);
      if (!name) return sendJson(res, 400, { error: 'Give the key a name.' });
      const key = 'op_' + crypto.randomBytes(32).toString('base64url');
      data.tokens.push({ id: crypto.randomBytes(6).toString('hex'), name: name, ownerId: me.id, ownerName: me.username, hash: sha256(key), created: new Date().toISOString() });
      saveData();
      // The key is shown this once and only its hash is kept.
      return sendJson(res, 200, { key: key, name: name });
    }
  }

  const delTok = /^\/api\/tokens\/([a-f0-9]+)$/.exec(p);
  if (delTok && method === 'DELETE') {
    const tok = data.tokens.find((t) => t.id === delTok[1]);
    if (!tok || (!isAdmin && tok.ownerId !== me.id)) return sendJson(res, 404, { error: 'No such key.' });
    data.tokens = data.tokens.filter((t) => t.id !== tok.id);
    saveData();
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'Not found.' });
}

// ---------- static files ----------

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8'
};

function sendStatic(res, file, type) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': type === 'font/woff2' ? 'public, max-age=31536000, immutable' : 'no-cache' });
    res.end(buf);
  });
}

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  let p = url.pathname;
  if (p === '/') p = '/index.html';
  if (p === '/lease.js') return sendStatic(res, path.join(__dirname, 'lib', 'lease.js'), TYPES['.js']);
  if (p === '/api/docs') {
    if (!currentUser(req)) { res.writeHead(302, { Location: '/' }); res.end(); return; }
    return sendStatic(res, path.join(PUBLIC_DIR, 'docs.html'), TYPES['.html']);
  }
  if (p === '/docs.html') { res.writeHead(404); res.end('Not found'); return; }
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(404); res.end('Not found'); return; }
  sendStatic(res, file, TYPES[path.extname(file)] || 'application/octet-stream');
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/') && url.pathname !== '/api/docs') await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: 'Something went wrong.' });
  }
});

// The container starts as root only to make the data folder writable, then drops to the node user.
function dropRoot() {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.chownSync(DATA_DIR, 1000, 1000);
  if (fs.existsSync(DATA_FILE)) fs.chownSync(DATA_FILE, 1000, 1000);
  process.setgid(1000);
  process.setuid(1000);
}

if (require.main === module) {
  dropRoot();
  server.listen(PORT, () => console.log('Odometer Pace listening on ' + PORT + ' (auth: ' + AUTH_MODE + ', data: ' + DATA_FILE + ')'));
}
module.exports = server;
