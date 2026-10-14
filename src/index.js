'use strict';

const { createApp } = require('./server');
const { hashPassword } = require('./auth');

const port = Number(process.env.PORT || 3000);
const app = createApp();

// First start: create an administrator so the platform can be configured.
const users = app.db.prepare('SELECT COUNT(*) n FROM users').get().n;
if (users === 0) {
  const email = process.env.ADMIN_EMAIL || 'admin@example.com';
  const password = process.env.ADMIN_PASSWORD || 'change-me-now';
  app.db
    .prepare('INSERT INTO users (email, name, password_hash, is_admin) VALUES (?, ?, ?, 1)')
    .run(email, 'Administrator', hashPassword(password));
  console.log(`Created initial administrator ${email}${process.env.ADMIN_PASSWORD ? '' : ' (default password "change-me-now" — change it)'}`);
}

app.startBackground();
app.server.listen(port, () => console.log(`Dashboard platform listening on http://localhost:${port}`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => app.close().then(() => process.exit(0)));
}
