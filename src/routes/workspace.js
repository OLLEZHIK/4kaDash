'use strict';

const { badRequest, notFound, forbidden, str, int, oneOf } = require('../http');
const { audit, notify } = require('../audit');
const { visibleFilter, loadViewable, canManage } = require('../permissions');

const COMMENT_KINDS = ['feedback', 'data_issue', 'suggestion', 'question'];

function register(router, { db }) {
  // Favorites ---------------------------------------------------------------------------
  router.put('/api/favorites/:id', ({ user, params }) => {
    const id = int(params.id, 'id');
    loadViewable(db, user, id);
    db.prepare('INSERT OR IGNORE INTO favorites (user_id, dashboard_id) VALUES (?, ?)').run(user.id, id);
    return { ok: true };
  });

  router.delete('/api/favorites/:id', ({ user, params }) => {
    db.prepare('DELETE FROM favorites WHERE user_id = ? AND dashboard_id = ?').run(user.id, int(params.id, 'id'));
    return { ok: true };
  });

  // Personal folders ---------------------------------------------------------------------
  const ownFolder = (user, id) => {
    const f = db.prepare('SELECT * FROM folders WHERE id = ? AND user_id = ?').get(id, user.id);
    if (!f) throw notFound('Folder not found');
    return f;
  };

  router.get('/api/folders', ({ user }) => {
    const f = visibleFilter(user);
    const folders = db.prepare('SELECT * FROM folders WHERE user_id = ? ORDER BY name COLLATE NOCASE').all(user.id);
    // Items the user has since lost access to are hidden rather than leaked.
    const items = db.prepare(
      `SELECT d.id, d.name, d.description, d.topic, d.tool FROM folder_items fi
         JOIN dashboards d ON d.id = fi.dashboard_id
        WHERE fi.folder_id = ? AND ${f.sql} ORDER BY d.name COLLATE NOCASE`
    );
    return folders.map((folder) => ({ ...folder, items: items.all(folder.id, ...f.params) }));
  });

  router.post('/api/folders', ({ user, body }) => {
    const name = str(body, 'name', { required: true, max: 100 });
    if (db.prepare('SELECT 1 FROM folders WHERE user_id = ? AND name = ?').get(user.id, name)) throw badRequest('You already have a folder with this name');
    const info = db.prepare('INSERT INTO folders (user_id, name) VALUES (?, ?)').run(user.id, name);
    return { status: 201, data: { id: Number(info.lastInsertRowid), name } };
  });

  router.patch('/api/folders/:id', ({ user, params, body }) => {
    const folder = ownFolder(user, int(params.id, 'id'));
    const name = str(body, 'name', { required: true, max: 100 });
    if (db.prepare('SELECT 1 FROM folders WHERE user_id = ? AND name = ? AND id <> ?').get(user.id, name, folder.id)) {
      throw badRequest('You already have a folder with this name');
    }
    db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(name, folder.id);
    return { ok: true };
  });

  router.delete('/api/folders/:id', ({ user, params }) => {
    const folder = ownFolder(user, int(params.id, 'id'));
    db.prepare('DELETE FROM folders WHERE id = ?').run(folder.id);
    return { ok: true };
  });

  router.put('/api/folders/:id/items/:dashboardId', ({ user, params }) => {
    const folder = ownFolder(user, int(params.id, 'id'));
    const did = int(params.dashboardId, 'dashboardId');
    loadViewable(db, user, did);
    db.prepare('INSERT OR IGNORE INTO folder_items (folder_id, dashboard_id) VALUES (?, ?)').run(folder.id, did);
    return { ok: true };
  });

  router.delete('/api/folders/:id/items/:dashboardId', ({ user, params }) => {
    const folder = ownFolder(user, int(params.id, 'id'));
    db.prepare('DELETE FROM folder_items WHERE folder_id = ? AND dashboard_id = ?').run(folder.id, int(params.dashboardId, 'dashboardId'));
    return { ok: true };
  });

  // Comments ------------------------------------------------------------------------------
  router.get('/api/dashboards/:id/comments', ({ user, params, query }) => {
    const id = int(params.id, 'id');
    const d = loadViewable(db, user, id);
    const where = ['c.dashboard_id = ?'];
    const args = [id];
    if (query.get('author') === 'owner') {
      where.push('c.user_id = ?');
      args.push(d.owner_id ?? -1);
    }
    const kind = query.get('kind');
    if (kind) {
      where.push('c.kind = ?');
      args.push(oneOf(kind, COMMENT_KINDS, 'kind'));
    }
    return db
      .prepare(
        `SELECT c.id, c.kind, c.body, c.created_at, c.user_id, u.name AS author_name
           FROM comments c LEFT JOIN users u ON u.id = c.user_id
          WHERE ${where.join(' AND ')} ORDER BY c.created_at DESC, c.id DESC`
      )
      .all(...args)
      .map((c) => ({
        id: c.id,
        kind: c.kind,
        body: c.body,
        createdAt: c.created_at,
        author: c.user_id ? { id: c.user_id, name: c.author_name } : null,
        isOwner: c.user_id !== null && c.user_id === d.owner_id,
        canDelete: user.isAdmin || c.user_id === user.id || canManage(user, d),
      }));
  });

  router.post('/api/dashboards/:id/comments', ({ user, params, body }) => {
    const id = int(params.id, 'id');
    const d = loadViewable(db, user, id);
    const text = str(body, 'body', { required: true, max: 5000 });
    const kind = oneOf(body.kind ?? 'feedback', COMMENT_KINDS, 'kind');
    const info = db.prepare('INSERT INTO comments (dashboard_id, user_id, kind, body) VALUES (?, ?, ?, ?)').run(id, user.id, kind, text);
    if (d.owner_id && d.owner_id !== user.id) {
      const label = { feedback: 'commented on', data_issue: 'reported a data issue on', suggestion: 'suggested an improvement to', question: 'asked a question about' }[kind];
      notify(db, d.owner_id, `${user.name} ${label} "${d.name}"`, `#/dashboards/${id}`);
    }
    audit(db, user.id, 'comment', 'dashboard', id, kind);
    return { status: 201, data: { id: Number(info.lastInsertRowid) } };
  });

  router.delete('/api/comments/:id', ({ user, params }) => {
    const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(int(params.id, 'id'));
    if (!c) throw notFound('Comment not found');
    const d = loadViewable(db, user, c.dashboard_id);
    if (!(user.isAdmin || c.user_id === user.id || canManage(user, d))) throw forbidden('You cannot delete this comment');
    db.prepare('DELETE FROM comments WHERE id = ?').run(c.id);
    audit(db, user.id, 'delete_comment', 'dashboard', c.dashboard_id, String(c.id));
    return { ok: true };
  });
}

module.exports = { register };
