// Odometer Pace front end. Plain JavaScript, no build step.
(function () {
  var app = document.getElementById('app');
  var status = null;
  var me = { username: '', role: 'user' };
  var mode = 'app';
  var ui = { accent: 'purple', oled: false };

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
    window.scrollTo(0, 0);
  }

  function longDate(k) {
    var p = k.split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
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
      el('h1', { text: 'Odometer Pace' }),
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
      kids.splice(1, 0, appearanceCard());
      if (mode !== 'proxy') kids.splice(2, 0, usersCard());
      if (mode !== 'proxy') kids.splice(3, 0, passwordCard());
    }
    kids.push(el('p', {}, [first ? iconBtn('logout', 'Log out', logout, 'quiet') : iconBtn('back', 'Back', boot, 'quiet')]));
    show(el('div', { class: 'wrap top' }, kids));
  }

  // A signed-in user who is not the admin: change password and manage their own API keys.
  function renderAccount() {
    var keysBox = el('div');
    var kids = [
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
      ]),
      el('p', {}, [iconBtn('back', 'Back', boot, 'quiet')])
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

  function renderMain() {
    var s = status, L = s.lease;
    var plan = Lease.makePlan({ startDate: L.start_date, years: L.years, totalMiles: L.total_miles, startOdometer: L.start_odometer });

    var hero = el('header', { class: 'hero' }, [el('div', { class: 'hero-inner' }, [
      el('div', { class: 'topbar' }, [
        el('span', { class: 'brand', text: 'Odometer Pace' }),
        el('nav', {}, [
          iconBtn('gear', 'Settings', function () { renderSettings(false); }, 'on-hero'),
          iconBtn('logout', 'Log out', logout, 'on-hero')
        ])
      ]),
      el('h1', { text: fmt(L.total_miles) + ' Miles, Day by Day' }),
      el('ul', { class: 'facts' }, [
        L.vehicle ? el('li', { text: L.vehicle }) : null,
        el('li', { text: longDate(L.start_date) + ' to ' + longDate(L.end_date) }),
        el('li', { text: fmt(L.miles_per_year) + ' miles a year' }),
        el('li', { text: 'Odometer limit ' + fmt(L.odometer_limit) })
      ])
    ])]);

    var wrap = el('div', { class: 'wrap' }, [standCard(s, plan), odometerCard(s, plan), calendar(s, plan)]);
    show(el('div', {}, [hero, wrap]));
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
      fill.style.width = (L.day_of_lease / L.days_total * 100) + '%';
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
      if (same && same.odometer !== next) {
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
    card.appendChild(el('p', { class: 'verdict' + (over ? ' over' : under ? ' under' : '') }, [
      b.miles_over_pace === 0 ? 'Right on pace' : fmt(Math.abs(b.miles_over_pace)) + ' mi ' + (over ? 'over' : 'under') + ' pace',
      ' ', el('small', { text: 'as of ' + longDate(b.date) })
    ]));
    var w = b.warning || s.warning;
    if (w && w.level !== 'none') {
      var names = { watch: 'Watch', warning: 'Warning', urgent: 'Urgent' };
      card.appendChild(el('div', { class: 'alert ' + w.level, role: 'status' }, [
        el('strong', { text: names[w.level] + ': ' }), w.message
      ]));
    }
    if (w && w.stale_note) card.appendChild(el('p', { class: 'note', text: w.stale_note }));
    var stats = el('div', { class: 'stats' }, [
      stat('Your reading', fmt(b.odometer), longDate(b.date)),
      stat('On pace', fmt(b.on_pace_odometer), 'odometer you should be at'),
      stat(over ? 'Over pace' : 'Under pace', (over ? '+' : '') + fmt(b.miles_over_pace), 'miles vs on-pace odometer', over ? 'over' : under ? 'under' : ''),
      stat('Remaining', fmt(b.miles_remaining), 'to the ' + fmt(s.lease.odometer_limit) + ' limit' + (pastLimit ? ' (past it)' : ''), pastLimit ? 'over' : ''),
      stat('Your pace', fmt1(b.miles_per_day_so_far) + '/day', 'since the lease started'),
      b.miles_per_day_to_stay_under === null ? null : stat('To stay under', fmt1(b.miles_per_day_to_stay_under) + '/day', 'for the days that are left'),
      stat('Projected at end', b.projected_end_odometer === null ? 'n/a' : fmt(b.projected_end_odometer),
        b.projected_vs_limit === null ? '' : (projOver ? fmt(b.projected_vs_limit) + ' over' : fmt(-b.projected_vs_limit) + ' under') + ' the limit' + (b.projected_includes_plan ? ', with your planned ' + s.lease.planned_change.miles_per_day + ' mi/day from ' + longDate(s.lease.planned_change.from) : ''), projOver ? 'over' : b.projected_vs_limit === null ? '' : 'under'),
      stat('Miles used', fmt(b.miles_used), 'of ' + fmt(s.lease.total_miles) + ' allowed')
    ]);
    card.appendChild(stats);
    if (b.days_left !== null && s.lease.day_of_lease < 30) {
      card.appendChild(el('p', { class: 'note', text: 'Early in the lease the projection swings a lot. It settles after a few weeks of readings.' }));
    }
    card.appendChild(chart(s, plan));

    var log = el('ul', { class: 'log' });
    s.readings.slice().reverse().forEach(function (r) {
      var who = '';
      if (r.source && r.source.indexOf('web:') === 0) who = ' by ' + r.source.slice(4);
      else if (r.source && r.source.indexOf('api:') === 0) who = ' via ' + r.source.slice(4);
      log.appendChild(el('li', {}, [
        el('span', {}, [longDate(r.date) + ' \u00b7 ' + fmt(r.odometer) + ' mi', el('span', { class: 'src', text: who })]),
        me.role === 'admin' ? iconBtn('trash', 'Delete reading from ' + longDate(r.date), function () {
          api('DELETE', '/api/readings/' + r.date).then(refresh);
        }, 'danger') : null
      ]));
    });
    card.appendChild(log);
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
        stroke: '#fbbf24', 'stroke-width': 2.5, 'stroke-dasharray': '6 5'
      }));
    }

    var legend = el('div', { class: 'legend' }, [
      el('span', {}, [el('i', { class: 'allowed' }), 'Allowed']),
      el('span', {}, [el('i', { class: 'readings' }), 'Your readings']),
      el('span', {}, [el('i', { class: 'projected' }), 'Projected'])
    ]);
    var box = el('div', { class: 'chart' });
    box.appendChild(svg);
    box.appendChild(legend);
    return box;
  }

  // ---------- calendar ----------

  function calendar(s, plan) {
    var todayIdx = Lease.dayIndex(plan, s.today);
    var readingDates = {};
    s.readings.forEach(function (r) { readingDates[r.date] = true; });
    var box = el('div', {});
    var todayCell = null;

    box.appendChild(el('div', { class: 'cal-head' }, [
      el('h2', { text: 'Every day of the lease' }),
      iconBtn('today', 'Jump to today', function () {
        if (todayCell) todayCell.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 'quiet')
    ]));
    box.appendChild(el('p', { class: 'note', text: 'Each box shows the day and the total miles you may have driven by the end of that day. Crossed-off days are behind you. An amber dot marks a day with a reading.' }));

    var dayNo = 0;
    for (var y = 0; y < plan.years; y++) {
      var yStart = Lease.dayNum(plan.yearStarts[y]);
      var yEnd = yStart + plan.yearLens[y] - 1;
      box.appendChild(el('h3', { class: 'year-title', text: 'Lease year ' + (y + 1) + ' \u00b7 ' + fmt(Math.round(plan.perYear)) + ' miles' }));
      var months = el('div', { class: 'months' });

      var first = new Date(Lease.fromDayNum(yStart) + 'T00:00:00Z');
      var cy = first.getUTCFullYear(), cm = first.getUTCMonth();
      var endD = new Date(Lease.fromDayNum(yEnd) + 'T00:00:00Z');
      while (cy < endD.getUTCFullYear() || (cy === endD.getUTCFullYear() && cm <= endD.getUTCMonth())) {
        months.appendChild(monthBlock(cy, cm));
        cm++;
        if (cm > 11) { cm = 0; cy++; }
      }
      box.appendChild(months);
      dayNo += plan.yearLens[y];
    }

    function monthBlock(yy, mm) {
      var title = new Date(Date.UTC(yy, mm, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
      var grid = el('div', { class: 'grid' });
      ['S', 'M', 'T', 'W', 'T', 'F', 'S'].forEach(function (d) { grid.appendChild(el('div', { class: 'dow', text: d })); });
      var firstDow = new Date(Date.UTC(yy, mm, 1)).getUTCDay();
      for (var b = 0; b < firstDow; b++) grid.appendChild(el('div', { class: 'day blank' }));
      var dim = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
      for (var d = 1; d <= dim; d++) {
        var key = yy + '-' + ('0' + (mm + 1)).slice(-2) + '-' + ('0' + d).slice(-2);
        var n = Lease.dayNum(key);
        if (n < yStart || n > yEnd) { grid.appendChild(el('div', { class: 'day blank' })); continue; }
        var idx = n - Lease.dayNum(plan.startDate);
        var cls = 'day';
        if (idx < todayIdx) cls += ' past';
        if (idx === todayIdx) cls += ' today';
        if (readingDates[key]) cls += ' reading';
        var cell = el('div', { class: cls, title: longDate(key) + ': ' + fmt(Lease.allowedThrough(plan, idx)) + ' miles allowed so far' }, [
          el('span', { class: 'n', text: String(d) }),
          el('span', { class: 'm', text: fmt(Lease.allowedThrough(plan, idx)) })
        ]);
        if (idx === todayIdx) todayCell = cell;
        grid.appendChild(cell);
      }
      return el('div', { class: 'month' }, [el('h3', { text: title }), grid]);
    }
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
