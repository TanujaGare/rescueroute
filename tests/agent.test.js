import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestApp, runAndWait, scriptedModel, NOW } from './helpers.js';
import { executeTool, functionDeclarations, TOOL_NAMES } from '../src/agent/tools.js';
import { classifyGeminiError } from '../src/agent/gemini.js';
import { PlanState, greedyPlan } from '../src/domain/planning.js';

const LIST = [['list_open_donations', {}], ['list_recipients', {}], ['list_vehicles', {}]];
const stage = (run, key) => run.stages.find((s) => s.key === key);
const propose = (donation_id, recipient_id, vehicle_id, quantity_kg, extra = {}) => ['propose_dispatch', {
  donation_id, recipient_id, vehicle_id, quantity_kg, priority: 'high',
  rationale: 'Chosen from rank_options output.', constraints_considered: ['expiry', 'capacity'], ...extra,
}];
const failingModel = (err) => {
  const m = { name: 'failing', calls: 0, generate: async () => { m.calls += 1; throw err; } };
  return m;
};

/** Proposals a perfect planner would make on the seeded data, used to script a fully successful Gemini run. */
function seededPlan(repo) {
  const open = repo.listDonations().filter((d) => d.status === 'open' && Date.parse(d.expires_at) > NOW);
  return greedyPlan(new PlanState({ donations: open, recipients: repo.listRecipients(), vehicles: repo.listVehicles(), now: NOW }));
}

test('function declarations cover every tool and expose no approval or raw-access tools', () => {
  const decls = functionDeclarations();
  assert.deepEqual(decls.map((d) => d.name), TOOL_NAMES);
  for (const d of decls) assert.equal(d.parametersJsonSchema.type, 'object');
  assert.ok(!TOOL_NAMES.some((n) => /approve|deliver|delete|sql|http/.test(n)));
  const propose = decls.find((d) => d.name === 'propose_dispatch').parametersJsonSchema;
  for (const f of ['donation_id', 'recipient_id', 'vehicle_id', 'quantity_kg', 'priority', 'rationale', 'constraints_considered']) {
    assert.ok(propose.required.includes(f), `${f} required`);
  }
});

test('Gemini success: structured proposals are verified and saved; no fallback stage; badge-worthy mode', async () => {
  const probe = buildTestApp();
  const plan = seededPlan(probe.repo);
  const model = scriptedModel([
    LIST,
    plan.map((a) => propose(a.donation_id, a.recipient_id, a.vehicle_id, a.quantity_kg, { priority: 'critical', assumptions: 'Road factor estimate.' })),
    [['finish', { summary: 'All feasible food placed.', unallocated: [{ donation_id: 'don_rice_bulk', reason: 'Too heavy' }] }]],
  ]);
  const { orchestrator, repo } = buildTestApp({ model });
  const run = await runAndWait(orchestrator, repo);

  assert.equal(run.status, 'completed');
  assert.equal(run.planner_mode, 'gemini');
  assert.equal(run.fallback_reason, null);
  assert.deepEqual(run.stages.map((s) => s.key), ['analyze', 'assess', 'plan', 'select', 'validate', 'save', 'evaluate', 'summarize']);
  assert.ok(run.stages.every((s) => s.status === 'success' && typeof s.duration_ms === 'number' && s.started_at && s.finished_at));
  assert.equal(stage(run, 'plan').label, 'Gemini AI planner');
  assert.equal(run.metrics.by_source.gemini, plan.length);
  assert.equal(run.metrics.by_source.deterministic, 0);
  assert.equal(run.metrics.proposals_saved, plan.length);
  assert.equal(run.metrics.validation_rate, 1);
  assert.equal(run.metrics.model_success_rate, 1);
  assert.equal(run.metrics.success, true);
  const d = run.dispatches[0];
  assert.equal(d.source, 'gemini');
  assert.equal(d.priority, 'critical');
  assert.equal(d.assumptions, 'Road factor estimate.');
  assert.ok(d.constraints_checked.includes('cold_chain_vehicle'));
  assert.ok(run.metrics.comparison.deterministic_only.kg > 0, 'same-input baseline is reported');
  assert.equal(run.metrics.plan_selected, 'gemini');
  assert.equal(stage(run, 'select').status, 'success');
});

