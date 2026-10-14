'use strict';

const auth = require('../auth');
const { badRequest, unauthorized, str } = require('../http');
const { audit } = require('../audit');

function register(router, { db, config }) {
  router.post(
    '/api/auth/login',
    ({ body, res }) => {
      const email = str(body, 'email', { required: true, max: 320 });
      const password = str(body, 'password', { required: true, max: 1000 });
      const row = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);
      if (!row || !auth.verifyPassword(password, row.password_hash)) throw unauthorized('Invalid email or password');
      const { token, expires } = auth.createSession(db, row.id);
      res.setHeader('Set-Cookie', auth.sessionCookie(token, expires, config.secureCookies));
      audit(db, row.id, 'login', 'user', row.id);
      return { id: row.id, email: row.email, name: row.name, department: row.department, isAdmin: !!row.is_admin };
    },
    { auth: false }
  );

  router.post('/api/auth/logout', ({ token, res }) => {
    auth.destroySession(db, token);
    res.setHeader('Set-Cookie', auth.clearCookie());
    return { ok: true };
  });

  router.get('/api/auth/me', ({ user }) => {
    const unread = db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(user.id).n;
    return { ...user, unreadNotifications: unread };
  });

  router.post('/api/auth/password', ({ user, body }) => {
    const current = str(body, 'currentPassword', { required: true });
    const next = str(body, 'newPassword', { required: true, max: 1000 });
    if (next.length < 8) throw badRequest('New password must be at least 8 characters');
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
    if (!auth.verifyPassword(current, row.password_hash)) throw badRequest('Current password is incorrect');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(next), user.id);
    audit(db, user.id, 'change_password', 'user', user.id);
    return { ok: true };
  });

  router.get('/api/notifications', ({ user }) =>
    db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(user.id)
  );

  router.post('/api/notifications/read', ({ user }) => {
    db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL").run(user.id);
    return { ok: true };
  });
}

module.exports = { register };
