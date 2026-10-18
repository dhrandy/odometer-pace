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

// The container starts as root only to make the data folder writable, then drops to the node user.
// This has to happen before the data file is read: with capabilities dropped, root cannot open a
// file owned by another user, so reading first made the app think there was no data.
function dropRoot() {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.chownSync(DATA_DIR, 1000, 1000);
  if (fs.existsSync(DATA_FILE)) fs.chownSync(DATA_FILE, 1000, 1000);
  process.setgid(1000);
  process.setuid(1000);
}
if (require.main === module) dropRoot();


function newCar(settings) {
  return { id: crypto.randomBytes(3).toString('hex'), settings: settings || null, readings: [], history: [], archived: false };
}

function emptyData() {
  return { vehicles: [newCar(null)], tokens: [], auth: null, users: [], sessions: [], ui: { accent: 'purple', oled: false }, options: { overage: false, whatif: false, glance: false, backup: false, overageRate: null, history: true } };
}

// The history log. Older readings that predate it are listed once, from what was stored with them.
function whoFromSource(src) {
  const t = String(src || '');
  const m = /^api:(.*?)(?: \((.*)\))?$/.exec(t);
  if (m) return { by: 'api', name: m[1], owner: m[2] || null };
  return { by: 'person', name: t.indexOf('web:') === 0 ? t.slice(4) : (t || 'unknown'), owner: null };
}
function seedHistory(readings) {
  return (readings || []).slice().sort((a, b) => ((a.saved || '') < (b.saved || '') ? -1 : 1)).map((r) =>
    Object.assign({ at: r.saved || null, date: r.date, odometer: r.odometer, previous: null, deleted: false }, whoFromSource(r.source)));
}
function logHistory(car, entry) {
  car.history.push(entry);
  if (car.history.length > 5000) car.history = car.history.slice(-5000);
}
function historyList(car) {
  return car.history.slice().reverse();
}
function historyCsv(car) {
  return 'saved,date,odometer,previous,by,name,owner,deleted\n' + car.history.map((h) => [h.at, h.date, h.odometer, h.previous === null || h.previous === undefined ? '' : h.previous, h.by, h.name, h.owner || '', h.deleted ? 'yes' : ''].map(csvCell).join(',')).join('\n') + '\n';
}

function loadData() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const d = Object.assign(emptyData(), raw);
    if (!Array.isArray(raw.vehicles) || !raw.vehicles.length) {
      // Files from before multiple vehicles hold one car at the top. It becomes car one.
      const car = newCar(raw.settings || null);
      car.readings = Array.isArray(raw.readings) ? raw.readings : [];
      car.history = Array.isArray(raw.history) ? raw.history : seedHistory(car.readings);
      d.vehicles = [car];
    }
    delete d.settings; delete d.readings; delete d.history;
    return d;
  } catch (e) {
    if (e.code === 'ENOENT') return emptyData();
    // Never start empty over a file we could not read: the next save would overwrite it.
    console.error('Cannot read ' + DATA_FILE + ': ' + e.message);
    process.exit(1);
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
    // The last entry is the one our own proxy added. Earlier entries can be forged by the client.
    const parts = String(req.headers['x-forwarded-for'] || '').split(',');
    const fwd = parts[parts.length - 1].trim();
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
setInterval(() => {
  const now = Date.now();
  for (const [ip, f] of failures) if (f.until <= now) failures.delete(ip);
}, 10 * 60 * 1000).unref();
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

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > (max || 20000)) { reject(new Error('too big')); req.destroy(); return; }
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
  return user ? { id: user.id, username: user.username, role: user.role, access: user.access } : null;
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

function sortedReadings(car) {
  return car.readings.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
}

function round1(n) { return n === null ? null : Math.round(n * 10) / 10; }