test('missing API key: plan stage skipped, fallback disclosed, run marked with warnings', async () => {
  const { orchestrator, repo } = buildTestApp();
  const run = await runAndWait(orchestrator, repo);
  assert.equal(run.planner_mode, 'deterministic_fallback');
  assert.equal(run.status, 'completed_with_warnings');
  assert.match(run.fallback_reason, /^MISSING_API_KEY/);
  assert.equal(stage(run, 'plan').status, 'skipped');
  assert.equal(stage(run, 'fallback').status, 'warning');
  assert.equal(run.metrics.success, true, 'fallback still meets the success criteria on demo data');
  assert.ok(run.dispatches.every((d) => d.source === 'deterministic'));
  assert.ok(!run.dispatches.some((d) => d.donation_id === 'don_rice_bulk'), '400 kg exceeds every available vehicle');
  assert.ok(!run.dispatches.some((d) => d.vehicle_id === 'veh_tempo'), 'unavailable vehicle is never used');
  assert.match(stage(run, 'assess').summary, /cannot be placed/);
});

test('invalid API key is classified, not retried, and triggers the fallback', async () => {
  const model = failingModel(Object.assign(new Error('API key not valid. Please pass a valid API key.'), { status: 400 }));
  const { orchestrator, repo } = buildTestApp({ model, agent: { modelRetries: 2 } });
  const run = await runAndWait(orchestrator, repo);
  assert.equal(model.calls, 1, 'auth errors are not retried');
  assert.equal(run.planner_mode, 'deterministic_fallback');
  assert.match(run.fallback_reason, /^INVALID_API_KEY/);
  assert.equal(stage(run, 'plan').status, 'failed');
  assert.match(stage(run, 'plan').error, /rejected the API key/);
  assert.equal(stage(run, 'fallback').status, 'warning');
  assert.ok(run.dispatches.length > 0);
});

test('unauthorized (403) and missing model (404) are not retried', async () => {
  for (const [status, code] of [[403, 'UNAUTHORIZED'], [404, 'MODEL_NOT_FOUND']]) {
    const model = failingModel(Object.assign(new Error('denied'), { status }));
    const { orchestrator, repo } = buildTestApp({ model, agent: { modelRetries: 2 } });
    const run = await runAndWait(orchestrator, repo);
    assert.equal(model.calls, 1);
    assert.match(run.fallback_reason, new RegExp(`^${code}`));
  }
});

test('rate limit (429) is retried with backoff, then falls back', async () => {
  const model = failingModel(Object.assign(new Error('Resource exhausted'), { status: 429 }));
  const { orchestrator, repo } = buildTestApp({ model, agent: { modelRetries: 1 } });
  const run = await runAndWait(orchestrator, repo);
  assert.equal(model.calls, 2);
  assert.equal(run.metrics.model_retries, 1);
  assert.equal(run.metrics.model_success_rate, 0);
  assert.match(run.fallback_reason, /^RATE_LIMITED/);
});

test('model timeout: retries then falls back and still completes', async () => {
  let calls = 0;
  const model = { name: 'hanging', generate: () => { calls += 1; return new Promise(() => {}); } };
  const { orchestrator, repo } = buildTestApp({ model, agent: { modelTimeoutMs: 50, modelRetries: 1 } });
  const run = await runAndWait(orchestrator, repo);
  assert.equal(calls, 2);
  assert.equal(run.status, 'completed_with_warnings');
  assert.match(run.fallback_reason, /^TIMEOUT/);
  assert.ok(run.dispatches.length > 0);
});

