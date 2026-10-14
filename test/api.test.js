'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startSeeded, idOf, userId } = require('./helpers');

let env;
before(async () => (env = await startSeeded()));
after(() => env.app.close());

test('authentication is required and bad credentials are rejected', async () => {
  const anon = await env.client();
  assert.equal((await anon.get('/api/dashboards')).status, 401);
  const bad = await anon.post('/api/auth/login', { email: 'tom@example.com', password: 'nope' });
  assert.equal(bad.status, 401);
  const tom = await env.client('tom@example.com');
  const me = await tom.get('/api/auth/me');
  assert.equal(me.data.name, 'Tom Berg');
});

test('keyword search finds the dashboard for a business question', async () => {
  const tom = await env.client('tom@example.com');
  const r = await tom.get('/api/dashboards?q=' + encodeURIComponent('customer lifetime by sales channel based on gross adds'));
  assert.equal(r.status, 200);
  assert.equal(r.data[0].name, 'Customer Lifetime by Sales Channel');
  // Prefix matching and stemming: "lifetim" / "channels"
  const r2 = await tom.get('/api/dashboards?q=channels');
  assert.ok(r2.data.some((d) => d.name === 'Customer Lifetime by Sales Channel'));
  // Zero-result searches are logged for the success metrics.
  await tom.get('/api/dashboards?q=zzzunknownzzz');
  const n = env.db.prepare("SELECT COUNT(*) n FROM search_log WHERE query = 'zzzunknownzzz' AND results = 0").get().n;
  assert.equal(n, 1);
});

test('filters by topic, department and tag', async () => {
  const tom = await env.client('tom@example.com');
  const byTopic = await tom.get('/api/dashboards?topic=Churn');
  assert.ok(byTopic.data.length >= 2);
  assert.ok(byTopic.data.every((d) => d.topic === 'Churn'));
  const byTag = await tom.get('/api/dashboards?tag=gross%20adds');
  assert.deepEqual(byTag.data.map((d) => d.name).sort(), ['Customer Lifetime by Sales Channel', 'Sales Performance – Daily']);
  const combined = await tom.get('/api/dashboards?q=churn&department=Retention');
  assert.ok(combined.data.every((d) => d.department === 'Retention'));
});

test('restricted dashboards are only visible to granted users and groups', async () => {
  const id = idOf(env.db, 'Revenue & Margin Bridge');
  const tom = await env.client('tom@example.com');
  const ines = await env.client('ines@example.com'); // in Finance group
  const admin = await env.client('admin@example.com');

  assert.equal((await tom.get(`/api/dashboards/${id}`)).status, 404);
  assert.ok(!(await tom.get('/api/dashboards?q=revenue')).data.length);
  assert.equal((await tom.get(`/api/dashboards/${id}/comments`)).status, 404);
  assert.equal((await tom.put(`/api/favorites/${id}`)).status, 404);
  assert.equal((await ines.get(`/api/dashboards/${id}`)).status, 200);
  assert.equal((await admin.get(`/api/dashboards/${id}`)).status, 200);

  // Owner grants Tom direct access.
  const grant = await ines.put(`/api/dashboards/${id}/access`, { visibility: 'restricted', users: [userId(env.db, 'tom@example.com')], groups: [] });
  assert.equal(grant.status, 200);
  assert.equal((await tom.get(`/api/dashboards/${id}`)).status, 200);
  // Non-owners cannot change access.
  assert.equal((await tom.put(`/api/dashboards/${id}/access`, { visibility: 'public' })).status, 403);
});

test('dashboard information page and editing by owner only', async () => {
  const id = idOf(env.db, 'Customer Lifetime by Sales Channel');
  const tom = await env.client('tom@example.com');
  const maria = await env.client('maria@example.com');
  const d = (await tom.get(`/api/dashboards/${id}`)).data;
  assert.equal(d.owner.name, 'Maria Novak');
  assert.equal(d.completeness, 100);
  assert.equal(d.canManage, false);
  assert.ok(d.instructions.length > 0);
  assert.equal((await tom.patch(`/api/dashboards/${id}`, { description: 'hack' })).status, 403);
  const ok = await maria.patch(`/api/dashboards/${id}`, { tags: ['lifetime', 'tenure'] });
  assert.equal(ok.status, 200);
  // Search index follows the edit.
  const found = await tom.get('/api/dashboards?q=tenure');
  assert.equal(found.data[0].id, id);
});

