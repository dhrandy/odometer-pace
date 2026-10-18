// Lease math. Runs in Node (server, tests) and in the browser (served as /lease.js).
// All dates are 'YYYY-MM-DD' strings. Day numbers use UTC so time zones and DST never shift a day.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Lease = factory();
})(this, function () {
  var KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

  function isDateKey(k) {
    var m = KEY.exec(String(k));
    if (!m) return false;
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
  }

  function dayNum(k) {
    var m = KEY.exec(k);
    return Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000;
  }

  function fromDayNum(n) {
    var d = new Date(n * 86400000);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  // Same month and day, n years later. Feb 29 falls back to Feb 28 in non-leap years.
  function addYears(k, n) {
    var m = KEY.exec(k);
    var y = +m[1] + n, mo = +m[2], d = +m[3];
    var last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    return y + '-' + pad(mo) + '-' + pad(Math.min(d, last));
  }

  // Turns the saved settings into a plan, or returns null when settings are missing or invalid.
  function makePlan(s) {
    if (!s || !isDateKey(s.startDate)) return null;
    var years = Math.round(Number(s.years));
    var total = Math.round(Number(s.totalMiles));
    var startOdo = Math.round(Number(s.startOdometer));
    if (!(years >= 1 && years <= 10) || !(total > 0) || !(startOdo >= 0)) return null;

    // Optional: from this date on, expect this many miles a day. Empty by default.
    var change = null;
    if (s.planFrom && isDateKey(s.planFrom) && String(s.planPerDay).trim() !== '' && Number(s.planPerDay) >= 0 && Number(s.planPerDay) <= 1000) {
      change = { from: s.planFrom, perDay: Number(s.planPerDay) };
    }

    var yearLens = [], yearStarts = [];
    for (var y = 0; y < years; y++) {
      var a = addYears(s.startDate, y), b = addYears(s.startDate, y + 1);
      yearStarts.push(a);
      yearLens.push(dayNum(b) - dayNum(a));
    }
    var dayCount = yearLens.reduce(function (t, n) { return t + n; }, 0);
    return {
      startDate: s.startDate,
      years: years,
      totalMiles: total,
      startOdometer: startOdo,
      perYear: total / years,
      yearLens: yearLens,
      yearStarts: yearStarts,
      dayCount: dayCount,
      endDate: fromDayNum(dayNum(s.startDate) + dayCount - 1),
      limit: startOdo + total,
      change: change
    };
  }

  // Miles allowed through the end of day number idx (0 = first day of the lease).
  // Each lease year's share is spread evenly over that year's own days.
  function allowedThrough(plan, idx) {
    if (idx < 0) return 0;
    if (idx >= plan.dayCount) return plan.totalMiles;
    var i = idx;
    for (var y = 0; y < plan.years; y++) {
      if (i < plan.yearLens[y]) {
        return Math.round(y * plan.perYear) + Math.round((i + 1) * plan.perYear / plan.yearLens[y]);
      }
      i -= plan.yearLens[y];
    }
    return plan.totalMiles;
  }

  function dayIndex(plan, key) { return dayNum(key) - dayNum(plan.startDate); }

  // How the newest reading compares with the plan.
  function evaluate(plan, readings) {
    if (!readings.length) return null;
    var last = readings[readings.length - 1];
    var idx = dayIndex(plan, last.date);
    if (idx < 0) return null;
    var di = Math.min(idx, plan.dayCount - 1);
    var allowed = allowedThrough(plan, di);
    var paceOdo = plan.startOdometer + allowed;
    var used = last.odometer - plan.startOdometer;
    var daysIn = di + 1;
    var daysLeft = plan.dayCount - daysIn;
    var remaining = plan.limit - last.odometer;
    var projected = allowed > 0 ? Math.round(plan.startOdometer + used / allowed * plan.totalMiles) : null;
    // With a planned change, keep today's pace until that date and use the planned pace after it.
    var usesPlan = false;
    if (plan.change && daysLeft > 0 && used > 0) {
      var before = Math.max(0, Math.min(daysLeft, dayNum(plan.change.from) - dayNum(last.date)));
      projected = Math.round(last.odometer + (used / daysIn) * before + plan.change.perDay * (daysLeft - before));
      usesPlan = true;
    }
    return {
      usesPlan: usesPlan,
      date: last.date,
      odometer: last.odometer,
      paceOdometer: paceOdo,
      diff: last.odometer - paceOdo,
      milesUsed: used,
      milesAllowedSoFar: allowed,
      daysIn: daysIn,
      daysLeft: daysLeft,
      perDay: used / daysIn,
      remaining: remaining,
      neededPerDay: daysLeft > 0 ? remaining / daysLeft : null,
      projected: projected
    };
  }

  // Turns the newest reading and the projection into a plain warning.
  // It looks at where you stand now, not at how many readings came in, so weekly readings work fine.
  //   none: on or under pace.   watch: over pace, but the projection still ends under the limit.
  //   warning: projected to end over the limit.   urgent: projected overage above 10% of the lease,
  //   already past the limit, or the miles per day left to stay under are under half the normal rate.
  function warning(plan, ev, todayKey) {
    var out = { level: 'none', message: '', stale_note: '', days_since_reading: null };
    if (!ev) return out;
    var since = Math.round(dayNum(todayKey) - dayNum(ev.date));
    if (since >= 0) out.days_since_reading = since;
    var idx = dayIndex(plan, todayKey);
    if (since > 10 && idx >= 0 && idx < plan.dayCount) {
      out.stale_note = 'The last reading was ' + since + ' days ago. A fresh one keeps this accurate.';
    }
    var fmt = function (n) { return Math.round(n).toLocaleString('en-US'); };
    var normal = plan.totalMiles / plan.dayCount;
    var projOver = ev.projected === null ? null : ev.projected - plan.limit;
    if (ev.remaining < 0) {
      out.level = 'urgent';
      out.message = 'You are ' + fmt(-ev.remaining) + ' mi past the ' + fmt(plan.limit) + ' odometer limit.';
      return out;
    }
    if (projOver !== null && projOver > 0) {
      var tail = ev.neededPerDay === null ? '' : ' To get back on track, keep it to about ' + (Math.round(ev.neededPerDay * 10) / 10) + ' mi/day for the rest of the lease (you have averaged ' + (Math.round(ev.perDay * 10) / 10) + ').';
      var urgent = projOver > plan.totalMiles * 0.1 || (ev.neededPerDay !== null && ev.neededPerDay < normal * 0.5);
      out.level = urgent ? 'urgent' : 'warning';
      out.message = 'At this pace you finish about ' + fmt(projOver) + ' mi over the limit' + (ev.usesPlan ? ', including your planned ' + plan.change.perDay + ' mi/day from ' + plan.change.from : '') + '.' + tail;
      return out;
    }
    if (ev.diff > 0) {
      out.level = 'watch';
      out.message = 'You are ' + fmt(ev.diff) + ' mi over pace. ' + (ev.usesPlan ? 'With your planned ' + plan.change.perDay + ' mi/day from ' + plan.change.from : 'At your average pace') + ' you would still finish under the limit, but keep an eye on it.';
    }
    return out;
  }


  // Fee for miles past the limit. rate is dollars per mile; returns null when no rate is set.
  function fee(overMiles, rate) {
    if (!(Number(rate) > 0)) return null;
    return Math.round(Math.max(0, overMiles) * Number(rate) * 100) / 100;
  }

  // "What if I drive an extra trip?" The trip is added on top of the miles already projected.
  function whatIf(plan, ev, tripMiles, rate) {
    if (!ev || !isFinite(tripMiles) || tripMiles < 0) return null;
    var projected = ev.projected === null ? null : ev.projected + tripMiles;
    var vsLimit = projected === null ? null : projected - plan.limit;
    var remaining = ev.remaining - tripMiles;
    return {
      trip_miles: tripMiles,
      projected_end_odometer: projected,
      projected_vs_limit: vsLimit,
      projected_fee: vsLimit === null ? null : fee(vsLimit, rate),
      miles_remaining: remaining,
      miles_per_day_to_stay_under: ev.daysLeft > 0 && remaining > 0 ? remaining / ev.daysLeft : null,
      fee_added: ev.projected === null ? null : fee(vsLimit, rate) === null ? null : Math.round((fee(vsLimit, rate) - fee(ev.projected - plan.limit, rate)) * 100) / 100
    };
  }

  // Miles you can drive from the newest reading and still be on pace: through the end of today
  // and through the end of the day six days later (a week that starts today).
  function glance(plan, ev, todayKey, w) {
    var idx = dayIndex(plan, todayKey);
    var out = { state: idx < 0 ? 'not_started' : idx >= plan.dayCount ? 'complete' : 'active' };
    if (out.state !== 'active') return out;
    if (!ev) { out.status = 'no_reading'; return out; }
    var through = function (d) { return plan.startOdometer + allowedThrough(plan, Math.min(idx + d, plan.dayCount - 1)); };
    var diff = ev.odometer - (plan.startOdometer + allowedThrough(plan, idx));
    out.status = diff > 0 ? 'over' : 'on_track';
    out.level = w ? w.level : 'none';
    out.reading_date = ev.date;
    out.days_since_reading = w ? w.days_since_reading : null;
    out.miles_over_pace = diff;
    out.can_drive_today = Math.max(0, through(0) - ev.odometer);
    out.can_drive_week = Math.max(0, through(6) - ev.odometer);
    out.miles_remaining = ev.remaining;
    out.average_per_day = Math.round(plan.totalMiles / plan.dayCount * 10) / 10;
    return out;
  }

  // Checks a new reading against the others: no dates before the lease, and the odometer never goes backwards.
  // Returns an error message, or '' when the reading is fine.
  function checkReading(plan, readings, date, odometer) {
    if (!isDateKey(date)) return 'Date must look like 2030-04-05.';
    if (!isFinite(odometer) || odometer < 0 || Math.round(odometer) !== odometer) return 'Odometer must be a whole number.';
    if (odometer > 999999) return 'That odometer reading looks too high.';
    if (dayIndex(plan, date) < 0) return 'That date is before the lease starts.';
    for (var i = 0; i < readings.length; i++) {
      var r = readings[i];
      if (r.date < date && odometer < r.odometer) return 'The reading on ' + r.date + ' was ' + r.odometer + ', and the odometer cannot go down.';
      if (r.date > date && odometer > r.odometer) return 'The reading on ' + r.date + ' was ' + r.odometer + ', which is lower than this one.';
    }
    return '';
  }

  return {
    isDateKey: isDateKey, dayNum: dayNum, fromDayNum: fromDayNum, addYears: addYears,
    makePlan: makePlan, allowedThrough: allowedThrough, dayIndex: dayIndex,
    evaluate: evaluate, warning: warning, fee: fee, whatIf: whatIf, glance: glance, checkReading: checkReading
  };
});
