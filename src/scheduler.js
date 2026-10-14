'use strict';

// Scheduled delivery. Times are interpreted in the server's local time zone (set TZ for the deployment).

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function at(date, hh, mm) {
  const d = new Date(date);
  d.setHours(hh, mm, 0, 0);
  return d;
}

// Returns the first run strictly after `from` that matches the schedule.
function computeNextRun(s, from = new Date()) {
  const m = TIME_RE.exec(s.time_of_day);
  if (!m) throw new Error(`Invalid time_of_day ${s.time_of_day}`);
  const hh = Number(m[1]);
  const mm = Number(m[2]);

  if (s.frequency === 'monthly') {
    for (let i = 0; i < 3; i++) {
      const c = at(new Date(from.getFullYear(), from.getMonth() + i, s.day_of_month), hh, mm);
      if (c > from) return c;
    }
  }
  for (let i = 0; i <= 7; i++) {
    const c = at(new Date(from.getFullYear(), from.getMonth(), from.getDate() + i), hh, mm);
    if (c <= from) continue;
    const dow = c.getDay();
    if (s.frequency === 'daily') return c;
    if (s.frequency === 'weekdays' && dow >= 1 && dow <= 5) return c;
    if (s.frequency === 'weekly' && dow === s.weekday) return c;
  }
  throw new Error(`Could not compute next run for schedule ${s.id}`);
}

function describe(s) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  if (s.frequency === 'daily') return `Every day at ${s.time_of_day}`;
  if (s.frequency === 'weekdays') return `Every weekday at ${s.time_of_day}`;
  if (s.frequency === 'weekly') return `Every ${days[s.weekday]} at ${s.time_of_day}`;
  return `Monthly on day ${s.day_of_month} at ${s.time_of_day}`;
}

// Delivers one schedule: queues a link (never the data itself) for every recipient.
function deliver(db, s, baseUrl) {
  const d = db.prepare('SELECT id, name FROM dashboards WHERE id = ?').get(s.dashboard_id);
  const recipients = db
    .prepare('SELECT email FROM recipient_group_members WHERE recipient_group_id = ?')
    .all(s.recipient_group_id)
    .map((r) => r.email);
  if (!d || !recipients.length) {
    db.prepare("INSERT INTO deliveries (schedule_id, status, recipients, detail) VALUES (?, 'skipped', 0, ?)").run(
      s.id,
      !d ? 'Dashboard no longer exists' : 'Recipient group is empty'
    );
    return 'skipped';
  }
  const issues = db
    .prepare("SELECT COUNT(*) n FROM dq_issues WHERE dashboard_id = ? AND status IN ('warning','investigating','confirmed_error')")
    .get(d.id).n;
  const link = `${baseUrl}/#/dashboards/${d.id}`;
  const subject = `[Scheduled report] ${d.name}`;
  const body = [
    `Your scheduled report "${d.name}" is ready.`,
    '',
    `Open it here: ${link}`,
    s.note ? `\nNote from the sender: ${s.note}` : '',
    issues ? `\nHeads-up: this report currently has ${issues} open data quality flag(s). Check the report page before relying on the figures.` : '',
    '',
    `Schedule: ${describe(s)}. Access is still governed by your dashboard permissions.`,
  ]
    .filter((l) => l !== '')
    .join('\n');
  const ins = db.prepare('INSERT INTO outbox (recipient, subject, body) VALUES (?, ?, ?)');
  recipients.forEach((r) => ins.run(r, subject, body));
  db.prepare("INSERT INTO deliveries (schedule_id, status, recipients, detail) VALUES (?, 'sent', ?, ?)").run(
    s.id,
    recipients.length,
    `Queued ${recipients.length} message(s)`
  );
  return 'sent';
}

function runDue(db, { now = new Date(), baseUrl = '' } = {}) {
  const due = db
    .prepare('SELECT * FROM schedules WHERE active = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?')
    .all(now.toISOString());
  for (const s of due) {
    try {
      deliver(db, s, baseUrl);
    } catch (err) {
      db.prepare("INSERT INTO deliveries (schedule_id, status, recipients, detail) VALUES (?, 'failed', 0, ?)").run(s.id, String(err.message));
    }
    db.prepare('UPDATE schedules SET last_run_at = ?, next_run_at = ? WHERE id = ?').run(
      now.toISOString(),
      computeNextRun(s, now).toISOString(),
      s.id
    );
  }
  return due.length;
}

module.exports = { TIME_RE, computeNextRun, describe, deliver, runDue };
