'use strict';

const { badRequest, notFound, str, int, oneOf } = require('../http');
const { transaction } = require('../db');
const { audit } = require('../audit');
const { visibleFilter, canManage, loadViewable, loadManageable } = require('../permissions');

const TEXT_FIELDS = {
  name: 200, description: 5000, purpose: 2000, topic: 100, department: 100, project: 100, tool: 100,
  url: 2000, data_sources: 2000, update_frequency: 200, instructions: 10000, limitations: 5000,
};

// Fields that make up the standardised information page; used for the documentation-completeness score.
const DOC_FIELDS = ['description', 'purpose', 'data_sources', 'update_frequency', 'instructions', 'limitations', 'owner_id'];

const STOPWORDS = new Set(
  'a an and are as at be by for from how i in is it of on or show showing the to what which with where who per'.split(' ')
);

function completeness(d) {
  const filled = DOC_FIELDS.filter((f) => d[f] !== null && d[f] !== undefined && String(d[f]).trim() !== '').length;
  return Math.round((filled / DOC_FIELDS.length) * 100);
}

// Turns free text ("customer lifetime by sales channel") into an FTS5 OR-query of prefix terms.
// Ranking (bm25) rewards dashboards matching more of the terms.
function ftsQuery(q) {
  const terms = String(q)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t && !STOPWORDS.has(t))
    .slice(0, 12);
  if (!terms.length) return null;
  return [...new Set(terms)].map((t) => `"${t}"*`).join(' OR ');
}

