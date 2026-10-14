'use strict';

const fs = require('node:fs');
const path = require('node:path');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const badRequest = (msg) => new HttpError(400, msg);
const unauthorized = (msg = 'Authentication required') => new HttpError(401, msg);
const forbidden = (msg = 'You do not have access to this resource') => new HttpError(403, msg);
const notFound = (msg = 'Not found') => new HttpError(404, msg);

// Minimal router: routes are registered as 'GET /api/dashboards/:id'.
class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler, opts = {}) {
    const keys = [];
    const regex = new RegExp(
      '^' +
        pattern.replace(/\/:([a-zA-Z]+)/g, (_, key) => {
          keys.push(key);
          return '/([^/]+)';
        }) +
        '/?$'
    );
    this.routes.push({ method, regex, keys, handler, auth: opts.auth !== false });
  }

  get(p, h, o) { this.add('GET', p, h, o); }
  post(p, h, o) { this.add('POST', p, h, o); }
  put(p, h, o) { this.add('PUT', p, h, o); }
  patch(p, h, o) { this.add('PATCH', p, h, o); }
  delete(p, h, o) { this.add('DELETE', p, h, o); }

  match(method, pathname) {
    let pathMatched = false;
    for (const route of this.routes) {
      const m = route.regex.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      const params = {};
      route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { route, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

const MAX_BODY = 1024 * 1024;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(badRequest('Request body must be a JSON object'));
        }
        resolve(parsed);
      } catch {
        reject(badRequest('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data, headers = {}) {
  const body = data === undefined ? '' : JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function serveStatic(root, pathname, res) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root + path.sep)) return false;
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Content-Length': stat.size,
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(file).pipe(res);
  return true;
}

// Input helpers -----------------------------------------------------------

function str(body, key, { required = false, max = 10000, def } = {}) {
  const v = body[key];
  if (v === undefined || v === null || v === '') {
    if (required) throw badRequest(`'${key}' is required`);
    return def;
  }
  if (typeof v !== 'string') throw badRequest(`'${key}' must be a string`);
  const t = v.trim();
  if (required && !t) throw badRequest(`'${key}' is required`);
  if (t.length > max) throw badRequest(`'${key}' must be at most ${max} characters`);
  return t;
}

function int(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n)) throw badRequest(`'${name}' must be an integer`);
  return n;
}

function num(body, key, { required = false } = {}) {
  const v = body[key];
  if (v === undefined || v === null || v === '') {
    if (required) throw badRequest(`'${key}' is required`);
    return null;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw badRequest(`'${key}' must be a number`);
  return n;
}

function oneOf(value, allowed, name) {
  if (!allowed.includes(value)) throw badRequest(`'${name}' must be one of: ${allowed.join(', ')}`);
  return value;
}

module.exports = {
  HttpError, badRequest, unauthorized, forbidden, notFound,
  Router, readJson, sendJson, parseCookies, serveStatic,
  str, int, num, oneOf,
};
