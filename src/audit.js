'use strict';

function audit(db, userId, action, entity, entityId, details = '') {
  db.prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?)').run(
    userId ?? null,
    action,
    entity,
    entityId ?? null,
    typeof details === 'string' ? details : JSON.stringify(details)
  );
}

function notify(db, userId, message, link = '') {
  if (!userId) return;
  db.prepare('INSERT INTO notifications (user_id, message, link) VALUES (?, ?, ?)').run(userId, message, link);
}

module.exports = { audit, notify };
