'use strict';

const { createApp } = require('../src/server');
const { openDatabase, transaction } = require('../src/db');
const { seed } = require('../scripts/seed');

async function startSeeded(options = {}) {
  const db = openDatabase(':memory:');
  transaction(db, () => seed(db));
  const app = createApp({ db, baseUrl: 'http://dash.test', dataSourcesFile: null, ...options });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { app, db, base, client: (email) => client(base, email) };
}

// A tiny cookie-keeping API client.
async function client(base, email, password = 'password123') {
  let cookie = '';
  const call = async (method, path, body, extraHeaders = {}) => {
    const res = await fetch(base + path, {
      method,
      redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extraHeaders },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  };
  if (email) {
    const r = await call('POST', '/api/auth/login', { email, password });
    if (r.status !== 200) throw new Error(`login failed for ${email}: ${JSON.stringify(r.data)}`);
  }
  return {
    get: (p, h) => call('GET', p, undefined, h),
    post: (p, b = {}, h) => call('POST', p, b, h),
    put: (p, b = {}) => call('PUT', p, b),
    patch: (p, b = {}) => call('PATCH', p, b),
    del: (p) => call('DELETE', p, {}),
  };
}

const idOf = (db, name) => db.prepare('SELECT id FROM dashboards WHERE name = ?').get(name).id;
const userId = (db, email) => db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;

module.exports = { startSeeded, client, idOf, userId };
