'use strict';

// Data quality engine. Rules produce *warnings*; only a person can confirm a data error.
//
// Rule types and params:
//   pct_change      { threshold_pct, direction: 'both'|'up'|'down', baseline: 'last_validated'|'previous'|'same_period_last_year', min_abs_change }
//   range           { min, max }
//   missing         {}  – value was not supplied for the period
//   duplicates      { max_duplicates }  – row_count vs distinct_count of the key
//   source_mismatch { tolerance_pct }   – reported value vs value recomputed from the source

const { audit, notify } = require('./audit');

const OPEN_STATUSES = ['warning', 'investigating', 'confirmed_error'];

const RULE_DEFAULTS = {
  pct_change: { threshold_pct: 20, direction: 'both', baseline: 'last_validated', min_abs_change: 0 },
  range: { min: null, max: null },
  missing: {},
  duplicates: { max_duplicates: 0 },
  source_mismatch: { tolerance_pct: 0.5 },
};

function normalizeParams(type, params) {
  const p = { ...RULE_DEFAULTS[type], ...(params || {}) };
  const numeric = (k, { allowNull = false, min } = {}) => {
    if (p[k] === null || p[k] === '' || p[k] === undefined) {
      if (allowNull) return (p[k] = null);
      throw new Error(`'${k}' is required`);
    }
    const n = Number(p[k]);
    if (!Number.isFinite(n) || (min !== undefined && n < min)) throw new Error(`'${k}' must be a number${min !== undefined ? ` ≥ ${min}` : ''}`);
    p[k] = n;
  };
  if (type === 'pct_change') {
    numeric('threshold_pct', { min: 0 });
    numeric('min_abs_change', { min: 0 });
    if (!['both', 'up', 'down'].includes(p.direction)) throw new Error("'direction' must be both, up or down");
    if (!['last_validated', 'previous', 'same_period_last_year'].includes(p.baseline)) {
      throw new Error("'baseline' must be last_validated, previous or same_period_last_year");
    }
  }
  if (type === 'range') {
    numeric('min', { allowNull: true });
    numeric('max', { allowNull: true });
    if (p.min === null && p.max === null) throw new Error("A range rule needs 'min' and/or 'max'");
    if (p.min !== null && p.max !== null && p.min > p.max) throw new Error("'min' must not exceed 'max'");
  }
  if (type === 'duplicates') numeric('max_duplicates', { min: 0 });
  if (type === 'source_mismatch') numeric('tolerance_pct', { min: 0 });
  return p;
}

function describeRule(type, p) {
  switch (type) {
    case 'pct_change': {
      const dir = { both: 'changes by', up: 'increases by', down: 'decreases by' }[p.direction];
      const base = { last_validated: 'the last validated value', previous: 'the previous period', same_period_last_year: 'the same period last year' }[p.baseline];
      return `Flag when the value ${dir} more than ${p.threshold_pct}% vs ${base}` + (p.min_abs_change ? ` (and by at least ${p.min_abs_change})` : '');
    }
    case 'range':
      if (p.min !== null && p.max !== null) return `Flag when the value is outside ${p.min} – ${p.max}`;
      return p.min !== null ? `Flag when the value is below ${p.min}` : `Flag when the value is above ${p.max}`;
    case 'missing':
      return 'Flag when no value is supplied for a period';
    case 'duplicates':
      return `Flag when more than ${p.max_duplicates} duplicate record(s) are found`;
    case 'source_mismatch':
      return `Flag when the reported value differs from the source by more than ${p.tolerance_pct}%`;
    default:
      return type;
  }
}

function lastYear(period) {
  const m = /^(\d{4})(.*)$/.exec(period);
  return m ? `${Number(m[1]) - 1}${m[2]}` : null;
}