// ---------- vehicles ----------
// With Multiple vehicles off, the app only ever shows the first car. Turning it on changes nothing about that car.
const MAX_CARS = 12;
function multiOn() { return optionsBody().multi; }
function activeCars() { return data.vehicles.filter((v) => !v.archived); }
function canSee(user, car) {
  if (!user || user.role === 'admin' || user.id === 'proxy') return true;
  return !Array.isArray(user.access) || user.access.indexOf(car.id) >= 0;
}
function visibleCars(me) {
  const live = activeCars();
  if (!multiOn()) return live.length ? [live[0]] : [];
  return live.filter((v) => canSee(me, v));
}
// The car this request is about: ?vehicle=ID, else the first one the person can see.
function pickCar(me, url) {
  const cars = visibleCars(me);
  const id = url.searchParams.get('vehicle');
  if (!id) return cars[0] || null;
  return cars.find((v) => v.id === id) || null;
}
function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30); }
function carBrief(car) {
  const plan = Lease.makePlan(car.settings);
  const out = { id: car.id, name: (car.settings && car.settings.vehicle) || 'Vehicle', archived: !!car.archived, configured: !!plan, state: null, day_of_lease: null, days_total: null, miles_over_pace: null, pace_status: null };
  if (!plan) return out;
  const idx = Lease.dayIndex(plan, todayKey());
  out.state = idx < 0 ? 'not_started' : idx >= plan.dayCount ? 'complete' : 'active';
  out.day_of_lease = idx < 0 ? 0 : Math.min(idx + 1, plan.dayCount);
  out.days_total = plan.dayCount;
  const ev = Lease.evaluate(plan, sortedReadings(car));
  if (ev) { out.miles_over_pace = ev.diff; out.pace_status = ev.diff > 0 ? 'over' : ev.diff < 0 ? 'under' : 'on_pace'; }
  return out;
}
// What the web app gets: the car's status plus, when Multiple vehicles is on, the list for the picker.
function statusFor(me, car) {
  const body = statusBody(car);
  if (multiOn()) body.vehicles = visibleCars(me).map(carBrief);
  return body;
}
// Settles which car an API key can reach, or says why not.
function tokenCar(token) {
  const car = token.vehicleId ? data.vehicles.find((v) => v.id === token.vehicleId) : data.vehicles[0];
  if (!car) return { status: 404, error: 'That vehicle no longer exists.' };
  if (car.archived) return { status: 403, error: 'That vehicle is archived.' };
  if (!multiOn() && car !== activeCars()[0]) return { status: 403, error: 'Multiple vehicles is turned off in Settings.' };
  const owner = token.ownerId ? data.users.find((u) => u.id === token.ownerId) : null;
  if (owner && !canSee(owner, car)) return { status: 403, error: 'The login that made this key no longer has access to that vehicle.' };
  return { car: car };
}
// Access for a login: all cars (now and later) or a list. Returns 'all' or an array of real car ids.
function cleanAccess(b) {
  if (Array.isArray(b.vehicles) && b.all !== true) {
    const ids = [];
    b.vehicles.forEach((id) => { if (data.vehicles.some((v) => v.id === id) && ids.indexOf(id) < 0) ids.push(id); });
    return ids;
  }
  return 'all';
}

// Optional features. All start OFF and the admin turns each one on in Settings.
const FEATURES = ['overage', 'whatif', 'glance', 'backup', 'multi'];
function optionsBody() {
  const o = data.options || {};
  const out = {};
  FEATURES.forEach((k) => { out[k] = o[k] === true; });
  out.overageRate = Number(o.overageRate) > 0 ? Number(o.overageRate) : null;
  out.history = o.history !== false; // a log, so it starts on
  return out;
}
// Returns the cleaned options, or null when the rate is not a number from 0 to 10.
function cleanOptions(b) {
  const out = {};
  FEATURES.forEach((k) => { out[k] = b[k] === true; });
  out.history = b.history !== false;
  const raw = String(b.overageRate === undefined || b.overageRate === null ? '' : b.overageRate).trim().replace(/^\$/, '');
  if (raw === '') out.overageRate = null;
  else if (isFinite(Number(raw)) && Number(raw) >= 0 && Number(raw) <= 10) out.overageRate = Number(raw) > 0 ? Math.round(Number(raw) * 10000) / 10000 : null;
  else return null;
  return out;
}

// Guards a spreadsheet cell from being read as a formula.
function csvCell(v) {
  let t = String(v === undefined || v === null ? '' : v);
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
  return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}
function readingsCsv(car) {
  return 'date,odometer,source\n' + sortedReadings(car).map((r) => [r.date, r.odometer, r.source || 'web'].map(csvCell).join(',')).join('\n') + '\n';
}

