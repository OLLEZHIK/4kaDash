'use strict';

const { badRequest, notFound, forbidden, str, int, num, oneOf } = require('../http');
const { transaction } = require('../db');
const { audit } = require('../audit');
const { visibleFilter, loadViewable, loadManageable, canManage } = require('../permissions');
const quality = require('../quality');

const PERIOD_RE = /^\d{4}(-\d{2}(-\d{2})?|-W\d{2}|-Q[1-4])?$/;

function register(router, { db }) {
  const loadMetric = (user, id, { manage = false } = {}) => {
    const m = db.prepare('SELECT * FROM metrics WHERE id = ?').get(id);
    if (!m) throw notFound('Metric not found');
    (manage ? loadManageable : loadViewable)(db, user, m.dashboard_id);
    return m;
  };

  // Metrics ----------------------------------------------------------------------------
  router.get('/api/dashboards/:id/metrics', ({ user, params }) => {
    const id = int(params.id, 'id');
    loadViewable(db, user, id);
    const metrics = db.prepare('SELECT * FROM metrics WHERE dashboard_id = ? ORDER BY name').all(id);
    const values = db.prepare(
      `SELECT v.*, u.name AS validated_by_name FROM metric_values v LEFT JOIN users u ON u.id = v.validated_by
        WHERE v.metric_id = ? ORDER BY v.period DESC LIMIT 24`
    );
    const rules = db.prepare('SELECT * FROM validation_rules WHERE metric_id = ? ORDER BY id');
    return metrics.map((m) => ({
      ...m,
      values: values.all(m.id),
      rules: rules.all(m.id).map((r) => {
        const p = JSON.parse(r.params);
        return { ...r, params: p, description: quality.describeRule(r.type, p) };
      }),
    }));
  });

  router.post('/api/dashboards/:id/metrics', ({ user, params, body }) => {
    const id = int(params.id, 'id');
    loadManageable(db, user, id);
    const name = str(body, 'name', { required: true, max: 200 });
    if (db.prepare('SELECT 1 FROM metrics WHERE dashboard_id = ? AND name = ?').get(id, name)) throw badRequest('This dashboard already has a metric with that name');
    const info = db
      .prepare('INSERT INTO metrics (dashboard_id, name, description, unit) VALUES (?, ?, ?, ?)')
      .run(id, name, str(body, 'description', { max: 2000, def: '' }), str(body, 'unit', { max: 50, def: '' }));
    const mid = Number(info.lastInsertRowid);
    audit(db, user.id, 'create', 'metric', mid, name);
    return { status: 201, data: { id: mid } };
  });

  router.delete('/api/metrics/:id', ({ user, params }) => {
    const m = loadMetric(user, int(params.id, 'id'), { manage: true });
    db.prepare('DELETE FROM metrics WHERE id = ?').run(m.id);
    audit(db, user.id, 'delete', 'metric', m.id, m.name);
    return { ok: true };
  });

  // Values: recorded by integrations or owners; each submission is checked against the rules.
  router.post('/api/metrics/:id/values', ({ user, params, body }) => {
    const m = loadMetric(user, int(params.id, 'id'), { manage: true });
    const period = str(body, 'period', { required: true, max: 20 });
    if (!PERIOD_RE.test(period)) throw badRequest("'period' must look like 2026, 2026-09, 2026-09-30, 2026-W39 or 2026-Q3");
    const value = num(body, 'value');
    const sourceValue = num(body, 'sourceValue');
    const rowCount = body.rowCount === undefined || body.rowCount === null ? null : int(body.rowCount, 'rowCount');
    const distinctCount = body.distinctCount === undefined || body.distinctCount === null ? null : int(body.distinctCount, 'distinctCount');
    const existing = db.prepare('SELECT * FROM metric_values WHERE metric_id = ? AND period = ?').get(m.id, period);
    if (existing?.validated) {
      const reason = str(body, 'overrideReason', { max: 1000 });
      if (!reason) throw badRequest(`${period} is validated history. Supply 'overrideReason' to replace it.`);
      audit(db, user.id, 'override_validated', 'metric_value', existing.id, { period, old: existing.value, new: value, reason });
    }
    const issues = transaction(db, () => {
      db.prepare(
        `INSERT INTO metric_values (metric_id, period, value, source_value, row_count, distinct_count)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (metric_id, period) DO UPDATE SET
           value = excluded.value, source_value = excluded.source_value, row_count = excluded.row_count,
           distinct_count = excluded.distinct_count, validated = 0, validated_by = NULL, validated_at = NULL,
           recorded_at = datetime('now')`
      ).run(m.id, period, value, sourceValue, rowCount, distinctCount);
      return quality.evaluate(db, m.id, period);
    });
    return { status: 201, data: { period, issues } };
  });

  // Mark a period as checked and validated, making it reference history for later checks.
  router.post('/api/metrics/:id/values/:period/validate', ({ user, params, body }) => {
    const m = loadMetric(user, int(params.id, 'id'), { manage: true });
    const v = db.prepare('SELECT * FROM metric_values WHERE metric_id = ? AND period = ?').get(m.id, params.period);
    if (!v) throw notFound('No value recorded for this period');
    const validated = body.validated === undefined ? true : !!body.validated;
    if (validated && v.value === null) throw badRequest('A missing value cannot be validated');
    db.prepare(
      `UPDATE metric_values SET validated = ?, validated_by = ?, validated_at = ${validated ? "datetime('now')" : 'NULL'} WHERE id = ?`
    ).run(validated ? 1 : 0, validated ? user.id : null, v.id);
    audit(db, user.id, validated ? 'validate' : 'unvalidate', 'metric_value', v.id, `${m.name} ${v.period} = ${v.value}`);
    return { ok: true };
  });

  // Rules --------------------------------------------------------------------------------
  const readRule = (body, type) => {
    let params;
    try {
      params = quality.normalizeParams(type, body.params);
    } catch (err) {
      throw badRequest(err.message);
    }
    return {
      params,
      severity: oneOf(body.severity ?? 'warning', ['info', 'warning', 'critical'], 'severity'),
      note: str(body, 'note', { max: 1000, def: '' }),
      active: body.active === undefined ? 1 : body.active ? 1 : 0,
    };
  };

  router.post('/api/metrics/:id/rules', ({ user, params, body }) => {
    const m = loadMetric(user, int(params.id, 'id'), { manage: true });
    const type = oneOf(body.type, Object.keys(quality.RULE_DEFAULTS), 'type');
    const r = readRule(body, type);
    const info = db
      .prepare('INSERT INTO validation_rules (metric_id, type, params, severity, note, active) VALUES (?, ?, ?, ?, ?, ?)')
      .run(m.id, type, JSON.stringify(r.params), r.severity, r.note, r.active);
    const id = Number(info.lastInsertRowid);
    audit(db, user.id, 'create', 'validation_rule', id, quality.describeRule(type, r.params));
    return { status: 201, data: { id, description: quality.describeRule(type, r.params) } };
  });

  const loadRule = (user, id) => {
    const r = db.prepare('SELECT * FROM validation_rules WHERE id = ?').get(id);
    if (!r) throw notFound('Rule not found');
    loadMetric(user, r.metric_id, { manage: true });
    return r;
  };

  router.put('/api/rules/:id', ({ user, params, body }) => {
    const existing = loadRule(user, int(params.id, 'id'));
    const r = readRule(body, existing.type);
    db.prepare('UPDATE validation_rules SET params = ?, severity = ?, note = ?, active = ? WHERE id = ?').run(
      JSON.stringify(r.params), r.severity, r.note, r.active, existing.id
    );
    audit(db, user.id, 'update', 'validation_rule', existing.id, quality.describeRule(existing.type, r.params));
    return { ok: true };
  });

  router.delete('/api/rules/:id', ({ user, params }) => {
    const r = loadRule(user, int(params.id, 'id'));
    db.prepare('DELETE FROM validation_rules WHERE id = ?').run(r.id);
    audit(db, user.id, 'delete', 'validation_rule', r.id);
    return { ok: true };
  });

  // Issues --------------------------------------------------------------------------------
  router.get('/api/issues', ({ user, query }) => {
    const f = visibleFilter(user);
    const where = [f.sql];
    const args = [...f.params];
    const status = query.get('status') || 'open';
    if (status === 'open') where.push("i.status IN ('warning','investigating','confirmed_error')");
    else if (status !== 'all') {
      where.push('i.status = ?');
      args.push(oneOf(status, ['warning', 'investigating', 'confirmed_error', 'resolved', 'dismissed'], 'status'));
    }
    if (query.get('dashboardId')) {
      where.push('i.dashboard_id = ?');
      args.push(int(query.get('dashboardId'), 'dashboardId'));
    }
    if (query.get('mine') === '1') {
      where.push('d.owner_id = ?');
      args.push(user.id);
    }
    return db
      .prepare(
        `SELECT i.*, d.name AS dashboard_name, d.owner_id, m.name AS metric_name, u.name AS resolved_by_name
           FROM dq_issues i
           JOIN dashboards d ON d.id = i.dashboard_id
           LEFT JOIN metrics m ON m.id = i.metric_id
           LEFT JOIN users u ON u.id = i.resolved_by
          WHERE ${where.join(' AND ')}
          ORDER BY CASE i.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, i.id DESC
          LIMIT 500`
      )
      .all(...args)
      .map((i) => ({ ...i, canManage: user.isAdmin || i.owner_id === user.id }));
  });

  router.patch('/api/issues/:id', ({ user, params, body }) => {
    const issue = db.prepare('SELECT * FROM dq_issues WHERE id = ?').get(int(params.id, 'id'));
    if (!issue) throw notFound('Issue not found');
    const d = loadViewable(db, user, issue.dashboard_id);
    if (!canManage(user, d)) throw forbidden('Only the report owner or an administrator can update issues');
    const status = oneOf(body.status, ['warning', 'investigating', 'confirmed_error', 'resolved', 'dismissed'], 'status');
    const resolution = str(body, 'resolution', { max: 5000 });
    const closing = status === 'resolved' || status === 'dismissed';
    if (closing && !resolution) throw badRequest('Record the resolution and the reason for the change');
    db.prepare(
      `UPDATE dq_issues SET status = ?, resolution = COALESCE(?, resolution),
              resolved_by = ?, resolved_at = ${closing ? "datetime('now')" : 'NULL'} WHERE id = ?`
    ).run(status, resolution ?? null, closing ? user.id : null, issue.id);
    audit(db, user.id, `issue_${status}`, 'dq_issue', issue.id, resolution || '');
    return { ok: true };
  });

  router.get('/api/issues/:id/history', ({ user, params }) => {
    const issue = db.prepare('SELECT * FROM dq_issues WHERE id = ?').get(int(params.id, 'id'));
    if (!issue) throw notFound('Issue not found');
    loadViewable(db, user, issue.dashboard_id);
    return db
      .prepare(
        `SELECT a.action, a.details, a.created_at, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
          WHERE a.entity = 'dq_issue' AND a.entity_id = ? ORDER BY a.id`
      )
      .all(issue.id);
  });
}

module.exports = { register };