function baselineFor(db, metricId, period, baseline) {
  if (baseline === 'same_period_last_year') {
    const p = lastYear(period);
    if (!p) return null;
    const row = db.prepare('SELECT period, value FROM metric_values WHERE metric_id = ? AND period = ? AND value IS NOT NULL').get(metricId, p);
    return row ? { period: row.period, value: row.value } : null;
  }
  const validatedOnly = baseline === 'last_validated' ? 'AND validated = 1' : '';
  const row = db
    .prepare(
      `SELECT period, value FROM metric_values
        WHERE metric_id = ? AND period < ? AND value IS NOT NULL ${validatedOnly}
        ORDER BY period DESC LIMIT 1`
    )
    .get(metricId, period);
  return row ? { period: row.period, value: row.value } : null;
}

const fmt = (n) => (Number.isInteger(n) ? n.toLocaleString('en-US') : Number(n.toFixed(4)).toLocaleString('en-US'));

// Returns null when the rule passes, otherwise { expected, actual, message }.
function check(db, rule, metric, v) {
  const p = JSON.parse(rule.params);
  switch (rule.type) {
    case 'missing':
      return v.value === null ? { expected: null, actual: null, message: `No value was supplied for ${v.period}.` } : null;

    case 'range': {
      if (v.value === null) return null;
      if ((p.min !== null && v.value < p.min) || (p.max !== null && v.value > p.max)) {
        const bound = p.min !== null && v.value < p.min ? p.min : p.max;
        return { expected: bound, actual: v.value, message: `${metric.name} for ${v.period} is ${fmt(v.value)}, outside the allowed range (${describeRule('range', p).replace('Flag when the value is ', '')}).` };
      }
      return null;
    }

    case 'pct_change': {
      if (v.value === null) return null;
      const base = baselineFor(db, metric.id, v.period, p.baseline);
      if (!base) return null; // nothing to compare against yet
      const diff = v.value - base.value;
      if (Math.abs(diff) < p.min_abs_change) return null;
      const pct = base.value === 0 ? (diff === 0 ? 0 : Infinity) : (diff / Math.abs(base.value)) * 100;
      const breached =
        (p.direction !== 'down' && pct > p.threshold_pct) || (p.direction !== 'up' && pct < -p.threshold_pct);
      if (!breached) return null;
      const pctText = Number.isFinite(pct) ? `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%` : 'from zero';
      return {
        expected: base.value,
        actual: v.value,
        message: `${metric.name} for ${v.period} is ${fmt(v.value)} vs ${fmt(base.value)} for ${base.period} (${pctText}); threshold is ±${p.threshold_pct}%.`,
      };
    }

    case 'duplicates': {
      if (v.row_count === null || v.distinct_count === null) return null;
      const dupes = v.row_count - v.distinct_count;
      if (dupes <= p.max_duplicates) return null;
      return { expected: v.distinct_count, actual: v.row_count, message: `${dupes.toLocaleString('en-US')} duplicate record(s) found for ${v.period} (${fmt(v.row_count)} rows, ${fmt(v.distinct_count)} distinct keys).` };
    }

    case 'source_mismatch': {
      if (v.value === null || v.source_value === null) return null;
      const diff = Math.abs(v.value - v.source_value);
      const pct = v.source_value === 0 ? (diff === 0 ? 0 : Infinity) : (diff / Math.abs(v.source_value)) * 100;
      if (pct <= p.tolerance_pct) return null;
      return {
        expected: v.source_value,
        actual: v.value,
        message: `Reported ${metric.name} for ${v.period} (${fmt(v.value)}) differs from the source (${fmt(v.source_value)}) by ${Number.isFinite(pct) ? pct.toFixed(2) + '%' : 'an undefined ratio'}; tolerance is ${p.tolerance_pct}%.`,
      };
    }
    default:
      return null;
  }
}