test('malformed model output (no tool calls, or non-object) triggers fallback, never silent success', async () => {
  const text = scriptedModel([() => ({ content: { role: 'model', parts: [{ text: 'Sure! Here is a plan' }] }, functionCalls: [], usage: {} })]);
  const a = buildTestApp({ model: text });
  const run = await runAndWait(a.orchestrator, a.repo);
  assert.equal(run.planner_mode, 'deterministic_fallback');
  assert.match(run.fallback_reason, /^MALFORMED_RESPONSE/);

  const nul = scriptedModel([() => null]);
  const b = buildTestApp({ model: nul });
  const run2 = await runAndWait(b.orchestrator, b.repo);
  assert.match(run2.fallback_reason, /^MALFORMED_RESPONSE/);
});

test('API keys are redacted from recorded errors', async () => {
  const model = failingModel(new Error('fetch failed for https://x/?key=AIzaSyDUMMYDUMMYDUMMYDUMMY123'));
  const { orchestrator, repo } = buildTestApp({ model });
  const run = await runAndWait(orchestrator, repo);
  assert.ok(!JSON.stringify(run).includes('AIzaSy'));
  assert.match(run.fallback_reason, /^NETWORK/);
});

test('invalid IDs, capacity, unavailable vehicle, partial quantity and duplicates are rejected and never saved', async () => {
  const model = scriptedModel([
    [
      propose('don_ghost', 'rcp_seva', 'veh_cold_van', 10),
      propose('don_veg', 'rcp_nowhere', 'veh_cargo_van', 140),
      propose('don_veg', 'rcp_talegaon_bank', 'veh_spaceship', 140),
      propose('don_rice_bulk', 'rcp_annapurna', 'veh_cargo_van', 400),
      propose('don_rice_bulk', 'rcp_annapurna', 'veh_tempo', 400),
      propose('don_bread', 'rcp_annapurna', 'veh_cargo_van', 10),
      propose('don_hotel_milk', 'rcp_swargate', 'veh_bike', 30),
      propose('don_mess_fruit', 'rcp_talegaon_bank', 'veh_cargo_van', 30),
      propose('don_mess_fruit', 'rcp_pimpri_fridge', 'veh_cargo_van', 30),
    ],
    [['finish', { summary: 'done' }]],
  ]);
  const { orchestrator, repo } = buildTestApp({ model });
  const run = await runAndWait(orchestrator, repo);
  const codes = run.stages.find((s) => s.key === 'validate').detail.rejected_during_planning.flatMap((r) => r.violations.map((v) => v.code));
  for (const c of ['UNKNOWN_DONATION', 'UNKNOWN_RECIPIENT', 'UNKNOWN_VEHICLE', 'VEHICLE_CAPACITY', 'RECIPIENT_CAPACITY',
    'VEHICLE_UNAVAILABLE', 'PARTIAL_NOT_SUPPORTED', 'CATEGORY_NOT_ACCEPTED', 'COLD_CHAIN_VEHICLE', 'ALREADY_PLANNED']) {
    assert.ok(codes.includes(c), `expected ${c} in ${codes}`);
  }
  assert.equal(stage(run, 'validate').status, 'warning');
  assert.equal(run.metrics.proposals_generated, run.metrics.proposals_validated + 8);
  assert.ok(run.metrics.validation_rate < 1);
  const perDonation = run.dispatches.reduce((m, d) => m.set(d.donation_id, (m.get(d.donation_id) ?? 0) + 1), new Map());
  assert.ok([...perDonation.values()].every((n) => n === 1), 'no duplicate allocation');
  assert.ok(!run.dispatches.some((d) => d.vehicle_id === 'veh_tempo' || d.donation_id === 'don_rice_bulk'));
});