test('register dashboard validates URL and logs open-throughs', async () => {
  const tom = await env.client('tom@example.com');
  assert.equal((await tom.post('/api/dashboards', { name: 'X', url: 'javascript:alert(1)' })).status, 400);
  assert.equal((await tom.post('/api/dashboards', { url: 'https://x.example.com' })).status, 400);
  const created = await tom.post('/api/dashboards', { name: 'Shop Footfall', url: 'https://bi.example.com/footfall', tags: 'retail, shops' });
  assert.equal(created.status, 201);
  const open = await tom.get(`/api/dashboards/${created.data.id}/open`);
  assert.equal(open.status, 302);
  assert.equal(open.headers.get('location'), 'https://bi.example.com/footfall');
  const detail = (await tom.get(`/api/dashboards/${created.data.id}`)).data;
  assert.equal(detail.owner.name, 'Tom Berg');
  assert.ok(detail.completeness < 100);
  // Non-admins cannot register on someone else's behalf.
  const other = await tom.post('/api/dashboards', { name: 'Y', url: 'https://y.example.com', owner_id: userId(env.db, 'maria@example.com') });
  assert.equal(other.status, 400);
});

test('favorites and personal folders', async () => {
  const tom = await env.client('tom@example.com');
  const id = idOf(env.db, 'Monthly Churn Overview');
  await tom.put(`/api/favorites/${id}`);
  assert.deepEqual((await tom.get('/api/dashboards?favorites=1')).data.map((d) => d.id), [id]);
  const f = await tom.post('/api/folders', { name: 'Daily' });
  assert.equal(f.status, 201);
  assert.equal((await tom.post('/api/folders', { name: 'Daily' })).status, 400);
  await tom.put(`/api/folders/${f.data.id}/items/${id}`);
  const folders = (await tom.get('/api/folders')).data;
  assert.equal(folders.find((x) => x.name === 'Daily').items[0].id, id);
  // Folders are private.
  const sam = await env.client('sam@example.com');
  assert.equal((await sam.put(`/api/folders/${f.data.id}/items/${id}`)).status, 404);
  assert.ok(!(await sam.get('/api/folders')).data.some((x) => x.name === 'Daily'));
});

test('comments carry author, timestamp and type; filter by owner; owner is notified', async () => {
  const id = idOf(env.db, 'Customer Lifetime by Sales Channel');
  const tom = await env.client('tom@example.com');
  const maria = await env.client('maria@example.com');
  assert.equal((await tom.post(`/api/dashboards/${id}/comments`, { body: 'x', kind: 'rant' })).status, 400);
  const c = await tom.post(`/api/dashboards/${id}/comments`, { body: 'Online lifetime jumped last week?', kind: 'data_issue' });
  assert.equal(c.status, 201);
  const all = (await tom.get(`/api/dashboards/${id}/comments`)).data;
  assert.equal(all[0].author.name, 'Tom Berg');
  assert.equal(all[0].kind, 'data_issue');
  assert.ok(all[0].createdAt);
  const ownerOnly = (await tom.get(`/api/dashboards/${id}/comments?author=owner`)).data;
  assert.ok(ownerOnly.length >= 1 && ownerOnly.every((x) => x.isOwner));
  const notes = (await maria.get('/api/notifications')).data;
  assert.match(notes[0].message, /reported a data issue/);
  // Only the author, owner or admin may delete.
  const sam = await env.client('sam@example.com');
  assert.equal((await sam.del(`/api/comments/${c.data.id}`)).status, 403);
  assert.equal((await maria.del(`/api/comments/${c.data.id}`)).status, 200);
});

test('admin manages users and groups; non-admins cannot', async () => {
  const tom = await env.client('tom@example.com');
  const admin = await env.client('admin@example.com');
  assert.equal((await tom.get('/api/admin/users')).status, 403);
  const u = await admin.post('/api/admin/users', { email: 'new@example.com', name: 'New Person', password: 'longenough' });
  assert.equal(u.status, 201);
  const g = await admin.post('/api/admin/groups', { name: 'Sales leads' });
  assert.equal((await admin.put(`/api/admin/groups/${g.data.id}/members`, { userIds: [u.data.id] })).status, 200);
  await admin.patch(`/api/admin/users/${u.data.id}`, { active: false });
  const anon = await env.client();
  assert.equal((await anon.post('/api/auth/login', { email: 'new@example.com', password: 'longenough' })).status, 401);
  const m = (await admin.get('/api/admin/metrics')).data;
  assert.ok(m.dashboards >= 7);
  assert.ok(m.searches30d >= 1);
});

test('cross-origin state changes are rejected', async () => {
  const tom = await env.client('tom@example.com');
  const r = await tom.post('/api/folders', { name: 'evil' }, { origin: 'https://evil.example.com' });
  assert.equal(r.status, 403);
});
