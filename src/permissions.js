'use strict';

const { forbidden, notFound } = require('./http');

// SQL fragment restricting the dashboard alias `d` to those the user may view.
// Bind parameters: userId, userId, userId (see visibleParams).
const VISIBLE_SQL = `(
  d.visibility = 'public'
  OR d.owner_id = ?
  OR EXISTS (SELECT 1 FROM dashboard_access a
              WHERE a.dashboard_id = d.id AND a.principal_type = 'user' AND a.principal_id = ?)
  OR EXISTS (SELECT 1 FROM dashboard_access a
               JOIN group_members gm ON gm.group_id = a.principal_id
              WHERE a.dashboard_id = d.id AND a.principal_type = 'group' AND gm.user_id = ?)
)`;

function visibleFilter(user) {
  if (user.isAdmin) return { sql: '1 = 1', params: [] };
  return { sql: VISIBLE_SQL, params: [user.id, user.id, user.id] };
}

function canView(db, user, dashboardId) {
  const f = visibleFilter(user);
  return !!db.prepare(`SELECT 1 FROM dashboards d WHERE d.id = ? AND ${f.sql}`).get(dashboardId, ...f.params);
}

function canManage(user, dashboard) {
  return user.isAdmin || dashboard.owner_id === user.id;
}

// Loads a dashboard the user may view; 404 rather than 403 so restricted reports are not disclosed.
function loadViewable(db, user, dashboardId) {
  const d = db.prepare('SELECT * FROM dashboards WHERE id = ?').get(dashboardId);
  if (!d || !canView(db, user, dashboardId)) throw notFound('Dashboard not found');
  return d;
}

function loadManageable(db, user, dashboardId) {
  const d = loadViewable(db, user, dashboardId);
  if (!canManage(user, d)) throw forbidden('Only the dashboard owner or an administrator can do this');
  return d;
}

function requireAdmin(user) {
  if (!user.isAdmin) throw forbidden('Administrator access required');
}

module.exports = { visibleFilter, canView, canManage, loadViewable, loadManageable, requireAdmin };
