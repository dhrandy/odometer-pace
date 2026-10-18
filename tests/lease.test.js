const test = require('node:test');
const assert = require('node:assert');
const Lease = require('../lib/lease.js');

// Invented sample lease, not real household data.
const plan = Lease.makePlan({ startDate: '2030-03-01', years: 3, totalMiles: 36000, startOdometer: 10 });

test('plan spans three years and ends the day before the anniversary', () => {
  assert.strictEqual(plan.endDate, '2033-02-28');
  assert.strictEqual(plan.dayCount, 1096);
  assert.strictEqual(plan.limit, 36010);
});

test('allowance reaches exactly the total on the last day', () => {
  assert.strictEqual(Lease.allowedThrough(plan, plan.dayCount - 1), 36000);
  assert.strictEqual(Lease.allowedThrough(plan, plan.yearLens[0] - 1), 12000);
});

test('allowance never goes down day to day', () => {
  let prev = 0;
  for (let i = 0; i < plan.dayCount; i++) {
    const a = Lease.allowedThrough(plan, i);
    assert.ok(a >= prev);
    prev = a;
  }
});

test('evaluate reports over and under pace', () => {
  const under = Lease.evaluate(plan, [{ date: '2030-03-10', odometer: 100 }]);
  assert.ok(under.diff < 0);
  const over = Lease.evaluate(plan, [{ date: '2030-03-10', odometer: 5000 }]);
  assert.ok(over.diff > 0 && over.projected > plan.limit);
});

test('evaluate returns null with no readings', () => {
  assert.strictEqual(Lease.evaluate(plan, []), null);
});

test('checkReading rejects bad dates and a falling odometer', () => {
  const rs = [{ date: '2030-04-01', odometer: 800 }];
  assert.ok(Lease.checkReading(plan, rs, '2030-02-01', 5));
  assert.ok(Lease.checkReading(plan, rs, '2030-04-05', 700));
  assert.ok(Lease.checkReading(plan, rs, '2030-03-20', 900));
  assert.ok(Lease.checkReading(plan, rs, '2030-02-30', 900));
  assert.strictEqual(Lease.checkReading(plan, rs, '2030-04-05', 900), '');
});

test('leap-day start falls back in non-leap years', () => {
  assert.strictEqual(Lease.addYears('2028-02-29', 1), '2029-02-28');
});

test('invalid settings give no plan', () => {
  assert.strictEqual(Lease.makePlan({ startDate: 'nope', years: 3, totalMiles: 1, startOdometer: 0 }), null);
  assert.strictEqual(Lease.makePlan({ startDate: '2030-01-01', years: 0, totalMiles: 1, startOdometer: 0 }), null);
});

test('warning levels follow the latest reading and the projection', () => {
  const plan = Lease.makePlan({ startDate: '2030-01-01', years: 3, totalMiles: 36000, startOdometer: 0 });
  const w = (odo, today) => Lease.warning(plan, Lease.evaluate(plan, [{ date: '2030-07-01', odometer: odo }]), today || '2030-07-03');
  assert.strictEqual(w(5000).level, 'none');
  assert.strictEqual(w(5000).message, '');
  assert.strictEqual(w(6000).level, 'warning');
  assert.match(w(6000).message, /finish about [\d,]+ mi over the limit/);
  assert.strictEqual(w(10000).level, 'urgent');
  assert.strictEqual(w(40000).level, 'urgent');
  assert.match(w(40000).message, /past the/);
  assert.strictEqual(Lease.warning(plan, null, '2030-07-03').level, 'none');
});

test('a reading from a week ago still gives a warning, and old readings add a quiet note', () => {
  const plan = Lease.makePlan({ startDate: '2030-01-01', years: 3, totalMiles: 36000, startOdometer: 0 });
  const ev = Lease.evaluate(plan, [{ date: '2030-07-01', odometer: 7000 }]);
  const week = Lease.warning(plan, ev, '2030-07-08');
  assert.strictEqual(week.level, 'urgent');
  assert.strictEqual(week.stale_note, '');
  assert.strictEqual(week.days_since_reading, 7);
  const old = Lease.warning(plan, ev, '2030-07-15');
  assert.match(old.stale_note, /14 days ago/);
});

test('a planned change lowers the projection after its date and leaves it alone before', () => {
  const base = { startDate: '2030-01-01', years: 3, totalMiles: 36000, startOdometer: 0 };
  const plain = Lease.makePlan(base);
  const readings = [{ date: '2030-07-01', odometer: 7000 }];
  const noPlan = Lease.evaluate(plain, readings);
  assert.strictEqual(noPlan.usesPlan, false);
  // The same pace until a date past the end of the lease changes nothing important.
  const later = Lease.evaluate(Lease.makePlan(Object.assign({ planFrom: '2032-12-31', planPerDay: 5 }, base)), readings);
  assert.ok(Math.abs(later.projected - noPlan.projected) < 60);
  // A planned drop to 20 a day from Sept 1 ends well under the no-plan projection.
  const plan = Lease.makePlan(Object.assign({ planFrom: '2030-09-01', planPerDay: 20 }, base));
  const withPlan = Lease.evaluate(plan, readings);
  assert.strictEqual(withPlan.usesPlan, true);
  assert.ok(withPlan.projected < noPlan.projected - 5000);
  // A plan that already started applies for all the days left.
  const started = Lease.evaluate(Lease.makePlan(Object.assign({ planFrom: '2030-06-01', planPerDay: 20 }, base)), readings);
  assert.strictEqual(started.projected, Math.round(7000 + 20 * started.daysLeft));
  const note = Lease.warning(plan, withPlan, '2030-07-03');
  assert.strictEqual(note.level, 'watch');
  assert.match(note.message, /planned 20 mi\/day from 2030-09-01/);
  // An empty or invalid plan is ignored.
  assert.strictEqual(Lease.makePlan(Object.assign({ planFrom: '', planPerDay: '' }, base)).change, null);
});