// Checks one car's part of a backup. Returns { error } or { settings, readings, history }.
function parseCar(b, label) {
  const pre = label ? label + ': ' : '';
  if (!b || !b.settings || !Array.isArray(b.readings)) return { error: pre + 'That is not an Odometer Pace backup file.' };
  if (b.readings.length > 5000) return { error: pre + 'That backup has too many readings.' };
  const settings = cleanSettings(b.settings);
  if (!settings || settings === 'plan') return { error: pre + 'The lease settings in that file are not valid.' };
  const plan = Lease.makePlan(settings);
  const readings = [];
  for (const r of b.readings) {
    const odometer = Number(r && r.odometer);
    const date = String(r && r.date);
    const err = Lease.checkReading(plan, readings, date, odometer);
    if (err) return { error: pre + 'Reading ' + date + ': ' + err };
    if (readings.some((x) => x.date === date)) return { error: pre + 'The date ' + date + ' appears twice.' };
    readings.push({ date: date, odometer: odometer, source: String((r && r.source) || 'restore').slice(0, 60), saved: new Date().toISOString() });
  }
  let history;
  if (Array.isArray(b.history)) {
    history = b.history.slice(-5000).map((h) => ({
      at: h && typeof h.at === 'string' ? h.at.slice(0, 40) : null,
      date: String((h && h.date) || '').slice(0, 10),
      odometer: Number(h && h.odometer) || 0,
      previous: h && h.previous !== null && h.previous !== undefined && isFinite(Number(h.previous)) ? Number(h.previous) : null,
      deleted: !!(h && h.deleted),
      by: h && h.by === 'api' ? 'api' : 'person',
      name: String((h && h.name) || '').slice(0, 60),
      owner: h && h.owner ? String(h.owner).slice(0, 60) : null
    }));
  } else history = seedHistory(readings);
  return { settings: settings, readings: readings, history: history };
}

// Checks a backup file. Version 1 holds one car, version 2 holds all of them.
// Returns { error } or { options, cars: [{ id, archived, settings, readings, history }], single }.
function parseBackup(b) {
  if (!b || b.app !== 'odometer-pace') return { error: 'That is not an Odometer Pace backup file.' };
  const options = cleanOptions(b.options || {}) || { overage: false, whatif: false, glance: false, backup: false, multi: false, overageRate: null, history: true };
  if (Array.isArray(b.vehicles)) {
    if (!b.vehicles.length || b.vehicles.length > MAX_CARS) return { error: 'That backup has no vehicles, or too many.' };
    const cars = [];
    for (let i = 0; i < b.vehicles.length; i++) {
      const raw = b.vehicles[i];
      const one = parseCar(raw, 'Vehicle ' + (i + 1));
      if (one.error) return one;
      const id = raw && /^[a-f0-9]{4,12}$/.test(String(raw.id)) && !cars.some((c) => c.id === raw.id) ? raw.id : crypto.randomBytes(3).toString('hex');
      cars.push({ id: id, archived: !!(raw && raw.archived), settings: one.settings, readings: one.readings, history: one.history });
    }
    if (cars.every((c) => c.archived)) cars[0].archived = false;
    return { options: options, cars: cars, single: false };
  }
  const one = parseCar(b);
  if (one.error) return one;
  return { options: options, cars: [{ id: null, archived: false, settings: one.settings, readings: one.readings, history: one.history }], single: true };
}

// Clean JSON for the page and for agents.
function statusBody(car) {
  const plan = Lease.makePlan(car.settings);
  if (!plan) return { configured: false, vehicle_id: car.id };
  const today = todayKey();
  const idx = Lease.dayIndex(plan, today);
  const readings = sortedReadings(car);
  const ev = Lease.evaluate(plan, readings);
  const body = {
    configured: true,
    vehicle_id: car.id,
    today: today,
    lease: {
      vehicle: car.settings.vehicle || '',
      start_date: plan.startDate,
      end_date: plan.endDate,
      years: plan.years,
      total_miles: plan.totalMiles,
      miles_per_year: plan.perYear,
      start_odometer: plan.startOdometer,
      odometer_limit: plan.limit,
      day_of_lease: idx < 0 ? 0 : Math.min(idx + 1, plan.dayCount),
      days_total: plan.dayCount,
      planned_change: plan.change ? { from: plan.change.from, miles_per_day: plan.change.perDay } : null,
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
      projected_includes_plan: ev.usesPlan,
      projected_vs_limit: ev.projected === null ? null : ev.projected - plan.limit,
      days_left: ev.daysLeft
    };
  }
  body.warning = Lease.warning(plan, ev, today);
  const opt = optionsBody();
  body.options = opt;
  if (opt.overage && opt.overageRate) {
    const over = ev && ev.projected !== null ? Math.max(0, ev.projected - plan.limit) : null;
    const now = ev ? Math.max(0, ev.odometer - plan.limit) : 0;
    body.overage = { rate_per_mile: opt.overageRate, projected_over_miles: over, projected_fee: over === null ? null : Lease.fee(over, opt.overageRate), current_over_miles: now, current_fee: Lease.fee(now, opt.overageRate) };
  }
  if (opt.glance) body.glance = Lease.glance(plan, ev, today, body.warning);
  return body;
}

