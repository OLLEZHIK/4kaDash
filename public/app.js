'use strict';

// ---------------------------------------------------------------------------------------
// Small helpers. All text goes through textContent, never innerHTML, so user content is safe.
// ---------------------------------------------------------------------------------------

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'selected' || k === 'disabled' || k === 'hidden' || k === 'required') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const $ = (sel, root = document) => root.querySelector(sel);
const view = () => $('#view');

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401 && !path.startsWith('/api/auth/login')) {
    state.user = null;
    location.hash = '#/login';
    throw new Error('Please sign in');
  }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg, kind = 'ok') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

// Wraps an async action with error reporting.
function act(fn) {
  return async (ev) => {
    if (ev && ev.preventDefault) ev.preventDefault();
    try {
      await fn(ev);
    } catch (err) {
      toast(err.message, 'error');
    }
  };
}

function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function fmtNum(n) {
  return n === null || n === undefined ? '—' : Number(n).toLocaleString();
}

function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.multiple) out[el.name] = [...el.selectedOptions].map((o) => o.value);
    else out[el.name] = el.value;
  }
  return out;
}

function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint ? h('span', { class: 'hint' }, hint) : null);
}

function select(name, options, value, attrs = {}) {
  return h(
    'select',
    { name, ...attrs },
    options.map((o) => {
      const [v, l] = Array.isArray(o) ? o : [o, o];
      return h('option', { value: v, selected: String(v) === String(value ?? '') }, l);
    })
  );
}

function pill(text, cls = '') {
  return h('span', { class: `pill ${cls}` }, text);
}

function empty(text) {
  return h('p', { class: 'empty' }, text);
}

const KIND_LABEL = { feedback: 'Feedback', data_issue: 'Data issue', suggestion: 'Suggestion', question: 'Question' };
const STATUS_LABEL = {
  warning: 'Auto warning', investigating: 'Investigating', confirmed_error: 'Confirmed error', resolved: 'Resolved', dismissed: 'Dismissed (expected)',
};
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const state = { user: null, facets: null, directory: null };

// ---------------------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------------------

