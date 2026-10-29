'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startSeeded } = require('./helpers');
const { seedWarehouse } = require('../scripts/seed-warehouse');
const { bindNamed, stripPersonalData, parseCsv } = require('../src/datasources');

let env, dir;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), '4kadash-data-'));
  seedWarehouse(path.join(dir, 'warehouse.db'));
  fs.writeFileSync(path.join(dir, 'sales.csv'), 'mesiac;kanal;trzby;telefon\n2026-08;Online;100,5;+421 900 123 456\n2026-09;Online;120;+421 900 654 321\n');
  fs.writeFileSync(path.join(dir, 'sources.json'), JSON.stringify({
    allowedOrigins: ['https://claude.ai'],
    sources: [
      { id: 'demo', driver: 'sqlite', connection: { file: 'warehouse.db' }, datasets: [{
        id: 'renewals', name: 'Predĺženia', periodColumn: 'mesiac', maxRows: 1000, piiColumns: ['email_zakaznika'],
        sql: 'SELECT mesiac, kanal, tarifa, predlzenia, email_zakaznika FROM renewals WHERE (:from IS NULL OR mesiac >= :from) AND (:to IS NULL OR mesiac <= :to)',
      }] },
      { id: 'files', driver: 'csv', connection: { file: 'sales.csv' }, datasets: [{ id: 'sales', periodColumn: 'mesiac' }] },
      { id: 'dwh', driver: 'postgres', connection: { env: 'MISSING_DWH_URL' }, datasets: [{ id: 'fin', sql: 'SELECT 1 AS x', groups: ['Finance'] }] },
    ],
  }));
  env = await startSeeded({ dataSourcesFile: path.join(dir, 'sources.json') });
});
after(async () => { await env.app.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('users see only the datasets their groups allow', async () => {
  const tom = await env.client('tom@example.com');
  const ines = await env.client('ines@example.com');
  const ids = (r) => r.data.flatMap((s) => s.datasets.map((d) => `${s.id}/${d.id}`));
  assert.deepEqual(ids(await tom.get('/api/data/sources')), ['demo/renewals', 'files/sales']);
  assert.ok(ids(await ines.get('/api/data/sources')).includes('dwh/fin'));
  assert.equal((await tom.get('/api/data/dwh/fin')).status, 404);
  assert.equal((await (await env.client()).get('/api/data/sources')).status, 401);
});

test('rows come back without personal data, filtered by period and limited', async () => {
  const tom = await env.client('tom@example.com');
  const r = await tom.get('/api/data/demo/renewals?from=2026-09&to=2026-09');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.columns, ['mesiac', 'kanal', 'tarifa', 'predlzenia']);
  assert.deepEqual(r.data.removedColumns, ['email_zakaznika']);
  assert.ok(r.data.rows.length > 0 && r.data.rows.every((row) => row[0] === '2026-09'));
  assert.ok(!JSON.stringify(r.data).includes('@example.com'));
  const small = await tom.get('/api/data/demo/renewals?limit=5');
  assert.equal(small.data.rowCount, 5);
  assert.equal(small.data.truncated, true);
  const csv = await tom.get('/api/data/files/sales?from=2026-09');
  assert.deepEqual(csv.data.columns, ['mesiac', 'kanal', 'trzby']);
  assert.deepEqual(csv.data.rows, [['2026-09', 'Online', 120]]);
  const log = env.db.prepare("SELECT details FROM audit_log WHERE action = 'data.read' ORDER BY id DESC LIMIT 1").get();
  assert.match(log.details, /"dataset":"sales"/);
});

test('bad input and broken sources give clear errors', async () => {
  const tom = await env.client('tom@example.com');
  assert.equal((await tom.get('/api/data/demo/renewals?from=2026-09;DROP')).status, 400);
  assert.equal((await tom.get('/api/data/demo/nothing')).status, 404);
  const ines = await env.client('ines@example.com');
  const broken = await ines.get('/api/data/dwh/fin');
  assert.equal(broken.status, 502);
  assert.equal(broken.data.error, 'Data source is not available');
});

test('a bearer token reads data from an allowed origin and nothing else', async () => {
  const tom = await env.client('tom@example.com');
  const { token } = (await tom.post('/api/data/token')).data;
  assert.match(token, /^[a-f0-9]{64}$/);
  const pre = await fetch(env.base + '/api/data/sources', { method: 'OPTIONS', headers: { origin: 'https://claude.ai' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), 'https://claude.ai');
  const auth = { authorization: `Bearer ${token}`, origin: 'https://claude.ai' };
  const ok = await fetch(env.base + '/api/data/demo/renewals?limit=2', { headers: auth });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://claude.ai');
  const other = await fetch(env.base + '/api/data/sources', { headers: { ...auth, origin: 'https://evil.example' } });
  assert.equal(other.headers.get('access-control-allow-origin'), null);
  assert.equal((await fetch(env.base + '/api/dashboards', { headers: auth })).status, 401);
});

test('named parameters bind per driver and personal data is found by value', () => {
  assert.deepEqual(bindNamed('x >= :from AND y::date <= :to AND z = :from', { from: 'a', to: 'b' }, 'pg'),
    { text: 'x >= $1 AND y::date <= $2 AND z = $3', values: ['a', 'b', 'a'] });
  assert.equal(bindNamed('x = :from', { from: 'a' }, 'mssql').text, 'x = @from');
  const { columns, removed } = stripPersonalData([{ id: 1, kontakt: 'a@b.sk' }, { id: 2, kontakt: 'c@d.sk' }], { piiColumns: [] });
  assert.deepEqual(columns, ['id']);
  assert.deepEqual(removed, ['kontakt']);
  assert.deepEqual(parseCsv('a,b\n"x, y",2\n'), [{ a: 'x, y', b: 2 }]);
});
