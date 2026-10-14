'use strict';

// Loads demo data. Usage: npm run seed [-- --reset]
// All demo accounts use the password "password123".

const fs = require('node:fs');
const path = require('node:path');
const { openDatabase, transaction } = require('../src/db');
const { hashPassword } = require('../src/auth');
const { reindex } = require('../src/routes/dashboards');
const quality = require('../src/quality');
const scheduler = require('../src/scheduler');

function seed(db) {
  const pw = hashPassword('password123');
  const user = (email, name, department, isAdmin = 0) =>
    Number(db.prepare('INSERT INTO users (email, name, password_hash, department, is_admin) VALUES (?, ?, ?, ?, ?)').run(email, name, pw, department, isAdmin).lastInsertRowid);

  const admin = user('admin@example.com', 'Alex Admin', 'BI Platform', 1);
  const maria = user('maria@example.com', 'Maria Novak', 'Customer Analytics');
  const tom = user('tom@example.com', 'Tom Berg', 'Sales Operations');
  const ines = user('ines@example.com', 'Ines Duarte', 'Finance');
  const sam = user('sam@example.com', 'Sam Lee', 'Retention');

  const group = (name, description, members) => {
    const id = Number(db.prepare('INSERT INTO user_groups (name, description) VALUES (?, ?)').run(name, description).lastInsertRowid);
    members.forEach((m) => db.prepare('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)').run(id, m));
    return id;
  };
  const finance = group('Finance', 'Finance team – revenue and margin reports', [ines]);
  group('Retention squad', 'Cross-functional churn reduction team', [sam, maria]);

  const dash = (d, tags) => {
    const cols = Object.keys(d);
    const id = Number(
      db.prepare(`INSERT INTO dashboards (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => d[c])).lastInsertRowid
    );
    tags.forEach((t) => db.prepare('INSERT INTO dashboard_tags (dashboard_id, tag) VALUES (?, ?)').run(id, t));
    reindex(db, id);
    return id;
  };

  const now = new Date().toISOString();
  const lifetime = dash(
    {
      name: 'Customer Lifetime by Sales Channel',
      description: 'Average and median customer lifetime (months) for gross adds, split by acquisition sales channel and cohort month.',
      purpose: 'Compare the long-term quality of customers acquired through each sales channel to steer acquisition spend.',
      topic: 'Customer lifetime', department: 'Customer Analytics', project: 'Channel Strategy 2026', tool: 'Tableau',
      url: 'https://tableau.example.com/views/CustomerLifetime/ByChannel',
      data_sources: 'DWH: core.customers, core.contracts, sales.gross_adds',
      update_frequency: 'Daily at 06:00',
      instructions: 'Select the cohort range at the top. Lifetime is measured from activation to churn date; customers still active are right-censored (Kaplan–Meier). Use the "Channel" filter to compare retail, online, telesales and partner channels.',
      limitations: 'Partner channel attribution before 2025-03 is incomplete. Cohorts younger than 6 months have wide confidence intervals.',
      owner_id: maria, stale_after_hours: 30, last_refreshed_at: now,
    },
    ['gross adds', 'lifetime', 'ltv', 'sales channel', 'cohort']
  );
  const churn = dash(
    {
      name: 'Monthly Churn Overview',
      description: 'Voluntary and involuntary churn rate by segment, product and region.',
      purpose: 'Track churn against target and spot segments with rising churn.',
      topic: 'Churn', department: 'Retention', project: 'Retention Program', tool: 'Power BI',
      url: 'https://app.powerbi.com/groups/me/reports/churn-overview',
      data_sources: 'DWH: core.contracts, core.churn_events',
      update_frequency: 'Daily',
      instructions: 'Churn rate = churned customers in month / active customers at start of month. Toggle between voluntary and involuntary churn using the buttons in the header.',
      limitations: 'Migrations between products are not counted as churn since 2026-01.',
      owner_id: sam, stale_after_hours: 30, last_refreshed_at: now,
    },
    ['churn', 'retention', 'active customers']
  );
  const active = dash(
    {
      name: 'Active Customer Base',
      description: 'Number of active customers at month end, by segment and product.',
      purpose: 'Single source of truth for the active customer KPI reported to management.',
      topic: 'Customer base', department: 'Customer Analytics', project: 'KPI Reporting', tool: 'Tableau',
      url: 'https://tableau.example.com/views/ActiveBase/Overview',
      data_sources: 'DWH: core.customers (snapshot at month end)',
      update_frequency: 'Monthly, 3rd working day',
      instructions: 'Use the month-end snapshot value for official reporting. The intra-month view is indicative only.',
      limitations: '',
      owner_id: maria, last_refreshed_at: now,
    },
    ['active customers', 'kpi', 'customer base']
  );
  dash(
    {
      name: 'Sales Performance – Daily',
      description: 'Gross adds, net adds and sales target attainment per channel and shop.',
      purpose: 'Daily steering of sales teams.',
      topic: 'Sales', department: 'Sales Operations', project: 'Channel Strategy 2026', tool: 'Power BI',
      url: 'https://app.powerbi.com/groups/me/reports/sales-daily',
      data_sources: 'sales.orders, sales.targets',
      update_frequency: 'Hourly',
      instructions: 'Targets are prorated by working days.',
      limitations: 'Online orders appear with up to 2h delay.',
      owner_id: tom, stale_after_hours: 4, last_refreshed_at: new Date(Date.now() - 6 * 3600e3).toISOString(),
    },
    ['gross adds', 'net adds', 'sales channel', 'targets']
  );
  dash(
    {
      name: 'Revenue & Margin Bridge',
      description: 'Monthly revenue and gross margin bridge versus budget and prior year.',
      purpose: 'Explain revenue variance for the monthly business review.',
      topic: 'Finance', department: 'Finance', project: 'Monthly Business Review', tool: 'Looker',
      url: 'https://looker.example.com/dashboards/42',
      data_sources: 'ERP general ledger, billing.invoices',
      update_frequency: 'Monthly',
      instructions: 'Start with the bridge chart; click a bar to drill into products.',
      limitations: 'Figures before month-end close are preliminary.',
      owner_id: ines, visibility: 'restricted',
    },
    ['revenue', 'margin', 'budget']
  );
  db.prepare("INSERT INTO dashboard_access (dashboard_id, principal_type, principal_id) VALUES (?, 'group', ?)").run(
    db.prepare("SELECT id FROM dashboards WHERE name = 'Revenue & Margin Bridge'").get().id,
    finance
  );
  dash(
    {
      name: 'Retention Campaign Results',
      description: 'Uplift of save offers and outbound retention campaigns versus control groups.',
      topic: 'Churn', department: 'Retention', project: 'Retention Program', tool: 'Tableau',
      url: 'https://tableau.example.com/views/RetentionCampaigns/Uplift',
      owner_id: sam,
    },
    ['churn', 'campaigns', 'uplift']
  );
  dash(
    {
      name: 'Customer Satisfaction (NPS)',
      description: 'Net Promoter Score by touchpoint, channel and segment.',
      purpose: 'Monitor customer experience and its link to churn.',
      topic: 'Customer experience', department: 'Customer Analytics', project: 'KPI Reporting', tool: 'Looker',
      url: 'https://looker.example.com/dashboards/17',
      data_sources: 'Survey platform export',
      update_frequency: 'Weekly',
      instructions: 'NPS = % promoters − % detractors. Sample sizes under 50 are greyed out.',
      owner_id: maria,
    },
    ['nps', 'satisfaction', 'survey']
  );

  // Collaboration
  const comment = (d, u, kind, body, ago) =>
    db.prepare(`INSERT INTO comments (dashboard_id, user_id, kind, body, created_at) VALUES (?, ?, ?, ?, datetime('now', ?))`).run(d, u, kind, body, ago);
  comment(lifetime, tom, 'question', 'Does "telesales" include inbound calls from the service hotline?', '-6 days');
  comment(lifetime, maria, 'feedback', 'Yes – inbound sales calls are part of telesales. Service-to-sales upgrades are excluded.', '-5 days');
  comment(lifetime, sam, 'suggestion', 'Could we add a split by tariff family? It would help the retention team target offers.', '-2 days');
  comment(churn, tom, 'data_issue', 'Churn for the South region dropped to almost zero on the 3rd – looks like missing data.', '-1 days');
  comment(churn, sam, 'feedback', 'Confirmed, the regional mapping job failed. Fix is deployed, numbers will be correct from tomorrow.', '-20 hours');

  // Personal workspace
  const folder = Number(db.prepare("INSERT INTO folders (user_id, name) VALUES (?, 'Customer retention')").run(sam).lastInsertRowid);
  [churn, lifetime].forEach((d) => db.prepare('INSERT INTO folder_items (folder_id, dashboard_id) VALUES (?, ?)').run(folder, d));
  db.prepare('INSERT INTO favorites (user_id, dashboard_id) VALUES (?, ?)').run(sam, churn);

  // Data quality: validated active-customer history and rules.
  const metric = Number(
    db.prepare("INSERT INTO metrics (dashboard_id, name, description, unit) VALUES (?, 'Active customers', 'Month-end active customers', 'customers')").run(active).lastInsertRowid
  );
  const history = [
    ['2025-09', 1_204_300], ['2025-10', 1_209_800], ['2025-11', 1_213_100], ['2025-12', 1_221_400],
    ['2026-01', 1_218_900], ['2026-02', 1_222_300], ['2026-03', 1_226_000], ['2026-04', 1_229_700],
    ['2026-05', 1_233_200], ['2026-06', 1_236_100], ['2026-07', 1_239_900], ['2026-08', 1_242_500],
  ];
  for (const [period, value] of history) {
    db.prepare(
      "INSERT INTO metric_values (metric_id, period, value, source_value, row_count, distinct_count, validated, validated_by, validated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, datetime('now'))"
    ).run(metric, period, value, value, value, value, maria);
  }
  const rule = (type, params, severity, note = '') =>
    db.prepare('INSERT INTO validation_rules (metric_id, type, params, severity, note) VALUES (?, ?, ?, ?, ?)').run(
      metric, type, JSON.stringify(quality.normalizeParams(type, params)), severity, note
    );
  rule('pct_change', { threshold_pct: 3, baseline: 'last_validated' }, 'warning', 'Month-over-month base changes above 3% are unusual outside of migrations.');
  rule('source_mismatch', { tolerance_pct: 0.1 }, 'critical');
  rule('duplicates', { max_duplicates: 0 }, 'warning');
  rule('missing', {}, 'critical');
  // September 2026 arrives with a suspicious jump and duplicates → flagged for investigation.
  db.prepare('INSERT INTO metric_values (metric_id, period, value, source_value, row_count, distinct_count) VALUES (?, ?, ?, ?, ?, ?)').run(
    metric, '2026-09', 1_311_700, 1_245_900, 1_311_700, 1_245_900
  );
  quality.evaluate(db, metric, '2026-09');
  quality.checkStale(db);

  // Scheduled delivery
  const rg = Number(db.prepare("INSERT INTO recipient_groups (name, owner_id) VALUES ('Retention team', ?)").run(sam).lastInsertRowid);
  ['sam@example.com', 'maria@example.com', 'retention-team@example.com'].forEach((e) =>
    db.prepare('INSERT INTO recipient_group_members (recipient_group_id, email) VALUES (?, ?)').run(rg, e)
  );
  const s = { frequency: 'daily', time_of_day: '09:00', weekday: null, day_of_month: null };
  db.prepare(
    "INSERT INTO schedules (dashboard_id, owner_id, recipient_group_id, frequency, time_of_day, note, next_run_at) VALUES (?, ?, ?, 'daily', '09:00', 'Morning churn check', ?)"
  ).run(churn, sam, rg, scheduler.computeNextRun(s).toISOString());

  return { admin };
}

if (require.main === module) {
  const file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'dash.db');
  if (process.argv.includes('--reset')) {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
  }
  const db = openDatabase(file);
  if (db.prepare('SELECT COUNT(*) n FROM users').get().n > 0) {
    console.error('Database already has users. Run "npm run seed -- --reset" to start over.');
    process.exit(1);
  }
  transaction(db, () => seed(db));
  console.log(`Seeded ${file}. Sign in as admin@example.com, maria@example.com, tom@example.com, ines@example.com or sam@example.com (password: password123).`);
}

module.exports = { seed };
