'use strict';

const { badRequest, notFound, str, int } = require('../http');
const { hashPassword } = require('../auth');
const { audit } = require('../audit');
const { requireAdmin } = require('../permissions');
const { completeness } = require('./dashboards');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function register(router, { db }) {
  // Users -----------------------------------------------------------------------------
  router.get('/api/admin/users', ({ user }) => {
    requireAdmin(user);
    return db
      .prepare(
        `SELECT u.id, u.email, u.name, u.department, u.is_admin, u.active, u.created_at,
                (SELECT group_concat(g.name, ', ') FROM group_members gm JOIN user_groups g ON g.id = gm.group_id
                  WHERE gm.user_id = u.id) AS groups
           FROM users u ORDER BY u.name`
      )
      .all();
  });

  router.post('/api/admin/users', ({ user, body }) => {
    requireAdmin(user);
    const email = str(body, 'email', { required: true, max: 320 });
    if (!EMAIL_RE.test(email)) throw badRequest('Invalid email');
    const name = str(body, 'name', { required: true, max: 200 });
    const password = str(body, 'password', { required: true, max: 1000 });
    if (password.length < 8) throw badRequest('Password must be at least 8 characters');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw badRequest('A user with this email already exists');
    const info = db
      .prepare('INSERT INTO users (email, name, password_hash, department, is_admin) VALUES (?, ?, ?, ?, ?)')
      .run(email, name, hashPassword(password), str(body, 'department', { max: 100, def: '' }), body.isAdmin ? 1 : 0);
    const id = Number(info.lastInsertRowid);
    audit(db, user.id, 'create', 'user', id, email);
    return { status: 201, data: { id } };
  });

  router.patch('/api/admin/users/:id', ({ user, params, body }) => {
    requireAdmin(user);
    const id = int(params.id, 'id');
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) throw notFound('User not found');
    const sets = [];
    const args = [];
    if (body.name !== undefined) { sets.push('name = ?'); args.push(str(body, 'name', { required: true, max: 200 })); }
    if (body.department !== undefined) { sets.push('department = ?'); args.push(str(body, 'department', { max: 100, def: '' })); }
    if (body.isAdmin !== undefined) {
      if (id === user.id && !body.isAdmin) throw badRequest('You cannot remove your own administrator role');
      sets.push('is_admin = ?'); args.push(body.isAdmin ? 1 : 0);
    }
    if (body.active !== undefined) {
      if (id === user.id && !body.active) throw badRequest('You cannot deactivate yourself');
      sets.push('active = ?'); args.push(body.active ? 1 : 0);
      if (!body.active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    }
    if (body.password !== undefined) {
      const pw = str(body, 'password', { required: true, max: 1000 });
      if (pw.length < 8) throw badRequest('Password must be at least 8 characters');
      sets.push('password_hash = ?'); args.push(hashPassword(pw));
    }
    if (sets.length) db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
    audit(db, user.id, 'update', 'user', id, Object.keys(body).filter((k) => k !== 'password').join(','));
    return { ok: true };
  });

  // Access groups ----------------------------------------------------------------------
  router.get('/api/admin/groups', ({ user }) => {
    requireAdmin(user);
    const groups = db.prepare('SELECT * FROM user_groups ORDER BY name').all();
    const members = db.prepare(
      'SELECT u.id, u.name, u.email FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ? ORDER BY u.name'
    );
    return groups.map((g) => ({ ...g, members: members.all(g.id) }));
  });

  router.post('/api/admin/groups', ({ user, body }) => {
    requireAdmin(user);
    const name = str(body, 'name', { required: true, max: 100 });
    if (db.prepare('SELECT 1 FROM user_groups WHERE name = ?').get(name)) throw badRequest('A group with this name already exists');
    const info = db.prepare('INSERT INTO user_groups (name, description) VALUES (?, ?)').run(name, str(body, 'description', { max: 1000, def: '' }));
    const id = Number(info.lastInsertRowid);
    audit(db, user.id, 'create', 'group', id, name);
    return { status: 201, data: { id } };
  });

  router.put('/api/admin/groups/:id/members', ({ user, params, body }) => {
    requireAdmin(user);
    const id = int(params.id, 'id');
    if (!db.prepare('SELECT 1 FROM user_groups WHERE id = ?').get(id)) throw notFound('Group not found');
    const ids = [...new Set((Array.isArray(body.userIds) ? body.userIds : []).map((v) => int(v, 'userIds')))];
    for (const uid of ids) if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(uid)) throw badRequest(`Unknown user ${uid}`);
    db.prepare('DELETE FROM group_members WHERE group_id = ?').run(id);
    const ins = db.prepare('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)');
    ids.forEach((uid) => ins.run(id, uid));
    audit(db, user.id, 'set_members', 'group', id, ids.join(','));
    return { ok: true };
  });

  router.delete('/api/admin/groups/:id', ({ user, params }) => {
    requireAdmin(user);
    const id = int(params.id, 'id');
    db.prepare('DELETE FROM user_groups WHERE id = ?').run(id);
    db.prepare("DELETE FROM dashboard_access WHERE principal_type = 'group' AND principal_id = ?").run(id);
    audit(db, user.id, 'delete', 'group', id);
    return { ok: true };
  });

  router.get('/api/admin/audit', ({ user, query }) => {
    requireAdmin(user);
    const limit = Math.min(int(query.get('limit') || 200, 'limit'), 1000);
    return db
      .prepare(
        `SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
          ORDER BY a.id DESC LIMIT ?`
      )
      .all(limit);
  });

  // Success indicators from section 7 of the product plan.
  router.get('/api/admin/metrics', ({ user }) => {
    requireAdmin(user);
    const one = (sql, ...a) => db.prepare(sql).get(...a);
    const dashboards = db.prepare('SELECT * FROM dashboards').all();
    const complete = dashboards.filter((d) => completeness(d) === 100).length;
    const searches = one(
      "SELECT COUNT(*) total, SUM(results = 0) zero FROM search_log WHERE created_at >= datetime('now', '-30 days')"
    );
    const deliveries = one(
      "SELECT COUNT(*) total, SUM(status = 'sent') sent FROM deliveries WHERE created_at >= datetime('now', '-30 days')"
    );
    return {
      dashboards: dashboards.length,
      fullyDocumented: complete,
      documentationRate: dashboards.length ? Math.round((complete / dashboards.length) * 100) : 0,
      averageCompleteness: dashboards.length
        ? Math.round(dashboards.reduce((s, d) => s + completeness(d), 0) / dashboards.length)
        : 0,
      activeUsers30d: one(
        "SELECT COUNT(DISTINCT user_id) n FROM dashboard_views WHERE created_at >= datetime('now', '-30 days')"
      ).n,
      searches30d: searches.total,
      zeroResultSearches30d: searches.zero || 0,
      topZeroResultQueries: db
        .prepare(
          `SELECT lower(query) query, COUNT(*) n FROM search_log
            WHERE results = 0 AND created_at >= datetime('now', '-30 days')
            GROUP BY lower(query) ORDER BY n DESC LIMIT 10`
        )
        .all(),
      topDashboards: db
        .prepare(
          `SELECT d.id, d.name, COUNT(*) views FROM dashboard_views v JOIN dashboards d ON d.id = v.dashboard_id
            WHERE v.created_at >= datetime('now', '-30 days') GROUP BY d.id ORDER BY views DESC LIMIT 10`
        )
        .all(),
      questionsAsked30d: one(
        "SELECT COUNT(*) n FROM comments WHERE kind = 'question' AND created_at >= datetime('now', '-30 days')"
      ).n,
      issuesDetected: one('SELECT COUNT(*) n FROM dq_issues').n,
      issuesResolved: one("SELECT COUNT(*) n FROM dq_issues WHERE status IN ('resolved','dismissed')").n,
      deliveries30d: deliveries.total,
      deliverySuccessRate: deliveries.total ? Math.round(((deliveries.sent || 0) / deliveries.total) * 100) : null,
    };
  });
}

module.exports = { register };