function validUrl(u) {
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function parseTags(value) {
  if (value === undefined) return undefined;
  const list = Array.isArray(value) ? value : String(value).split(',');
  return [...new Set(list.map((t) => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 30);
}

function tagsFor(db, id) {
  return db.prepare('SELECT tag FROM dashboard_tags WHERE dashboard_id = ? ORDER BY tag').all(id).map((r) => r.tag);
}

function reindex(db, id) {
  db.prepare('DELETE FROM dashboards_fts WHERE rowid = ?').run(id);
  const d = db.prepare('SELECT * FROM dashboards WHERE id = ?').get(id);
  if (!d) return;
  db.prepare(
    `INSERT INTO dashboards_fts (rowid, name, description, purpose, topic, department, project, tags, instructions)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, d.name, d.description, d.purpose, d.topic, d.department, d.project, tagsFor(db, id).join(' '), d.instructions);
}

function summary(db, d, user) {
  return {
    id: d.id,
    name: d.name,
    description: d.description,
    topic: d.topic,
    department: d.department,
    project: d.project,
    tool: d.tool,
    visibility: d.visibility,
    owner: d.owner_id ? { id: d.owner_id, name: d.owner_name } : null,
    tags: tagsFor(db, d.id),
    updatedAt: d.updated_at,
    lastRefreshedAt: d.last_refreshed_at,
    completeness: completeness(d),
    isFavorite: !!db.prepare('SELECT 1 FROM favorites WHERE user_id = ? AND dashboard_id = ?').get(user.id, d.id),
    openIssues: db
      .prepare("SELECT COUNT(*) n FROM dq_issues WHERE dashboard_id = ? AND status IN ('warning','investigating','confirmed_error')")
      .get(d.id).n,
  };
}

function readFields(body, { partial }) {
  const out = {};
  for (const [key, max] of Object.entries(TEXT_FIELDS)) {
    const required = !partial && (key === 'name' || key === 'url');
    if (partial && body[key] === undefined) continue;
    out[key] = str(body, key, { required, max, def: '' });
  }
  if ((out.name !== undefined || !partial) && !out.name) throw badRequest("'name' is required");
  if (out.url !== undefined && !validUrl(out.url)) throw badRequest("'url' must be an http(s) URL");
  if (body.visibility !== undefined) out.visibility = oneOf(body.visibility, ['public', 'restricted'], 'visibility');
  if (body.stale_after_hours !== undefined) {
    out.stale_after_hours = body.stale_after_hours === null || body.stale_after_hours === '' ? null : int(body.stale_after_hours, 'stale_after_hours');
    if (out.stale_after_hours !== null && out.stale_after_hours <= 0) throw badRequest("'stale_after_hours' must be positive");
  }
  if (body.owner_id !== undefined) out.owner_id = body.owner_id === null ? null : int(body.owner_id, 'owner_id');
  return out;
}

function register(router, { db }) {
  // Library search with keyword ranking and filters ---------------------------------
  router.get('/api/dashboards', ({ user, query }) => {
    const f = visibleFilter(user);
    const where = [f.sql];
    const params = [...f.params];
    let join = '';
    let order = 'd.name COLLATE NOCASE';

    const q = (query.get('q') || '').trim();
    const match = q ? ftsQuery(q) : null;
    if (match) {
      join = 'JOIN dashboards_fts fts ON fts.rowid = d.id';
      where.push('dashboards_fts MATCH ?');
      params.push(match);
      // Weight name and tags highest, then description/purpose.
      order = 'bm25(dashboards_fts, 10.0, 4.0, 3.0, 2.0, 1.0, 1.0, 6.0, 1.0)';
    }
    for (const field of ['topic', 'department', 'project', 'tool']) {
      const v = query.get(field);
      if (v) {
        where.push(`d.${field} = ? COLLATE NOCASE`);
        params.push(v);
      }
    }
    const tag = query.get('tag');
    if (tag) {
      where.push('EXISTS (SELECT 1 FROM dashboard_tags t WHERE t.dashboard_id = d.id AND t.tag = ?)');
      params.push(tag.toLowerCase());
    }
    const owner = query.get('owner');
    if (owner) {
      where.push('d.owner_id = ?');
      params.push(int(owner, 'owner'));
    }
    if (query.get('favorites') === '1') {
      where.push('EXISTS (SELECT 1 FROM favorites fv WHERE fv.dashboard_id = d.id AND fv.user_id = ?)');
      params.push(user.id);
    }
    const sort = query.get('sort');
    if (sort === 'recent') order = 'd.updated_at DESC';
    if (sort === 'popular') order = '(SELECT COUNT(*) FROM dashboard_views v WHERE v.dashboard_id = d.id) DESC';

    const rows = db
      .prepare(
        `SELECT d.*, u.name AS owner_name FROM dashboards d ${join}
           LEFT JOIN users u ON u.id = d.owner_id
          WHERE ${where.join(' AND ')}
          ORDER BY ${order}
          LIMIT 200`
      )
      .all(...params);

    if (q) db.prepare('INSERT INTO search_log (user_id, query, results) VALUES (?, ?, ?)').run(user.id, q.slice(0, 500), rows.length);
    return rows.map((d) => summary(db, d, user));
  });

  // Filter options (only values present among dashboards the user may see).
  router.get('/api/facets', ({ user }) => {
    const f = visibleFilter(user);
    const distinct = (col) =>
      db
        .prepare(`SELECT DISTINCT d.${col} v FROM dashboards d WHERE ${f.sql} AND d.${col} <> '' ORDER BY v COLLATE NOCASE`)
        .all(...f.params)
        .map((r) => r.v);
    return {
      topics: distinct('topic'),
      departments: distinct('department'),
      projects: distinct('project'),
      tools: distinct('tool'),
      tags: db
        .prepare(
          `SELECT t.tag, COUNT(*) n FROM dashboard_tags t JOIN dashboards d ON d.id = t.dashboard_id
            WHERE ${f.sql} GROUP BY t.tag ORDER BY n DESC, t.tag LIMIT 50`
        )
        .all(...f.params)
        .map((r) => r.tag),
      owners: db
        .prepare(
          `SELECT DISTINCT u.id, u.name FROM dashboards d JOIN users u ON u.id = d.owner_id
            WHERE ${f.sql} ORDER BY u.name`
        )
        .all(...f.params),
    };
  });

  // Standardised information page -------------------------------------------------------
  router.get('/api/dashboards/:id', ({ user, params }) => {
    const id = int(params.id, 'id');
    const d = loadViewable(db, user, id);
    db.prepare("INSERT INTO dashboard_views (dashboard_id, user_id, action) VALUES (?, ?, 'view')").run(id, user.id);
    const owner = d.owner_id ? db.prepare('SELECT id, name, email, department FROM users WHERE id = ?').get(d.owner_id) : null;
    const manage = canManage(user, d);
    const result = {
      ...d,
      owner,
      tags: tagsFor(db, id),
      completeness: completeness(d),
      canManage: manage,
      isFavorite: !!db.prepare('SELECT 1 FROM favorites WHERE user_id = ? AND dashboard_id = ?').get(user.id, id),
      folderIds: db
        .prepare('SELECT fi.folder_id FROM folder_items fi JOIN folders f ON f.id = fi.folder_id WHERE f.user_id = ? AND fi.dashboard_id = ?')
        .all(user.id, id)
        .map((r) => r.folder_id),
      stats: {
        views30d: db
          .prepare("SELECT COUNT(*) n FROM dashboard_views WHERE dashboard_id = ? AND created_at >= datetime('now', '-30 days')")
          .get(id).n,
        comments: db.prepare('SELECT COUNT(*) n FROM comments WHERE dashboard_id = ?').get(id).n,
        favorites: db.prepare('SELECT COUNT(*) n FROM favorites WHERE dashboard_id = ?').get(id).n,
      },
      openIssues: db
        .prepare(
          `SELECT id, rule_type, period, message, severity, status, created_at FROM dq_issues
            WHERE dashboard_id = ? AND status IN ('warning','investigating','confirmed_error') ORDER BY id DESC`
        )
        .all(id),
    };
    if (manage) result.access = accessList(db, id);
    return result;
  });

  // Follow-through link to the original report; logged to measure usage.
  router.get('/api/dashboards/:id/open', ({ user, params, res }) => {
    const id = int(params.id, 'id');
    const d = loadViewable(db, user, id);
    db.prepare("INSERT INTO dashboard_views (dashboard_id, user_id, action) VALUES (?, ?, 'open')").run(id, user.id);
    res.writeHead(302, { Location: d.url });
    res.end();
  });

  router.post('/api/dashboards', ({ user, body }) => {
    const fields = readFields(body, { partial: false });
    if (fields.owner_id === undefined) fields.owner_id = user.id;
    if (!user.isAdmin && fields.owner_id !== user.id) throw badRequest('Only administrators can assign another owner');
    if (fields.owner_id !== null && !db.prepare('SELECT 1 FROM users WHERE id = ?').get(fields.owner_id)) throw badRequest('Unknown owner');
    const tags = parseTags(body.tags) || [];
    const id = transaction(db, () => {
      const cols = Object.keys(fields);
      const info = db
        .prepare(`INSERT INTO dashboards (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...cols.map((c) => fields[c]));
      const newId = Number(info.lastInsertRowid);
      const ins = db.prepare('INSERT INTO dashboard_tags (dashboard_id, tag) VALUES (?, ?)');
      tags.forEach((t) => ins.run(newId, t));
      reindex(db, newId);
      audit(db, user.id, 'create', 'dashboard', newId, fields.name);
      return newId;
    });
    return { status: 201, data: { id } };
  });

  router.patch('/api/dashboards/:id', ({ user, params, body }) => {
    const id = int(params.id, 'id');
    const existing = loadManageable(db, user, id);
    const fields = readFields(body, { partial: true });
    if (fields.owner_id !== undefined && fields.owner_id !== existing.owner_id) {
      if (fields.owner_id !== null && !db.prepare('SELECT 1 FROM users WHERE id = ?').get(fields.owner_id)) throw badRequest('Unknown owner');
    }
    const tags = parseTags(body.tags);
    transaction(db, () => {
      const cols = Object.keys(fields);
      if (cols.length) {
        db.prepare(`UPDATE dashboards SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(
          ...cols.map((c) => fields[c]),
          id
        );
      }
      if (tags) {
        db.prepare('DELETE FROM dashboard_tags WHERE dashboard_id = ?').run(id);
        const ins = db.prepare('INSERT INTO dashboard_tags (dashboard_id, tag) VALUES (?, ?)');
        tags.forEach((t) => ins.run(id, t));
      }
      reindex(db, id);
      audit(db, user.id, 'update', 'dashboard', id, { fields: cols, tags: tags !== undefined });
    });
    return { ok: true };
  });

  router.delete('/api/dashboards/:id', ({ user, params }) => {
    const id = int(params.id, 'id');
    const d = loadManageable(db, user, id);
    transaction(db, () => {
      db.prepare('DELETE FROM dashboards WHERE id = ?').run(id);
      db.prepare('DELETE FROM dashboards_fts WHERE rowid = ?').run(id);
      audit(db, user.id, 'delete', 'dashboard', id, d.name);
    });
    return { ok: true };
  });

  // Mark the underlying report as refreshed (called by integrations or the owner).
  router.post('/api/dashboards/:id/refreshed', ({ user, params, body }) => {
    const id = int(params.id, 'id');
    loadManageable(db, user, id);
    const at = str(body, 'at', { def: new Date().toISOString() });
    if (Number.isNaN(Date.parse(at))) throw badRequest("'at' must be an ISO timestamp");
    db.prepare('UPDATE dashboards SET last_refreshed_at = ? WHERE id = ?').run(new Date(at).toISOString(), id);
    return { ok: true };
  });

  // Access management --------------------------------------------------------------------
  router.get('/api/dashboards/:id/access', ({ user, params }) => {
    const id = int(params.id, 'id');
    loadManageable(db, user, id);
    return accessList(db, id);
  });

  router.put('/api/dashboards/:id/access', ({ user, params, body }) => {
    const id = int(params.id, 'id');
    loadManageable(db, user, id);
    const visibility = oneOf(body.visibility ?? 'restricted', ['public', 'restricted'], 'visibility');
    const userIds = (Array.isArray(body.users) ? body.users : []).map((v) => int(v, 'users'));
    const groupIds = (Array.isArray(body.groups) ? body.groups : []).map((v) => int(v, 'groups'));
    for (const uid of userIds) if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(uid)) throw badRequest(`Unknown user ${uid}`);
    for (const gid of groupIds) if (!db.prepare('SELECT 1 FROM user_groups WHERE id = ?').get(gid)) throw badRequest(`Unknown group ${gid}`);
    transaction(db, () => {
      db.prepare("UPDATE dashboards SET visibility = ?, updated_at = datetime('now') WHERE id = ?").run(visibility, id);
      db.prepare('DELETE FROM dashboard_access WHERE dashboard_id = ?').run(id);
      const ins = db.prepare('INSERT INTO dashboard_access (dashboard_id, principal_type, principal_id) VALUES (?, ?, ?)');
      [...new Set(userIds)].forEach((uid) => ins.run(id, 'user', uid));
      [...new Set(groupIds)].forEach((gid) => ins.run(id, 'group', gid));
      audit(db, user.id, 'set_access', 'dashboard', id, { visibility, users: userIds, groups: groupIds });
    });
    return accessList(db, id);
  });

  router.get('/api/directory', () => ({
    users: db.prepare('SELECT id, name, email, department FROM users WHERE active = 1 ORDER BY name').all(),
    groups: db.prepare('SELECT id, name, description FROM user_groups ORDER BY name').all(),
  }));
}

function accessList(db, id) {
  const d = db.prepare('SELECT visibility FROM dashboards WHERE id = ?').get(id);
  if (!d) throw notFound();
  return {
    visibility: d.visibility,
    users: db
      .prepare(
        `SELECT u.id, u.name, u.email FROM dashboard_access a JOIN users u ON u.id = a.principal_id
          WHERE a.dashboard_id = ? AND a.principal_type = 'user' ORDER BY u.name`
      )
      .all(id),
    groups: db
      .prepare(
        `SELECT g.id, g.name FROM dashboard_access a JOIN user_groups g ON g.id = a.principal_id
          WHERE a.dashboard_id = ? AND a.principal_type = 'group' ORDER BY g.name`
      )
      .all(id),
  };
}

module.exports = { register, reindex, ftsQuery, completeness };
