'use strict';

const { badRequest, notFound, str, int, oneOf } = require('../http');
const { transaction } = require('../db');
const { audit } = require('../audit');
const { loadViewable, requireAdmin } = require('../permissions');
const scheduler = require('../scheduler');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseEmails(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[\s,;]+/);
  const emails = [...new Set(list.map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
  const bad = emails.filter((e) => !EMAIL_RE.test(e));
  if (bad.length) throw badRequest(`Invalid email address(es): ${bad.join(', ')}`);
  if (emails.length > 500) throw badRequest('A recipient group can have at most 500 members');
  return emails;
}

function register(router, { db, config }) {
  // Recipient groups ----------------------------------------------------------------------
  const ownGroup = (user, id) => {
    const g = db.prepare('SELECT * FROM recipient_groups WHERE id = ?').get(id);
    if (!g || (g.owner_id !== user.id && !user.isAdmin)) throw notFound('Recipient group not found');
    return g;
  };

  router.get('/api/recipient-groups', ({ user }) => {
    const groups = db
      .prepare('SELECT * FROM recipient_groups WHERE owner_id = ? ORDER BY name COLLATE NOCASE')
      .all(user.id);
    const members = db.prepare('SELECT email FROM recipient_group_members WHERE recipient_group_id = ? ORDER BY email');
    return groups.map((g) => ({ ...g, members: members.all(g.id).map((m) => m.email) }));
  });

  router.post('/api/recipient-groups', ({ user, body }) => {
    const name = str(body, 'name', { required: true, max: 100 });
    const emails = parseEmails(body.members);
    const id = transaction(db, () => {
      const info = db.prepare('INSERT INTO recipient_groups (name, owner_id) VALUES (?, ?)').run(name, user.id);
      const gid = Number(info.lastInsertRowid);
      const ins = db.prepare('INSERT INTO recipient_group_members (recipient_group_id, email) VALUES (?, ?)');
      emails.forEach((e) => ins.run(gid, e));
      return gid;
    });
    audit(db, user.id, 'create', 'recipient_group', id, name);
    return { status: 201, data: { id } };
  });

  router.put('/api/recipient-groups/:id', ({ user, params, body }) => {
    const g = ownGroup(user, int(params.id, 'id'));
    const name = str(body, 'name', { max: 100, def: g.name });
    const emails = parseEmails(body.members);
    transaction(db, () => {
      db.prepare('UPDATE recipient_groups SET name = ? WHERE id = ?').run(name, g.id);
      db.prepare('DELETE FROM recipient_group_members WHERE recipient_group_id = ?').run(g.id);
      const ins = db.prepare('INSERT INTO recipient_group_members (recipient_group_id, email) VALUES (?, ?)');
      emails.forEach((e) => ins.run(g.id, e));
    });
    audit(db, user.id, 'update', 'recipient_group', g.id, `${emails.length} members`);
    return { ok: true };
  });

  router.delete('/api/recipient-groups/:id', ({ user, params }) => {
    const g = ownGroup(user, int(params.id, 'id'));
    db.prepare('DELETE FROM recipient_groups WHERE id = ?').run(g.id);
    audit(db, user.id, 'delete', 'recipient_group', g.id);
    return { ok: true };
  });

  // Schedules -----------------------------------------------------------------------------
  const readSchedule = (user, body) => {
    const s = {
      dashboard_id: int(body.dashboardId, 'dashboardId'),
      recipient_group_id: int(body.recipientGroupId, 'recipientGroupId'),
      frequency: oneOf(body.frequency, ['daily', 'weekdays', 'weekly', 'monthly'], 'frequency'),
      time_of_day: str(body, 'timeOfDay', { required: true }),
      weekday: null,
      day_of_month: null,
      note: str(body, 'note', { max: 1000, def: '' }),
      active: body.active === undefined ? 1 : body.active ? 1 : 0,
    };
    if (!scheduler.TIME_RE.test(s.time_of_day)) throw badRequest("'timeOfDay' must be HH:MM (24h)");
    if (s.frequency === 'weekly') {
      s.weekday = int(body.weekday, 'weekday');
      if (s.weekday < 0 || s.weekday > 6) throw badRequest("'weekday' must be 0 (Sunday) to 6 (Saturday)");
    }
    if (s.frequency === 'monthly') {
      s.day_of_month = int(body.dayOfMonth, 'dayOfMonth');
      if (s.day_of_month < 1 || s.day_of_month > 28) throw badRequest("'dayOfMonth' must be between 1 and 28");
    }
    loadViewable(db, user, s.dashboard_id);
    ownGroup(user, s.recipient_group_id);
    s.next_run_at = s.active ? scheduler.computeNextRun(s).toISOString() : null;
    return s;
  };

  const ownSchedule = (user, id) => {
    const s = db.prepare('SELECT * FROM schedules WHERE id = ?').get(id);
    if (!s || (s.owner_id !== user.id && !user.isAdmin)) throw notFound('Schedule not found');
    return s;
  };

  router.get('/api/schedules', ({ user, query }) => {
    const all = user.isAdmin && query.get('all') === '1';
    const rows = db
      .prepare(
        `SELECT s.*, d.name AS dashboard_name, g.name AS group_name, u.name AS owner_name,
                (SELECT COUNT(*) FROM recipient_group_members m WHERE m.recipient_group_id = s.recipient_group_id) AS recipients,
                (SELECT status FROM deliveries x WHERE x.schedule_id = s.id ORDER BY x.id DESC LIMIT 1) AS last_status
           FROM schedules s
           JOIN dashboards d ON d.id = s.dashboard_id
           JOIN recipient_groups g ON g.id = s.recipient_group_id
           JOIN users u ON u.id = s.owner_id
          ${all ? '' : 'WHERE s.owner_id = ?'}
          ORDER BY d.name COLLATE NOCASE`
      )
      .all(...(all ? [] : [user.id]));
    return rows.map((s) => ({ ...s, description: scheduler.describe(s) }));
  });

  router.post('/api/schedules', ({ user, body }) => {
    const s = readSchedule(user, body);
    const info = db
      .prepare(
        `INSERT INTO schedules (dashboard_id, owner_id, recipient_group_id, frequency, weekday, day_of_month, time_of_day, note, active, next_run_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(s.dashboard_id, user.id, s.recipient_group_id, s.frequency, s.weekday, s.day_of_month, s.time_of_day, s.note, s.active, s.next_run_at);
    const id = Number(info.lastInsertRowid);
    audit(db, user.id, 'create', 'schedule', id, scheduler.describe(s));
    return { status: 201, data: { id, nextRunAt: s.next_run_at } };
  });

  router.put('/api/schedules/:id', ({ user, params, body }) => {
    const existing = ownSchedule(user, int(params.id, 'id'));
    const s = readSchedule(user, body);
    db.prepare(
      `UPDATE schedules SET dashboard_id = ?, recipient_group_id = ?, frequency = ?, weekday = ?, day_of_month = ?,
              time_of_day = ?, note = ?, active = ?, next_run_at = ? WHERE id = ?`
    ).run(s.dashboard_id, s.recipient_group_id, s.frequency, s.weekday, s.day_of_month, s.time_of_day, s.note, s.active, s.next_run_at, existing.id);
    audit(db, user.id, 'update', 'schedule', existing.id, scheduler.describe(s));
    return { ok: true, nextRunAt: s.next_run_at };
  });

  router.delete('/api/schedules/:id', ({ user, params }) => {
    const s = ownSchedule(user, int(params.id, 'id'));
    db.prepare('DELETE FROM schedules WHERE id = ?').run(s.id);
    audit(db, user.id, 'delete', 'schedule', s.id);
    return { ok: true };
  });

  router.post('/api/schedules/:id/run', ({ user, params }) => {
    const s = ownSchedule(user, int(params.id, 'id'));
    const status = scheduler.deliver(db, s, config.baseUrl);
    audit(db, user.id, 'run_now', 'schedule', s.id, status);
    return { status };
  });

  router.get('/api/schedules/:id/deliveries', ({ user, params }) => {
    const s = ownSchedule(user, int(params.id, 'id'));
    return db.prepare('SELECT * FROM deliveries WHERE schedule_id = ? ORDER BY id DESC LIMIT 50').all(s.id);
  });

  router.get('/api/admin/outbox', ({ user }) => {
    requireAdmin(user);
    return db.prepare('SELECT * FROM outbox ORDER BY id DESC LIMIT 200').all();
  });
}

module.exports = { register };
