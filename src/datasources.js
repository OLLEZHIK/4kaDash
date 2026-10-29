'use strict';

// Data gateway: reads company databases for 4kaDash reports.
//
// - Only datasets an admin defined in the config can be read. The browser never sends SQL,
//   only a period (from/to) and a row limit, which are passed as bound parameters.
// - Connection strings come from environment variables; they never reach the browser.
// - Personal-data columns are dropped on the server before anything is sent.

const fs = require('node:fs');
const path = require('node:path');

const MAX_ROWS = 200_000;
const PERIOD_RE = /^\d{4}-\d{2}(-\d{2})?$/;
const PII_COLUMN_RE = /(rodn|rodne|\brc\b|r\.č|birth|narod|telef|phone|mobil|e-?mail|iban|ucet|účet|adres|address|priezv|surname|first.?name|last.?name|meno)/i;
const PII_VALUE_RES = [
  /^\d{6}\/?\d{3,4}$/,                       // rodné číslo
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/,              // e-mail
  /^\+?\d[\d ]{8,14}\d$/,                    // phone number
  /^[A-Z]{2}\d{2}[A-Z0-9 ]{12,30}$/,         // IBAN
];

function loadConfig(file) {
  if (!file || !fs.existsSync(file)) return { allowedOrigins: [], sources: [] };
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const sources = (raw.sources || []).map((s) => {
    if (!s.id || !s.driver) throw new Error(`Data source needs "id" and "driver": ${JSON.stringify(s)}`);
    return {
      id: String(s.id),
      name: String(s.name || s.id),
      driver: String(s.driver),
      connection: s.connection || {},
      baseDir: path.dirname(path.resolve(file)),
      datasets: (s.datasets || []).map((d) => ({
        id: String(d.id),
        name: String(d.name || d.id),
        description: String(d.description || ''),
        sql: d.sql ? String(d.sql) : null,
        file: d.file ? String(d.file) : null,
        periodColumn: d.periodColumn ? String(d.periodColumn) : null,
        maxRows: Math.min(Number(d.maxRows) || 50_000, MAX_ROWS),
        piiColumns: (d.piiColumns || []).map(String),
        groups: Array.isArray(d.groups) ? d.groups.map(String) : null,
      })),
    };
  });
  return { allowedOrigins: (raw.allowedOrigins || []).map(String), sources };
}

// Secrets are referenced by environment variable name, never written in the config file.
function connectionString(source) {
  const c = source.connection;
  if (c.env) {
    const v = process.env[c.env];
    if (!v) throw new Error(`Environment variable ${c.env} for data source "${source.id}" is not set`);
    return v;
  }
  if (c.file) return path.resolve(source.baseDir, c.file);
  throw new Error(`Data source "${source.id}" has no connection (use "env" or "file")`);
}

function optionalRequire(name, driver) {
  try {
    return require(name);
  } catch {
    throw new Error(`Driver "${driver}" needs the npm package "${name}" (npm install ${name})`);
  }
}

// Named :params -> each driver's placeholder style, so dataset SQL is written once.
function bindNamed(sql, params, style) {
  const values = [];
  const text = sql.replace(/(^|[^:]):([a-zA-Z_]\w*)/g, (m, pre, name) => {
    if (!(name in params)) return m;
    if (style === 'pg') { values.push(params[name]); return `${pre}$${values.length}`; }
    if (style === 'mssql') return `${pre}@${name}`;
    values.push(params[name]);
    return `${pre}?`;
  });
  return { text, values };
}

const drivers = {
  async sqlite(source, ds, params, limit) {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(connectionString(source), { readOnly: true });
    try {
      const { text, values } = bindNamed(ds.sql, params, 'qmark');
      const stmt = db.prepare(`SELECT * FROM (${text}) AS q LIMIT ${limit}`);
      return stmt.all(...values);
    } finally {
      db.close();
    }
  },
  async postgres(source, ds, params, limit) {
    const { Client } = optionalRequire('pg', 'postgres');
    const client = new Client({ connectionString: connectionString(source), statement_timeout: 60_000 });
    await client.connect();
    try {
      await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
      const { text, values } = bindNamed(ds.sql, params, 'pg');
      return (await client.query(`SELECT * FROM (${text}) AS q LIMIT ${limit}`, values)).rows;
    } finally {
      await client.end();
    }
  },
  async mysql(source, ds, params, limit) {
    const mysql = optionalRequire('mysql2/promise', 'mysql');
    const conn = await mysql.createConnection(connectionString(source));
    try {
      await conn.query('SET SESSION TRANSACTION READ ONLY');
      const { text, values } = bindNamed(ds.sql, params, 'qmark');
      return (await conn.query(`SELECT * FROM (${text}) AS q LIMIT ${limit}`, values))[0];
    } finally {
      await conn.end();
    }
  },
  async mssql(source, ds, params, limit) {
    const sql = optionalRequire('mssql', 'mssql');
    const pool = await sql.connect(connectionString(source));
    try {
      const req = pool.request();
      for (const [k, v] of Object.entries(params)) req.input(k, v);
      const { text } = bindNamed(ds.sql, params, 'mssql');
      return (await req.query(`SELECT TOP (${limit}) * FROM (${text}) AS q`)).recordset;
    } finally {
      await pool.close();
    }
  },
  // A CSV export on the server (e.g. a nightly dump). The period filter uses periodColumn.
  async csv(source, ds, params, limit) {
    const file = path.resolve(source.baseDir, ds.file || connectionString(source));
    const rows = parseCsv(fs.readFileSync(file, 'utf8'));
    const p = ds.periodColumn;
    return rows
      .filter((r) => !p || ((!params.from || String(r[p]) >= params.from) && (!params.to || String(r[p]) <= params.to + '￿')))
      .slice(0, limit);
  },
};

