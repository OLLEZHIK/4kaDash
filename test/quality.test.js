'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startSeeded, idOf } = require('./helpers');

let env;
before(async () => (env = await startSeeded()));
after(() => env.app.close());

const metricId = () => env.db.prepare("SELECT id FROM metrics WHERE name = 'Active customers'").get().id;

test('seeded September value is flagged by change, source and duplicate rules', async () => {
  const maria = await env.client('maria@example.com');
  const issues = (await maria.get('/api/issues?mine=1')).data.filter((i) => i.period === '2026-09');
  assert.deepEqual(issues.map((i) => i.rule_type).sort(), ['duplicates', 'pct_change', 'source_mismatch']);
  const pct = issues.find((i) => i.rule_type === 'pct_change');
  assert.equal(pct.expected, 1242500); // last validated value
  assert.equal(pct.actual, 1311700);
  assert.equal(pct.status, 'warning');
  assert.match(pct.message, /threshold is ±3%/);
});

test('re-submitting a corrected value supersedes automatic warnings', async () => {
  const maria = await env.client('maria@example.com');
  const r = await maria.post(`/api/metrics/${metricId()}/values`, {
    period: '2026-09', value: 1245900, sourceValue: 1245900, rowCount: 1245900, distinctCount: 1245900,
  });
  assert.equal(r.status, 201);
  assert.deepEqual(r.data.issues, []);
  const open = (await maria.get('/api/issues?mine=1')).data.filter((i) => i.period === '2026-09');
  assert.equal(open.length, 0);
});

test('validated history is the baseline and cannot be silently overwritten', async () => {
  const maria = await env.client('maria@example.com');
  const tom = await env.client('tom@example.com');
  const mid = metricId();
  assert.equal((await tom.post(`/api/metrics/${mid}/values/2026-09/validate`)).status, 403);
  assert.equal((await maria.post(`/api/metrics/${mid}/values/2026-09/validate`)).status, 200);
  const over = await maria.post(`/api/metrics/${mid}/values`, { period: '2026-09', value: 1 });
  assert.equal(over.status, 400);
  // October compares against the newly validated September.
  const oct = await maria.post(`/api/metrics/${mid}/values`, { period: '2026-10', value: 1100000 });
  const pct = oct.data.issues.find((i) => i.rule_type === 'pct_change');
  assert.ok(pct);
  assert.match(pct.message, /1,245,900 for 2026-09/);
});

test('issue workflow: warning → investigating → dismissed requires a recorded reason', async () => {
  const maria = await env.client('maria@example.com');
  const tom = await env.client('tom@example.com');
  const issue = (await maria.get('/api/issues?mine=1')).data.find((i) => i.period === '2026-10' && i.rule_type === 'pct_change');
  assert.equal((await tom.patch(`/api/issues/${issue.id}`, { status: 'investigating' })).status, 403);
  assert.equal((await maria.patch(`/api/issues/${issue.id}`, { status: 'investigating' })).status, 200);
  assert.equal((await maria.patch(`/api/issues/${issue.id}`, { status: 'dismissed' })).status, 400);
  const done = await maria.patch(`/api/issues/${issue.id}`, { status: 'dismissed', resolution: 'Prepaid base clean-up in October (expected).' });
  assert.equal(done.status, 200);
  const all = (await maria.get('/api/issues?status=dismissed')).data.find((i) => i.id === issue.id);
  assert.equal(all.resolved_by_name, 'Maria Novak');
  assert.match(all.resolution, /clean-up/);
  const history = (await maria.get(`/api/issues/${issue.id}/history`)).data.map((h) => h.action);
  assert.deepEqual(history, ['flag', 'issue_investigating', 'issue_dismissed']);
});

test('issues a person picked up are not duplicated on re-submission', async () => {
  const maria = await env.client('maria@example.com');
  const mid = metricId();
  const first = await maria.post(`/api/metrics/${mid}/values`, { period: '2026-11', value: 2000000 });
  const id = first.data.issues.find((i) => i.rule_type === 'pct_change').id;
  await maria.patch(`/api/issues/${id}`, { status: 'confirmed_error', resolution: 'Double-loaded partition' });
  const again = await maria.post(`/api/metrics/${mid}/values`, { period: '2026-11', value: 2100000 });
  assert.ok(!again.data.issues.some((i) => i.rule_type === 'pct_change'));
  const row = env.db.prepare('SELECT status FROM dq_issues WHERE id = ?').get(id);
  assert.equal(row.status, 'confirmed_error');
});

test('rules: validation, seasonality baseline, range and missing value', async () => {
  const maria = await env.client('maria@example.com');
  const lifetime = idOf(env.db, 'Customer Lifetime by Sales Channel');
  const m = await maria.post(`/api/dashboards/${lifetime}/metrics`, { name: 'Gross adds', unit: 'customers' });
  const mid = m.data.id;
  assert.equal((await maria.post(`/api/metrics/${mid}/rules`, { type: 'range', params: {} })).status, 400);
  assert.equal((await maria.post(`/api/metrics/${mid}/rules`, { type: 'pct_change', params: { threshold_pct: -1 } })).status, 400);
  await maria.post(`/api/metrics/${mid}/rules`, { type: 'pct_change', params: { threshold_pct: 15, baseline: 'same_period_last_year' } });
  await maria.post(`/api/metrics/${mid}/rules`, { type: 'range', params: { min: 0, max: 100000 } });
  await maria.post(`/api/metrics/${mid}/rules`, { type: 'missing', severity: 'critical' });

  await maria.post(`/api/metrics/${mid}/values`, { period: '2025-12', value: 40000 });
  await maria.post(`/api/metrics/${mid}/values`, { period: '2026-11', value: 25000 });
  // December peak is normal vs last December even though it is +60% vs November.
  const dec = await maria.post(`/api/metrics/${mid}/values`, { period: '2026-12', value: 42000 });
  assert.deepEqual(dec.data.issues, []);
  const big = await maria.post(`/api/metrics/${mid}/values`, { period: '2027-01', value: 150000 });
  assert.deepEqual(big.data.issues.map((i) => i.rule_type), ['range']);
  const missing = await maria.post(`/api/metrics/${mid}/values`, { period: '2027-02', value: null });
  assert.deepEqual(missing.data.issues.map((i) => i.rule_type), ['missing']);
  assert.equal((await maria.post(`/api/metrics/${mid}/values`, { period: 'Feb', value: 1 })).status, 400);
});

test('stale reports are flagged and auto-resolved after refresh', async () => {
  const tom = await env.client('tom@example.com');
  const id = idOf(env.db, 'Sales Performance – Daily');
  const open = () => env.db.prepare("SELECT * FROM dq_issues WHERE dashboard_id = ? AND rule_type = 'stale'").all(id);
  assert.equal(open().filter((i) => i.status === 'warning').length, 1);
  env.app.tick();
  assert.equal(open().length, 1, 'no duplicate stale issue');
  await tom.post(`/api/dashboards/${id}/refreshed`, {});
  env.app.tick();
  assert.equal(open()[0].status, 'resolved');
});
