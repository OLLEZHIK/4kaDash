'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  department    TEXT,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

-- Access groups: sets of users that share access to restricted dashboards.
CREATE TABLE IF NOT EXISTS user_groups (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id INTEGER NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS dashboards (
  id                INTEGER PRIMARY KEY,
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  purpose           TEXT NOT NULL DEFAULT '',
  topic             TEXT NOT NULL DEFAULT '',
  department        TEXT NOT NULL DEFAULT '',
  project           TEXT NOT NULL DEFAULT '',
  tool              TEXT NOT NULL DEFAULT '',
  url               TEXT NOT NULL,
  data_sources      TEXT NOT NULL DEFAULT '',
  update_frequency  TEXT NOT NULL DEFAULT '',
  instructions      TEXT NOT NULL DEFAULT '',
  limitations       TEXT NOT NULL DEFAULT '',
  owner_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  visibility        TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'restricted')),
  stale_after_hours INTEGER,
  last_refreshed_at TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dashboard_tags (
  dashboard_id INTEGER NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  tag          TEXT NOT NULL COLLATE NOCASE,
  PRIMARY KEY (dashboard_id, tag)
);

-- Explicit grants for restricted dashboards. principal_type is 'user' or 'group'.
CREATE TABLE IF NOT EXISTS dashboard_access (
  dashboard_id   INTEGER NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'group')),
  principal_id   INTEGER NOT NULL,
  PRIMARY KEY (dashboard_id, principal_type, principal_id)
);

-- Full-text index over the searchable dashboard fields; kept in sync by the application.
CREATE VIRTUAL TABLE IF NOT EXISTS dashboards_fts USING fts5(
  name, description, purpose, topic, department, project, tags, instructions,
  tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS favorites (
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dashboard_id INTEGER NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, dashboard_id)
);

CREATE TABLE IF NOT EXISTS folders (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS folder_items (
  folder_id    INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  dashboard_id INTEGER NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  added_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (folder_id, dashboard_id)
);

CREATE TABLE IF NOT EXISTS comments (
  id           INTEGER PRIMARY KEY,
  dashboard_id INTEGER NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind         TEXT NOT NULL DEFAULT 'feedback'
               CHECK (kind IN ('feedback', 'data_issue', 'suggestion', 'question')),
  body         TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Recipient groups for scheduled delivery (distinct from access groups: may hold any address).
CREATE TABLE IF NOT EXISTS recipient_groups (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS recipient_group_members (
  recipient_group_id INTEGER NOT NULL REFERENCES recipient_groups(id) ON DELETE CASCADE,
  email              TEXT NOT NULL COLLATE NOCASE,
  PRIMARY KEY (recipient_group_id, email)
);

CREATE TABLE IF NOT EXISTS schedules (
  id                 INTEGER PRIMARY KEY,
  dashboard_id       INTEGER NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  owner_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_group_id INTEGER NOT NULL REFERENCES recipient_groups(id) ON DELETE CASCADE,
  frequency          TEXT NOT NULL CHECK (frequency IN ('daily', 'weekdays', 'weekly', 'monthly')),
  weekday            INTEGER CHECK (weekday BETWEEN 0 AND 6),
  day_of_month       INTEGER CHECK (day_of_month BETWEEN 1 AND 28),
  time_of_day        TEXT NOT NULL,
  note               TEXT NOT NULL DEFAULT '',
  active             INTEGER NOT NULL DEFAULT 1,
  next_run_at        TEXT,
  last_run_at        TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS deliveries (
  id          INTEGER PRIMARY KEY,
  schedule_id INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  status      TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
  recipients  INTEGER NOT NULL DEFAULT 0,
  detail      TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Outgoing messages. A mail transport drains this table; the platform sends links, not data.
CREATE TABLE IF NOT EXISTS outbox (
  id         INTEGER PRIMARY KEY,
  recipient  TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at    TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message    TEXT NOT NULL,
  link       TEXT NOT NULL DEFAULT '',
  read_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Data quality: a metric is a tracked number shown on a dashboard.
CREATE TABLE IF NOT EXISTS metrics (
  id           INTEGER PRIMARY KEY,
  dashboard_id INTEGER NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  unit         TEXT NOT NULL DEFAULT '',
  UNIQUE (dashboard_id, name)
);

-- One observation per metric and period (e.g. '2026-09'). Validated rows are the reference history.
CREATE TABLE IF NOT EXISTS metric_values (
  id           INTEGER PRIMARY KEY,
  metric_id    INTEGER NOT NULL REFERENCES metrics(id) ON DELETE CASCADE,
  period       TEXT NOT NULL,
  value        REAL,
  source_value REAL,
  row_count    INTEGER,
  distinct_count INTEGER,
  validated    INTEGER NOT NULL DEFAULT 0,
  validated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  validated_at TEXT,
  recorded_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (metric_id, period)
);

CREATE TABLE IF NOT EXISTS validation_rules (
  id        INTEGER PRIMARY KEY,
  metric_id INTEGER NOT NULL REFERENCES metrics(id) ON DELETE CASCADE,
  type      TEXT NOT NULL CHECK (type IN ('pct_change', 'range', 'missing', 'duplicates', 'source_mismatch')),
  params    TEXT NOT NULL DEFAULT '{}',
  severity  TEXT NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
  note      TEXT NOT NULL DEFAULT '',
  active    INTEGER NOT NULL DEFAULT 1
);

-- Detected problems. 'warning' is automatic; 'confirmed_error' is a human judgement.
CREATE TABLE IF NOT EXISTS dq_issues (
  id           INTEGER PRIMARY KEY,
  dashboard_id INTEGER NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  metric_id    INTEGER REFERENCES metrics(id) ON DELETE CASCADE,
  rule_id      INTEGER REFERENCES validation_rules(id) ON DELETE SET NULL,
  rule_type    TEXT NOT NULL,
  period       TEXT,
  expected     REAL,
  actual       REAL,
  message      TEXT NOT NULL,
  severity     TEXT NOT NULL DEFAULT 'warning',
  status       TEXT NOT NULL DEFAULT 'warning'
               CHECK (status IN ('warning', 'investigating', 'confirmed_error', 'resolved', 'dismissed')),
  resolution   TEXT,
  resolved_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolved_at  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  INTEGER,
  details    TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Search queries, used to measure discovery (time-to-find, zero-result searches).
CREATE TABLE IF NOT EXISTS search_log (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  query      TEXT NOT NULL,
  results    INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dashboard_views (
  id           INTEGER PRIMARY KEY,
  dashboard_id INTEGER NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action       TEXT NOT NULL CHECK (action IN ('view', 'open')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_comments_dashboard ON comments(dashboard_id, created_at);
CREATE INDEX IF NOT EXISTS idx_issues_dashboard ON dq_issues(dashboard_id, status);
CREATE INDEX IF NOT EXISTS idx_values_metric ON metric_values(metric_id, period);
CREATE INDEX IF NOT EXISTS idx_schedules_next ON schedules(active, next_run_at);
CREATE INDEX IF NOT EXISTS idx_views_dashboard ON dashboard_views(dashboard_id, created_at);
`;

function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

// Runs fn inside a transaction, rolling back on any thrown error.
function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDatabase, transaction };
