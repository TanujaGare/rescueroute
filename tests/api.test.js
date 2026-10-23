import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { buildTestApp, login, NOW, scriptedModel } from './helpers.js';
import { signToken, verifyToken, hashPassword, verifyPassword } from '../src/security/auth.js';

const at = (min) => new Date(NOW + min * 60_000).toISOString();

async function startRun(app, token) {
  const res = await request(app).post('/api/runs').set('Authorization', `Bearer ${token}`).send({ objective: 'Rescue everything possible' });
  assert.equal(res.status, 202);
  return res.body.id;
}

test('health check reports db and planner status', async () => {
  const { app } = buildTestApp();
  const res = await request(app).get('/healthz');
  assert.equal(res.status, 200);
  assert.equal(res.body.db, 'ok');
  assert.equal(res.body.gemini_configured, false);
  assert.ok(!JSON.stringify(res.body).toLowerCase().includes('key='));
});

test('security headers: CSP, frame denial, no x-powered-by', async () => {
  const { app } = buildTestApp();
  const res = await request(app).get('/');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-security-policy'], /default-src 'self'/);
  assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['x-powered-by'], undefined);
});

test('login rejects wrong password and validates input', async () => {
  const { app } = buildTestApp();
  const bad = await request(app).post('/api/auth/login').send({ email: 'coordinator@rescueroute.demo', password: 'nope' });
  assert.equal(bad.status, 401);
  const invalid = await request(app).post('/api/auth/login').send({ email: 'not-an-email', password: 'x' });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'VALIDATION_FAILED');
  const extra = await request(app).post('/api/auth/login').send({ email: 'a@b.co', password: 'x', role: 'admin' });
  assert.equal(extra.status, 400, 'unknown fields are rejected');
});

test('login is rate limited', async () => {
  const { app } = buildTestApp();
  let last;
  for (let i = 0; i < 11; i++) {
    last = await request(app).post('/api/auth/login').send({ email: 'coordinator@rescueroute.demo', password: 'wrong' });
  }
  assert.equal(last.status, 429);
});

test('protected routes require a valid, untampered token', async () => {
  const { app, config } = buildTestApp();
  assert.equal((await request(app).get('/api/overview')).status, 401);
  const forged = signToken({ sub: 'usr_coord', role: 'coordinator' }, 'a-different-secret-of-sufficient-length!!', 3600);
  assert.equal((await request(app).get('/api/overview').set('Authorization', `Bearer ${forged}`)).status, 401);
  const expired = signToken({ sub: 'usr_coord', role: 'coordinator' }, config.sessionSecret, 60, NOW - 3_600_000);
  assert.equal((await request(app).get('/api/overview').set('Authorization', `Bearer ${expired}`)).status, 401);
});

test('token and password primitives', () => {
  const t = signToken({ sub: 'u' }, 's'.repeat(32), 60);
  assert.equal(verifyToken(t, 's'.repeat(32)).sub, 'u');
  const [body, sig] = t.split('.');
  const tampered = `${Buffer.from(JSON.stringify({ sub: 'admin', exp: 9e9 })).toString('base64url')}.${sig}`;
  assert.equal(verifyToken(tampered, 's'.repeat(32)), null);
  assert.equal(verifyToken(`${body}`, 's'.repeat(32)), null);
  const h = hashPassword('pw');
  assert.ok(verifyPassword('pw', h));
  assert.ok(!verifyPassword('pw2', h));
  assert.ok(!verifyPassword('pw', 'garbage'));
});

test('overview returns computed KPIs without leaking password hashes', async () => {
  const { app } = buildTestApp();
  const token = await login(app);
  const res = await request(app).get('/api/overview').set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.kpis.open_donations, 13);
  assert.ok(res.body.kpis.at_risk_kg > 0);
  assert.ok(!JSON.stringify(res.body).includes('scrypt$'));
});