test('re-verification against fresh DB state rejects food claimed after planning', async () => {
  const ctx = {};
  const model = scriptedModel([
    [propose('don_bread', 'rcp_annapurna', 'veh_cargo_van', 22)],
    () => {
      // Simulates another process claiming the bread between planning and verification.
      ctx.db.prepare("UPDATE donations SET status = 'assigned' WHERE id = 'don_bread'").run();
      return { content: { role: 'model', parts: [{ functionCall: { name: 'finish', args: { summary: 'ok' } } }] }, functionCalls: [{ id: 'f', name: 'finish', args: { summary: 'ok' } }], usage: {} };
    },
  ]);
  const t = buildTestApp({ model });
  ctx.db = t.db;
  const run = await runAndWait(t.orchestrator, t.repo);
  const rejected = stage(run, 'validate').detail.rejected_on_reverification;
  assert.equal(rejected[0].donation_id, 'don_bread');
  assert.equal(rejected[0].violations[0].code, 'DONATION_NOT_OPEN');
  assert.equal(run.metrics.violations, 1);
  assert.ok(!run.dispatches.some((d) => d.donation_id === 'don_bread'));
});

test('prompt-injection style request for an undeclared tool is blocked and logged', async () => {
  const model = scriptedModel([
    [['approve_all_dispatches', { recipient_id: 'rcp_swargate' }], ['list_open_donations', {}]],
    [['finish', { summary: 'done' }]],
  ]);
  const { orchestrator, repo } = buildTestApp({ model });
  const run = await runAndWait(orchestrator, repo);
  const blocked = run.steps.find((s) => s.kind === 'blocked');
  assert.equal(blocked.output.error, 'TOOL_NOT_PERMITTED');
  assert.equal(run.metrics.blocked_tool_calls, 1);
  assert.ok(run.dispatches.every((d) => d.status === 'pending_approval'));
});

test('invalid tool arguments return structured errors; prototype keys are not tools', () => {
  const state = new PlanState({ donations: [], recipients: [], vehicles: [], now: 0 });
  const r = executeTool(state, 'propose_dispatch', { donation_id: 'DROP TABLE', recipient_id: 'x', vehicle_id: 'y', rationale: 'ok ok', extra: 1 });
  assert.equal(r.output.error, 'INVALID_ARGUMENTS');
  assert.equal(executeTool(state, '__proto__', {}).output.error, 'TOOL_NOT_PERMITTED');
  assert.equal(executeTool(state, 'constructor', {}).output.error, 'TOOL_NOT_PERMITTED');
});

test('turn limit and tool-call budget bound a model that never finishes', async () => {
  const a = buildTestApp({ model: scriptedModel([[['list_vehicles', {}]]]), agent: { maxModelTurns: 3 } });
  const run = await runAndWait(a.orchestrator, a.repo);
  assert.equal(run.steps.filter((s) => s.kind === 'model').length, 3);
  assert.match(run.fallback_reason, /turn limit/);

  const b = buildTestApp({ model: scriptedModel([[['list_vehicles', {}], ['list_vehicles', {}], ['list_vehicles', {}]]]), agent: { maxToolCalls: 4 } });
  const run2 = await runAndWait(b.orchestrator, b.repo);
  assert.equal(run2.metrics.tool_calls, 4);
  assert.match(run2.fallback_reason, /budget/);
});

