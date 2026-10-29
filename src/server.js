'use strict';

const http = require('node:http');
const path = require('node:path');
const { openDatabase } = require('./db');
const auth = require('./auth');
const { HttpError, Router, readJson, sendJson, parseCookies, serveStatic, unauthorized, forbidden } = require('./http');
const scheduler = require('./scheduler');
const quality = require('./quality');
const { loadConfig, createGateway } = require('./datasources');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
};

function createApp(options = {}) {
  const config = {
    dbFile: options.dbFile ?? process.env.DB_FILE ?? path.join(__dirname, '..', 'data', 'dash.db'),
    baseUrl: options.baseUrl ?? process.env.BASE_URL ?? 'http://localhost:3000',
    secureCookies: options.secureCookies ?? process.env.SECURE_COOKIES === '1',
    dataSourcesFile: options.dataSourcesFile ?? process.env.DATA_SOURCES ?? path.join(__dirname, '..', 'config', 'data-sources.json'),
  };
  const db = options.db ?? openDatabase(config.dbFile);
  const router = new Router();
  const gateway = options.gateway ?? createGateway(loadConfig(config.dataSourcesFile));
  const ctx = { db, config, gateway };
  for (const mod of ['auth', 'dashboards', 'workspace', 'admin', 'schedules', 'quality', 'data']) {
    require(`./routes/${mod}`).register(router, ctx);
  }

  async function handle(req, res) {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const url = new URL(req.url, 'http://internal');

    if (!url.pathname.startsWith('/api/')) {
      if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(PUBLIC_DIR, url.pathname, res)) return;
      return sendJson(res, 404, { error: 'Not found' });
    }

    // The data gateway may be called from allowed origins (e.g. the 4kaDash page on claude.ai).
    const isData = url.pathname.startsWith('/api/data/');
    const origin = req.headers.origin;
    if (isData && origin && gateway.config.allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Headers', 'Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET');
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    }

    const found = router.match(req.method, url.pathname);
    if (!found) return sendJson(res, 404, { error: 'Unknown endpoint' });
    if (found.methodNotAllowed) return sendJson(res, 405, { error: 'Method not allowed' });

    try {
      // Reject cross-origin state changes (defence in depth on top of SameSite cookies).
      if (req.method !== 'GET' && req.headers.origin) {
        const origin = new URL(req.headers.origin);
        if (origin.host !== req.headers.host) throw forbidden('Cross-origin request rejected');
      }
      const token = parseCookies(req.headers.cookie)[auth.SESSION_COOKIE];
      // A bearer token is accepted only for reading data, never for other endpoints.
      const bearer = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1];
      const user = auth.userForToken(db, token) ?? (isData && req.method === 'GET' ? auth.userForToken(db, bearer) : null);
      if (found.route.auth && !user) throw unauthorized();
      const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readJson(req) : {};
      const result = await found.route.handler({ req, res, db, user, token, params: found.params, query: url.searchParams, body });
      if (res.headersSent) return;
      if (result && typeof result === 'object' && 'status' in result && 'data' in result) return sendJson(res, result.status, result.data);
      sendJson(res, 200, result ?? { ok: true });
    } catch (err) {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      console.error(err);
      sendJson(res, 500, { error: 'Internal server error' });
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
    });
  });

  // Background work: scheduled deliveries and freshness checks.
  function tick(now = new Date()) {
    const delivered = scheduler.runDue(db, { now, baseUrl: config.baseUrl });
    const stale = quality.checkStale(db, now);
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now.toISOString());
    return { delivered, stale: stale.length };
  }

  let timer = null;
  function startBackground(intervalMs = 60_000) {
    tick();
    timer = setInterval(() => {
      try {
        tick();
      } catch (err) {
        console.error('Background tick failed', err);
      }
    }, intervalMs);
    timer.unref();
  }

  function close() {
    if (timer) clearInterval(timer);
    return new Promise((resolve) => server.close(() => resolve()));
  }

  return { server, db, config, tick, startBackground, close };
}

module.exports = { createApp };
