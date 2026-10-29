# 4kaDash: internal dashboard platform

4kaDash is one place to find internal dashboards and reports, understand them, discuss them and trust their numbers.
It implements all four phases of the [product plan](docs/PRODUCT_PLAN.md): discovery, personalisation and collaboration, scheduled delivery, and data quality monitoring.

It has no runtime dependencies. It needs only Node.js ≥ 22.13 and uses Node's built-in SQLite (with FTS5 full-text search), HTTP server and test runner.

## Quick start

```bash
npm run seed      # demo data in data/dash.db (use `npm run seed -- --reset` to start over)
npm start         # http://localhost:3000
npm test
```

Demo accounts all use the password `password123`:

| Account | Role in the demo |
|---|---|
| `admin@example.com` | Administrator: users, groups, success metrics, audit log, outbox |
| `maria@example.com` | Owns *Customer Lifetime by Sales Channel* and *Active Customer Base* (which has open data-quality flags) |
| `sam@example.com` | Retention team. Has a folder, a favorite and a daily 09:00 churn schedule |
| `tom@example.com` | Sales ops. Cannot see the restricted *Revenue & Margin Bridge* |
| `ines@example.com` | Finance group member. Can see the restricted finance report |

With an empty database and no seed, the first `npm start` creates `ADMIN_EMAIL` / `ADMIN_PASSWORD` (default `admin@example.com` / `change-me-now`).

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DB_FILE` | `data/dash.db` | SQLite database file |
| `BASE_URL` | `http://localhost:3000` | Used to build the links in scheduled e-mails |
| `SECURE_COOKIES` | off | Set to `1` behind HTTPS |
| `TZ` | system | Time zone in which schedule times (e.g. 09:00) are interpreted |

## How the plan maps to the implementation

| Plan section | What is built |
|---|---|
| **2.1 Centralised search** | Free-text search ranked by relevance (SQLite FTS5 with BM25, stemming and prefix matching; filler words such as "by" and "the" are ignored, so a business question like *"customer lifetime by sales channel based on gross adds"* works). Filters for topic, department, project, tool, owner and tag, plus favorites only. Sorting by relevance, recently updated or most viewed. "Open report" goes to the original tool and is counted. |
| **2.2 Standardised info page** | Name, description, business purpose, how-to-interpret, limitations, data sources, update frequency, owner, last refresh, tags. A **documentation completeness score** is shown on every card to encourage complete documentation. |
| **2.3 Folders and favorites** | A star on every card and page. Private folders that you can create, rename and delete, plus "Add to folder" from the report page. Items you lose access to are hidden from your folders. |
| **2.4 Accounts and permissions** | Session login with scrypt-hashed passwords. Each dashboard is *public* or *restricted* to named users and access groups. The owner and admins manage access. Admins manage users (create, deactivate, reset password, admin role) and groups. Restricted reports return 404 to everyone else, so their existence is not disclosed. Permissions are enforced in every endpoint: search, comments, folders, schedules and metrics. |
| **2.5 Scheduled reports** | Recipient groups (any e-mail addresses), schedules that run daily, on weekdays, weekly on a chosen day or monthly on a chosen day, at a set time, with an optional message. A background job sends due schedules. **Messages contain a link, never data**, and warn when the report has open data-quality flags. You can send now, pause and view delivery history. |
| **2.6 Comments** | A comment panel on the right of every report page. Comments show author and timestamp, and have a type: *feedback / data issue / suggestion / question*. Filters for **owner only** and by type. Owner comments are highlighted. The owner is notified of new comments. |
| **2.7 Data quality** | Metrics per dashboard with a history per period (`2026-09`, `2026-W39`, `2026-Q3`…). Owners **mark periods as checked and validated**, and validated history becomes the reference. Changing a validated value requires a reason, which goes to the audit log. Configurable rules are listed below. A detected problem becomes an *Auto warning* that shows the rule triggered, the expected value, the actual value and the difference. The owner is notified, then investigates and marks it *Confirmed error* or *Dismissed (expected)* with a mandatory resolution. Every step is in the issue history and audit log. |
| **7 Success measures** | The admin page shows documentation rate, active users, searches and **zero-result searches** (which hint at gaps), most-viewed reports, questions asked, data-quality issues resolved vs detected, and delivery success rate. |

### Validation rules

| Rule | Flags when… | Parameters |
|---|---|---|
| `pct_change` | the value moves more than X% vs a baseline | `threshold_pct`, `direction` (both/up/down), `baseline` (`last_validated`, `previous`, or `same_period_last_year` for seasonal metrics), `min_abs_change` |
| `range` | the value is outside min/max | `min`, `max` |
| `missing` | no value was supplied for the period | — |
| `duplicates` | the row count exceeds the distinct key count | `max_duplicates` |
| `source_mismatch` | the reported value differs from the value recomputed from the source | `tolerance_pct` |
| *stale* (per dashboard) | the report has not been refreshed within *N* hours | `stale_after_hours` on the dashboard |

