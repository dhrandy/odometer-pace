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