const ACCENTS = ['purple', 'blue', 'cyan', 'green', 'pink', 'orange'];

// Each login keeps its own look. The proxy "user" has no record, so it uses the shared one.
function uiBody(me) {
  const record = me && me.id !== 'proxy' ? data.users.find((u) => u.id === me.id) : null;
  const ui = (record ? record.ui : data.ui) || {};
  return { accent: ACCENTS.includes(ui.accent) ? ui.accent : 'purple', oled: ui.oled === true, accents: ACCENTS };
}

// Returns { error } or { previous }, where previous is the reading this one replaced (or null).
function addReading(car, date, odometer, source) {
  const plan = Lease.makePlan(car.settings);
  if (!plan) return { error: 'Lease settings are not set up yet.' };
  const others = car.readings.filter((r) => r.date !== date);
  const err = Lease.checkReading(plan, others, date, odometer);
  if (err) return { error: err };
  const old = car.readings.find((r) => r.date === date);
  const previous = old ? { date: old.date, odometer: old.odometer } : null;
  // The same value for the same date is not a change: no new row, no history entry.
  if (old && old.odometer === odometer) return { previous: previous, unchanged: true };
  const at = new Date().toISOString();
  car.readings = others.concat([{ date: date, odometer: odometer, source: source, saved: at }]);
  logHistory(car, Object.assign({ at: at, date: date, odometer: odometer, previous: previous ? previous.odometer : null, deleted: false }, whoFromSource(source)));
  saveData();
  return { previous: previous };
}

