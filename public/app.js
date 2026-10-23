// RescueRoute client. All server data is rendered with textContent (never innerHTML) to prevent XSS.

const $ = (sel) => document.querySelector(sel);
const TOKEN_KEY = 'rescueroute.token';
const state = { user: null, overview: null, currentRunId: null, pollTimer: null };

// ---------- helpers ----------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function getToken() {
  try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
}
function setToken(token) {
  try { token ? sessionStorage.setItem(TOKEN_KEY, token) : sessionStorage.removeItem(TOKEN_KEY); } catch { /* storage unavailable */ }
}

async function api(path, { method = 'GET', body, allowError = false } = {}) {
  const headers = { Accept: 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error('Network error: the server could not be reached.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/auth/login') {
    signOut('Your session has expired. Please sign in again.');
  }
  if (!res.ok && !allowError) {
    const issues = data.error?.issues?.map((i) => `${i.path}: ${i.message}`).join('; ');
    const err = new Error(issues ? `${data.error.message} (${issues})` : data.error?.message || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const fmtMin = (m) => {
  if (m <= 0) return 'expired';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
};
const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtDateTime = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const fmtMs = (ms) => (ms === null || ms === undefined ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const pct = (x) => (x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`);
const label = (s) => String(s).replaceAll('_', ' ');
const statusTag = (s) => el('span', { class: `tag st-${s}` }, label(s));
const MODE_LABELS = { gemini: 'Gemini AI', deterministic_fallback: 'Deterministic fallback', none: 'None (failed)', pending: 'Running' };

function setStatus(node, message, isError = false) {
  node.textContent = message;
  node.classList.toggle('error', isError);
}

function renderTable(table, columns, rows, emptyText) {
  const caption = table.querySelector('caption');
  table.replaceChildren();
  if (caption) table.append(caption);
  table.append(el('thead', {}, el('tr', {}, columns.map((c) => el('th', { scope: 'col', class: c.num ? 'num' : null }, c.label)))));
  const tbody = el('tbody');
  if (rows.length === 0) {
    tbody.append(el('tr', {}, el('td', { class: 'empty', colspan: columns.length }, emptyText)));
  }
  for (const row of rows) {
    tbody.append(el('tr', {}, columns.map((c) => el('td', { class: c.num ? 'num' : null }, c.render(row)))));
  }
  table.append(tbody);
}

const kpi = (value, text, alert = false) =>
  el('div', { class: `kpi${alert ? ' alert' : ''}` }, el('div', { class: 'value' }, value), el('div', { class: 'label' }, text));

// ---------- session ----------

async function signIn(event) {
  event.preventDefault();
  const errorBox = $('#login-error');
  errorBox.textContent = '';
  const form = event.currentTarget;
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const { token } = await api('/auth/login', {
      method: 'POST',
      body: { email: form.email.value, password: form.password.value },
    });
    setToken(token);
    form.password.value = '';
    await enterApp();
  } catch (err) {
    errorBox.textContent = err.message;
  } finally {
    button.disabled = false;
  }
}

function signOut(message) {
  setToken(null);
  clearInterval(state.pollTimer);
  state.user = null;
  $('#app-view').hidden = true;
  $('#session').hidden = true;
  $('#login-view').hidden = false;
  if (message) $('#login-error').textContent = message;
  $('#email').focus();
}

async function enterApp() {
  const { user } = await api('/me');
  state.user = user;
  document.body.classList.toggle('role-viewer', user.role !== 'coordinator');
  $('#user-label').textContent = `${user.name}`;
  $('#login-view').hidden = true;
  $('#session').hidden = false;
  $('#app-view').hidden = false;
  showView('dashboard');
  await Promise.all([loadOverview(), loadPlannerStatus()]);
  $('#main').focus();
}

// ---------- planner status ----------

async function loadPlannerStatus() {
  try {
    const s = await api('/planner/status');
    const badge = $('#planner-badge');
    badge.textContent = s.label;
    badge.title = s.detail;
    badge.className = `badge planner-${s.state}`;
    const parts = [s.detail];
    if (s.model) parts.push(`Model: ${s.model}.`);
    if (s.stats.runs) parts.push(`Your runs: ${s.stats.runs} (Gemini ${pct(s.stats.gemini_run_rate)}, fallback ${pct(s.stats.fallback_rate)}).`);
    $('#planner-detail').textContent = parts.join(' ');
  } catch (err) {
    $('#planner-badge').textContent = 'Planner status unknown';
  }
}

async function checkGemini() {
  const status = $('#check-status');
  const button = $('#check-btn');
  button.disabled = true;
  setStatus(status, 'Sending a minimal test request to Gemini…');
  try {
    const r = await api('/planner/check', { method: 'POST', allowError: true });
    if (r.ok) setStatus(status, `Connected: ${r.message} Round trip ${fmtMs(r.latency_ms)}.`);
    else setStatus(status, `Not connected (${r.code ?? r.error?.code}): ${r.message ?? r.error?.message}`, true);
  } catch (err) {
    setStatus(status, err.message, true);
  } finally {
    button.disabled = false;
    loadPlannerStatus();
  }
}

// ---------- navigation ----------

function showView(name) {
  for (const tab of document.querySelectorAll('.tab')) {
    if (tab.dataset.view === name) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  for (const panel of document.querySelectorAll('[data-view-panel]')) {
    panel.hidden = panel.dataset.viewPanel !== name;
  }
  if (name === 'history') loadHistory();
  if (name === 'audit') loadAudit();
  if (name === 'agent') loadPlannerStatus();
}

// ---------- dashboard ----------

async function loadOverview() {
  const status = $('#dashboard-status');
  setStatus(status, 'Loading…');
  try {
    state.overview = await api('/overview');
    renderOverview(state.overview);
    setStatus(status, `Updated ${fmtTime(state.overview.generated_at)}`);
  } catch (err) {
    setStatus(status, err.message, true);
  }
}

function renderOverview(o) {
  const k = o.kpis;
  $('#kpis').replaceChildren(
    kpi(`${k.open_kg} kg`, `Open food (${k.open_donations} donations)`),
    kpi(`${k.at_risk_kg} kg`, 'Open and expiring within 3 h', k.at_risk_kg > 0),
    kpi(`${k.proposed_kg} kg`, `Proposed, awaiting approval (${k.awaiting_approval})`),
    kpi(`${k.assigned_kg} kg`, 'Approved, not yet delivered'),
    kpi(`${k.delivered_kg} kg`, 'Delivered (confirmed)'),
    kpi(`${k.expired_kg} kg`, 'Expired (lost)', k.expired_kg > 0),
  );

  renderTable($('#donations-table'), [
    { label: 'Donation', render: (d) => el('span', {}, el('strong', {}, d.description), el('br'), el('small', {}, d.donor_name)) },
    { label: 'Category', render: (d) => `${label(d.category)}${d.needs_cold ? ' · cold' : ''}` },
    { label: 'Kg', num: true, render: (d) => d.quantity_kg },
    { label: 'Expires in', render: (d) => (d.status === 'open' || d.status === 'proposed' ? fmtMin(d.expires_in_min) : '—') },
    { label: 'Status', render: (d) => statusTag(d.status) },
  ], o.donations, 'No donations logged yet.');

  renderTable($('#recipients-table'), [
    { label: 'Recipient', render: (r) => r.name },
    { label: 'Accepts', render: (r) => r.accepts.map(label).join(', ') + (r.has_cold_storage ? ' · cold storage' : '') },
    { label: 'Capacity', num: true, render: (r) => `${r.capacity_kg} kg` },
    { label: 'Closes in', render: (r) => fmtMin(r.closes_in_min) },
  ], o.recipients, 'No recipients.');

  renderTable($('#vehicles-table'), [
    { label: 'Vehicle', render: (v) => v.name },
    { label: 'Capacity', num: true, render: (v) => `${v.capacity_kg} kg` },
    { label: 'Cold', render: (v) => (v.refrigerated ? 'Yes' : 'No') },
    { label: 'Available', render: (v) => (v.available ? 'Yes' : statusTag('unavailable')) },
  ], o.vehicles, 'No vehicles.');

  const select = $('#d-donor');
  const current = select.value;
  select.replaceChildren(...o.donors.map((d) => el('option', { value: d.id }, d.name)));
  if (current) select.value = current;

  renderMap(o, []);
}

function renderMap(o, routes) {
  const NS = 'http://www.w3.org/2000/svg';
  const points = [
    ...o.donations.filter((d) => d.status === 'open').map((d) => ({ lat: d.donor_lat, lng: d.donor_lng, kind: 'donor', name: d.donor_name })),
    ...o.recipients.map((r) => ({ lat: r.lat, lng: r.lng, kind: 'recipient', name: r.name })),
    ...o.vehicles.map((v) => ({ lat: v.lat, lng: v.lng, kind: 'vehicle', name: v.name })),
  ];
  const all = [...o.donors, ...o.recipients, ...o.vehicles];
  const lats = all.map((p) => p.lat);
  const lngs = all.map((p) => p.lng);
  const [minLat, maxLat, minLng, maxLng] = [Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs)];
  const W = 400, H = 300, pad = 24;
  const x = (lng) => pad + ((lng - minLng) / (maxLng - minLng || 1)) * (W - 2 * pad);
  const y = (lat) => H - pad - ((lat - minLat) / (maxLat - minLat || 1)) * (H - 2 * pad);

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Map of ${points.length} locations: donors with open food, NGO recipients and vehicle bases${routes.length ? `, with ${routes.length} proposed routes` : ''}.`);
  for (const r of routes) {
    const line = document.createElementNS(NS, 'polyline');
    line.setAttribute('class', 'route');
    line.setAttribute('points', r.map((p) => `${x(p.lng)},${y(p.lat)}`).join(' '));
    svg.append(line);
  }
  for (const p of points) {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', x(p.lng));
    c.setAttribute('cy', y(p.lat));
    c.setAttribute('r', p.kind === 'recipient' ? 6 : 5);
    c.setAttribute('class', `pt-${p.kind}`);
    const title = document.createElementNS(NS, 'title');
    title.textContent = p.name;
    c.append(title);
    svg.append(c);
  }
  const north = document.createElementNS(NS, 'text');
  north.setAttribute('x', W - 30);
  north.setAttribute('y', 16);
  north.textContent = 'N ↑';
  svg.append(north);
  $('#map').replaceChildren(svg);
}

async function addDonation(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const errorBox = $('#donation-error');
  errorBox.textContent = '';
  const now = Date.now();
  const body = {
    donor_id: form.donor_id.value,
    category: form.category.value,
    description: form.description.value,
    quantity_kg: Number(form.quantity_kg.value),
    needs_cold: form.needs_cold.checked,
    ready_at: new Date(now).toISOString(),
    expires_at: new Date(now + Number(form.expires_in.value) * 60_000).toISOString(),
    notes: form.notes.value,
  };
  if (!body.description.trim() || !(body.quantity_kg > 0)) {
    errorBox.textContent = 'Enter a description and a quantity above 0 kg.';
    return;
  }
  try {
    await api('/donations', { method: 'POST', body });
    form.reset();
    form.expires_in.value = 180;
    setStatus($('#dashboard-status'), 'Donation added.');
    await loadOverview();
  } catch (err) {
    errorBox.textContent = err.message;
  }
}

async function resetDemo() {
  if (!window.confirm('Reset all demo data? This clears donations, runs and approvals.')) return;
  try {
    await api('/demo/reset', { method: 'POST' });
    setStatus($('#dashboard-status'), 'Demo data reset.');
    await Promise.all([loadOverview(), loadPlannerStatus()]);
  } catch (err) {
    setStatus($('#dashboard-status'), err.message, true);
  }
}

// ---------- agent runs ----------

async function startRun(event) {
  event.preventDefault();
  const status = $('#run-status');
  const button = $('#run-btn');
  button.disabled = true;
  setStatus(status, 'Starting agent run…');
  try {
    const { id } = await api('/runs', { method: 'POST', body: { objective: $('#objective').value } });
    state.currentRunId = id;
    $('#run-output').hidden = false;
    pollRun(id);
  } catch (err) {
    setStatus(status, err.message, true);
    button.disabled = false;
  }
}

function pollRun(id) {
  clearInterval(state.pollTimer);
  const tick = async () => {
    try {
      const { run } = await api(`/runs/${id}`);
      renderRun(run);
      if (run.status !== 'running') {
        clearInterval(state.pollTimer);
        $('#run-btn').disabled = false;
        loadOverview();
        loadPlannerStatus();
      }
    } catch (err) {
      clearInterval(state.pollTimer);
      $('#run-btn').disabled = false;
      setStatus($('#run-status'), err.message, true);
    }
  };
  tick();
  state.pollTimer = setInterval(tick, 1000);
}

const STEP_LABELS = { model: 'Gemini turn', tool_call: 'Tool', blocked: 'Blocked tool request' };

function renderStage(s, steps) {
  const trace = s.key === 'plan' && steps.length
    ? el('details', {}, el('summary', {}, `Gemini trace (${steps.length} steps)`),
      el('ol', { class: 'trace' }, steps.map((t) => el('li', {},
        `${STEP_LABELS[t.kind] ?? t.kind}${t.tool ? `: ${t.tool}` : ''} ${t.ok ? '✓' : '✗'} (${fmtMs(t.latency_ms)}) `,
        el('code', {}, JSON.stringify(t.output ?? t.input ?? {}).slice(0, 300))))))
    : null;
  return el('li', { class: s.status },
    el('div', { class: 'step-head' },
      el('span', {}, s.label),
      statusTag(s.status),
      el('span', { class: 'ms' }, s.duration_ms !== null ? fmtMs(s.duration_ms) : s.status === 'running' ? 'running…' : '')),
    s.summary ? el('p', { class: 'stage-summary' }, s.summary) : null,
    s.error ? el('p', { class: 'stage-error' }, `Error: ${s.error}`) : null,
    s.detail && Object.keys(s.detail).length ? el('details', {}, el('summary', {}, 'Technical details'), el('pre', {}, JSON.stringify(s.detail, null, 2))) : null,
    trace);
}

function renderRun(run) {
  const status = $('#run-status');
  if (run.status === 'running') setStatus(status, 'Agent running…');
  else if (run.status === 'failed') setStatus(status, `Run failed: ${run.error}`, true);
  else if (run.status === 'completed_with_warnings') setStatus(status, `Run completed with warnings. Planner: ${MODE_LABELS[run.planner_mode]}.${run.fallback_reason ? ` Fallback reason: ${run.fallback_reason}` : ''}`);
  else setStatus(status, `Run completed. Planner: ${MODE_LABELS[run.planner_mode]}.`);

  $('#timeline').replaceChildren(...run.stages.map((s) => renderStage(s, run.steps)));

  $('#run-summary').textContent = run.summary ?? (run.status === 'running' ? 'Planning in progress…' : run.error ?? '');
  const m = run.metrics;
  $('#criteria').replaceChildren(...(m?.criteria ?? []).map((c) => el('li', {},
    el('span', { class: c.passed ? 'pass' : 'fail' }, c.passed ? 'PASS' : 'FAIL'),
    el('span', {}, c.label + (c.value !== undefined ? ` (${pct(c.value)})` : '')))));
  const metric = (k, v) => el('div', {}, el('dt', {}, k), el('dd', {}, v));
  $('#run-metrics').replaceChildren(...(m ? [
    metric('Planner used', MODE_LABELS[m.planner_mode] ?? '—'),
    metric('Planner time', fmtMs(m.planner_ms)),
    metric('End-to-end time', fmtMs(m.latency_ms)),
    metric('Gemini call success', m.model_calls ? `${pct(m.model_success_rate)} (${m.model_successes}/${m.model_calls})` : 'not called'),
    metric('Proposals generated / valid / saved', `${m.proposals_generated} / ${m.proposals_validated} / ${m.proposals_saved}`),
    metric('Validation rate', pct(m.validation_rate)),
    metric('Saved from Gemini / rule-based', `${m.by_source.gemini} / ${m.by_source.deterministic}`),
    metric('Food allocated', `${m.allocated_kg} of ${m.feasible_kg} feasible kg`),
    metric('Urgent donations allocated', `${m.urgent_allocated}/${m.urgent_feasible} (${pct(m.urgent_allocation_rate)})`),
    metric('Constraint violations saved', m.violations),
    metric('Blocked tool requests', m.blocked_tool_calls),
    metric('Tokens in / out', `${m.input_tokens} / ${m.output_tokens}`),
  ] : []));

  const cmp = m?.comparison;
  renderTable($('#comparison-table'), [
    { label: 'Plan', render: (r) => r.name },
    { label: 'Dispatches', num: true, render: (r) => r.dispatches },
    { label: 'Kg allocated', num: true, render: (r) => r.kg },
    { label: 'Distance', num: true, render: (r) => `${r.distance_km} km` },
  ], cmp ? [
    { name: `This run (${MODE_LABELS[run.planner_mode]})`, ...cmp.this_run },
    { name: 'Deterministic planner only', ...cmp.deterministic_only },
  ] : [], run.status === 'running' ? 'Available when the run finishes.' : 'Not available.');

  renderDispatches(run);
  if (state.overview && run.dispatches.length) {
    const donors = new Map(state.overview.donors.map((d) => [d.name, d]));
    const recips = new Map(state.overview.recipients.map((r) => [r.id, r]));
    const routes = run.dispatches
      .filter((d) => d.status !== 'rejected' && donors.has(d.donor_name) && recips.has(d.recipient_id))
      .map((d) => [donors.get(d.donor_name), recips.get(d.recipient_id)]);
    renderMap(state.overview, routes);
  }
}

function renderDispatches(run) {
  const box = $('#dispatches');
  if (!run.dispatches.length) {
    box.replaceChildren(el('p', { class: 'empty' }, run.status === 'running' ? 'Proposals appear when planning finishes.' : 'No dispatches were saved.'));
    return;
  }
  const isCoordinator = state.user?.role === 'coordinator';
  box.replaceChildren(...run.dispatches.map((d) => el('article', { class: 'dispatch', 'aria-label': `${d.description} to ${d.recipient_name}` },
    el('div', {},
      el('h3', {}, `${d.quantity_kg} kg ${label(d.category)}: ${d.donor_name} → ${d.recipient_name}`),
      el('div', {}, d.description, ' · priority ', statusTag(d.priority)),
      el('div', { class: 'facts' },
        el('span', { class: 'tag tag-verified' }, 'verified'),
        el('span', {}, `Vehicle: ${d.vehicle_name}`),
        el('span', {}, `Route: ${d.distance_km} km (estimate)`),
        el('span', {}, `Pickup ${fmtTime(d.pickup_at)}`),
        el('span', {}, `Delivered by ${fmtTime(d.deliver_at)}`),
        el('span', {}, `Safety slack: ${d.slack_minutes} min`),
        d.needs_cold ? el('span', {}, 'Cold chain kept') : null),
      el('p', { class: 'rationale' },
        el('span', { class: `tag ${d.source === 'gemini' ? 'tag-inferred' : 'tag-verified'}` }, d.source === 'gemini' ? 'Gemini rationale' : 'rule-based'), ' ', d.rationale),
      d.assumptions ? el('p', { class: 'assumption' }, `Assumptions: ${d.assumptions}`) : null,
      el('details', {}, el('summary', {}, `${d.constraints_checked.length} hard constraints verified in code`), el('p', {}, d.constraints_checked.map(label).join(', ')))),
    el('div', { class: 'decide' },
      d.status === 'pending_approval' && isCoordinator
        ? [
          el('button', { type: 'button', class: 'btn btn-ok', onclick: () => act(`/dispatches/${d.id}/decision`, { decision: 'approve' }, 'Dispatch approved.', run.id), 'aria-label': `Approve dispatch of ${d.description}` }, 'Approve'),
          el('button', { type: 'button', class: 'btn btn-bad', onclick: () => act(`/dispatches/${d.id}/decision`, { decision: 'reject' }, 'Dispatch rejected; the food is open again.', run.id), 'aria-label': `Reject dispatch of ${d.description}` }, 'Reject'),
        ]
        : d.status === 'approved' && isCoordinator
          ? [statusTag('approved'), el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => act(`/dispatches/${d.id}/delivered`, undefined, 'Marked as delivered.', run.id), 'aria-label': `Mark ${d.description} delivered` }, 'Mark delivered')]
          : statusTag(d.status)),
  )));
}

async function act(path, body, message, runId) {
  try {
    await api(path, { method: 'POST', body });
    setStatus($('#run-status'), message);
    const { run } = await api(`/runs/${runId}`);
    renderRun(run);
    loadOverview();
  } catch (err) {
    setStatus($('#run-status'), err.message, true);
  }
}

// ---------- history & audit ----------

async function loadHistory() {
  try {
    const { runs, stats } = await api('/runs');
    $('#run-stats').replaceChildren(
      kpi(stats.runs, 'Finished runs'),
      kpi(stats.runs ? pct(stats.gemini_runs / stats.runs) : '—', 'Planned by Gemini'),
      kpi(stats.runs ? pct(stats.fallback_runs / stats.runs) : '—', 'Fallback frequency', stats.fallback_runs > 0),
      kpi(stats.failed_runs, 'Failed runs', stats.failed_runs > 0),
    );
    renderTable($('#runs-table'), [
      { label: 'Started', render: (r) => fmtDateTime(r.started_at) },
      { label: 'Planner', render: (r) => statusTag(r.planner_mode) },
      { label: 'Status', render: (r) => statusTag(r.status) },
      { label: 'Fallback reason', render: (r) => r.fallback_reason ?? '—' },
      { label: 'Saved', num: true, render: (r) => (r.metrics ? `${r.metrics.proposals_saved}/${r.metrics.proposals_generated}` : '—') },
      { label: 'Kg', num: true, render: (r) => (r.metrics ? r.metrics.allocated_kg : '—') },
      { label: 'Urgent', num: true, render: (r) => (r.metrics ? pct(r.metrics.urgent_allocation_rate) : '—') },
      { label: 'Violations', num: true, render: (r) => (r.metrics ? r.metrics.violations : '—') },
      { label: 'Time', num: true, render: (r) => (r.metrics ? fmtMs(r.metrics.latency_ms) : '—') },
      { label: '', render: (r) => el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => openRun(r.id) }, 'Open') },
    ], runs, 'No runs yet. Start one from “Plan with agent”.');
  } catch (err) {
    setStatus($('#dashboard-status'), err.message, true);
  }
}

function openRun(id) {
  showView('agent');
  $('#run-output').hidden = false;
  pollRun(id);
}

async function loadAudit() {
  try {
    const { entries } = await api('/audit');
    renderTable($('#audit-table'), [
      { label: 'Time', render: (a) => fmtDateTime(a.created_at) },
      { label: 'Action', render: (a) => a.action },
      { label: 'Target', render: (a) => a.target ?? '—' },
      { label: 'Details', render: (a) => (a.details ? JSON.stringify(a.details) : '—') },
    ], entries, 'No actions recorded yet.');
  } catch (err) {
    setStatus($('#dashboard-status'), err.message, true);
  }
}

// ---------- boot ----------

document.addEventListener('DOMContentLoaded', () => {
  $('#login-form').addEventListener('submit', signIn);
  $('#logout').addEventListener('click', () => signOut());
  $('#refresh').addEventListener('click', loadOverview);
  $('#reset-demo').addEventListener('click', resetDemo);
  $('#donation-form').addEventListener('submit', addDonation);
  $('#run-form').addEventListener('submit', startRun);
  $('#check-btn').addEventListener('click', checkGemini);
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => showView(tab.dataset.view));
  }
  if (getToken()) enterApp().catch(() => signOut());
});