test('viewer cannot run the agent, create donations or approve', async () => {
  const { app } = buildTestApp();
  const token = await login(app, 'viewer@rescueroute.demo');
  const auth = { Authorization: `Bearer ${token}` };
  assert.equal((await request(app).post('/api/runs').set(auth).send({ objective: 'do it now' })).status, 403);
  assert.equal((await request(app).post('/api/donations').set(auth).send({})).status, 403);
  assert.equal((await request(app).post('/api/dispatches/dsp_x/decision').set(auth).send({ decision: 'approve' })).status, 403);
});

test('donation creation validates and sanitises input', async () => {
  const { app, repo } = buildTestApp();
  const token = await login(app);
  const auth = { Authorization: `Bearer ${token}` };
  const good = {
    donor_id: 'dnr_sahyadri', category: 'bakery', description: 'Buns\u0007 and cakes', quantity_kg: 12,
    needs_cold: false, ready_at: at(0), expires_at: at(240), notes: '<script>alert(1)</script>',
  };
  const ok = await request(app).post('/api/donations').set(auth).send(good);
  assert.equal(ok.status, 201);
  const saved = repo.listDonations().find((d) => d.id === ok.body.id);
  assert.equal(saved.description, 'Buns and cakes', 'control characters stripped');

  const cases = [
    { ...good, quantity_kg: -5 },
    { ...good, category: 'weapons' },
    { ...good, expires_at: at(-10), ready_at: at(-20) },
    { ...good, expires_at: at(0), ready_at: at(10) },
    { ...good, donor_id: 'dnr_missing' },
    { ...good, description: 'x'.repeat(500) },
  ];
  for (const body of cases) {
    const res = await request(app).post('/api/donations').set(auth).send(body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
  }
});

test('malformed and oversized JSON bodies are rejected cleanly', async () => {
  const { app } = buildTestApp();
  const bad = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{"email":');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'BAD_REQUEST');
  const big = await request(app).post('/api/auth/login').send({ email: 'a@b.co', password: 'x'.repeat(20_000) });
  assert.equal(big.status, 413);
});

test('full workflow: run, poll, approve; double decision refused', async () => {
  const { app, orchestrator } = buildTestApp();
  const token = await login(app);
  const auth = { Authorization: `Bearer ${token}` };
  const id = await startRun(app, token);
  await orchestrator.idle();
  const { body } = await request(app).get(`/api/runs/${id}`).set(auth);
  assert.equal(body.run.status, 'completed_with_warnings', 'no Gemini key, so the fallback is disclosed');
  assert.ok(body.run.dispatches.length >= 8);
  const d = body.run.dispatches[0];

  const approve = await request(app).post(`/api/dispatches/${d.id}/decision`).set(auth).send({ decision: 'approve' });
  assert.equal(approve.status, 200);
  assert.equal(approve.body.status, 'approved');
  const again = await request(app).post(`/api/dispatches/${d.id}/decision`).set(auth).send({ decision: 'reject' });
  assert.equal(again.status, 409);

  const overview = await request(app).get('/api/overview').set(auth);
  assert.equal(overview.body.donations.find((x) => x.id === d.donation_id).status, 'assigned');
  const audit = await request(app).get('/api/audit').set(auth);
  assert.ok(audit.body.entries.some((e) => e.action === 'dispatch.approve' && e.target === d.id));
});

test('rejecting a dispatch reopens the donation for the next run', async () => {
  const { app, orchestrator } = buildTestApp();
  const token = await login(app);
  const auth = { Authorization: `Bearer ${token}` };
  const id = await startRun(app, token);
  await orchestrator.idle();
  const { body } = await request(app).get(`/api/runs/${id}`).set(auth);
  const d = body.run.dispatches[0];
  await request(app).post(`/api/dispatches/${d.id}/decision`).set(auth).send({ decision: 'reject' });
  const overview = await request(app).get('/api/overview').set(auth);
  assert.equal(overview.body.donations.find((x) => x.id === d.donation_id).status, 'open');
});

test('cross-user isolation: another coordinator cannot read runs or decide dispatches', async () => {
  const { app, orchestrator } = buildTestApp();
  const tokenA = await login(app);
  const tokenB = await login(app, 'coordinator2@rescueroute.demo');
  const id = await startRun(app, tokenA);
  await orchestrator.idle();
  const run = await request(app).get(`/api/runs/${id}`).set('Authorization', `Bearer ${tokenA}`);
  const dispatchId = run.body.run.dispatches[0].id;

  assert.equal((await request(app).get(`/api/runs/${id}`).set('Authorization', `Bearer ${tokenB}`)).status, 404);
  const decide = await request(app).post(`/api/dispatches/${dispatchId}/decision`).set('Authorization', `Bearer ${tokenB}`).send({ decision: 'approve' });
  assert.equal(decide.status, 404);
  const list = await request(app).get('/api/runs').set('Authorization', `Bearer ${tokenB}`);
  assert.equal(list.body.runs.length, 0);
});

test('a second run does not re-propose food already awaiting approval', async () => {
  const { app, orchestrator } = buildTestApp();
  const token = await login(app);
  const auth = { Authorization: `Bearer ${token}` };
  const first = await startRun(app, token);
  await orchestrator.idle();
  const second = await startRun(app, token);
  await orchestrator.idle();
  const r1 = (await request(app).get(`/api/runs/${first}`).set(auth)).body.run;
  const r2 = (await request(app).get(`/api/runs/${second}`).set(auth)).body.run;
  const ids1 = new Set(r1.dispatches.map((d) => d.donation_id));
  assert.ok(r2.dispatches.every((d) => !ids1.has(d.donation_id)));
});

test('unknown API routes and bad ids return 404 JSON', async () => {
  const { app } = buildTestApp();
  const token = await login(app);
  assert.equal((await request(app).get('/api/nope').set('Authorization', `Bearer ${token}`)).status, 404);
  assert.equal((await request(app).get('/api/runs/../../etc').set('Authorization', `Bearer ${token}`)).status, 404);
});

test('planner status is truthful: no key means fallback; latest run decides the badge', async () => {
  const { app, orchestrator } = buildTestApp();
  const token = await login(app);
  const auth = { Authorization: `Bearer ${token}` };
  let status = (await request(app).get('/api/planner/status').set(auth)).body;
  assert.equal(status.label, 'Deterministic fallback');
  assert.equal(status.gemini_configured, false);
  await startRun(app, token);
  await orchestrator.idle();
  status = (await request(app).get('/api/planner/status').set(auth)).body;
  assert.equal(status.latest_run.planner_mode, 'deterministic_fallback');
  assert.match(status.detail, /MISSING_API_KEY/);
  assert.equal(status.stats.fallback_rate, 1);
});

test('connection check: missing key, verified key, and failing key', async () => {
  const none = buildTestApp();
  const t0 = await login(none.app);
  const r0 = await request(none.app).post('/api/planner/check').set('Authorization', `Bearer ${t0}`);
  assert.equal(r0.status, 503);
  assert.equal(r0.body.code, 'MISSING_API_KEY');

  const good = scriptedModel([]);
  good.ping = async () => ({ text: 'ready' });
  const ok = buildTestApp({ model: good });
  const t1 = await login(ok.app);
  const before = (await request(ok.app).get('/api/planner/status').set('Authorization', `Bearer ${t1}`)).body;
  assert.equal(before.state, 'unverified', 'a configured key alone is not reported as working');
  const r1 = await request(ok.app).post('/api/planner/check').set('Authorization', `Bearer ${t1}`);
  assert.equal(r1.status, 200);
  assert.equal(r1.body.ok, true);
  const after = (await request(ok.app).get('/api/planner/status').set('Authorization', `Bearer ${t1}`)).body;
  assert.equal(after.label, 'Gemini AI active');

  const bad = scriptedModel([]);
  bad.ping = async () => { throw Object.assign(new Error('API key not valid'), { status: 400 }); };
  const ko = buildTestApp({ model: bad });
  const t2 = await login(ko.app);
  const r2 = await request(ko.app).post('/api/planner/check').set('Authorization', `Bearer ${t2}`);
  assert.equal(r2.status, 503);
  assert.equal(r2.body.code, 'INVALID_API_KEY');
  const st = (await request(ko.app).get('/api/planner/status').set('Authorization', `Bearer ${t2}`)).body;
  assert.equal(st.label, 'Planner unavailable');

  const tv = await login(ok.app, 'viewer@rescueroute.demo');
  assert.equal((await request(ok.app).post('/api/planner/check').set('Authorization', `Bearer ${tv}`)).status, 403);
});

test('delivery lifecycle: proposed -> approved -> delivered, tracked separately in KPIs', async () => {
  const { app, orchestrator } = buildTestApp();
  const token = await login(app);
  const auth = { Authorization: `Bearer ${token}` };
  const id = await startRun(app, token);
  await orchestrator.idle();
  const d = (await request(app).get(`/api/runs/${id}`).set(auth)).body.run.dispatches[0];
  assert.equal((await request(app).post(`/api/dispatches/${d.id}/delivered`).set(auth)).status, 409, 'cannot deliver before approval');
  await request(app).post(`/api/dispatches/${d.id}/decision`).set(auth).send({ decision: 'approve' });
  const del = await request(app).post(`/api/dispatches/${d.id}/delivered`).set(auth);
  assert.equal(del.status, 200);
  const k = (await request(app).get('/api/overview').set(auth)).body.kpis;
  assert.equal(k.delivered_kg, d.quantity_kg);
  assert.ok(k.proposed_kg > 0);
  const audit = (await request(app).get('/api/audit').set(auth)).body.entries.map((e) => e.action);
  for (const a of ['run.start', 'run.complete', 'planner.fallback', 'dispatch.approve', 'dispatch.delivered']) assert.ok(audit.includes(a), a);
});

test('planner status: a stale no-key run does not hide a newly configured key; newer evidence wins', async () => {
  const { buildPlannerStatus } = await import('../src/services/planner-status.js');
  const stats = { runs: 1, gemini_runs: 0, fallback_runs: 1, failed_runs: 0 };
  const staleRun = { planner_mode: 'deterministic_fallback', status: 'completed_with_warnings', fallback_reason: 'MISSING_API_KEY: x', finished_at: '2026-10-23T08:10:00Z' };
  const model = { name: 'gemini-3.5-flash' };
  assert.equal(buildPlannerStatus({ model, latestRun: staleRun, stats }).state, 'unverified');
  assert.equal(buildPlannerStatus({ model: null, latestRun: staleRun, stats }).label, 'Deterministic fallback');
  const rateRun = { ...staleRun, fallback_reason: 'RATE_LIMITED: y' };
  assert.equal(buildPlannerStatus({ model, latestRun: rateRun, stats }).label, 'Deterministic fallback');
  const newerCheck = { ok: true, code: 'OK', at: '2026-10-23T08:20:00Z' };
  assert.equal(buildPlannerStatus({ model, latestRun: rateRun, lastCheck: newerCheck, stats }).label, 'Gemini AI active');
});

test('serverless mode completes the run within the request and returns it', async () => {
  const { app } = buildTestApp({ serverless: true });
  const token = await login(app);
  const res = await request(app).post('/api/runs').set('Authorization', `Bearer ${token}`).send({ objective: 'Rescue everything possible' });
  assert.equal(res.status, 201);
  assert.notEqual(res.body.run.status, 'running');
  assert.ok(res.body.run.stages.length >= 7);
  assert.ok(res.body.run.dispatches.length > 0);
});