function cleanSettings(b) {
  const s = {
    vehicle: String(b.vehicle || '').trim().slice(0, 60),
    startDate: String(b.startDate || ''),
    years: Number(b.years),
    totalMiles: Number(b.totalMiles),
    startOdometer: Number(b.startOdometer)
  };
  const from = String(b.planFrom || '').trim();
  const perDay = String(b.planPerDay === undefined || b.planPerDay === null ? '' : b.planPerDay).trim();
  if (from || perDay) {
    // The planned change is optional, but half of it is not allowed.
    if (!Lease.isDateKey(from) || perDay === '' || !(Number(perDay) >= 0 && Number(perDay) <= 1000)) return 'plan';
    s.planFrom = from;
    s.planPerDay = Number(perDay);
  }
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
    const tc = tokenCar(token);
    if (tc.error) return sendJson(res, tc.status, { error: tc.error });
    const car = tc.car;
    if (p === '/api/v1/status' && method === 'GET') return sendJson(res, 200, statusBody(car));
    if (p === '/api/v1/glance' && method === 'GET') {
      const st = statusBody(car);
      if (!st.configured) return sendJson(res, 404, { error: 'Lease settings are not set up yet.' });
      if (!st.glance) return sendJson(res, 404, { error: 'The glance view is turned off in Settings.' });
      return sendJson(res, 200, Object.assign({ today: st.today, vehicle: st.lease.vehicle }, st.glance));
    }
    if (p === '/api/v1/readings' && method === 'GET') return sendJson(res, 200, { readings: statusBody(car).readings || [] });
    if (p === '/api/v1/readings' && method === 'POST') {
      let b;
      try { b = await readBody(req); } catch (e) { return sendJson(res, 400, { error: 'Send a JSON body like {"odometer": 1234}.' }); }
      const odometer = Number(String(b.odometer).replace(/,/g, ''));
      const date = b.date ? String(b.date) : todayKey();
      const result = addReading(car, date, odometer, 'api:' + token.name + (token.ownerName ? ' (' + token.ownerName + ')' : ''));
      if (result.error) return sendJson(res, 400, { error: result.error });
      // No prompt for assistants: a same-date save replaces, and the reply says so.
      return sendJson(res, 200, { saved: { date: date, odometer: odometer }, unchanged: !!result.unchanged, replaced: !!result.previous && !result.unchanged, previous: result.previous ? { odometer: result.previous.odometer } : null, status: statusBody(car) });
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
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': 'op_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' + (COOKIE_SECURE ? '; Secure' : '') });
  }

  const me = currentUser(req);
  if (!me) return sendJson(res, 401, { error: 'Log in first.' });
  const isAdmin = me.role === 'admin';
  const adminOnly = () => sendJson(res, 403, { error: 'Only the admin can do that.' });

  // Mutations must be JSON, which a cross-site form cannot send.
  if (method !== 'GET' && !String(req.headers['content-type'] || '').startsWith('application/json')) {
    return sendJson(res, 415, { error: 'Send JSON.' });
  }

  // Which car this request is about. Routes that need one use it.
  const car = pickCar(me, url);
  const needCar = () => sendJson(res, 404, { error: 'No such vehicle.' });

  if (p === '/api/status' && method === 'GET') {
    if (!car) return needCar();
    return sendJson(res, 200, Object.assign(statusFor(me, car), { ui: uiBody(me), me: { username: me.username, role: me.role } }));
  }

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

  if (p === '/api/options' && method === 'PUT') {
    if (!isAdmin) return adminOnly();
    let b;
    try { b = await readBody(req); } catch (e) { return sendJson(res, 400, { error: 'Bad request.' }); }
    const o = cleanOptions(b);
    if (!o) return sendJson(res, 400, { error: 'The overage rate is dollars per mile, from 0 to 10.' });
    data.options = o;
    saveData();
    const now = pickCar(me, url) || visibleCars(me)[0] || data.vehicles[0];
    return sendJson(res, 200, statusFor(me, now));
  }

  if (p === '/api/export.csv' && method === 'GET') {
    if (!isAdmin) return adminOnly();
    if (!optionsBody().backup) return sendJson(res, 404, { error: 'Export is turned off in Settings.' });
    if (!car) return needCar();
    const tag = multiOn() ? '-' + (slug(car.settings && car.settings.vehicle) || car.id) : '';
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="odometer-readings' + tag + '.csv"', 'Cache-Control': 'no-store' });
    return res.end(readingsCsv(car));
  }
  if (p === '/api/history' && method === 'GET') {
    if (!optionsBody().history) return sendJson(res, 404, { error: 'History is turned off in Settings.' });
    if (!car) return needCar();
    return sendJson(res, 200, { history: historyList(car) });
  }
  if (p === '/api/history.csv' && method === 'GET') {
    if (!isAdmin) return adminOnly();
    if (!optionsBody().backup) return sendJson(res, 404, { error: 'Export is turned off in Settings.' });
    if (!car) return needCar();
    const tag = multiOn() ? '-' + (slug(car.settings && car.settings.vehicle) || car.id) : '';
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="odometer-history' + tag + '.csv"', 'Cache-Control': 'no-store' });
    return res.end(historyCsv(car));
  }
  if (p === '/api/backup' && method === 'GET') {
    if (!isAdmin) return adminOnly();
    if (!optionsBody().backup) return sendJson(res, 404, { error: 'Backup is turned off in Settings.' });
    const file = { app: 'odometer-pace', version: 2, exported: new Date().toISOString(), options: optionsBody(), vehicles: data.vehicles.map((v) => ({ id: v.id, archived: !!v.archived, settings: v.settings, readings: sortedReadings(v).map((r) => ({ date: r.date, odometer: r.odometer, source: r.source || 'web' })), history: v.history })) };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="odometer-pace-backup.json"', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(file, null, 2));
  }
  if (p === '/api/restore' && method === 'POST') {
    if (!isAdmin) return adminOnly();
    if (!optionsBody().backup) return sendJson(res, 404, { error: 'Restore is turned off in Settings.' });
    let b;
    try { b = await readBody(req, 2000000); } catch (e) { return sendJson(res, 400, { error: 'That file is too big or not JSON.' }); }
    const r = parseBackup(b);
    if (r.error) return sendJson(res, 400, { error: r.error });
    if (r.single) {
      // An older one-car backup replaces car one and leaves the other cars alone.
      const first = data.vehicles[0];
      first.settings = r.cars[0].settings; first.readings = r.cars[0].readings; first.history = r.cars[0].history;
      r.options.multi = multiOn();
      data.options = r.options;
    } else {
      data.vehicles = r.cars.map((c) => ({ id: c.id, archived: c.archived, settings: c.settings, readings: c.readings, history: c.history }));
      data.options = r.options;
      data.users.forEach((u) => { if (Array.isArray(u.access)) u.access = u.access.filter((id) => data.vehicles.some((v) => v.id === id)); });
    }
    saveData();
    const back = visibleCars(me)[0] || data.vehicles[0];
    return sendJson(res, 200, statusFor(me, back));
  }

  if (p === '/api/settings') {
    if (!isAdmin) return adminOnly();
    if (!car) return needCar();
    if (method === 'GET') return sendJson(res, 200, { settings: car.settings });
    if (method === 'PUT') {
      let b;
      try { b = await readBody(req); } catch (e) { return sendJson(res, 400, { error: 'Bad request.' }); }
      const s = cleanSettings(b);
      if (s === 'plan') return sendJson(res, 400, { error: 'For a planned change, fill in both the date and the miles per day (0 to 1000), or leave both empty.' });
      if (!s) return sendJson(res, 400, { error: 'Check the lease settings: a valid start date, 1 to 10 years, total miles and a starting odometer.' });
      car.settings = s;
      saveData();
      return sendJson(res, 200, { settings: s });
    }
  }

  if (p === '/api/readings' && method === 'POST') {
    if (!car) return needCar();
    let b;
    try { b = await readBody(req); } catch (e) { return sendJson(res, 400, { error: 'Bad request.' }); }
    const odometer = Number(String(b.odometer).replace(/,/g, ''));
    const date = String(b.date || todayKey());
    const result = addReading(car, date, odometer, 'web:' + me.username);
    if (result.error) return sendJson(res, 400, { error: result.error });
    return sendJson(res, 200, Object.assign(statusFor(me, car), { unchanged: !!result.unchanged }));
  }

  const del = /^\/api\/readings\/(\d{4}-\d{2}-\d{2})$/.exec(p);
  if (del && method === 'DELETE') {
    if (!isAdmin) return adminOnly();
    if (!car) return needCar();
    const gone = car.readings.find((r) => r.date === del[1]);
    car.readings = car.readings.filter((r) => r.date !== del[1]);
    if (gone) logHistory(car, { at: new Date().toISOString(), date: gone.date, odometer: gone.odometer, previous: null, deleted: true, by: 'person', name: me.username, owner: null });
    saveData();
    return sendJson(res, 200, statusFor(me, car));
  }

  // Vehicles. Admin only. Everything here needs Multiple vehicles turned on, except the list.
  if (p === '/api/vehicles' || p.startsWith('/api/vehicles/')) {
    if (!isAdmin) return adminOnly();
    if (p === '/api/vehicles' && method === 'GET') return sendJson(res, 200, { vehicles: data.vehicles.map(carBrief) });
    if (!multiOn()) return sendJson(res, 400, { error: 'Turn on Multiple vehicles in Settings first.' });
    if (p === '/api/vehicles' && method === 'POST') {
      let b;
      try { b = await readBody(req); } catch (e) { return sendJson(res, 400, { error: 'Bad request.' }); }
      if (data.vehicles.length >= MAX_CARS) return sendJson(res, 400, { error: 'That is the most vehicles this app tracks (' + MAX_CARS + ').' });
      const s = cleanSettings(b);
      if (s === 'plan') return sendJson(res, 400, { error: 'For a planned change, fill in both the date and the miles per day (0 to 1000), or leave both empty.' });
      if (!s) return sendJson(res, 400, { error: 'Check the lease settings: a valid start date, 1 to 10 years, total miles and a starting odometer.' });
      const created = newCar(s);
      data.vehicles.push(created);
      saveData();
      return sendJson(res, 200, { id: created.id, vehicles: data.vehicles.map(carBrief) });
    }
    const vm = /^\/api\/vehicles\/([a-f0-9]+)(\/archive|\/restore)?$/.exec(p);
    const target = vm && data.vehicles.find((v) => v.id === vm[1]);
    if (!target) return sendJson(res, 404, { error: 'No such vehicle.' });
    if (vm[2] === '/archive' && method === 'POST') {
      if (!target.archived && activeCars().length < 2) return sendJson(res, 400, { error: 'Keep at least one vehicle that is not archived.' });
      target.archived = true;
      saveData();
      return sendJson(res, 200, { vehicles: data.vehicles.map(carBrief) });
    }
    if (vm[2] === '/restore' && method === 'POST') {
      target.archived = false;
      saveData();
      return sendJson(res, 200, { vehicles: data.vehicles.map(carBrief) });
    }
    if (!vm[2] && method === 'DELETE') {
      if (!target.archived) return sendJson(res, 400, { error: 'Archive the vehicle first. Deleting is permanent.' });
      data.vehicles = data.vehicles.filter((v) => v.id !== target.id);
      data.tokens = data.tokens.filter((k) => k.vehicleId !== target.id);
      data.users.forEach((u) => { if (Array.isArray(u.access)) u.access = u.access.filter((id) => id !== target.id); });
      saveData();
      return sendJson(res, 200, { vehicles: data.vehicles.map(carBrief) });
    }
    return sendJson(res, 404, { error: 'Not found.' });
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
    // Sign out this user's other devices; keep the one that just changed the password.
    const keep = sha256(readCookie(req, 'op_session'));
    data.sessions = data.sessions.filter((x) => x.userId !== user.id || x.hash === keep);
    saveData();
    return sendJson(res, 200, { ok: true });
  }

  // Logins for the household. Admin only.
  if (p === '/api/users' || p.startsWith('/api/users/')) {
    if (!isAdmin) return adminOnly();
    if (AUTH_MODE === 'proxy') return sendJson(res, 400, { error: 'Logins are handled by the reverse proxy.' });
    if (p === '/api/users' && method === 'GET') {
      return sendJson(res, 200, { users: data.users.map((u) => ({ id: u.id, username: u.username, role: u.role, access: Array.isArray(u.access) ? u.access : 'all' })) });
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
      const made = makeUser(username, String(b.password), 'user');
      made.access = cleanAccess(b);
      data.users.push(made);
      saveData();
      return sendJson(res, 200, { ok: true });
    }
    const one = /^\/api\/users\/([a-f0-9]+)(\/password|\/access)?$/.exec(p);
    const target = one && data.users.find((u) => u.id === one[1]);
    if (!target) return sendJson(res, 404, { error: 'No such user.' });
    if (one[2] === '/access' && method === 'PUT') {
      if (target.role === 'admin') return sendJson(res, 400, { error: 'The admin always sees every vehicle.' });
      target.access = cleanAccess(b);
      saveData();
      return sendJson(res, 200, { ok: true, access: target.access });
    }
    if (one[2] === '/password' && method === 'POST') {
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
      return sendJson(res, 200, { tokens: mine.map((t) => ({ vehicle: t.vehicleId || data.vehicles[0].id, id: t.id, name: t.name, owner: t.ownerName || '', own: t.ownerId === me.id, created: t.created, last_used: t.last_used || null })) });
    }
    if (method === 'POST') {
      let b;
      try { b = await readBody(req); } catch (e) { return sendJson(res, 400, { error: 'Bad request.' }); }
      const name = String(b.name || '').trim().slice(0, 40);
      if (!name) return sendJson(res, 400, { error: 'Give the key a name.' });
      // A key reaches one car. Without a choice it gets the car you are looking at.
      const keyCar = b.vehicle ? visibleCars(me).find((v) => v.id === b.vehicle) : (visibleCars(me)[0] || null);
      if (!keyCar) return sendJson(res, 400, { error: 'Pick one of your vehicles for this key.' });
      const key = 'op_' + crypto.randomBytes(32).toString('base64url');
      data.tokens.push({ id: crypto.randomBytes(6).toString('hex'), name: name, vehicleId: keyCar.id, ownerId: me.id, ownerName: me.username, hash: sha256(key), created: new Date().toISOString() });
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

if (require.main === module) {
  server.listen(PORT, () => console.log('Odometer Pace listening on ' + PORT + ' (auth: ' + AUTH_MODE + ', data: ' + DATA_FILE + ')'));
}
module.exports = server;
