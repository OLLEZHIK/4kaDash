'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { computeNextRun } = require('../src/scheduler');
const { startSeeded, idOf } = require('./helpers');

const local = (y, mo, d, hh = 0, mm = 0) => new Date(y, mo - 1, d, hh, mm);

test('computeNextRun handles daily, weekdays, weekly and monthly', () => {
  // Wednesday 14 Oct 2026, 10:00 local
  const now = local(2026, 10, 14, 10, 0);
  assert.deepEqual(computeNextRun({ frequency: 'daily', time_of_day: '09:00' }, now), local(2026, 10, 15, 9, 0));
  assert.deepEqual(computeNextRun({ frequency: 'daily', time_of_day: '11:30' }, now), local(2026, 10, 14, 11, 30));
  // Friday evening → Monday
  assert.deepEqual(computeNextRun({ frequency: 'weekdays', time_of_day: '09:00' }, local(2026, 10, 16, 18)), local(2026, 10, 19, 9, 0));
  assert.deepEqual(computeNextRun({ frequency: 'weekly', weekday: 1, time_of_day: '08:00' }, now), local(2026, 10, 19, 8, 0));
  assert.deepEqual(computeNextRun({ frequency: 'weekly', weekday: 3, time_of_day: '08:00' }, now), local(2026, 10, 21, 8, 0));
  assert.deepEqual(computeNextRun({ frequency: 'monthly', day_of_month: 3, time_of_day: '07:00' }, now), local(2026, 11, 3, 7, 0));
  assert.deepEqual(computeNextRun({ frequency: 'monthly', day_of_month: 20, time_of_day: '07:00' }, now), local(2026, 10, 20, 7, 0));
  // Year rollover
  assert.deepEqual(computeNextRun({ frequency: 'monthly', day_of_month: 1, time_of_day: '07:00' }, local(2026, 12, 5)), local(2027, 1, 1, 7, 0));
});

let env;
before(async () => (env = await startSeeded()));
after(() => env.app.close());

test('schedules deliver links (not data) to recipient groups when due', async () => {
  const tom = await env.client('tom@example.com');
  const id = idOf(env.db, 'Sales Performance – Daily');
  assert.equal((await tom.post('/api/recipient-groups', { name: 'Bad', members: 'not-an-email' })).status, 400);
  const g = await tom.post('/api/recipient-groups', { name: 'Sales leads', members: 'a@example.com, b@example.com\nA@example.com' });
  assert.equal(g.status, 201);
  assert.equal((await tom.post('/api/schedules', { dashboardId: id, recipientGroupId: g.data.id, frequency: 'daily', timeOfDay: '25:00' })).status, 400);
  assert.equal((await tom.post('/api/schedules', { dashboardId: id, recipientGroupId: g.data.id, frequency: 'weekly', timeOfDay: '09:00' })).status, 400);
  const s = await tom.post('/api/schedules', { dashboardId: id, recipientGroupId: g.data.id, frequency: 'daily', timeOfDay: '09:00', note: 'Stand-up' });
  assert.equal(s.status, 201);

  const before = env.db.prepare('SELECT COUNT(*) n FROM outbox').get().n;
  env.app.tick(new Date(Date.parse(s.data.nextRunAt) + 1000));
  const msgs = env.db.prepare('SELECT * FROM outbox WHERE id > ? ORDER BY id').all(before);
  const mine = msgs.filter((m) => m.subject.includes('Sales Performance'));
  assert.deepEqual(mine.map((m) => m.recipient).sort(), ['a@example.com', 'b@example.com']);
  assert.match(mine[0].body, new RegExp(`http://dash.test/#/dashboards/${id}`));
  assert.match(mine[0].body, /open data quality flag/); // stale report warning travels with the link
  // The simulated clock jump expires sessions, so sign in again.
  const tomAgain = await env.client('tom@example.com');
  const sched = (await tomAgain.get('/api/schedules')).data.find((x) => x.id === s.data.id);
  assert.equal(sched.last_status, 'sent');
  assert.ok(Date.parse(sched.next_run_at) > Date.parse(s.data.nextRunAt));
});

test('schedules are private and respect report permissions', async () => {
  const tom = await env.client('tom@example.com');
  const sam = await env.client('sam@example.com');
  const g = await tom.post('/api/recipient-groups', { name: 'Me', members: ['tom@example.com'] });
  const restricted = idOf(env.db, 'Revenue & Margin Bridge');
  assert.equal((await tom.post('/api/schedules', { dashboardId: restricted, recipientGroupId: g.data.id, frequency: 'daily', timeOfDay: '09:00' })).status, 404);
  const samGroup = (await sam.get('/api/recipient-groups')).data[0];
  const id = idOf(env.db, 'Monthly Churn Overview');
  assert.equal((await tom.post('/api/schedules', { dashboardId: id, recipientGroupId: samGroup.id, frequency: 'daily', timeOfDay: '09:00' })).status, 404);
  const samSchedule = (await sam.get('/api/schedules')).data[0];
  assert.equal((await tom.post(`/api/schedules/${samSchedule.id}/run`)).status, 404);
  const run = await sam.post(`/api/schedules/${samSchedule.id}/run`);
  assert.equal(run.data.status, 'sent');
});
