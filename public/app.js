// Odometer Pace front end. Plain JavaScript, no build step.
(function () {
  var app = document.getElementById('app');
  var status = null;
  var me = { username: '', role: 'user' };
  var mode = 'app';
  var ui = { accent: 'purple', oled: false };
  var factsOpen = false;

  // Remember the theme on this device so the login page matches before the server answers.
  try { ui = Object.assign(ui, JSON.parse(localStorage.getItem('op_ui') || '{}')); } catch (e) { /* keep defaults */ }
  applyUi(ui);

  function applyUi(next) {
    ui = { accent: next.accent || 'purple', oled: next.oled === true };
    document.documentElement.setAttribute('data-accent', ui.accent);
    document.documentElement.setAttribute('data-oled', String(ui.oled));
    var meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.setAttribute('content', ui.oled ? '#000000' : '#222226');
    try { localStorage.setItem('op_ui', JSON.stringify(ui)); } catch (e) { /* private mode */ }
  }

  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  function fmt(n) { return Number(n).toLocaleString('en-US'); }
  function fmt1(n) { return Number(n).toLocaleString('en-US', { maximumFractionDigits: 1 }); }

  // Small helper to build elements. Text goes in as text, never as HTML.
  function el(tag, attrs, kids) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
      else node.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) {
      if (c === null || c === undefined) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  // Small inline icons, drawn here so nothing is loaded from elsewhere. They use the text color.
  var ICONS = {
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
    history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    left: '<path d="M15 6l-6 6 6 6"/>',
    right: '<path d="M9 6l6 6-6 6"/>',
    chevron: '<path d="M6 9l6 6 6-6"/>',
    back: '<path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
    today: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v3"/><path d="M12 19v3"/><path d="M2 12h3"/><path d="M19 12h3"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9"/><path d="M16 7l3 3"/>',
    userx: '<circle cx="9" cy="8" r="4"/><path d="M2 21v-1a6 6 0 0 1 6-6h2"/><path d="M16 16l5 5"/><path d="M21 16l-5 5"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    close: '<path d="M18 6L6 18"/><path d="M6 6l12 12"/>',
    ban: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>'
  };

  function icon(name) {
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', '22'); s.setAttribute('height', '22');
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '2'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true'); s.setAttribute('focusable', 'false');
    s.innerHTML = ICONS[name];
    return s;
  }

  // A button that shows only an icon. The label feeds screen readers and the hover tooltip.
  function iconBtn(name, label, onclick, cls) {
    return el('button', { class: 'icon-btn' + (cls ? ' ' + cls : ''), type: 'button', 'aria-label': label, title: label, onclick: onclick }, [icon(name)]);
  }

  function api(method, path, body) {
    var opts = { method: method, headers: {}, credentials: 'same-origin' };
    if (method !== 'GET') {
      // The server only accepts JSON for changes, which a cross-site form cannot send.
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body || {});
    }
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) {
          var e = new Error(j.error || 'Something went wrong.');
          e.status = r.status;
          throw e;
        }
        return j;
      });
    });
  }

  function show(node) {
    app.textContent = '';
    app.appendChild(node);
    app.appendChild(el('p', { class: 'foot' }, [el('a', { href: 'https://github.com/dhrandy/odometer-pace', target: '_blank', rel: 'noopener noreferrer', text: 'Odometer Pace on GitHub' })]));
    window.scrollTo(0, 0);
  }

  function longDate(k) {
    var p = k.split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // The logo: a road narrowing to the horizon with a dot in the accent color.
  var TAGLINE = 'Every mile, on schedule.';
  function logoMark() {
    var n = el('span', { class: 'logo-mark', 'aria-hidden': 'true' });
    n.innerHTML = '<svg viewBox="0 0 48 48" width="48" height="48"><rect width="48" height="48" rx="12" fill="rgba(255,255,255,.14)"/><path d="M17 40L21.5 8h5L31 40z" fill="rgba(255,255,255,.28)"/><path d="M24 36v-5M24 26v-5M24 16v-4" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/><circle class="dot" cx="35" cy="13" r="4"/></svg>';
    return n;
  }
  function brandBlock() {
    return el('div', { class: 'brand-block' }, [logoMark(), el('div', {}, [el('div', { class: 'brand', text: 'Odometer Pace' }), el('div', { class: 'tagline', text: TAGLINE })])]);
  }

  // ---------- login and first run ----------

  function renderLogin(first) {
    var name = el('input', { type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', 'aria-label': 'Username', placeholder: 'Username' });
    var pw = el('input', { type: 'password', autocomplete: first ? 'new-password' : 'current-password', 'aria-label': 'Password', placeholder: 'Password' });
    var err = el('p', { class: 'err', role: 'status' });
    function submit(e) {
      e.preventDefault();
      err.textContent = '';
      api('POST', first ? '/api/setup' : '/api/login', { username: name.value, password: pw.value })
        .then(boot)
        .catch(function (x) { err.textContent = x.message; });
    }
    show(el('div', { class: 'center' }, [el('div', { class: 'card' }, [
      el('div', { class: 'login-brand' }, [brandBlock()]),
      el('p', { class: 'sub', text: first ? 'First run. Create the admin login. Use 8 or more characters for the password.' : 'Log in to see your mileage.' }),
      el('form', { onsubmit: submit }, [
        el('label', { class: 'field' }, [name]),
        el('div', { class: 'spacer' }),
        el('label', { class: 'field' }, [pw]),
        el('div', { class: 'spacer' }),
        el('button', { class: 'btn', type: 'submit', text: first ? 'Create admin' : 'Log in' }),
        err
      ])
    ])]));
    name.focus();
  }

  // Optional features, off until the admin turns them on.
  function featuresCard() {
    var o = (status && status.options) || {};
    var names = [
      ['overage', 'Overage cost', 'Shows what the miles past the limit would cost at turn-in.'],
      ['whatif', 'Trip what-if', 'A small calculator for how a planned trip changes your projection.'],
      ['glance', 'Glance view', 'A card at the top with the miles you can drive today and this week, and a read-only /api/v1/glance for widgets and Home Assistant.'],
      ['history', 'History', 'A page listing every reading that was entered, when, and by whom (a person, or an AI or API key). Starts on.'],
      ['backup', 'Export and backup', 'Download your readings and history as CSV, or a full backup you can restore later.']
    ];
    var boxes = {};
    var rate = el('input', { type: 'number', inputmode: 'decimal', min: '0', max: '10', step: 'any', placeholder: 'Dollars per mile over, e.g. 0.25' });
    rate.value = o.overageRate || '';
    var msg = el('p', { class: 'err', role: 'status' });
    var rows = names.map(function (n) {
      var cb = el('input', { type: 'checkbox' });
      cb.checked = n[0] === 'history' ? o.history !== false : o[n[0]] === true;
      boxes[n[0]] = cb;
      return el('div', { class: 'opt' }, [el('label', { class: 'check' }, [cb, n[1]]), el('p', { class: 'note', text: n[2] })]);
    });
    var box = el('div', { class: 'card' }, [
      el('h2', { text: 'Optional features' }),
      el('p', { class: 'sub', text: 'Off by default, except History. Turn on only what you want to see.' })
    ].concat(rows, [
      el('label', { class: 'field' }, ['Overage rate (used by Overage cost and Trip what-if)', rate]),
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn', type: 'button', text: 'Save', onclick: function () {
        msg.className = 'err'; msg.textContent = '';
        api('PUT', '/api/options', { overage: boxes.overage.checked, whatif: boxes.whatif.checked, glance: boxes.glance.checked, backup: boxes.backup.checked, history: boxes.history.checked, overageRate: rate.value })
          .then(function (st) { status = st; msg.className = 'err ok'; msg.textContent = 'Saved.'; renderSettings(false); })
          .catch(function (x) { msg.textContent = x.message; });
      } }),
      msg
    ]));
    if (o.backup) {
      var rmsg = el('p', { class: 'err', role: 'status' });
      var file = el('input', { type: 'file', accept: 'application/json,.json', 'aria-label': 'Backup file to restore' });
      file.addEventListener('change', function () {
        var f = file.files[0];
        if (!f) return;
        rmsg.className = 'err'; rmsg.textContent = '';
        f.text().then(function (t) {
          var parsed;
          try { parsed = JSON.parse(t); } catch (e) { throw new Error('That file is not valid JSON.'); }
          var n = Array.isArray(parsed.readings) ? parsed.readings.length : 0;
          if (!confirm('Restore this backup? It replaces your lease settings and all ' + (status.readings || []).length + ' current readings with the ' + n + ' in the file. Logins and API keys stay as they are.')) { file.value = ''; return; }
          return api('POST', '/api/restore', parsed).then(function () { rmsg.className = 'err ok'; rmsg.textContent = 'Restored.'; boot(); });
        }).catch(function (x) { rmsg.textContent = x.message; file.value = ''; });
      });
      box.appendChild(el('div', { class: 'spacer' }));
      box.appendChild(el('h3', { class: 'minor', text: 'Export and backup' }));
      box.appendChild(el('p', { class: 'row' }, [
        el('a', { class: 'btn quiet btn-link', href: '/api/export.csv', download: 'odometer-readings.csv', text: 'Download CSV' }), ' ',
        el('a', { class: 'btn quiet btn-link', href: '/api/history.csv', download: 'odometer-history.csv', text: 'History CSV' }), ' ',
        el('a', { class: 'btn quiet btn-link', href: '/api/backup', download: 'odometer-pace-backup.json', text: 'Download backup' })
      ]));
      box.appendChild(el('p', { class: 'note', text: 'The backup holds your lease settings, readings and history, not logins or API keys.' }));
      box.appendChild(el('label', { class: 'field' }, ['Restore from a backup file', file]));
      box.appendChild(rmsg);
    }
    return box;
  }

  // ---------- settings ----------

  function renderSettings(first) {
    if (me.role !== 'admin') return first ? renderWaiting() : renderAccount();
    var vehicle = el('input', { type: 'text', maxlength: '60', placeholder: 'Optional, e.g. My lease' });
    var start = el('input', { type: 'date' });
    var years = el('input', { type: 'number', inputmode: 'numeric', min: '1', max: '10', value: '3' });
    var total = el('input', { type: 'number', inputmode: 'numeric', min: '1', placeholder: 'e.g. 36000' });
    var odo = el('input', { type: 'number', inputmode: 'numeric', min: '0', placeholder: 'Miles on the odometer at delivery' });
    var planFrom = el('input', { type: 'date' });
    var planPerDay = el('input', { type: 'number', inputmode: 'decimal', min: '0', max: '1000', step: 'any', placeholder: 'e.g. 30' });
    var err = el('p', { class: 'err', role: 'status' });
    var keysBox = el('div');

    api('GET', '/api/settings').then(function (r) {
      var s = r.settings;
      if (!s) return;
      vehicle.value = s.vehicle || ''; start.value = s.startDate; years.value = s.years;
      total.value = s.totalMiles; odo.value = s.startOdometer;
      planFrom.value = s.planFrom || ''; planPerDay.value = s.planPerDay === undefined ? '' : s.planPerDay;
    });

    function save(e) {
      e.preventDefault();
      err.textContent = '';
      err.className = 'err';
      api('PUT', '/api/settings', {
        vehicle: vehicle.value, startDate: start.value, years: years.value, totalMiles: total.value, startOdometer: odo.value,
        planFrom: planFrom.value, planPerDay: planPerDay.value
      }).then(boot).catch(function (x) { err.textContent = x.message; });
    }

    var lease = el('div', { class: 'card' }, [
      el('h2', { text: first ? 'Set up your lease' : 'Lease settings' }),
      el('p', { class: 'sub', text: 'These stay on your server. Change them any time and the calendar redraws.' }),
      el('form', { onsubmit: save }, [
        el('div', { class: 'form-row' }, [
          el('label', { class: 'field' }, ['Name', vehicle]),
          el('label', { class: 'field' }, ['Lease start date', start])
        ]),
        el('div', { class: 'spacer' }),
        el('div', { class: 'form-row' }, [
          el('label', { class: 'field' }, ['Term in years', years]),
          el('label', { class: 'field' }, ['Total miles allowed', total]),
          el('label', { class: 'field' }, ['Starting odometer', odo])
        ]),
        el('div', { class: 'spacer' }),
        el('h3', { class: 'minor', text: 'Planned change (optional)' }),
        el('p', { class: 'sub', text: 'If your driving will change, say so here. Until that date the projection uses your pace so far. After it, the projection uses the miles per day you enter. Leave both empty to skip.' }),
        el('div', { class: 'form-row' }, [
          el('label', { class: 'field' }, ['From this date', planFrom]),
          el('label', { class: 'field' }, ['Expected miles per day', planPerDay])
        ]),
        el('div', { class: 'spacer' }),
        el('button', { class: 'btn', type: 'submit', text: 'Save' }),
        err
      ])
    ]);

    var kids = [lease];
    if (!first) {
      kids.push(el('div', { class: 'card' }, [
        el('h2', { text: 'API keys' }),
        el('p', { class: 'sub', text: 'Let an AI or script add odometer readings and read your status. A key can only do that, nothing else. The key is shown once, so copy it right away.' }),
        keysBox,
        el('p', { class: 'note' }, [el('a', { href: '/api/docs', text: 'API docs' }), ' (you must be logged in to see them)'])
      ]));
      loadKeys(keysBox);
    }
    if (!first) {
      kids.splice(1, 0, appearanceCard(), featuresCard());
      if (mode !== 'proxy') kids.splice(3, 0, usersCard());
      if (mode !== 'proxy') kids.splice(4, 0, passwordCard());
    }
    kids.unshift(el('p', {}, [first ? iconBtn('logout', 'Log out', logout, 'quiet') : iconBtn('back', 'Back', boot, 'quiet')]));
    show(el('div', { class: 'wrap top' }, kids));
  }

  // A signed-in user who is not the admin: change password and manage their own API keys.
  function renderAccount() {
    var keysBox = el('div');
    var kids = [
      el('p', {}, [iconBtn('back', 'Back', boot, 'quiet')]),
      el('div', { class: 'card' }, [
        el('h2', { text: 'Signed in as ' + me.username }),
        el('p', { class: 'sub', text: 'You can add odometer readings. The admin manages the lease settings and logins.' })
      ]),
      appearanceCard(),
      passwordCard(),
      el('div', { class: 'card' }, [
        el('h2', { text: 'Your API keys' }),
        el('p', { class: 'sub', text: 'Let your AI or a script add odometer readings and read the status. A key can only do that, nothing else. The key is shown once, so copy it right away.' }),
        keysBox,
        el('p', { class: 'note' }, [el('a', { href: '/api/docs', text: 'API docs' })])
      ])
    ];
    loadKeys(keysBox);
    show(el('div', { class: 'wrap top' }, kids));
  }

  function renderWaiting() {
    show(el('div', { class: 'center' }, [el('div', { class: 'card' }, [
      el('h1', { text: 'Odometer Pace' }),
      el('p', { class: 'sub', text: 'The admin has not set up the lease yet. Check back after they have.' }),
      iconBtn('logout', 'Log out', logout, 'quiet')
    ])]));
  }

  function passwordCard() {
    var cur = el('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Current password' });
    var next = el('input', { type: 'password', autocomplete: 'new-password', placeholder: 'New password (8 or more characters)' });
    var msg = el('p', { class: 'err', role: 'status' });
    return el('div', { class: 'card' }, [
      el('h2', { text: 'Change your password' }),
      el('form', { onsubmit: function (e) {
        e.preventDefault();
        msg.className = 'err';
        api('POST', '/api/me/password', { current: cur.value, password: next.value }).then(function () {
          cur.value = ''; next.value = '';
          msg.className = 'err ok';
          msg.textContent = 'Password changed.';
        }).catch(function (x) { msg.textContent = x.message; });
      } }, [
        el('label', { class: 'field' }, [cur]), el('div', { class: 'spacer' }),
        el('label', { class: 'field' }, [next]), el('div', { class: 'spacer' }),
        el('button', { class: 'btn quiet', type: 'submit', text: 'Change password' }), msg
      ])
    ]);
  }

  // Admin only: add and remove household logins.
  function usersCard() {
    var list = el('div');
    var name = el('input', { type: 'text', maxlength: '30', autocapitalize: 'none', spellcheck: 'false', autocomplete: 'off', placeholder: 'Username' });
    var pw = el('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Password (8 or more characters)' });
    var msg = el('p', { class: 'err', role: 'status' });

    function draw() {
      api('GET', '/api/users').then(function (r) {
        list.textContent = '';
        r.users.forEach(function (u) {
          var row = el('div', { class: 'token-row' }, [el('span', { text: u.username + (u.role === 'admin' ? ' (admin)' : '') })]);
          if (u.role !== 'admin') {
            var btns = el('span', { class: 'row-btns' }, [
              iconBtn('key', 'New password for ' + u.username, function () {
                var p = prompt('New password for ' + u.username + ' (8 or more characters). They will be logged out.');
                if (p) api('POST', '/api/users/' + u.id + '/password', { password: p }).then(function () { msg.className = 'err ok'; msg.textContent = 'Password changed for ' + u.username + '.'; }).catch(function (x) { msg.className = 'err'; msg.textContent = x.message; });
              }, 'quiet'),
              iconBtn('userx', 'Remove ' + u.username, function () {
                if (confirm('Remove ' + u.username + '? Their API keys stop working. Readings they added stay.')) api('DELETE', '/api/users/' + u.id).then(draw);
              }, 'danger')
            ]);
            row.appendChild(btns);
          }
          list.appendChild(row);
        });
      });
    }
    draw();

    return el('div', { class: 'card' }, [
      el('h2', { text: 'Logins' }),
      el('p', { class: 'sub', text: 'Users can add readings and use their own API keys. Only you, the admin, can change the lease and logins or delete readings. Everyone picks their own appearance.' }),
      list,
      el('div', { class: 'spacer' }),
      el('form', { onsubmit: function (e) {
        e.preventDefault();
        msg.className = 'err';
        api('POST', '/api/users', { username: name.value, password: pw.value }).then(function () {
          name.value = ''; pw.value = '';
          msg.className = 'err ok';
          msg.textContent = 'Login added.';
          draw();
        }).catch(function (x) { msg.textContent = x.message; });
      } }, [
        el('label', { class: 'field' }, ['New login', name]), el('div', { class: 'spacer' }),
        el('label', { class: 'field' }, [pw]), el('div', { class: 'spacer' }),
        el('button', { class: 'btn', type: 'submit', text: 'Add login' }), msg
      ])
    ]);
  }

  function appearanceCard() {
    var box = el('div', { class: 'card' }, [
      el('h2', { text: 'Appearance' }),
      el('p', { class: 'sub', text: 'Pick your accent color. It is saved to your login, so your devices match. Other logins keep their own.' })
    ]);
    var swatches = el('div', { class: 'swatches', role: 'group', 'aria-label': 'Accent color' });
    var names = { purple: 'Purple', blue: 'Blue', cyan: 'Cyan', green: 'Green', pink: 'Pink', orange: 'Orange' };
    var oled = el('input', { type: 'checkbox' });
    oled.checked = ui.oled;

    function save(next) {
      applyUi(next);
      drawSwatches();
      api('PUT', '/api/ui', next).catch(function () { /* the theme still applies on this device */ });
    }
    function drawSwatches() {
      swatches.textContent = '';
      Object.keys(names).forEach(function (k) {
        swatches.appendChild(el('button', {
          type: 'button', class: 'swatch s-' + k, title: names[k], 'aria-label': names[k], 'aria-pressed': String(ui.accent === k),
          onclick: function () { save({ accent: k, oled: ui.oled }); }
        }));
      });
    }
    oled.addEventListener('change', function () { save({ accent: ui.accent, oled: oled.checked }); });
    drawSwatches();
    box.appendChild(swatches);
    box.appendChild(el('label', { class: 'check' }, [oled, 'OLED black background']));
    return box;
  }

  function loadKeys(box, shownKey) {
    api('GET', '/api/tokens').then(function (r) {
      box.textContent = '';
      r.tokens.forEach(function (t) {
        box.appendChild(el('div', { class: 'token-row' }, [
          el('span', { text: t.name + (me.role === 'admin' && t.owner && !t.own ? ' for ' + t.owner : '') + (t.last_used ? ' (last used ' + t.last_used.slice(0, 10) + ')' : ' (never used)') }),
          iconBtn('ban', 'Revoke key ' + t.name, function () {
            if (confirm('Revoke "' + t.name + '"? Anything using it stops working.')) api('DELETE', '/api/tokens/' + t.id).then(function () { loadKeys(box); });
          }, 'danger')
        ]));
      });
      var name = el('input', { type: 'text', maxlength: '40', placeholder: 'Key name, e.g. Instinct' });
      var out = el('div');
      box.appendChild(el('div', { class: 'spacer' }));
      box.appendChild(el('div', { class: 'form-row' }, [
        el('label', { class: 'field' }, ['New key', name]),
        el('button', { class: 'btn', type: 'button', text: 'Create key', onclick: function () {
          api('POST', '/api/tokens', { name: name.value }).then(function (k) {
            loadKeys(box, k.key);
          }).catch(function (x) { out.textContent = x.message; });
        } })
      ]));
      box.appendChild(out);
      if (shownKey) {
        out.appendChild(el('p', { class: 'ok', text: 'Copy this now. It will not be shown again.' }));
        out.appendChild(el('div', { class: 'token-box', text: shownKey }));
      }
    });
  }

  function logout() { api('POST', '/api/logout', {}).then(boot); }

  // ---------- main page ----------

  // Redraw after a save or delete without jumping back to the top.
  function refresh(st) {
    var y = window.scrollY;
    status = st;
    renderMain();
    window.scrollTo(0, y);
  }

  function stat(k, v, n, cls) {
    return el('div', { class: 'stat' + (cls ? ' ' + cls : '') }, [
      el('div', { class: 'k', text: k }), el('div', { class: 'v', text: v }), el('div', { class: 'n', text: n })
    ]);
  }

  // Every reading that was entered, newest first, and who entered it.
  function renderHistory() {
    var list = el('ul', { class: 'log hist' });
    var msg = el('p', { class: 'err', role: 'status' });
    api('GET', '/api/history').then(function (r) {
      if (!r.history.length) list.appendChild(el('li', {}, ['Nothing has been entered yet.']));
      r.history.forEach(function (h) {
        var when = h.at ? new Date(h.at).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'earlier';
        var what = h.deleted ? 'Deleted ' + fmt(h.odometer) + ' mi' : fmt(h.odometer) + ' mi';
        var more = ' for ' + longDate(h.date) + (!h.deleted && h.previous !== null && h.previous !== undefined ? ', replaced ' + fmt(h.previous) : '');
        var who = h.by === 'api'
          ? [el('span', { class: 'tag', text: 'AI/API' }), ' ' + h.name + (h.owner ? ' (' + h.owner + ')' : '')]
          : [h.name];
        list.appendChild(el('li', {}, [el('div', {}, [
          el('div', {}, [el('strong', { text: what }), more]),
          el('div', { class: 'src hist-meta' }, [when + ' \u00b7 '].concat(who))
        ])]));
      });
    }).catch(function (x) { msg.textContent = x.message; });
    show(el('div', { class: 'wrap top' }, [
      el('p', {}, [iconBtn('back', 'Back', boot, 'quiet')]),
      el('div', { class: 'card' }, [el('h2', { text: 'History' }), el('p', { class: 'sub', text: 'Every reading that was entered, newest first.' }), list, msg])
    ]));
  }

  function renderMain() {
    var s = status, L = s.lease;
    var plan = Lease.makePlan({ startDate: L.start_date, years: L.years, totalMiles: L.total_miles, startOdometer: L.start_odometer });

    var summary = [L.vehicle, fmt(L.total_miles) + ' mi', L.state === 'not_started' ? 'starts ' + longDate(L.start_date) : L.state === 'complete' ? 'lease complete' : 'day ' + fmt(L.day_of_lease) + ' of ' + fmt(L.days_total)].filter(Boolean).join(' \u00b7 ');
    var factsBox = el('div', { class: 'hero-facts' }, [
      el('h1', { text: fmt(L.total_miles) + ' Miles, Day by Day' }),
      el('ul', { class: 'facts' }, [
        L.vehicle ? el('li', { text: L.vehicle }) : null,
        el('li', { text: longDate(L.start_date) + ' to ' + longDate(L.end_date) }),
        el('li', { text: fmt(L.miles_per_year) + ' miles a year' }),
        el('li', { text: 'Odometer limit ' + fmt(L.odometer_limit) })
      ])
    ]);
    factsBox.hidden = !factsOpen;
    var line = el('button', { class: 'summary-line', type: 'button', 'aria-expanded': String(factsOpen), onclick: function () {
      factsOpen = !factsOpen;
      factsBox.hidden = !factsOpen;
      line.setAttribute('aria-expanded', String(factsOpen));
      line.classList.toggle('open', factsOpen);
    } }, [el('span', { text: summary }), icon('chevron')]);
    line.classList.toggle('open', factsOpen);
    var hero = el('header', { class: 'hero' }, [el('div', { class: 'hero-inner' }, [
      el('div', { class: 'topbar' }, [
        logoMark(), el('div', { class: 'brand', text: 'Odometer Pace' }),
        el('nav', {}, [
          (s.options && s.options.history !== false) ? iconBtn('history', 'History', renderHistory, 'on-hero') : null,
          iconBtn('gear', 'Settings', function () { renderSettings(false); }, 'on-hero'),
          iconBtn('logout', 'Log out', logout, 'on-hero')
        ])
      ]),
      line, factsBox
    ])]);

    var cards = [];
    if (s.glance) {
      // One card: the glance numbers on top, the day line and bar below.
      var merged = glanceCard(s), stand = standCard(s, plan);
      merged.appendChild(el('div', { class: 'merge-rule' }));
      Array.prototype.slice.call(stand.children, 1).forEach(function (c) {
        if (c.classList.contains('stand-line')) c.classList.add('sm');
        merged.appendChild(c);
      });
      cards.push(merged);
    } else cards.push(standCard(s, plan));
    cards.push(odometerCard(s, plan));
    if (s.options && s.options.whatif && s.latest && s.lease.state === 'active') cards.push(whatIfCard(s, plan));
    cards.push(calendar(s, plan));
    var wrap = el('div', { class: 'wrap' }, cards);
    show(el('div', {}, [hero, wrap]));
  }

  function money(n) { return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

  // Miles you can drive today and this week and still be on pace.
  function glanceCard(s) {
    var g = s.glance;
    if (g.state !== 'active' || g.status === 'no_reading') {
      var text = g.state === 'not_started' ? 'The lease has not started yet.' : g.state === 'complete' ? 'The lease is complete.' : 'Add a reading to see how far you can drive this week.';
      return el('div', { class: 'card glance' }, [el('p', { class: 'label', text: 'At a glance' }), el('p', { class: 'stand-line', text: text })]);
    }
    var over = g.status === 'over';
    var head = over ? 'Over pace by ' + fmt(g.miles_over_pace) + ' mi today.' : 'On track.';
    var sub = over
      ? 'Drive a little less to get back on track. Pace allows about ' + fmt1(g.average_per_day) + ' mi a day.'
      : 'Staying within these miles keeps you on pace. Pace allows about ' + fmt1(g.average_per_day) + ' mi a day.';
    var node = el('div', { class: 'card glance ' + (over ? 'over' : 'under') }, [
      el('p', { class: 'label', text: 'At a glance' }),
      el('div', { class: 'glance-main' }, [
        el('div', {}, [el('div', { class: 'big', text: fmt(g.can_drive_week) }), el('div', { class: 'n', text: 'you can drive by the end of the week' })]),
        el('div', {}, [el('div', { class: 'mid', text: fmt(g.can_drive_today) }), el('div', { class: 'n', text: 'you can still drive today' })])
      ]),
      el('p', { class: 'glance-status' }, [el('strong', { text: head }), ' ' + sub]),
      g.days_since_reading !== null && g.days_since_reading > 3 ? el('p', { class: 'note', text: 'Based on the reading from ' + longDate(g.reading_date) + '. A fresh one sharpens this.' }) : null
    ]);
    return node;
  }

  // A trip is added on top of the miles already projected.
  function whatIfCard(s, plan) {
    var b = s.latest, o = s.options;
    var trip = el('input', { type: 'number', inputmode: 'numeric', min: '0', step: '1', placeholder: 'e.g. 800', 'aria-label': 'Trip miles' });
    var out = el('div', { 'aria-live': 'polite' });
    function draw() {
      out.textContent = '';
      var miles = Math.round(Number(trip.value));
      if (!trip.value || !isFinite(miles) || miles < 0) return;
      var r = Lease.whatIf(plan, { projected: b.projected_end_odometer, remaining: b.miles_remaining, daysLeft: b.days_left }, miles, o.overageRate);
      if (!r || r.projected_vs_limit === null) { out.appendChild(el('p', { class: 'note', text: 'Not enough readings to project yet.' })); return; }
      var over = r.projected_vs_limit > 0;
      var items = [
        stat('Projected end', fmt(r.projected_end_odometer), (over ? fmt(r.projected_vs_limit) + ' over' : fmt(-r.projected_vs_limit) + ' under') + ' the limit', over ? 'over' : 'under')
      ];
      if (o.overageRate && o.overage) items.push(stat('Projected fee', money(r.projected_fee), over ? 'at ' + money(o.overageRate) + ' a mile' : 'nothing owed', over ? 'over' : 'under'));
      if (r.miles_per_day_to_stay_under !== null) items.push(stat('To stay under', fmt1(r.miles_per_day_to_stay_under) + '/day', 'for the days that are left'));
      out.appendChild(el('div', { class: 'stats' }, items));
    }
    trip.addEventListener('input', draw);
    return el('div', { class: 'card' }, [
      el('h2', { text: 'Trip what-if' }),
      el('p', { class: 'sub', text: 'Drive somewhere extra? Enter the round-trip miles to see the effect on your projection. It is added on top of what you already drive.' }),
      el('label', { class: 'field' }, ['Trip miles', trip]),
      el('div', { class: 'spacer' }),
      out
    ]);
  }

  function standCard(s, plan) {
    var L = s.lease, line, left = '', right = '';
    var fill = el('div');
    if (L.state === 'not_started') {
      line = 'The lease starts ' + longDate(L.start_date) + '. Nothing to cross off yet.';
    } else if (L.state === 'complete') {
      line = 'Lease complete: ' + fmt(L.total_miles) + ' miles over ' + fmt(L.days_total) + ' days.';
      fill.style.width = '100%';
    } else {
      line = 'Day ' + fmt(L.day_of_lease) + ' of ' + fmt(L.days_total) + '. Allowed so far: ' + fmt(s.allowed_odometer_today - L.start_odometer) + ' miles.';
      fill.style.width = Math.max(2.5, L.day_of_lease / L.days_total * 100) + '%'; // always a visible sliver
      left = fmt(L.days_total - L.day_of_lease) + ' days left';
      right = 'on-pace odometer today: ' + fmt(s.allowed_odometer_today);
    }
    return el('div', { class: 'card' }, [
      el('p', { class: 'label', text: 'Where you stand' }),
      el('p', { class: 'stand-line', text: line }),
      el('div', { class: 'bar' }, [fill]),
      el('div', { class: 'bar-meta' }, [el('span', { text: left }), el('span', { text: right })])
    ]);
  }

  function odometerCard(s, plan) {
    var odo = el('input', { type: 'number', inputmode: 'numeric', min: '0', step: '1', placeholder: 'e.g. 1250', 'aria-label': 'Odometer reading' });
    var date = el('input', { type: 'date', value: s.today, 'aria-label': 'Date of reading' });
    var err = el('p', { class: 'err', role: 'status' });

    function post() {
      confirmBox.hidden = true;
      api('POST', '/api/readings', { odometer: odo.value, date: date.value })
        .then(refresh)
        .catch(function (x) { err.textContent = x.message; });
    }

    // A date that already has a reading asks before it replaces it.
    var confirmText = el('span');
    var confirmBox = el('div', { class: 'confirm', role: 'alert', hidden: '' }, [
      confirmText,
      el('div', { class: 'row-btns' }, [
        el('button', { class: 'btn', type: 'button', text: 'Replace', onclick: post }),
        el('button', { class: 'btn quiet', type: 'button', text: 'Cancel', onclick: function () { confirmBox.hidden = true; } })
      ])
    ]);

    function save(e) {
      e.preventDefault();
      err.textContent = '';
      var same = (s.readings || []).filter(function (r) { return r.date === date.value; })[0];
      var next = Number(String(odo.value).replace(/,/g, ''));
      if (same && same.odometer === next) { err.textContent = longDate(date.value) + ' already has ' + fmt(next) + '. No change.'; return; }
      if (same) {
        confirmText.textContent = longDate(date.value) + ' already has ' + fmt(same.odometer) + '. Replace with ' + fmt(next) + '?';
        confirmBox.hidden = false;
        return;
      }
      post();
    }

    // The entry form stays folded away until the plus button is tapped. With no readings yet it starts open.
    var form = el('form', { class: 'form-row add-form', id: 'add-form', onsubmit: save }, [
      el('label', { class: 'field' }, ['Odometer', odo]),
      el('label', { class: 'field' }, ['Date', date]),
      el('button', { class: 'btn', type: 'submit', text: 'Save reading' })
    ]);
    var intro = el('p', { class: 'sub', text: 'Enter a reading whenever you like. It is saved on the server, so your phone and computer match.' });
    var open = !s.latest;
    var toggle = el('button', { class: 'icon-btn add-btn', type: 'button', 'aria-controls': 'add-form', onclick: function () { setOpen(!open, true); } });
    function setOpen(next, focus) {
      open = next;
      form.hidden = !open;
      intro.hidden = !open;
      err.hidden = !open;
      if (!open) confirmBox.hidden = true;
      var label = open ? 'Close' : 'Add reading';
      toggle.textContent = '';
      toggle.appendChild(icon(open ? 'close' : 'plus'));
      toggle.setAttribute('aria-label', label);
      toggle.setAttribute('title', label);
      toggle.setAttribute('aria-expanded', String(open));
      if (open && focus) odo.focus();
    }
    setOpen(open, false);

    var card = el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [el('h2', { text: 'Your odometer' }), toggle]),
      intro,
      form,
      confirmBox,
      err
    ]);

    var b = s.latest;
    if (!b) {
      card.appendChild(el('p', { class: 'note', text: 'No readings yet. Add one to see how you compare with the on-pace odometer.' }));
      return card;
    }
    var over = b.miles_over_pace > 0;
    var under = b.miles_over_pace < 0;
    var pastLimit = b.miles_remaining < 0;
    var projOver = b.projected_vs_limit > 0;
    card.appendChild(el('div', { class: 'hero-status ' + (over ? 'over' : under ? 'under' : '') }, [
      el('p', { class: 'label', text: b.date === s.today ? 'at today\u2019s reading' : 'at your last reading, ' + longDate(b.date) }),
      el('div', { class: 'huge', text: fmt(Math.abs(b.miles_over_pace)) }),
      el('div', { class: 'huge-sub', text: b.miles_over_pace === 0 ? 'miles, right on pace' : 'miles ' + (over ? 'over' : 'under') + ' pace' }),
      el('p', { class: 'hero-note', text: 'You are at ' + fmt(b.odometer) + '. On pace would be ' + fmt(b.on_pace_odometer) + '.' })
    ]));
    var w = b.warning || s.warning;
    if (w && w.level !== 'none') {
      var names = { watch: 'Watch', warning: 'Warning', urgent: 'Urgent' };
      card.appendChild(el('div', { class: 'alert ' + w.level, role: 'status' }, [
        el('strong', { text: names[w.level] + ': ' }), w.message
      ]));
    }
    if (w && w.stale_note) card.appendChild(el('p', { class: 'note', text: w.stale_note }));
    var stats = el('div', { class: 'stats tight' }, [
      stat('Remaining', fmt(b.miles_remaining), 'to the ' + fmt(s.lease.odometer_limit) + ' limit' + (pastLimit ? ' (past it)' : ''), pastLimit ? 'over' : ''),
      stat('Your pace', fmt1(b.miles_per_day_so_far) + '/day', 'since the lease started'),
      b.miles_per_day_to_stay_under === null ? null : stat('To stay under', fmt1(b.miles_per_day_to_stay_under) + '/day', 'for the days that are left'),
      stat('Projected end', b.projected_end_odometer === null ? 'n/a' : fmt(b.projected_end_odometer),
        b.projected_vs_limit === null ? '' : (projOver ? fmt(b.projected_vs_limit) + ' over' : fmt(-b.projected_vs_limit) + ' under') + ' the limit' + (b.projected_includes_plan ? ', with your planned ' + s.lease.planned_change.miles_per_day + ' mi/day from ' + longDate(s.lease.planned_change.from) : ''), projOver ? 'over' : b.projected_vs_limit === null ? '' : 'under'),
      s.overage && s.overage.projected_fee !== null ? stat('Projected fee', money(s.overage.projected_fee), s.overage.projected_over_miles > 0 ? fmt(s.overage.projected_over_miles) + ' mi over at ' + money(s.overage.rate_per_mile) + ' a mile' : 'nothing owed at this pace', s.overage.projected_over_miles > 0 ? 'over' : 'under') : null,
      stat('Miles used', fmt(b.miles_used), 'of ' + fmt(s.lease.total_miles) + ' allowed')
    ]);
    card.appendChild(stats);
    if (b.days_left !== null && s.lease.day_of_lease < 30) {
      card.appendChild(el('p', { class: 'note', text: 'Early in the lease the projection swings a lot. It settles after a few weeks of readings.' }));
    }
    card.appendChild(chart(s, plan));

    return card;
  }

  // Allowance line, readings line and a dashed projection, drawn as SVG.
  function chart(s, plan) {
    var W = 640, H = 230, padL = 52, padR = 12, padT = 12, padB = 26;
    var NS = 'http://www.w3.org/2000/svg';
    var lo = plan.startOdometer, hi = plan.limit;
    var latest = s.latest;
    if (latest && latest.projected_end_odometer) hi = Math.max(hi, latest.projected_end_odometer);
    if (latest) hi = Math.max(hi, latest.odometer);
    function x(d) { return padL + d / plan.dayCount * (W - padL - padR); }
    function y(o) { return padT + (1 - (o - lo) / (hi - lo)) * (H - padT - padB); }
    function node(tag, attrs) {
      var n = document.createElementNS(NS, tag);
      Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
      return n;
    }
    var svg = node('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': 'Odometer readings compared with the allowance line' });

    [0, 0.5, 1].forEach(function (f) {
      var o = lo + (hi - lo) * f;
      svg.appendChild(node('line', { x1: padL, x2: W - padR, y1: y(o), y2: y(o), stroke: cssVar('--line') }));
      var t = node('text', { x: padL - 6, y: y(o) + 4, 'text-anchor': 'end', 'font-size': 11, fill: cssVar('--muted') });
      t.textContent = fmt(Math.round(o));
      svg.appendChild(t);
    });
    for (var yr = 0; yr <= plan.years; yr++) {
      var d = yr === 0 ? 0 : plan.yearLens.slice(0, yr).reduce(function (a, b) { return a + b; }, 0);
      var tl = node('text', { x: x(d), y: H - 8, 'text-anchor': yr === 0 ? 'start' : yr === plan.years ? 'end' : 'middle', 'font-size': 11, fill: cssVar('--muted') });
      tl.textContent = yr === 0 ? 'Start' : yr === plan.years ? 'End' : 'Year ' + yr;
      svg.appendChild(tl);
    }

    var pts = [];
    for (var i = -1; i < plan.dayCount; i += 15) pts.push(x(i + 1) + ',' + y(plan.startOdometer + Lease.allowedThrough(plan, i)));
    pts.push(x(plan.dayCount) + ',' + y(plan.limit));
    svg.appendChild(node('polyline', { points: pts.join(' '), fill: 'none', stroke: cssVar('--accent-mid'), 'stroke-opacity': 0.55, 'stroke-width': 3 }));

    var rp = [x(0) + ',' + y(plan.startOdometer)];
    s.readings.forEach(function (r) { rp.push(x(Lease.dayIndex(plan, r.date) + 1) + ',' + y(r.odometer)); });
    svg.appendChild(node('polyline', { points: rp.join(' '), fill: 'none', stroke: cssVar('--accent'), 'stroke-width': 3, 'stroke-linejoin': 'round' }));
    s.readings.forEach(function (r) {
      svg.appendChild(node('circle', { cx: x(Lease.dayIndex(plan, r.date) + 1), cy: y(r.odometer), r: 4, fill: cssVar('--accent-mid') }));
    });
    if (latest && latest.projected_end_odometer && s.lease.state === 'active') {
      var last = s.readings[s.readings.length - 1];
      svg.appendChild(node('line', {
        x1: x(Lease.dayIndex(plan, last.date) + 1), y1: y(last.odometer), x2: x(plan.dayCount), y2: y(latest.projected_end_odometer),
        stroke: cssVar(latest.projected_vs_limit > 0 ? '--over' : '--under'), 'stroke-width': 2.5, 'stroke-dasharray': '6 5'
      }));
    }

    var legend = el('div', { class: 'legend' }, [
      el('span', {}, [el('i', { class: 'allowed' }), 'Allowed']),
      el('span', {}, [el('i', { class: 'readings' }), 'Your readings']),
      el('span', {}, [el('i', { class: 'projected' + (latest && latest.projected_vs_limit > 0 ? ' over' : '') }), 'Projected'])
    ]);
    var box = el('div', { class: 'chart' });
    box.appendChild(svg);
    box.appendChild(legend);
    return box;
  }

  // ---------- calendar ----------

  // Month view (day numbers, tap a day for details) and a year view of the whole lease.
  function calendar(s, plan) {
    var startN = Lease.dayNum(plan.startDate), endN = startN + plan.dayCount - 1;
    var todayIdx = Lease.dayIndex(plan, s.today);
    var readingByDate = {};
    s.readings.forEach(function (r) { readingByDate[r.date] = r; });
    function ym(key) { return { y: Number(key.slice(0, 4)), m: Number(key.slice(5, 7)) - 1 }; }
    var firstM = ym(Lease.fromDayNum(startN)), lastM = ym(Lease.fromDayNum(endN));
    function monthNo(c) { return c.y * 12 + c.m; }
    var clampKey = Math.min(Math.max(Lease.dayNum(s.today), startN), endN);
    var cur = ym(Lease.fromDayNum(clampKey));
    var selected = Lease.fromDayNum(clampKey);
    var yearIdx = 0;
    plan.yearStarts.forEach(function (st, i) { if (clampKey >= Lease.dayNum(st)) yearIdx = i; });
    var view = 'month';
    var box = el('div', {});
    var body = el('div');

    function monthName(c) { return new Date(Date.UTC(c.y, c.m, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }); }
    function keyOf(yy, mm, d) { return yy + '-' + ('0' + (mm + 1)).slice(-2) + '-' + ('0' + d).slice(-2); }

    // The days of one month, limited to the lease. pick is called with a date key when a day is tapped.
    function grid(c, lo, hi, pick, mini) {
      var g = el('div', { class: 'grid' });
      if (!mini) ['S', 'M', 'T', 'W', 'T', 'F', 'S'].forEach(function (d) { g.appendChild(el('div', { class: 'dow', text: d })); });
      var cells = [];
      var firstDow = new Date(Date.UTC(c.y, c.m, 1)).getUTCDay();
      for (var b = 0; b < firstDow; b++) cells.push(el('div', { class: 'day blank' }));
      var dim = new Date(Date.UTC(c.y, c.m + 1, 0)).getUTCDate();
      for (var d = 1; d <= dim; d++) {
        var key = keyOf(c.y, c.m, d), n = Lease.dayNum(key);
        if (n < lo || n > hi) { cells.push(el('div', { class: 'day blank' })); continue; }
        var idx = n - startN;
        var cls = 'day';
        if (idx < todayIdx) cls += ' past';
        if (idx === todayIdx) cls += ' today';
        if (readingByDate[key]) cls += ' reading';
        if (!mini && key === selected) cls += ' selected';
        var cell = el(mini ? 'div' : 'button', mini ? { class: cls } : { class: cls, type: 'button', 'aria-label': longDate(key), 'aria-pressed': String(key === selected), onclick: (function (k) { return function () { pick(k); }; })(key) }, mini ? [] : [el('span', { class: 'n', text: String(d) })]);
        cells.push(cell);
      }
      // A week with no lease days in it is left out, so the first and last month have no empty rows.
      if (!mini) {
        var isBlank = function (x) { return x.className === 'day blank'; };
        while (cells.length >= 7 && cells.slice(0, 7).every(isBlank)) cells.splice(0, 7);
        while (cells.length >= 7 && cells.slice(-7).every(isBlank)) cells.splice(-7, 7);
      }
      cells.forEach(function (x) { g.appendChild(x); });
      return g;
    }

    function navRow(title, sub, onPrev, onNext, prevOff, nextOff) {
      var prev = iconBtn('left', 'Previous', onPrev, 'quiet');
      var next = iconBtn('right', 'Next', onNext, 'quiet');
      prev.disabled = prevOff; next.disabled = nextOff;
      return el('div', { class: 'month-nav' }, [prev, el('h3', {}, [title, sub ? el('small', { text: sub }) : null]), next]);
    }

    function monthView() {
      var wrap = el('div');
      function go(delta) {
        var n = monthNo(cur) + delta;
        cur = { y: Math.floor(n / 12), m: n % 12 };
        draw();
      }
      var card = el('div', { class: 'month big' }, [grid(cur, startN, endN, function (k) { selected = k; draw(); }, false)]);
      var touchX = null;
      card.addEventListener('touchstart', function (e) { touchX = e.touches[0].clientX; }, { passive: true });
      card.addEventListener('touchend', function (e) {
        if (touchX === null) return;
        var dx = e.changedTouches[0].clientX - touchX; touchX = null;
        if (dx < -50 && monthNo(cur) < monthNo(lastM)) go(1);
        else if (dx > 50 && monthNo(cur) > monthNo(firstM)) go(-1);
      }, { passive: true });
      wrap.appendChild(navRow(monthName(cur), '', function () { go(-1); }, function () { go(1); }, monthNo(cur) <= monthNo(firstM), monthNo(cur) >= monthNo(lastM)));
      wrap.appendChild(card);
      var sel = ym(selected);
      var inView = sel.y === cur.y && sel.m === cur.m;
      var key = inView ? selected : keyOf(cur.y, cur.m, 1);
      if (!inView) selected = key;
      var idx = Lease.dayIndex(plan, key);
      var allowed = Lease.allowedThrough(plan, idx);
      var r = readingByDate[key];
      wrap.appendChild(el('div', { class: 'card day-detail' }, [
        el('div', { class: 'card-head' }, [el('p', { class: 'label', text: longDate(key) + (idx === todayIdx ? ' \u00b7 today' : '') }),
          r && me.role === 'admin' ? iconBtn('trash', 'Delete reading from ' + longDate(key), function () { api('DELETE', '/api/readings/' + key).then(refresh); }, 'danger') : null]),
        el('p', { class: 'dd-line' }, [el('strong', { text: fmt(plan.startOdometer + allowed) }), ' on-pace odometer at the end of this day']),
        el('p', { class: 'note dd-note', text: fmt(allowed) + ' miles allowed so far. ' + (r ? 'Your reading: ' + fmt(r.odometer) + ' mi.' : 'No reading on this day.') })
      ]));
      wrap.appendChild(el('p', { class: 'note center-note', text: 'Swipe left or right, or use the arrows. A dot marks a day with a reading.' }));
      return wrap;
    }

    function yearView() {
      var wrap = el('div');
      var yStart = Lease.dayNum(plan.yearStarts[yearIdx]);
      var yEnd = yStart + plan.yearLens[yearIdx] - 1;
      wrap.appendChild(navRow('Lease year ' + (yearIdx + 1), fmt(Math.round(plan.perYear)) + ' miles',
        function () { yearIdx--; draw(); }, function () { yearIdx++; draw(); }, yearIdx <= 0, yearIdx >= plan.years - 1));
      var months = el('div', { class: 'months year' });
      var c = ym(Lease.fromDayNum(yStart)), end = ym(Lease.fromDayNum(yEnd));
      while (monthNo(c) <= monthNo(end)) {
        var mc = { y: c.y, m: c.m };
        var tile = el('button', { class: 'month', type: 'button', 'aria-label': 'Open ' + monthName(mc), onclick: function (m) { return function () { cur = m; selected = keyOf(m.y, m.m, 1); if (Lease.dayNum(selected) < startN) selected = plan.startDate; view = 'month'; draw(); }; }(mc) },
          [el('h3', { text: new Date(Date.UTC(mc.y, mc.m, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }) }), grid(mc, yStart, yEnd, null, true)]);
        months.appendChild(tile);
        c = { y: c.m === 11 ? c.y + 1 : c.y, m: (c.m + 1) % 12 };
      }
      wrap.appendChild(months);
      wrap.appendChild(el('p', { class: 'note center-note', text: 'Tap a month to open it. A dot marks a day with a reading.' }));
      return wrap;
    }

    function draw() {
      var seg = el('div', { class: 'seg', role: 'tablist' }, ['month', 'year'].map(function (v) {
        return el('button', { class: view === v ? 'on' : '', type: 'button', role: 'tab', 'aria-selected': String(view === v), text: v === 'month' ? 'Month' : 'Year', onclick: function () { view = v; draw(); } });
      }));
      body.innerHTML = '';
      body.appendChild(seg);
      body.appendChild(view === 'month' ? monthView() : yearView());
    }

    box.appendChild(el('div', { class: 'cal-head' }, [
      el('h2', { text: 'Every day of the lease' }),
      iconBtn('today', 'Jump to today', function () {
        cur = ym(Lease.fromDayNum(clampKey)); selected = Lease.fromDayNum(clampKey); view = 'month'; draw();
      }, 'quiet')
    ]));
    box.appendChild(body);
    draw();
    return box;
  }

  // ---------- start ----------

  function boot() {
    api('GET', '/api/session').then(function (sess) {
      mode = sess.mode;
      if (sess.setupNeeded) return renderLogin(true);
      if (!sess.loggedIn) return renderLogin(false);
      return api('GET', '/api/status').then(function (st) {
        status = st;
        if (st.me) me = st.me;
        if (st.ui) applyUi(st.ui);
        if (!st.configured) renderSettings(true);
        else renderMain();
      });
    }).catch(function (e) {
      if (e.status === 401) return renderLogin(false);
      show(el('div', { class: 'center' }, [el('div', { class: 'card' }, [el('p', { text: 'Could not reach the server: ' + e.message })])]));
    });
  }

  boot();
})();
