// Lease Miles front end. Plain JavaScript, no build step.
(function () {
  var app = document.getElementById('app');
  var status = null;

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

  function renderPassword(first) {
    var pw = el('input', { type: 'password', autocomplete: first ? 'new-password' : 'current-password', 'aria-label': 'Password', placeholder: 'Password' });
    var err = el('p', { class: 'err', role: 'status' });
    function submit(e) {
      e.preventDefault();
      err.textContent = '';
      api('POST', first ? '/api/setup-password' : '/api/login', { password: pw.value })
        .then(boot)
        .catch(function (x) { err.textContent = x.message; });
    }
    show(el('div', { class: 'center' }, [el('div', { class: 'card' }, [
      el('h1', { text: 'Lease Miles' }),
      el('p', { class: 'sub', text: first ? 'First run. Choose a password (8 or more characters).' : 'Log in to see your mileage.' }),
      el('form', { onsubmit: submit }, [
        el('label', { class: 'field' }, [pw]),
        el('div', { class: 'spacer' }),
        el('button', { class: 'btn', type: 'submit', text: first ? 'Save password' : 'Log in' }),
        err
      ])
    ])]));
    pw.focus();
  }

  // ---------- settings ----------

  function renderSettings(first) {
    var vehicle = el('input', { type: 'text', maxlength: '60', placeholder: 'Optional, e.g. My lease' });
    var start = el('input', { type: 'date' });
    var years = el('input', { type: 'number', inputmode: 'numeric', min: '1', max: '10', value: '3' });
    var total = el('input', { type: 'number', inputmode: 'numeric', min: '1', placeholder: 'e.g. 36000' });
    var odo = el('input', { type: 'number', inputmode: 'numeric', min: '0', placeholder: 'Miles on the odometer at delivery' });
    var err = el('p', { class: 'err', role: 'status' });
    var keysBox = el('div');

    api('GET', '/api/settings').then(function (r) {
      var s = r.settings;
      if (!s) return;
      vehicle.value = s.vehicle || ''; start.value = s.startDate; years.value = s.years;
      total.value = s.totalMiles; odo.value = s.startOdometer;
    });

    function save(e) {
      e.preventDefault();
      err.textContent = '';
      err.className = 'err';
      api('PUT', '/api/settings', {
        vehicle: vehicle.value, startDate: start.value, years: years.value, totalMiles: total.value, startOdometer: odo.value
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
    kids.push(el('p', {}, [el('button', { class: 'btn quiet', type: 'button', text: first ? 'Log out' : 'Back', onclick: first ? logout : boot })]));
    show(el('div', { class: 'wrap top' }, kids));
  }

  function loadKeys(box, shownKey) {
    api('GET', '/api/tokens').then(function (r) {
      box.textContent = '';
      r.tokens.forEach(function (t) {
        box.appendChild(el('div', { class: 'token-row' }, [
          el('span', { text: t.name + (t.last_used ? ' (last used ' + t.last_used.slice(0, 10) + ')' : ' (never used)') }),
          el('button', { class: 'btn danger', type: 'button', text: 'Revoke', onclick: function () {
            if (confirm('Revoke "' + t.name + '"? Anything using it stops working.')) api('DELETE', '/api/tokens/' + t.id).then(function () { loadKeys(box); });
          } })
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
        el('span', { class: 'brand', text: 'Lease Miles' }),
        el('nav', {}, [
          el('button', { class: 'link-btn', type: 'button', text: 'Settings', onclick: function () { renderSettings(false); } }),
          el('button', { class: 'link-btn', type: 'button', text: 'Log out', onclick: logout })
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

    function save(e) {
      e.preventDefault();
      err.textContent = '';
      api('POST', '/api/readings', { odometer: odo.value, date: date.value })
        .then(function (st) { status = st; renderMain(); })
        .catch(function (x) { err.textContent = x.message; });
    }

    var card = el('div', { class: 'card' }, [
      el('h2', { text: 'Your odometer' }),
      el('p', { class: 'sub', text: 'Enter a reading whenever you like. It is saved on the server, so your phone and computer match.' }),
      el('form', { class: 'form-row', onsubmit: save }, [
        el('label', { class: 'field' }, ['Odometer', odo]),
        el('label', { class: 'field' }, ['Date', date]),
        el('button', { class: 'btn', type: 'submit', text: 'Save reading' })
      ]),
      err
    ]);

    var b = s.latest;
    if (!b) {
      card.appendChild(el('p', { class: 'note', text: 'No readings yet. Add one to see how you compare with the on-pace odometer.' }));
      return card;
    }
    var over = b.miles_over_pace > 0;
    var pastLimit = b.miles_remaining < 0;
    var projOver = b.projected_vs_limit > 0;
    card.appendChild(el('p', { class: 'verdict' + (over ? ' over' : '') }, [
      b.miles_over_pace === 0 ? 'Right on pace' : fmt(Math.abs(b.miles_over_pace)) + ' mi ' + (over ? 'over' : 'under') + ' pace',
      ' ', el('small', { text: 'as of ' + longDate(b.date) })
    ]));
    var stats = el('div', { class: 'stats' }, [
      stat('Your reading', fmt(b.odometer), longDate(b.date)),
      stat('On pace', fmt(b.on_pace_odometer), 'odometer you should be at'),
      stat(over ? 'Over pace' : 'Under pace', (over ? '+' : '') + fmt(b.miles_over_pace), 'miles vs on-pace odometer', over ? 'over' : ''),
      stat('Remaining', fmt(b.miles_remaining), 'to the ' + fmt(s.lease.odometer_limit) + ' limit' + (pastLimit ? ' (past it)' : ''), pastLimit ? 'over' : ''),
      stat('Your pace', fmt1(b.miles_per_day_so_far) + '/day', 'since the lease started'),
      b.miles_per_day_to_stay_under === null ? null : stat('To stay under', fmt1(b.miles_per_day_to_stay_under) + '/day', 'for the days that are left'),
      stat('Projected at end', b.projected_end_odometer === null ? 'n/a' : fmt(b.projected_end_odometer),
        b.projected_vs_limit === null ? '' : (projOver ? fmt(b.projected_vs_limit) + ' over' : fmt(-b.projected_vs_limit) + ' under') + ' the limit', projOver ? 'over' : ''),
      stat('Miles used', fmt(b.miles_used), 'of ' + fmt(s.lease.total_miles) + ' allowed')
    ]);
    card.appendChild(stats);
    if (b.days_left !== null && s.lease.day_of_lease < 30) {
      card.appendChild(el('p', { class: 'note', text: 'Early in the lease the projection swings a lot. It settles after a few weeks of readings.' }));
    }
    card.appendChild(chart(s, plan));

    var log = el('ul', { class: 'log' });
    s.readings.slice().reverse().forEach(function (r) {
      var who = r.source && r.source !== 'web' ? ' via ' + r.source.replace('api:', '') : '';
      log.appendChild(el('li', {}, [
        el('span', {}, [longDate(r.date) + ' \u00b7 ' + fmt(r.odometer) + ' mi', el('span', { class: 'src', text: who })]),
        el('button', { type: 'button', text: 'Delete', 'aria-label': 'Delete reading from ' + longDate(r.date), onclick: function () {
          api('DELETE', '/api/readings/' + r.date).then(function (st) { status = st; renderMain(); });
        } })
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
      svg.appendChild(node('line', { x1: padL, x2: W - padR, y1: y(o), y2: y(o), stroke: '#3a3150' }));
      var t = node('text', { x: padL - 6, y: y(o) + 4, 'text-anchor': 'end', 'font-size': 11, fill: '#a79fb8' });
      t.textContent = fmt(Math.round(o));
      svg.appendChild(t);
    });
    for (var yr = 0; yr <= plan.years; yr++) {
      var d = yr === 0 ? 0 : plan.yearLens.slice(0, yr).reduce(function (a, b) { return a + b; }, 0);
      var tl = node('text', { x: x(d), y: H - 8, 'text-anchor': yr === 0 ? 'start' : yr === plan.years ? 'end' : 'middle', 'font-size': 11, fill: '#a79fb8' });
      tl.textContent = yr === 0 ? 'Start' : yr === plan.years ? 'End' : 'Year ' + yr;
      svg.appendChild(tl);
    }

    var pts = [];
    for (var i = -1; i < plan.dayCount; i += 15) pts.push(x(i + 1) + ',' + y(plan.startOdometer + Lease.allowedThrough(plan, i)));
    pts.push(x(plan.dayCount) + ',' + y(plan.limit));
    svg.appendChild(node('polyline', { points: pts.join(' '), fill: 'none', stroke: '#7c6aa8', 'stroke-width': 3 }));

    var rp = [x(0) + ',' + y(plan.startOdometer)];
    s.readings.forEach(function (r) { rp.push(x(Lease.dayIndex(plan, r.date) + 1) + ',' + y(r.odometer)); });
    svg.appendChild(node('polyline', { points: rp.join(' '), fill: 'none', stroke: '#a78bfa', 'stroke-width': 3, 'stroke-linejoin': 'round' }));
    s.readings.forEach(function (r) {
      svg.appendChild(node('circle', { cx: x(Lease.dayIndex(plan, r.date) + 1), cy: y(r.odometer), r: 4, fill: '#c4b5fd' }));
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
      el('button', { class: 'btn quiet', type: 'button', text: 'Jump to today', onclick: function () {
        if (todayCell) todayCell.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } })
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
      if (!sess.passwordSet) return renderPassword(true);
      if (!sess.loggedIn) return renderPassword(false);
      return api('GET', '/api/status').then(function (st) {
        status = st;
        if (!st.configured) renderSettings(true);
        else renderMain();
      });
    }).catch(function (e) {
      if (e.status === 401) return renderPassword(false);
      show(el('div', { class: 'center' }, [el('div', { class: 'card' }, [el('p', { text: 'Could not reach the server: ' + e.message })])]));
    });
  }

  boot();
})();