const routes = [
  [/^#\/login$/, renderLogin, { public: true }],
  [/^#\/?$/, renderLibrary],
  [/^#\/dashboards\/new$/, () => renderEditor(null)],
  [/^#\/dashboards\/(\d+)\/edit$/, (m) => renderEditor(Number(m[1]))],
  [/^#\/dashboards\/(\d+)$/, (m) => renderDashboard(Number(m[1]))],
  [/^#\/workspace$/, renderWorkspace],
  [/^#\/schedules$/, renderSchedules],
  [/^#\/quality$/, renderQuality],
  [/^#\/notifications$/, renderNotifications],
  [/^#\/admin$/, renderAdmin],
];

async function route() {
  const hash = location.hash || '#/';
  const path = hash.split('?')[0];
  if (!state.user && path !== '#/login') {
    try {
      state.user = await api('GET', '/api/auth/me');
    } catch {
      return;
    }
  }
  updateChrome(path);
  for (const [re, fn, opts] of routes) {
    const m = re.exec(path);
    if (!m) continue;
    if (!opts?.public && !state.user) return (location.hash = '#/login');
    view().replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
    try {
      await fn(m);
    } catch (err) {
      view().replaceChildren(h('div', { class: 'card error' }, err.message));
    }
    window.scrollTo(0, 0);
    return;
  }
  view().replaceChildren(empty('Page not found.'));
}

function updateChrome(path) {
  const loggedIn = !!state.user && path !== '#/login';
  $('#topbar').hidden = !loggedIn;
  if (!loggedIn) return;
  $('#user-name').textContent = state.user.name;
  $('#nav-admin').hidden = !state.user.isAdmin;
  const section = path === '#/' || path.startsWith('#/dashboards') ? 'library' : path.slice(2).split('/')[0];
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === section));
  const n = state.user.unreadNotifications || 0;
  $('#bell-count').hidden = !n;
  $('#bell-count').textContent = n;
}

async function refreshMe() {
  state.user = await api('GET', '/api/auth/me');
  updateChrome((location.hash || '#/').split('?')[0]);
}

function queryParams() {
  const q = (location.hash.split('?')[1] || '');
  return new URLSearchParams(q);
}

// ---------------------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------------------

function renderLogin() {
  const form = h(
    'form',
    { class: 'card login', onsubmit: act(async () => {
      const body = formData(form);
      await api('POST', '/api/auth/login', body);
      state.user = null;
      await refreshMe();
      location.hash = '#/';
    }) },
    h('h1', {}, '4kaDash'),
    h('p', { class: 'muted' }, 'Find, understand and trust internal dashboards.'),
    field('Email', h('input', { name: 'email', type: 'email', required: true, autocomplete: 'username' })),
    field('Password', h('input', { name: 'password', type: 'password', required: true, autocomplete: 'current-password' })),
    h('button', { class: 'primary', type: 'submit' }, 'Sign in')
  );
  view().replaceChildren(h('div', { class: 'login-wrap' }, form));
}

// ---------------------------------------------------------------------------------------
// Library: search + filters
// ---------------------------------------------------------------------------------------

async function renderLibrary() {
  if (!state.facets) state.facets = await api('GET', '/api/facets');
  const f = state.facets;
  const params = queryParams();
  const results = h('div', { class: 'results' });
  const count = h('p', { class: 'muted' });

  const form = h(
    'form',
    { class: 'search', onsubmit: (e) => { e.preventDefault(); apply(); } },
    h('input', {
      name: 'q', type: 'search', class: 'search-input', value: params.get('q') || '',
      placeholder: 'Describe what you need, e.g. "customer lifetime by sales channel gross adds"',
      'aria-label': 'Search dashboards',
    }),
    h('button', { class: 'primary', type: 'submit' }, 'Search'),
    h(
      'div',
      { class: 'filters' },
      select('topic', [['', 'All topics'], ...f.topics], params.get('topic'), { onchange: apply, 'aria-label': 'Topic' }),
      select('department', [['', 'All departments'], ...f.departments], params.get('department'), { onchange: apply, 'aria-label': 'Department' }),
      select('project', [['', 'All projects'], ...f.projects], params.get('project'), { onchange: apply, 'aria-label': 'Project' }),
      select('tool', [['', 'All tools'], ...f.tools], params.get('tool'), { onchange: apply, 'aria-label': 'Tool' }),
      select('owner', [['', 'Any owner'], ...f.owners.map((o) => [o.id, o.name])], params.get('owner'), { onchange: apply, 'aria-label': 'Owner' }),
      select('sort', [['', 'Best match / A–Z'], ['recent', 'Recently updated'], ['popular', 'Most viewed']], params.get('sort'), { onchange: apply, 'aria-label': 'Sort' }),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'favorites', checked: params.get('favorites') === '1', onchange: apply }), 'Favorites only')
    )
  );
  const tags = h(
    'div',
    { class: 'tags' },
    f.tags.map((t) =>
      h('button', {
        type: 'button', class: `tag ${params.get('tag') === t ? 'active' : ''}`,
        onclick: () => { const p = currentParams(); p.get('tag') === t ? p.delete('tag') : p.set('tag', t); go(p); },
      }, t)
    )
  );

  function currentParams() {
    const d = formData(form);
    const p = new URLSearchParams();
    for (const k of ['q', 'topic', 'department', 'project', 'tool', 'owner', 'sort']) if (d[k]) p.set(k, d[k]);
    if (d.favorites) p.set('favorites', '1');
    if (params.get('tag')) p.set('tag', params.get('tag'));
    return p;
  }
  function go(p) {
    location.hash = '#/' + (p.toString() ? '?' + p : '');
  }
  function apply() {
    go(currentParams());
  }

  view().replaceChildren(
    h('div', { class: 'page-head' },
      h('h1', {}, 'Dashboard library'),
      h('a', { class: 'button', href: '#/dashboards/new' }, '+ Register dashboard')),
    form, tags, count, results
  );

  const list = await api('GET', '/api/dashboards?' + params.toString());
  count.textContent = `${list.length} dashboard${list.length === 1 ? '' : 's'}`;
  if (!list.length) {
    results.append(empty('No dashboards match. Try fewer or broader words, or clear the filters. If the report you need does not exist, ask the BI team.'));
    return;
  }
  results.append(...list.map(dashboardCard));
}

function dashboardCard(d) {
  const star = favButton(d.id, d.isFavorite);
  return h(
    'article',
    { class: 'card dash-card' },
    h('div', { class: 'dash-card-head' },
      h('a', { href: `#/dashboards/${d.id}`, class: 'dash-title' }, d.name),
      star),
    h('p', { class: 'desc' }, d.description || h('em', { class: 'muted' }, 'No description yet')),
    h('div', { class: 'meta' },
      d.topic && pill(d.topic),
      d.department && pill(d.department, 'soft'),
      d.tool && pill(d.tool, 'soft'),
      d.visibility === 'restricted' && pill('Restricted', 'warn'),
      d.openIssues ? pill(`${d.openIssues} data quality flag${d.openIssues > 1 ? 's' : ''}`, 'danger') : null,
      h('span', { class: 'muted small' }, d.owner ? `Owner: ${d.owner.name}` : 'No owner'),
      h('span', { class: `muted small doc-score ${d.completeness < 70 ? 'low' : ''}` }, `Docs ${d.completeness}%`)),
    d.tags.length ? h('div', { class: 'tags small' }, d.tags.map((t) => h('span', { class: 'tag static' }, t))) : null
  );
}

function favButton(id, isFav) {
  const btn = h('button', {
    class: `star ${isFav ? 'on' : ''}`, type: 'button', title: isFav ? 'Remove from favorites' : 'Add to favorites',
    'aria-pressed': String(isFav),
    onclick: act(async () => {
      const on = btn.classList.contains('on');
      await api(on ? 'DELETE' : 'PUT', `/api/favorites/${id}`);
      btn.classList.toggle('on', !on);
      btn.setAttribute('aria-pressed', String(!on));
      btn.title = !on ? 'Remove from favorites' : 'Add to favorites';
      btn.textContent = !on ? '★' : '☆';
    }),
  }, isFav ? '★' : '☆');
  return btn;
}

// ---------------------------------------------------------------------------------------
// Dashboard information page with comments on the right
// ---------------------------------------------------------------------------------------

async function renderDashboard(id) {
  const [d, folders] = await Promise.all([api('GET', `/api/dashboards/${id}`), api('GET', '/api/folders')]);

  const section = (title, text, hint) =>
    h('section', { class: 'doc-section' }, h('h3', {}, title), text ? h('p', { class: 'prewrap' }, text) : h('p', { class: 'muted' }, hint || 'Not documented yet.'));

  const folderSelect = h(
    'select',
    { 'aria-label': 'Add to folder', onchange: act(async (e) => {
      const v = e.target.value;
      if (!v) return;
      if (v === '__new') {
        const name = prompt('New folder name');
        if (!name) return (e.target.value = '');
        const f = await api('POST', '/api/folders', { name });
        await api('PUT', `/api/folders/${f.id}/items/${id}`);
        toast(`Added to "${name}"`);
      } else {
        await api('PUT', `/api/folders/${v}/items/${id}`);
        toast('Added to folder');
      }
      renderDashboard(id);
    }) },
    h('option', { value: '' }, 'Add to folder…'),
    folders.map((f) => h('option', { value: f.id, disabled: d.folderIds.includes(f.id) }, f.name + (d.folderIds.includes(f.id) ? ' ✓' : ''))),
    h('option', { value: '__new' }, '+ New folder')
  );

  const issues = d.openIssues.length
    ? h('div', { class: 'card alert' },
        h('strong', {}, `${d.openIssues.length} open data quality flag${d.openIssues.length > 1 ? 's' : ''}`),
        h('ul', {}, d.openIssues.map((i) => h('li', {}, pill(STATUS_LABEL[i.status], `st-${i.status}`), ' ', i.message))),
        h('a', { href: `#/quality?dashboardId=${id}` }, 'Review in data quality →'))
    : null;

  const info = h(
    'div',
    { class: 'info' },
    h('div', { class: 'page-head' },
      h('div', {},
        h('a', { href: '#/', class: 'muted small' }, '← Library'),
        h('h1', {}, d.name),
        h('div', { class: 'meta' },
          d.topic && pill(d.topic), d.department && pill(d.department, 'soft'), d.project && pill(d.project, 'soft'),
          d.tool && pill(d.tool, 'soft'), d.visibility === 'restricted' && pill('Restricted', 'warn'),
          h('span', { class: `muted small doc-score ${d.completeness < 70 ? 'low' : ''}` }, `Documentation ${d.completeness}% complete`))),
      h('div', { class: 'actions' },
        h('a', { class: 'button primary', href: `/api/dashboards/${id}/open`, target: '_blank', rel: 'noopener' }, 'Open report ↗'),
        favButton(id, d.isFavorite),
        folderSelect,
        h('a', { class: 'button', href: `#/schedules?dashboardId=${id}` }, 'Schedule'),
        d.canManage && h('a', { class: 'button', href: `#/dashboards/${id}/edit` }, 'Edit'))),
    issues,
    h('div', { class: 'card' },
      section('Description', d.description),
      section('Business purpose', d.purpose),
      section('How to use and interpret', d.instructions),
      section('Limitations and known data issues', d.limitations, 'No known limitations documented.'),
      h('div', { class: 'grid2' },
        section('Data sources', d.data_sources),
        section('Update frequency', d.update_frequency),
        h('section', { class: 'doc-section' }, h('h3', {}, 'Owner'),
          d.owner ? h('p', {}, d.owner.name, ' · ', h('a', { href: `mailto:${d.owner.email}` }, d.owner.email), d.owner.department ? ` · ${d.owner.department}` : '') : h('p', { class: 'muted' }, 'No owner assigned')),
        h('section', { class: 'doc-section' }, h('h3', {}, 'Last refresh'), h('p', {}, fmtDate(d.last_refreshed_at),
          d.stale_after_hours ? h('span', { class: 'muted small' }, ` (expected every ${d.stale_after_hours}h)`) : null))),
      d.tags.length ? h('div', { class: 'tags' }, d.tags.map((t) => h('a', { class: 'tag', href: `#/?tag=${encodeURIComponent(t)}` }, t))) : null,
      h('p', { class: 'muted small' }, `${d.stats.views30d} views in the last 30 days · ${d.stats.favorites} favorites · updated ${fmtDate(d.updated_at)}`)),
    d.canManage ? accessPanel(d) : null,
    h('div', { id: 'metrics' })
  );

  const comments = h('aside', { class: 'comments' });
  view().replaceChildren(h('div', { class: 'detail' }, info, comments));
  renderComments(comments, d);
  renderMetrics($('#metrics'), d);
}

async function renderComments(container, d, filter = { author: '', kind: '' }) {
  const qs = new URLSearchParams();
  if (filter.author) qs.set('author', filter.author);
  if (filter.kind) qs.set('kind', filter.kind);
  const list = await api('GET', `/api/dashboards/${d.id}/comments?${qs}`);
  const rerender = (f) => renderComments(container, d, f);

  const form = h(
    'form',
    { class: 'comment-form', onsubmit: act(async () => {
      const body = formData(form);
      await api('POST', `/api/dashboards/${d.id}/comments`, body);
      toast('Comment posted');
      rerender(filter);
    }) },
    select('kind', Object.entries(KIND_LABEL), 'feedback', { 'aria-label': 'Comment type' }),
    h('textarea', { name: 'body', rows: 3, required: true, placeholder: 'Share a tip, ask a question, or report a data issue…' }),
    h('button', { class: 'primary', type: 'submit' }, 'Post')
  );

  container.replaceChildren(
    h('h2', {}, 'Comments'),
    h('div', { class: 'comment-filters' },
      select('author', [['', 'Everyone'], ['owner', 'Owner only']], filter.author, { onchange: (e) => rerender({ ...filter, author: e.target.value }), 'aria-label': 'Author filter' }),
      select('kind', [['', 'All types'], ...Object.entries(KIND_LABEL)], filter.kind, { onchange: (e) => rerender({ ...filter, kind: e.target.value }), 'aria-label': 'Type filter' })),
    form,
    list.length
      ? h('ol', { class: 'comment-list' }, list.map((c) =>
          h('li', { class: `comment ${c.isOwner ? 'by-owner' : ''}` },
            h('div', { class: 'comment-head' },
              h('strong', {}, c.author ? c.author.name : 'Deleted user'),
              c.isOwner && pill('Owner', 'owner'),
              pill(KIND_LABEL[c.kind], `k-${c.kind}`)),
            h('p', { class: 'prewrap' }, c.body),
            h('div', { class: 'comment-foot muted small' },
              fmtDate(c.createdAt),
              c.canDelete && h('button', { class: 'link small', onclick: act(async () => {
                if (!confirm('Delete this comment?')) return;
                await api('DELETE', `/api/comments/${c.id}`);
                rerender(filter);
              }) }, 'Delete')))))
      : empty('No comments yet.')
  );
}

function accessPanel(d) {
  const box = h('details', { class: 'card' }, h('summary', {}, h('strong', {}, 'Access'), ' ', h('span', { class: 'muted' },
    d.access.visibility === 'public' ? '— visible to everyone' : `— restricted to ${d.access.users.length} user(s), ${d.access.groups.length} group(s)`)));
  box.addEventListener('toggle', act(async () => {
    if (!box.open || box.dataset.loaded) return;
    box.dataset.loaded = '1';
    if (!state.directory) state.directory = await api('GET', '/api/directory');
    const dir = state.directory;
    const userIds = new Set(d.access.users.map((u) => String(u.id)));
    const groupIds = new Set(d.access.groups.map((g) => String(g.id)));
    const form = h('form', { class: 'stack', onsubmit: act(async () => {
      const v = formData(form);
      await api('PUT', `/api/dashboards/${d.id}/access`, { visibility: v.visibility, users: v.users, groups: v.groups });
      toast('Access updated');
      state.facets = null;
      renderDashboard(d.id);
    }) },
      field('Visibility', select('visibility', [['public', 'Everyone in the company'], ['restricted', 'Only the users and groups below']], d.access.visibility)),
      h('div', { class: 'grid2' },
        field('Users', h('select', { name: 'users', multiple: true, size: 6 }, dir.users.map((u) => h('option', { value: u.id, selected: userIds.has(String(u.id)) }, `${u.name} (${u.email})`))), 'Ctrl/Cmd-click to select several'),
        field('Groups', h('select', { name: 'groups', multiple: true, size: 6 }, dir.groups.map((g) => h('option', { value: g.id, selected: groupIds.has(String(g.id)) }, g.name))))),
      h('p', { class: 'muted small' }, 'The owner and administrators always have access.'),
      h('button', { class: 'primary', type: 'submit' }, 'Save access'));
    box.append(form);
  }));
  return box;
}

// Metrics, validated history and rules for one dashboard.
async function renderMetrics(container, d) {
  const metrics = await api('GET', `/api/dashboards/${d.id}/metrics`);
  if (!metrics.length && !d.canManage) return container.replaceChildren();
  const reload = () => renderMetrics(container, d);

  const metricCard = (m) => {
    const valueForm = h('form', { class: 'inline-form', onsubmit: act(async () => {
      const v = formData(valueForm);
      const body = { period: v.period, value: v.value === '' ? null : Number(v.value) };
      if (v.sourceValue !== '') body.sourceValue = Number(v.sourceValue);
      if (v.rowCount !== '') body.rowCount = Number(v.rowCount);
      if (v.distinctCount !== '') body.distinctCount = Number(v.distinctCount);
      if (m.values.some((x) => x.period === v.period && x.validated)) {
        const reason = prompt(`${v.period} is validated history. Why are you replacing it?`);
        if (!reason) return;
        body.overrideReason = reason;
      }
      const res = await api('POST', `/api/metrics/${m.id}/values`, body);
      toast(res.issues.length ? `Recorded – ${res.issues.length} rule(s) flagged this value` : 'Recorded – all checks passed', res.issues.length ? 'warn' : 'ok');
      reload();
    }) },
      h('input', { name: 'period', placeholder: 'Period (2026-09)', required: true, size: 12 }),
      h('input', { name: 'value', placeholder: 'Value', inputmode: 'decimal', size: 10 }),
      h('input', { name: 'sourceValue', placeholder: 'Source value', inputmode: 'decimal', size: 10 }),
      h('input', { name: 'rowCount', placeholder: 'Rows', inputmode: 'numeric', size: 8 }),
      h('input', { name: 'distinctCount', placeholder: 'Distinct keys', inputmode: 'numeric', size: 8 }),
      h('button', { type: 'submit' }, 'Record value'));

    const ruleForm = h('form', { class: 'inline-form', onsubmit: act(async () => {
      const v = formData(ruleForm);
      const params = {};
      if (v.type === 'pct_change') Object.assign(params, { threshold_pct: v.p1 || 10, baseline: v.baseline, direction: v.direction });
      if (v.type === 'range') Object.assign(params, { min: v.p1 === '' ? null : v.p1, max: v.p2 === '' ? null : v.p2 });
      if (v.type === 'source_mismatch') params.tolerance_pct = v.p1 || 0.5;
      if (v.type === 'duplicates') params.max_duplicates = v.p1 || 0;
      await api('POST', `/api/metrics/${m.id}/rules`, { type: v.type, params, severity: v.severity, note: v.note });
      toast('Rule added');
      reload();
    }) },
      select('type', [['pct_change', '% change'], ['range', 'Range'], ['source_mismatch', 'Source mismatch'], ['duplicates', 'Duplicates'], ['missing', 'Missing value']], 'pct_change', { 'aria-label': 'Rule type' }),
      h('input', { name: 'p1', placeholder: 'Threshold % / min', size: 10 }),
      h('input', { name: 'p2', placeholder: 'max (range)', size: 8 }),
      select('baseline', [['last_validated', 'vs last validated'], ['previous', 'vs previous period'], ['same_period_last_year', 'vs same period last year']], 'last_validated', { 'aria-label': 'Baseline' }),
      select('direction', [['both', 'up or down'], ['up', 'increase only'], ['down', 'decrease only']], 'both', { 'aria-label': 'Direction' }),
      select('severity', ['info', 'warning', 'critical'], 'warning', { 'aria-label': 'Severity' }),
      h('input', { name: 'note', placeholder: 'Business context (optional)', size: 24 }),
      h('button', { type: 'submit' }, 'Add rule'));

    return h('div', { class: 'card' },
      h('div', { class: 'page-head' },
        h('h3', {}, m.name, m.unit ? h('span', { class: 'muted small' }, ` (${m.unit})`) : null),
        d.canManage && h('button', { class: 'link small', onclick: act(async () => {
          if (!confirm(`Delete metric "${m.name}" and its history?`)) return;
          await api('DELETE', `/api/metrics/${m.id}`);
          reload();
        }) }, 'Delete metric')),
      m.description && h('p', { class: 'muted' }, m.description),
      h('h4', {}, 'Validation rules'),
      m.rules.length
        ? h('ul', { class: 'rules' }, m.rules.map((r) => h('li', {},
            pill(r.severity, `sev-${r.severity}`), ' ', r.description, r.note ? h('span', { class: 'muted' }, ` — ${r.note}`) : null,
            !r.active && pill('inactive', 'soft'),
            d.canManage && h('button', { class: 'link small', onclick: act(async () => {
              await api('PUT', `/api/rules/${r.id}`, { params: r.params, severity: r.severity, note: r.note, active: !r.active });
              reload();
            }) }, r.active ? 'Pause' : 'Activate'),
            d.canManage && h('button', { class: 'link small', onclick: act(async () => {
              if (!confirm('Delete this rule?')) return;
              await api('DELETE', `/api/rules/${r.id}`);
              reload();
            }) }, 'Delete'))))
        : empty('No rules yet.'),
      d.canManage && ruleForm,
      h('h4', {}, 'History'),
      m.values.length
        ? h('div', { class: 'table-wrap' }, h('table', {},
            h('thead', {}, h('tr', {}, ['Period', 'Value', 'Source', 'Rows / distinct', 'Status', ''].map((t) => h('th', {}, t)))),
            h('tbody', {}, m.values.map((v) => h('tr', {},
              h('td', {}, v.period),
              h('td', { class: 'num' }, fmtNum(v.value)),
              h('td', { class: 'num' }, fmtNum(v.source_value)),
              h('td', { class: 'num' }, v.row_count === null ? '—' : `${fmtNum(v.row_count)} / ${fmtNum(v.distinct_count)}`),
              h('td', {}, v.validated ? h('span', { title: `by ${v.validated_by_name || '?'} on ${fmtDate(v.validated_at)}` }, pill('Validated', 'ok')) : pill('Unchecked', 'soft')),
              h('td', {}, d.canManage && h('button', { class: 'link small', onclick: act(async () => {
                await api('POST', `/api/metrics/${m.id}/values/${encodeURIComponent(v.period)}/validate`, { validated: !v.validated });
                toast(v.validated ? 'Validation removed' : `${v.period} marked as checked and validated`);
                reload();
              }) }, v.validated ? 'Unvalidate' : 'Mark validated')))))))
        : empty('No values recorded yet.'),
      d.canManage && valueForm);
  };

  const addMetric = d.canManage
    ? h('form', { class: 'inline-form', onsubmit: act(async (e) => {
        const v = formData(e.target);
        await api('POST', `/api/dashboards/${d.id}/metrics`, v);
        toast('Metric added');
        reload();
      }) },
        h('input', { name: 'name', placeholder: 'Metric name, e.g. Active customers', required: true, size: 30 }),
        h('input', { name: 'unit', placeholder: 'Unit', size: 10 }),
        h('input', { name: 'description', placeholder: 'Description', size: 30 }),
        h('button', { type: 'submit' }, 'Add metric'))
    : null;

  container.replaceChildren(
    h('h2', {}, 'Data quality checks'),
    h('p', { class: 'muted small' }, 'Tracked figures from this report, the validated history they are compared to, and the rules that flag unexpected changes. A flag is a warning to investigate, not a confirmed error.'),
    ...metrics.map(metricCard),
    ...(addMetric ? [addMetric] : [])
  );
}

// ---------------------------------------------------------------------------------------
// Create / edit dashboard
// ---------------------------------------------------------------------------------------

async function renderEditor(id) {
  const d = id ? await api('GET', `/api/dashboards/${id}`) : { tags: [], visibility: 'public' };
  if (!state.directory) state.directory = await api('GET', '/api/directory');
  const text = (name, label, attrs = {}, hint) => field(label, h('input', { name, value: d[name] ?? '', ...attrs }), hint);
  const area = (name, label, rows, hint) => field(label, h('textarea', { name, rows }, d[name] ?? ''), hint);

  const form = h('form', { class: 'card stack editor', onsubmit: act(async () => {
    const v = formData(form);
    v.tags = v.tags.split(',').map((t) => t.trim()).filter(Boolean);
    v.owner_id = v.owner_id ? Number(v.owner_id) : null;
    v.stale_after_hours = v.stale_after_hours ? Number(v.stale_after_hours) : null;
    if (id) {
      await api('PATCH', `/api/dashboards/${id}`, v);
      toast('Saved');
    } else {
      const res = await api('POST', '/api/dashboards', v);
      id = res.id;
      toast('Dashboard registered');
    }
    state.facets = null;
    location.hash = `#/dashboards/${id}`;
  }) },
    h('h2', {}, 'Basics'),
    text('name', 'Dashboard name *', { required: true, maxlength: 200 }),
    text('url', 'Link to the report *', { required: true, type: 'url', placeholder: 'https://…' }),
    area('description', 'Description', 3, 'What the dashboard shows, in one or two sentences.'),
    area('purpose', 'Business purpose', 2, 'Which business questions does it answer?'),
    h('div', { class: 'grid3' },
      text('topic', 'Topic', { list: 'dl-topic' }),
      text('department', 'Department', { list: 'dl-dept' }),
      text('project', 'Project', { list: 'dl-proj' }),
      text('tool', 'Tool', { placeholder: 'Tableau, Power BI…' })),
    field('Tags', h('input', { name: 'tags', value: d.tags.join(', ') }), 'Comma-separated keywords people might search for.'),
    h('h2', {}, 'Documentation'),
    area('instructions', 'How to use and interpret the results', 5),
    area('limitations', 'Limitations and known data issues', 3),
    h('div', { class: 'grid2' },
      text('data_sources', 'Data sources'),
      text('update_frequency', 'Update frequency', { placeholder: 'Daily at 06:00' })),
    h('h2', {}, 'Ownership and monitoring'),
    h('div', { class: 'grid3' },
      field('Owner', select('owner_id', [['', '— none —'], ...state.directory.users.map((u) => [u.id, u.name])], d.owner?.id ?? (id ? '' : state.user.id))),
      field('Visibility', select('visibility', [['public', 'Everyone'], ['restricted', 'Restricted']], d.visibility)),
      text('stale_after_hours', 'Flag if not refreshed within (hours)', { type: 'number', min: 1 })),
    h('div', { class: 'actions' },
      h('button', { class: 'primary', type: 'submit' }, id ? 'Save changes' : 'Register dashboard'),
      h('a', { class: 'button', href: id ? `#/dashboards/${id}` : '#/' }, 'Cancel'),
      id && d.canManage && h('button', { type: 'button', class: 'danger', onclick: act(async () => {
        if (!confirm(`Delete "${d.name}" from the library? Comments, folders and schedules referencing it will be removed.`)) return;
        await api('DELETE', `/api/dashboards/${id}`);
        state.facets = null;
        toast('Deleted');
        location.hash = '#/';
      }) }, 'Delete')));

  const f = state.facets || (state.facets = await api('GET', '/api/facets'));
  view().replaceChildren(
    h('div', { class: 'page-head' }, h('h1', {}, id ? `Edit: ${d.name}` : 'Register a dashboard')),
    form,
    h('datalist', { id: 'dl-topic' }, f.topics.map((t) => h('option', { value: t }))),
    h('datalist', { id: 'dl-dept' }, f.departments.map((t) => h('option', { value: t }))),
    h('datalist', { id: 'dl-proj' }, f.projects.map((t) => h('option', { value: t })))
  );
}

// ---------------------------------------------------------------------------------------
// Personal workspace
// ---------------------------------------------------------------------------------------

async function renderWorkspace() {
  const [favs, folders] = await Promise.all([api('GET', '/api/dashboards?favorites=1'), api('GET', '/api/folders')]);
  const newFolder = h('form', { class: 'inline-form', onsubmit: act(async (e) => {
    await api('POST', '/api/folders', formData(e.target));
    renderWorkspace();
  }) }, h('input', { name: 'name', placeholder: 'New folder, e.g. Customer retention', required: true, size: 30 }), h('button', { type: 'submit' }, 'Create folder'));

  view().replaceChildren(
    h('div', { class: 'page-head' }, h('h1', {}, 'My workspace')),
    h('h2', {}, '★ Favorites'),
    favs.length ? h('div', { class: 'results' }, favs.map(dashboardCard)) : empty('Star a dashboard to keep it here.'),
    h('h2', {}, 'Folders'),
    newFolder,
    folders.length
      ? h('div', { class: 'folders' }, folders.map((f) =>
          h('div', { class: 'card' },
            h('div', { class: 'page-head' },
              h('h3', {}, `📁 ${f.name}`),
              h('div', { class: 'actions' },
                h('button', { class: 'link small', onclick: act(async () => {
                  const name = prompt('Rename folder', f.name);
                  if (!name || name === f.name) return;
                  await api('PATCH', `/api/folders/${f.id}`, { name });
                  renderWorkspace();
                }) }, 'Rename'),
                h('button', { class: 'link small', onclick: act(async () => {
                  if (!confirm(`Delete folder "${f.name}"? The dashboards themselves are not affected.`)) return;
                  await api('DELETE', `/api/folders/${f.id}`);
                  renderWorkspace();
                }) }, 'Delete'))),
            f.items.length
              ? h('ul', { class: 'folder-items' }, f.items.map((i) => h('li', {},
                  h('a', { href: `#/dashboards/${i.id}` }, i.name), ' ', i.tool && h('span', { class: 'muted small' }, i.tool),
                  h('button', { class: 'link small', title: 'Remove from folder', onclick: act(async () => {
                    await api('DELETE', `/api/folders/${f.id}/items/${i.id}`);
                    renderWorkspace();
                  }) }, 'Remove'))))
              : empty('Empty. Use "Add to folder" on a dashboard page.'))))
      : empty('No folders yet.')
  );
}

// ---------------------------------------------------------------------------------------
// Scheduled delivery
// ---------------------------------------------------------------------------------------

async function renderSchedules() {
  const params = queryParams();
  const [groups, schedules, dashboards] = await Promise.all([
    api('GET', '/api/recipient-groups'),
    api('GET', '/api/schedules'),
    api('GET', '/api/dashboards'),
  ]);

  const freqExtra = h('span', {});
  const renderFreqExtra = (freq) => {
    freqExtra.replaceChildren(...[
      freq === 'weekly' ? select('weekday', DAYS.map((d, i) => [i, d]), 1, { 'aria-label': 'Weekday' }) : null,
      freq === 'monthly' ? h('input', { name: 'dayOfMonth', type: 'number', min: 1, max: 28, value: 1, 'aria-label': 'Day of month', size: 4 }) : null,
    ].filter(Boolean));
  };
  const schedForm = h('form', { class: 'card stack', onsubmit: act(async () => {
    const v = formData(schedForm);
    await api('POST', '/api/schedules', {
      dashboardId: Number(v.dashboardId), recipientGroupId: Number(v.recipientGroupId), frequency: v.frequency,
      timeOfDay: v.timeOfDay, weekday: v.weekday !== undefined ? Number(v.weekday) : undefined,
      dayOfMonth: v.dayOfMonth !== undefined ? Number(v.dayOfMonth) : undefined, note: v.note,
    });
    toast('Schedule created');
    location.hash = '#/schedules';
    renderSchedules();
  }) },
    h('h2', {}, 'New scheduled delivery'),
    groups.length ? null : h('p', { class: 'alert-inline' }, 'Create a recipient group first (below).'),
    h('div', { class: 'grid2' },
      field('Report', select('dashboardId', dashboards.map((d) => [d.id, d.name]), params.get('dashboardId'))),
      field('Recipients', select('recipientGroupId', groups.map((g) => [g.id, `${g.name} (${g.members.length})`]), ''))),
    h('div', { class: 'inline-form' },
      select('frequency', [['daily', 'Every day'], ['weekdays', 'Every weekday'], ['weekly', 'Weekly on'], ['monthly', 'Monthly on day']], 'daily', {
        onchange: (e) => renderFreqExtra(e.target.value), 'aria-label': 'Frequency',
      }),
      freqExtra,
      h('span', {}, 'at'),
      h('input', { name: 'timeOfDay', type: 'time', value: '09:00', required: true, 'aria-label': 'Time' })),
    field('Message (optional)', h('input', { name: 'note', placeholder: 'e.g. Please check the South region before stand-up' })),
    h('p', { class: 'muted small' }, 'Recipients receive a link to the report, not a copy of the data, so access permissions still apply.'),
    h('button', { class: 'primary', type: 'submit', disabled: !groups.length }, 'Create schedule'));

  const groupForm = (g) => {
    const form = h('form', { class: 'stack', onsubmit: act(async () => {
      const v = formData(form);
      if (g) await api('PUT', `/api/recipient-groups/${g.id}`, v);
      else await api('POST', '/api/recipient-groups', v);
      toast('Recipient group saved');
      renderSchedules();
    }) },
      field('Group name', h('input', { name: 'name', value: g?.name || '', required: true })),
      field('Email addresses', h('textarea', { name: 'members', rows: 3 }, g ? g.members.join('\n') : ''), 'One per line or comma-separated.'),
      h('div', { class: 'actions' },
        h('button', { type: 'submit' }, g ? 'Save' : 'Create group'),
        g && h('button', { type: 'button', class: 'link', onclick: act(async () => {
          if (!confirm(`Delete "${g.name}"? Schedules using it will be removed.`)) return;
          await api('DELETE', `/api/recipient-groups/${g.id}`);
          renderSchedules();
        }) }, 'Delete')));
    return form;
  };

  view().replaceChildren(
    h('div', { class: 'page-head' }, h('h1', {}, 'Scheduled reports')),
    h('h2', {}, 'My schedules'),
    schedules.length
      ? h('div', { class: 'table-wrap card' }, h('table', {},
          h('thead', {}, h('tr', {}, ['Report', 'When', 'Recipients', 'Next run', 'Last delivery', ''].map((t) => h('th', {}, t)))),
          h('tbody', {}, schedules.map((s) => h('tr', { class: s.active ? '' : 'inactive' },
            h('td', {}, h('a', { href: `#/dashboards/${s.dashboard_id}` }, s.dashboard_name), s.note && h('div', { class: 'muted small' }, s.note)),
            h('td', {}, s.description, !s.active && pill('paused', 'soft')),
            h('td', {}, `${s.group_name} (${s.recipients})`),
            h('td', {}, s.active ? fmtDate(s.next_run_at) : '—'),
            h('td', {}, s.last_status ? pill(s.last_status, s.last_status === 'sent' ? 'ok' : 'danger') : '—', s.last_run_at && h('div', { class: 'muted small' }, fmtDate(s.last_run_at))),
            h('td', { class: 'actions' },
              h('button', { class: 'link small', onclick: act(async () => {
                const r = await api('POST', `/api/schedules/${s.id}/run`);
                toast(r.status === 'sent' ? 'Sent now' : `Delivery ${r.status}`, r.status === 'sent' ? 'ok' : 'warn');
                renderSchedules();
              }) }, 'Send now'),
              h('button', { class: 'link small', onclick: act(async () => {
                await api('PUT', `/api/schedules/${s.id}`, {
                  dashboardId: s.dashboard_id, recipientGroupId: s.recipient_group_id, frequency: s.frequency, timeOfDay: s.time_of_day,
                  weekday: s.weekday ?? undefined, dayOfMonth: s.day_of_month ?? undefined, note: s.note, active: !s.active,
                });
                renderSchedules();
              }) }, s.active ? 'Pause' : 'Resume'),
              h('button', { class: 'link small', onclick: act(async () => {
                const list = await api('GET', `/api/schedules/${s.id}/deliveries`);
                alert(list.length ? list.map((x) => `${fmtDate(x.created_at)} — ${x.status}: ${x.detail}`).join('\n') : 'No deliveries yet.');
              }) }, 'History'),
              h('button', { class: 'link small', onclick: act(async () => {
                if (!confirm('Delete this schedule?')) return;
                await api('DELETE', `/api/schedules/${s.id}`);
                renderSchedules();
              }) }, 'Delete')))))))
      : empty('No schedules yet.'),
    schedForm,
    h('h2', {}, 'Recipient groups'),
    h('div', { class: 'folders' },
      groups.map((g) => h('div', { class: 'card' }, groupForm(g))),
      h('div', { class: 'card' }, h('h3', {}, 'New recipient group'), groupForm(null)))
  );
  renderFreqExtra('daily');
}

// ---------------------------------------------------------------------------------------
// Data quality issues
// ---------------------------------------------------------------------------------------

async function renderQuality() {
  const params = queryParams();
  const status = params.get('status') || 'open';
  const qs = new URLSearchParams({ status });
  if (params.get('dashboardId')) qs.set('dashboardId', params.get('dashboardId'));
  if (params.get('mine') === '1') qs.set('mine', '1');
  const issues = await api('GET', `/api/issues?${qs}`);
  const focus = params.get('issue');

  const setParam = (k, v) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v); else p.delete(k);
    p.delete('issue');
    location.hash = '#/quality?' + p;
  };

  const issueCard = (i) => {
    const form = h('form', { class: 'stack', onsubmit: act(async () => {
      const v = formData(form);
      await api('PATCH', `/api/issues/${i.id}`, v);
      toast('Issue updated');
      renderQuality();
    }) },
      h('div', { class: 'inline-form' },
        select('status', Object.entries(STATUS_LABEL), i.status, { 'aria-label': 'Status' }),
        h('input', { name: 'resolution', placeholder: 'Resolution and reason for the change (required to close)', value: i.resolution || '', size: 50 }),
        h('button', { type: 'submit' }, 'Update')));
    return h('article', { class: `card issue sev-border-${i.severity} ${String(i.id) === focus ? 'focus' : ''}`, id: `issue-${i.id}` },
      h('div', { class: 'page-head' },
        h('div', {},
          pill(STATUS_LABEL[i.status], `st-${i.status}`), ' ', pill(i.severity, `sev-${i.severity}`), ' ',
          h('a', { href: `#/dashboards/${i.dashboard_id}` }, h('strong', {}, i.dashboard_name)),
          i.metric_name && h('span', { class: 'muted' }, ` · ${i.metric_name}`),
          i.period && h('span', { class: 'muted' }, ` · ${i.period}`)),
        h('span', { class: 'muted small' }, `#${i.id} · ${fmtDate(i.created_at)}`)),
      h('p', {}, i.message),
      i.expected !== null || i.actual !== null
        ? h('div', { class: 'compare' },
            h('div', {}, h('span', { class: 'muted small' }, 'Expected / reference'), h('strong', {}, fmtNum(i.expected))),
            h('div', {}, h('span', { class: 'muted small' }, 'Actual'), h('strong', {}, fmtNum(i.actual))),
            i.expected !== null && i.actual !== null
              ? h('div', {}, h('span', { class: 'muted small' }, 'Difference'), h('strong', {}, `${i.actual - i.expected > 0 ? '+' : ''}${fmtNum(Math.round((i.actual - i.expected) * 100) / 100)}`))
              : null)
        : null,
      h('p', { class: 'muted small' }, `Rule: ${i.rule_type.replaceAll('_', ' ')}`),
      i.resolution && h('p', { class: 'resolution' }, h('strong', {}, 'Resolution: '), i.resolution, i.resolved_by_name ? h('span', { class: 'muted' }, ` — ${i.resolved_by_name}, ${fmtDate(i.resolved_at)}`) : null),
      i.canManage ? form : h('p', { class: 'muted small' }, 'The report owner investigates and resolves this issue.'));
  };

  view().replaceChildren(
    h('div', { class: 'page-head' }, h('h1', {}, 'Data quality')),
    h('p', { class: 'muted' }, 'Automatic checks raise warnings. The report owner investigates, then confirms an error, or dismisses the warning as expected (seasonality, corrections, method changes). Each resolution is recorded with its reason.'),
    h('div', { class: 'filters' },
      select('status', [['open', 'Open'], ['all', 'All'], ...Object.entries(STATUS_LABEL)], status, { onchange: (e) => setParam('status', e.target.value), 'aria-label': 'Status filter' }),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: params.get('mine') === '1', onchange: (e) => setParam('mine', e.target.checked ? '1' : '') }), 'Only reports I own'),
      params.get('dashboardId') && h('button', { class: 'link', onclick: () => setParam('dashboardId', '') }, 'Show all reports')),
    issues.length ? h('div', { class: 'stack' }, issues.map(issueCard)) : empty('No issues match. 🎉')
  );
  if (focus) $(`#issue-${focus}`)?.scrollIntoView({ block: 'center' });
}

