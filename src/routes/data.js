'use strict';

const { HttpError, badRequest, notFound, int } = require('../http');
const { audit } = require('../audit');
const { createSession } = require('../auth');

// Data gateway endpoints: list the datasets a user may read and return their rows.
function register(router, { db, gateway }) {
  const groupsOf = (user) => db.prepare(
    'SELECT g.name FROM user_groups g JOIN group_members m ON m.group_id = g.id WHERE m.user_id = ?'
  ).all(user.id).map((r) => r.name);

  router.get('/api/data/sources', ({ user }) => gateway.list(groupsOf(user), user.isAdmin));

  router.get('/api/data/:source/:dataset', async ({ user, params, query }) => {
    const opts = {
      from: query.get('from') || null,
      to: query.get('to') || null,
      limit: query.get('limit') ? int(query.get('limit'), 'limit') : undefined,
    };
    let result;
    try {
      result = await gateway.fetch(params.source, params.dataset, opts, groupsOf(user), user.isAdmin);
    } catch (err) {
      if (err instanceof RangeError) throw badRequest(err.message);
      console.error(`Data source ${params.source}/${params.dataset} failed:`, err.message);
      throw new HttpError(502, 'Data source is not available');
    }
    if (!result) throw notFound('Dataset not found');
    audit(db, user.id, 'data.read', 'dataset', null, {
      source: params.source, dataset: params.dataset, from: opts.from, to: opts.to, rows: result.rowCount, removed: result.removedColumns,
    });
    return result;
  });

  // A token for pages served from another origin (e.g. the 4kaDash artifact on claude.ai).
  // It only works for GET /api/data/* and expires like a normal session.
  router.post('/api/data/token', ({ user }) => {
    const { token, expires } = createSession(db, user.id);
    audit(db, user.id, 'data.token', 'user', user.id);
    return { token, expires };
  });
}

module.exports = { register };