Each rule has a severity (`info` / `warning` / `critical`) and a business note. If the same period is submitted again, the remaining automatic warnings are re-evaluated. Issues that someone is already investigating or has confirmed are never overwritten or duplicated.

### Feeding data in

Integrations use the same JSON API as the UI. Typical calls from an ETL job, authenticated as the report owner or as a service account that owns the report:

```
POST /api/auth/login                       {"email": "...", "password": "..."}
POST /api/metrics/:id/values               {"period": "2026-09", "value": 1245900, "sourceValue": 1245900, "rowCount": 1245900, "distinctCount": 1245900}
POST /api/dashboards/:id/refreshed         {"at": "2026-10-01T06:00:00Z"}
```

The response to a value submission lists any warnings it raised.

## Data gateway (reports straight from the company database)

The 4kaDash page can load report data from a company database instead of an attached file.
The browser never connects to the database itself: it asks this server, which acts as a gateway.

```
4kaDash page ──HTTPS + access key──▶ /api/data/... (this server) ──read-only──▶ PostgreSQL / MS SQL / MySQL / SQLite / CSV
```

- **Only approved datasets.** The data team defines each dataset (its SQL) in `config/data-sources.json`.
  The page can only choose a dataset and a period (`from`/`to`, bound as parameters), never send SQL.
- **No secrets in the config.** Connection strings come from environment variables (`"connection": {"env": "DWH_URL"}`).
- **Personal data stays out.** Columns listed in `piiColumns`, columns whose names look personal
  (e-mail, phone, rodné číslo, IBAN, address, name) and columns whose values look personal are removed on the server.
- **Who sees what.** `"groups": ["Finance"]` limits a dataset to members of those user groups (admins see all).
- **Read-only and audited.** Sessions are read-only, row counts are capped (`maxRows`), every read lands in `audit_log`.
- **Access from the claude.ai page.** List the page's origin in `allowedOrigins`. A user opens `/token.html`,
  creates a 12-hour access key and pastes it into 4kaDash (Databáza → Prihlásiť sa). The key works only for `GET /api/data/*`.

Try it with the demo warehouse:

```bash
npm run seed:warehouse                                   # creates data/warehouse.db
DATA_SOURCES=config/data-sources.example.json npm start
```

Drivers for PostgreSQL (`pg`), MS SQL (`mssql`) and MySQL (`mysql2`) load on first use; install the one you need
(`npm install pg`). SQLite (built into Node) and CSV work without extra packages.

## Project layout

```
src/
  server.js          HTTP app, routing, background tick (schedules + freshness checks)
  db.js              SQLite schema
  auth.js            password hashing, sessions
  permissions.js     who can see / manage which dashboard (single SQL predicate)
  quality.js         validation rule engine and stale-report check
  scheduler.js       next-run calculation and link delivery
  routes/            auth, dashboards (search, info, access), workspace (favorites, folders, comments),
                     schedules, quality (metrics, values, rules, issues), admin
public/              single-page UI (vanilla JS, no build step; strict CSP, no innerHTML)
scripts/seed.js      demo data
test/                API, permission, quality-engine and scheduler tests (node:test)
```

## Decisions on the open technical questions

These are placeholders for the decisions the team still has to make (plan §6). Each one can be replaced later:

1. **Hosting.** It runs as a single Node process with a single SQLite file, so it fits a small VM or container. For high availability, move to Postgres. The SQL is deliberately simple, so the port is straightforward.
2. **Tool integration.** Dashboards are registered by URL and are tool-agnostic (Tableau, Power BI, Looker…). Metadata is entered manually today. A connector can sync it through the same API.
3. **Metadata.** It is entered manually and kept honest by the completeness score. Last refresh can be pushed automatically through `/refreshed`.
4. **Links or files.** Only links are sent, as the plan recommends. Exports can be added later.
5. **Validation history.** It is stored in the platform database (`metric_values`). Pointing it at a data warehouse table is a swap of the storage layer.
6. **Rules.** Generic rules are configurable in the UI. Business-specific logic belongs to the metric owner, who uses the threshold, baseline and note fields.
7. **Company identity.** Built-in accounts and groups. SSO (OIDC/SAML) and directory group sync are the natural next step: `auth.js` and `group_members` are the integration points.

**E-mail transport.** Scheduled deliveries are written to an `outbox` table, which admins can view in the UI. Connecting SMTP or another mail service means draining that table. This is intentionally left to the hosting team.