function parseCsv(text) {
  const first = text.split(/\r?\n/, 1)[0] || '';
  const delim = [';', '\t', ','].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const out = [];
  let row = [], cell = '', q = false;
  const push = () => { row.push(cell); cell = ''; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) push();
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      push(); out.push(row); row = [];
    } else cell += c;
  }
  if (cell || row.length) { push(); out.push(row); }
  const [head, ...body] = out.filter((r) => r.some((v) => v !== ''));
  if (!head) return [];
  return body.map((r) => Object.fromEntries(head.map((h, j) => {
    const v = r[j] ?? '';
    const n = Number(v.replace(/\s/g, '').replace(',', '.'));
    return [h.trim(), v !== '' && Number.isFinite(n) && /^-?[\d\s]+([.,]\d+)?$/.test(v.trim()) ? n : v];
  })));
}

function plain(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, v.getUTCHours() || v.getUTCMinutes() ? 19 : 10);
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'object' && typeof v.toString === 'function' && !Array.isArray(v)) {
    const n = Number(v.toString());
    return Number.isFinite(n) ? n : String(v);
  }
  return v;
}

// Drops personal-data columns: listed in the config, recognised by name, or by their values.
function stripPersonalData(rows, ds) {
  const columns = rows.length ? Object.keys(rows[0]) : [];
  const listed = new Set(ds.piiColumns.map((c) => c.toLowerCase()));
  const removed = columns.filter((c) => {
    if (listed.has(c.toLowerCase()) || PII_COLUMN_RE.test(c)) return true;
    const sample = rows.slice(0, 200).map((r) => r[c]).filter((v) => typeof v === 'string' && v.trim());
    return sample.length > 0 && sample.filter((v) => PII_VALUE_RES.some((re) => re.test(v.trim()))).length / sample.length > 0.5;
  });
  const keep = columns.filter((c) => !removed.includes(c));
  return { columns: keep, rows: rows.map((r) => keep.map((c) => plain(r[c]))), removed };
}

function createGateway(config) {
  const find = (sourceId, datasetId) => {
    const source = config.sources.find((s) => s.id === sourceId);
    const ds = source?.datasets.find((d) => d.id === datasetId);
    return source && ds ? { source, ds } : null;
  };
  const allowed = (ds, groups, isAdmin) => isAdmin || !ds.groups || ds.groups.some((g) => groups.includes(g));

  return {
    config,
    list(groups, isAdmin) {
      return config.sources.map((s) => ({
        id: s.id,
        name: s.name,
        driver: s.driver,
        datasets: s.datasets.filter((d) => allowed(d, groups, isAdmin)).map((d) => ({
          id: d.id, name: d.name, description: d.description, period: !!(d.periodColumn || /:from|:to/.test(d.sql || '')), maxRows: d.maxRows,
        })),
      })).filter((s) => s.datasets.length);
    },
    find,
    allowed,
    async fetch(sourceId, datasetId, { from = null, to = null, limit } = {}, groups = [], isAdmin = false) {
      const hit = find(sourceId, datasetId);
      if (!hit || !allowed(hit.ds, groups, isAdmin)) return null;
      for (const p of [from, to]) if (p !== null && !PERIOD_RE.test(p)) throw new RangeError('Period must be YYYY-MM or YYYY-MM-DD');
      const driver = drivers[hit.source.driver];
      if (!driver) throw new Error(`Unknown driver "${hit.source.driver}"`);
      if (hit.source.driver !== 'csv' && !hit.ds.sql) throw new Error(`Dataset "${datasetId}" has no sql`);
      const max = Math.max(1, Math.min(Number(limit) || hit.ds.maxRows, hit.ds.maxRows));
      const raw = await driver(hit.source, hit.ds, { from, to }, max + 1);
      const truncated = raw.length > max;
      const { columns, rows, removed } = stripPersonalData(raw.slice(0, max), hit.ds);
      return {
        dataset: { source: hit.source.id, id: hit.ds.id, name: hit.ds.name },
        columns, rows, rowCount: rows.length, truncated, removedColumns: removed, fetchedAt: new Date().toISOString(),
      };
    },
  };
}

module.exports = { loadConfig, createGateway, stripPersonalData, bindNamed, parseCsv };