// Evaluates every active rule for one metric value and records any warnings. Returns created issues.
function evaluate(db, metricId, period) {
  const metric = db.prepare('SELECT * FROM metrics WHERE id = ?').get(metricId);
  const v = db.prepare('SELECT * FROM metric_values WHERE metric_id = ? AND period = ?').get(metricId, period);
  if (!metric || !v) return [];
  const dashboard = db.prepare('SELECT id, name, owner_id FROM dashboards WHERE id = ?').get(metric.dashboard_id);

  // Automatic warnings from an earlier submission of this period are superseded by the re-evaluation.
  // Issues a person has already picked up (investigating / confirmed) are left alone.
  db.prepare(
    `UPDATE dq_issues SET status = 'resolved', resolution = 'Superseded: value re-submitted and re-checked', resolved_at = datetime('now')
      WHERE metric_id = ? AND period = ? AND status = 'warning'`
  ).run(metricId, period);

  const created = [];
  const rules = db.prepare('SELECT * FROM validation_rules WHERE metric_id = ? AND active = 1').all(metricId);
  for (const rule of rules) {
    const result = check(db, rule, metric, v);
    if (!result) continue;
    const pickedUp = db
      .prepare("SELECT id FROM dq_issues WHERE rule_id = ? AND period = ? AND status IN ('investigating','confirmed_error')")
      .get(rule.id, period);
    if (pickedUp) continue;
    const message = rule.note ? `${result.message} Rule note: ${rule.note}` : result.message;
    const info = db
      .prepare(
        `INSERT INTO dq_issues (dashboard_id, metric_id, rule_id, rule_type, period, expected, actual, message, severity)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(metric.dashboard_id, metricId, rule.id, rule.type, period, result.expected, result.actual, message, rule.severity);
    const id = Number(info.lastInsertRowid);
    created.push({ id, rule_type: rule.type, severity: rule.severity, message });
    if (rule.severity !== 'info') {
      notify(db, dashboard.owner_id, `Data quality ${rule.severity} on "${dashboard.name}": ${result.message}`, `#/quality?issue=${id}`);
    }
    audit(db, null, 'flag', 'dq_issue', id, message);
  }
  return created;
}

// Flags dashboards whose report has not been refreshed within their expected window.
function checkStale(db, now = new Date()) {
  const rows = db
    .prepare('SELECT id, name, owner_id, stale_after_hours, last_refreshed_at FROM dashboards WHERE stale_after_hours IS NOT NULL')
    .all();
  const created = [];
  for (const d of rows) {
    const last = d.last_refreshed_at ? Date.parse(d.last_refreshed_at) : null;
    const overdue = last === null || now.getTime() - last > d.stale_after_hours * 3600 * 1000;
    const open = db
      .prepare(`SELECT id FROM dq_issues WHERE dashboard_id = ? AND rule_type = 'stale' AND status IN ('warning','investigating','confirmed_error')`)
      .get(d.id);
    if (!overdue) {
      if (open) {
        db.prepare(
          "UPDATE dq_issues SET status = 'resolved', resolution = 'Report was refreshed', resolved_at = datetime('now') WHERE id = ? AND status = 'warning'"
        ).run(open.id);
      }
      continue;
    }
    if (open) continue;
    const message = last === null
      ? `"${d.name}" has never reported a refresh; it is expected at least every ${d.stale_after_hours}h.`
      : `"${d.name}" was last refreshed ${new Date(last).toISOString().replace('T', ' ').slice(0, 16)} UTC; it is expected at least every ${d.stale_after_hours}h.`;
    const info = db
      .prepare("INSERT INTO dq_issues (dashboard_id, rule_type, message, severity) VALUES (?, 'stale', ?, 'warning')")
      .run(d.id, message);
    const id = Number(info.lastInsertRowid);
    notify(db, d.owner_id, `Report not updated as expected: ${message}`, `#/quality?issue=${id}`);
    created.push(id);
  }
  return created;
}

module.exports = { OPEN_STATUSES, RULE_DEFAULTS, normalizeParams, describeRule, evaluate, checkStale, check };
