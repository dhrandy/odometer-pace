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
      limit: startOdo + total
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
    return {
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
      projected: allowed > 0 ? Math.round(plan.startOdometer + used / allowed * plan.totalMiles) : null
    };
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
    evaluate: evaluate, checkReading: checkReading
  };
});