test('early finish is refused until remaining feasible food is explained; gap-fill then completes the plan', async () => {
  const probe = buildTestApp();
  const others = probe.repo.listDonations().map((d) => d.id).filter((id) => id !== 'don_rice_dal');
  const model = scriptedModel([
    [propose('don_rice_dal', 'rcp_swargate', 'veh_erickshaw', 35)],
    [['finish', { summary: 'Placed one.' }]],
    [['finish', { summary: 'Placed one.', unallocated: others.map((donation_id) => ({ donation_id, reason: 'Left for coordinator review.' })) }]],
  ]);
  const { orchestrator, repo } = buildTestApp({ model });
  const run = await runAndWait(orchestrator, repo);
  const finishes = run.steps.filter((s) => s.tool === 'finish');
  assert.equal(finishes[0].ok, false);
  assert.equal(finishes[0].output.error, 'FEASIBLE_DONATIONS_REMAIN');
  assert.equal(finishes[1].ok, true);
  assert.equal(run.planner_mode, 'gemini');
  assert.equal(run.status, 'completed_with_warnings');
  assert.equal(stage(run, 'fallback').status, 'warning');
  assert.match(stage(run, 'fallback').summary, /left \d+ feasible donation/);
  assert.equal(run.metrics.by_source.gemini, 1);
  assert.ok(run.metrics.by_source.deterministic > 0);
  assert.match(run.summary, /Gemini's own summary \(unverified\)/);
});

test('database failure while saving fails the run with a sanitised error', async () => {
  const t = buildTestApp();
  t.repo.saveProposals = () => { throw new Error('SQLITE_IOERR: disk I/O error'); };
  const run = await runAndWait(t.orchestrator, t.repo);
  assert.equal(run.status, 'failed');
  assert.equal(stage(run, 'save').status, 'failed');
  assert.match(stage(run, 'save').error, /disk I\/O/);
  assert.equal(stage(run, 'evaluate').status, 'pending', 'later stages never ran');
  assert.equal(run.dispatches.length, 0);
});

test('concurrency: only one run at a time, and the DB refuses a second live dispatch per donation', async () => {
  const model = { name: 'slow', generate: () => new Promise(() => {}) };
  const { orchestrator, repo, db } = buildTestApp({ model, agent: { modelTimeoutMs: 40, modelRetries: 0 } });
  const first = orchestrator.start({ id: 'usr_coord' }, 'first run');
  assert.equal(orchestrator.start({ id: 'usr_coord2' }, 'second run').conflict, true);
  await first.done;
  const run = repo.getRunForUser(first.runId, 'usr_coord');
  const claimed = run.dispatches[0];

  // A second save of the same donation is skipped atomically.
  const again = repo.saveProposals(first.runId, [{ ...claimed, constraints_checked: [], source: 'deterministic' }]);
  assert.deepEqual(again.saved, []);
  assert.equal(again.skipped.length, 1);

  // Even a raw insert bypassing the claim is blocked by the partial unique index.
  db.prepare("UPDATE donations SET status = 'open' WHERE id = ?").run(claimed.donation_id);
  assert.throws(() => repo.saveProposals(first.runId, [{ ...claimed, constraints_checked: [], source: 'deterministic' }]), /UNIQUE/);
  assert.equal(repo.getRunForUser(first.runId, 'usr_coord').dispatches.filter((d) => d.donation_id === claimed.donation_id).length, 1, 'transaction rolled back');
});

test('classifyGeminiError maps provider failures', () => {
  const c = (e) => classifyGeminiError(e).code;
  assert.equal(c(Object.assign(new Error('API key not valid'), { status: 400 })), 'INVALID_API_KEY');
  assert.equal(c({ status: 401, message: 'x' }), 'UNAUTHORIZED');
  assert.equal(c({ status: 404, message: 'x' }), 'MODEL_NOT_FOUND');
  assert.equal(c({ status: 429, message: 'x' }), 'RATE_LIMITED');
  assert.equal(c({ status: 503, message: 'x' }), 'UNAVAILABLE');
  assert.equal(c(Object.assign(new Error('aborted'), { name: 'AbortError' })), 'TIMEOUT');
  assert.equal(c(new Error('fetch failed')), 'NETWORK');
  assert.equal(classifyGeminiError({ status: 429 }).retryable, true);
  assert.equal(classifyGeminiError({ status: 401 }).retryable, false);
});

test('Gemini adapter fails over to a backup model on overload, but not on auth errors', async () => {
  const { createGeminiModel } = await import('../src/agent/gemini.js');
  const fakeClient = (failFor) => ({
    models: {
      generateContent: async ({ model }) => {
        if (failFor[model]) throw failFor[model];
        return { candidates: [{ content: { role: 'model', parts: [] } }], functionCalls: [{ name: 'finish', args: {} }], usageMetadata: {} };
      },
    },
  });
  const overloaded = Object.assign(new Error('high demand'), { status: 503 });
  const switches = [];
  const m = createGeminiModel({ apiKey: 'k', model: 'primary', fallbackModels: ['backup'], client: fakeClient({ primary: overloaded }) });
  const r = await m.generate({ contents: [], tools: [], onSwitch: (s) => switches.push(s) });
  assert.equal(r.model, 'backup');
  assert.deepEqual(switches, [{ from: 'primary', to: 'backup', reason: 'UNAVAILABLE' }]);
  m.reset();
  assert.equal(m.name, 'primary', 'each run starts on the primary model');

  const badKey = Object.assign(new Error('API key not valid'), { status: 400 });
  const m2 = createGeminiModel({ apiKey: 'k', model: 'primary', fallbackModels: ['backup'], client: fakeClient({ primary: badKey }) });
  await assert.rejects(() => m2.generate({ contents: [], tools: [] }), (e) => e.code === 'INVALID_API_KEY');
});

test('one-turn planning: the first prompt carries the situation, ranked options and verified baseline', async () => {
  const probe = buildTestApp();
  const plan = seededPlan(probe.repo);
  let firstPrompt = '';
  const scripted = scriptedModel([[
    ...plan.map((a) => propose(a.donation_id, a.recipient_id, a.vehicle_id, a.quantity_kg)),
    ['finish', { summary: 'Adopted the verified baseline.', unallocated: [{ donation_id: 'don_rice_bulk', reason: 'Too heavy' }] }],
  ]]);
  const model = { name: 'one-turn', generate: (req) => { firstPrompt ||= req.contents[0].parts[0].text; return scripted.generate(req); } };
  const { orchestrator, repo } = buildTestApp({ model });
  const run = await runAndWait(orchestrator, repo);
  assert.equal(run.metrics.model_calls, 1, 'whole plan in a single Gemini request');
  assert.equal(run.planner_mode, 'gemini');
  assert.match(firstPrompt, /<situation>/);
  const brief = JSON.parse(firstPrompt.match(/<situation>(.*)<\/situation>/s)[1]);
  assert.equal(brief.baseline_plan.dispatches.length, plan.length);
  assert.ok(brief.donations.every((d) => Array.isArray(d.options)));
  assert.ok(brief.donations.find((d) => d.id === 'don_hotel_breakfast').donor_notes_untrusted.includes('IGNORE'), 'injected note is passed only as labelled data');
});

test('plan selection keeps the verified baseline when Gemini allocates less food, and says so', async () => {
  const model = scriptedModel([[propose('don_mess_fruit', 'rcp_talegaon_bank', 'veh_cargo_van', 30)], [['finish', { summary: 'done' }]]]);
  const { orchestrator, repo } = buildTestApp({ model, agent: { maxModelTurns: 2 } });
  const run = await runAndWait(orchestrator, repo);
  assert.equal(stage(run, 'select').status, 'warning');
  assert.equal(run.metrics.plan_selected, 'deterministic');
  assert.equal(run.planner_mode, 'deterministic_fallback');
  assert.match(run.fallback_reason, /^GEMINI_PLAN_INFERIOR/);
  assert.equal(run.metrics.allocated_kg, run.metrics.comparison.deterministic_only.kg);
  assert.ok(run.dispatches.every((d) => d.source === 'deterministic'));
});

test('impact estimate is derived from verified kilograms with cited factors', async () => {
  const { estimateImpact, IMPACT_FACTORS } = await import('../src/domain/impact.js');
  assert.deepEqual(estimateImpact(42), { meals: 100, co2e_kg: 105 });
  assert.ok(IMPACT_FACTORS.sources.length >= 2);
  const { orchestrator, repo } = buildTestApp();
  const run = await runAndWait(orchestrator, repo);
  assert.equal(run.metrics.impact_estimate.meals, Math.round(run.metrics.allocated_kg / 0.42));
});