// ---------------------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------------------

async function renderNotifications() {
  const list = await api('GET', '/api/notifications');
  view().replaceChildren(
    h('div', { class: 'page-head' }, h('h1', {}, 'Notifications'),
      h('button', { onclick: act(async () => { await api('POST', '/api/notifications/read'); await refreshMe(); renderNotifications(); }) }, 'Mark all read')),
    list.length
      ? h('ul', { class: 'notif card' }, list.map((n) => h('li', { class: n.read_at ? '' : 'unread' },
          n.link ? h('a', { href: n.link }, n.message) : n.message, h('div', { class: 'muted small' }, fmtDate(n.created_at)))))
      : empty('Nothing here yet.')
  );
}

// ---------------------------------------------------------------------------------------
// Administration
// ---------------------------------------------------------------------------------------

async function renderAdmin() {
  if (!state.user.isAdmin) return view().replaceChildren(empty('Administrator access required.'));
  const [metrics, users, groups] = await Promise.all([api('GET', '/api/admin/metrics'), api('GET', '/api/admin/users'), api('GET', '/api/admin/groups')]);

  const stat = (label, value, hint) => h('div', { class: 'card stat' }, h('span', { class: 'muted small' }, label), h('strong', {}, value ?? '—'), hint && h('span', { class: 'muted small' }, hint));

  const userForm = h('form', { class: 'inline-form', onsubmit: act(async () => {
    const v = formData(userForm);
    await api('POST', '/api/admin/users', v);
    toast('User created');
    state.directory = null;
    renderAdmin();
  }) },
    h('input', { name: 'name', placeholder: 'Full name', required: true }),
    h('input', { name: 'email', type: 'email', placeholder: 'Email', required: true }),
    h('input', { name: 'department', placeholder: 'Department' }),
    h('input', { name: 'password', type: 'password', placeholder: 'Initial password (8+)', required: true, minlength: 8 }),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'isAdmin' }), 'Admin'),
    h('button', { type: 'submit' }, 'Add user'));

  const groupCard = (g) => {
    const form = h('form', { class: 'stack', onsubmit: act(async () => {
      const v = formData(form);
      await api('PUT', `/api/admin/groups/${g.id}/members`, { userIds: v.userIds.map(Number) });
      toast('Members saved');
      renderAdmin();
    }) },
      h('select', { name: 'userIds', multiple: true, size: 5, 'aria-label': 'Members' },
        users.filter((u) => u.active).map((u) => h('option', { value: u.id, selected: g.members.some((m) => m.id === u.id) }, u.name))),
      h('div', { class: 'actions' },
        h('button', { type: 'submit' }, 'Save members'),
        h('button', { type: 'button', class: 'link', onclick: act(async () => {
          if (!confirm(`Delete group "${g.name}"? Access granted through it will be revoked.`)) return;
          await api('DELETE', `/api/admin/groups/${g.id}`);
          state.directory = null;
          renderAdmin();
        }) }, 'Delete group')));
    return h('div', { class: 'card' }, h('h3', {}, g.name), g.description && h('p', { class: 'muted small' }, g.description), form);
  };

  const newGroup = h('form', { class: 'inline-form', onsubmit: act(async (e) => {
    await api('POST', '/api/admin/groups', formData(e.target));
    state.directory = null;
    renderAdmin();
  }) }, h('input', { name: 'name', placeholder: 'Group name', required: true }), h('input', { name: 'description', placeholder: 'Description' }), h('button', { type: 'submit' }, 'Create group'));

  const extra = h('div', {});
  view().replaceChildren(
    h('div', { class: 'page-head' }, h('h1', {}, 'Administration')),
    h('h2', {}, 'Success indicators (last 30 days)'),
    h('div', { class: 'stats' },
      stat('Dashboards', metrics.dashboards),
      stat('Fully documented', `${metrics.documentationRate}%`, `${metrics.fullyDocumented} of ${metrics.dashboards}; avg ${metrics.averageCompleteness}%`),
      stat('Active users', metrics.activeUsers30d),
      stat('Searches', metrics.searches30d, `${metrics.zeroResultSearches30d} with no results`),
      stat('Questions asked', metrics.questionsAsked30d),
      stat('DQ issues resolved', `${metrics.issuesResolved} / ${metrics.issuesDetected}`),
      stat('Delivery success', metrics.deliverySuccessRate === null ? '—' : `${metrics.deliverySuccessRate}%`, `${metrics.deliveries30d} deliveries`)),
    h('div', { class: 'grid2' },
      h('div', { class: 'card' }, h('h3', {}, 'Most viewed'), metrics.topDashboards.length ? h('ol', {}, metrics.topDashboards.map((d) => h('li', {}, h('a', { href: `#/dashboards/${d.id}` }, d.name), ` — ${d.views}`))) : empty('No views yet.')),
      h('div', { class: 'card' }, h('h3', {}, 'Searches with no results'), h('p', { class: 'muted small' }, 'Candidates for new dashboards, tags or better descriptions.'),
        metrics.topZeroResultQueries.length ? h('ol', {}, metrics.topZeroResultQueries.map((q) => h('li', {}, `"${q.query}" — ${q.n}×`))) : empty('None.'))),
    h('h2', {}, 'Users'),
    userForm,
    h('div', { class: 'table-wrap card' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Name', 'Email', 'Department', 'Groups', 'Role', 'Status', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, users.map((u) => h('tr', { class: u.active ? '' : 'inactive' },
        h('td', {}, u.name), h('td', {}, u.email), h('td', {}, u.department || '—'), h('td', {}, u.groups || '—'),
        h('td', {}, u.is_admin ? pill('Admin', 'owner') : 'User'),
        h('td', {}, u.active ? 'Active' : 'Deactivated'),
        h('td', { class: 'actions' },
          h('button', { class: 'link small', onclick: act(async () => {
            await api('PATCH', `/api/admin/users/${u.id}`, { isAdmin: !u.is_admin });
            renderAdmin();
          }) }, u.is_admin ? 'Revoke admin' : 'Make admin'),
          h('button', { class: 'link small', onclick: act(async () => {
            await api('PATCH', `/api/admin/users/${u.id}`, { active: !u.active });
            renderAdmin();
          }) }, u.active ? 'Deactivate' : 'Reactivate'),
          h('button', { class: 'link small', onclick: act(async () => {
            const pw = prompt(`New password for ${u.name} (8+ characters)`);
            if (!pw) return;
            await api('PATCH', `/api/admin/users/${u.id}`, { password: pw });
            toast('Password reset');
          }) }, 'Reset password'))))))),
    h('h2', {}, 'Access groups'),
    newGroup,
    h('div', { class: 'folders' }, groups.map(groupCard)),
    h('h2', {}, 'Logs'),
    h('div', { class: 'actions' },
      h('button', { onclick: act(async () => {
        const rows = await api('GET', '/api/admin/outbox');
        extra.replaceChildren(h('div', { class: 'card' }, h('h3', {}, 'Outgoing messages'),
          rows.length ? h('ul', { class: 'log' }, rows.map((r) => h('li', {}, h('strong', {}, r.recipient), ` · ${r.subject} · ${r.status} · ${fmtDate(r.created_at)}`, h('pre', {}, r.body)))) : empty('Outbox is empty.')));
      }) }, 'Show outbox'),
      h('button', { onclick: act(async () => {
        const rows = await api('GET', '/api/admin/audit');
        extra.replaceChildren(h('div', { class: 'card' }, h('h3', {}, 'Audit log'),
          h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['When', 'Who', 'Action', 'Entity', 'Details'].map((t) => h('th', {}, t)))),
            h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, fmtDate(r.created_at)), h('td', {}, r.user_name || 'system'), h('td', {}, r.action), h('td', {}, `${r.entity} #${r.entity_id ?? ''}`), h('td', { class: 'small' }, r.details))))))));
      }) }, 'Show audit log')),
    extra
  );
}

// ---------------------------------------------------------------------------------------

$('#logout').addEventListener('click', act(async () => {
  await api('POST', '/api/auth/logout');
  state.user = null;
  state.facets = null;
  state.directory = null;
  location.hash = '#/login';
}));

window.addEventListener('hashchange', route);
route();
