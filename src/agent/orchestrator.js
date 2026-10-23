import { PlanState, greedyPlan, urgencyFor, CONSTRAINTS_CHECKED, VERIFICATION_LIMITATIONS } from '../domain/planning.js';
import { plannerError } from './gemini.js';
import { createModelLoop, newModelMetrics } from './model-loop.js';
import { verifyAgainstDatabase } from './verifier.js';
import { buildSummary, explainInfeasible, outcomeMetrics, successCriteria } from './report.js';
import { iso, round1, round3, safeError, sumKg } from '../lib/util.js';

export { SYSTEM_POLICY, situationBrief } from './policy.js';
export { safeError } from '../lib/util.js';

/** Donations expiring within this many minutes count as urgent. */
export const URGENT_WINDOW_MIN = 180;
/** Gemini's plan is kept when it allocates at least the baseline's kilograms (within rounding). */
const SELECTION_TOLERANCE_KG = 0.05;

/** Fixed stages, created as 'pending' when a run starts. Fallback is inserted only when needed. */
const STAGES = [
  { seq: 10, key: 'analyze', label: 'Analyze situation' },
  { seq: 20, key: 'assess', label: 'Assess constraints' },
  { seq: 30, key: 'plan', label: 'Gemini AI planner' },
  { seq: 45, key: 'select', label: 'Plan selection' },
  { seq: 50, key: 'validate', label: 'Independent verification' },
  { seq: 60, key: 'save', label: 'Save proposals' },
  { seq: 70, key: 'evaluate', label: 'Evaluate success criteria' },
  { seq: 80, key: 'summarize', label: 'Summarize' },
];
const FALLBACK_STAGE = { seq: 40, key: 'fallback', label: 'Deterministic fallback' };

/**
 * Bounded, auditable agent workflow. Every stage is persisted with its real
 * status and measured duration so the UI timeline reflects what happened.
 * Hard constraints are enforced by PlanState in code, never by the model.
 */
export function createOrchestrator({ repo, config, model, clock = () => Date.now(), logger }) {
  const runModelLoop = model ? createModelLoop({ model, config, clock }) : null;
  let active = null;

  /** Per-run mutable context shared by the stage functions. */
  function createContext(runId, objective, user) {
    let traceSeq = 0;
    const ctx = {
      runId,
      objective,
      user,
      started: clock(),
      metrics: newModelMetrics(),
      trace: (step) => repo.addStep(runId, { seq: ++traceSeq, ...step }),
      modelOutcome: { finished: false, error: null, summary: null, proposed: 0, rejected: [] },
      selection: { kept: 'deterministic' },
      statuses: {},
    };
    /** Runs one stage: marks it running, measures it, persists its outcome. */
    ctx.stage = async (key, fn) => {
      const t0 = clock();
      repo.updateStage(runId, key, { status: 'running', started_at: iso(t0) });
      try {
        const out = await fn();
        const t1 = clock();
        repo.updateStage(runId, key, { ...out, started_at: iso(t0), finished_at: iso(t1), duration_ms: t1 - t0 });
        ctx.statuses[key] = out.status;
        return { ...out, duration_ms: t1 - t0 };
      } catch (err) {
        const t1 = clock();
        repo.updateStage(runId, key, {
          status: 'failed',
          summary: 'Stage failed; the run was stopped.',
          error: safeError(err),
          started_at: iso(t0),
          finished_at: iso(t1),
          duration_ms: t1 - t0,
        });
        throw err;
      }
    };
    return ctx;
  }

  // ----- 1. Analyze: read current data from the database -----
  function analyze(ctx) {
    return ctx.stage('analyze', () => {
      const all = repo.listDonations();
      const isOpen = (d) => d.status === 'open';
      const open = all.filter((d) => isOpen(d) && Date.parse(d.expires_at) > ctx.started);
      ctx.data = { donations: open, recipients: repo.listRecipients(), vehicles: repo.listVehicles() };
      const available = ctx.data.vehicles.filter((v) => v.available).length;
      return {
        status: open.length ? 'success' : 'warning',
        summary: `Loaded ${open.length} open donations (${sumKg(open)} kg), ${ctx.data.recipients.length} recipients and ${available}/${ctx.data.vehicles.length} available vehicles.`,
        detail: {
          open_donations: open.length,
          open_kg: sumKg(open),
          expired_excluded: all.filter((d) => isOpen(d) && Date.parse(d.expires_at) <= ctx.started).length,
          recipients: ctx.data.recipients.length,
          vehicles_available: available,
          vehicles_unavailable: ctx.data.vehicles.filter((v) => !v.available).map((v) => v.id),
        },
      };
    });
  }

  // ----- 2. Assess: deterministic feasibility, urgency and the verified baseline -----
  function assess(ctx) {
    const freshState = () => new PlanState({ ...ctx.data, now: ctx.started });
    ctx.freshState = freshState;
    ctx.state = freshState();
    ctx.feasibleAtStart = new Set();
    ctx.infeasible = [];
    return ctx.stage('assess', () => {
      const { state } = ctx;
      // Verified rule-based plan on the same snapshot: Gemini's starting point and the bar it must meet.
      ctx.baselinePlan = greedyPlan(freshState());
      for (const d of state.donations.values()) {
        if (state.rankOptions(d.id, 1).feasible_count > 0) ctx.feasibleAtStart.add(d.id);
        else ctx.infeasible.push({ donation_id: d.id, kg: d.quantity_kg, reason: explainInfeasible(state, d) });
      }
      const donations = [...state.donations.values()];
      ctx.urgent = donations.filter((d) => state.minutesFromNow(d.expires_at) <= URGENT_WINDOW_MIN);
      const bands = { critical: 0, high: 0, normal: 0, low: 0 };
      for (const d of donations) bands[urgencyFor(state.minutesFromNow(d.expires_at))] += 1;
      return {
        status: 'success',
        summary: `${ctx.feasibleAtStart.size} of ${donations.length} donations have at least one feasible route; ${ctx.urgent.length} expire within 3 h; ${ctx.infeasible.length} cannot be placed under any option.`,
        detail: {
          urgency_bands: bands,
          urgent_kg: sumKg(ctx.urgent),
          cold_chain_donations: donations.filter((d) => d.needs_cold).length,
          infeasible: ctx.infeasible,
          baseline_kg: sumKg(ctx.baselinePlan),
          constraints_checked: CONSTRAINTS_CHECKED,
          limitations: VERIFICATION_LIMITATIONS,
        },
      };
    });
  }

  // ----- 3. Plan with Gemini (bounded tool loop) -----
  function plan(ctx) {
    return ctx.stage('plan', async () => {
      if (!model) {
        ctx.modelOutcome.error = plannerError('MISSING_API_KEY');
        return {
          status: 'skipped',
          summary: 'Gemini was not called because GEMINI_API_KEY is not configured on the server.',
          error: ctx.modelOutcome.error.message,
          detail: { error_code: 'MISSING_API_KEY' },
        };
      }
      if (ctx.state.donations.size === 0) {
        return { status: 'success', summary: 'Nothing to plan: no open donations.', detail: {} };
      }
      model.reset?.();
      ctx.modelOutcome = await runModelLoop({ ...ctx, baselinePlan: ctx.baselinePlan });
      return describePlanOutcome(ctx);
    });
  }

  function describePlanOutcome({ modelOutcome: out, metrics }) {
    const detail = {
      model: metrics.models_used.join(', ') || model.name,
      model_switches: metrics.model_switches,
      model_calls: metrics.model_calls,
      retries: metrics.model_retries,
      tool_calls: metrics.tool_calls,
      tool_errors: metrics.tool_errors,
      blocked_tool_calls: metrics.blocked_tool_calls,
      proposals_accepted: out.proposed,
      proposals_rejected: out.rejected,
      tokens: { input: metrics.input_tokens, output: metrics.output_tokens },
      error_code: out.error?.code,
    };
    if (out.finished) {
      const rejectedNote = out.rejected.length ? `; ${out.rejected.length} of its proposals were rejected by code checks` : '';
      return { detail, status: out.rejected.length ? 'warning' : 'success', summary: `Gemini proposed ${out.proposed} dispatches${rejectedNote}.` };
    }
    const failed = out.proposed === 0;
    return {
      detail,
      status: failed ? 'failed' : 'warning',
      error: out.error?.message,
      summary: failed
        ? `Gemini planning failed: ${out.error?.message}`
        : `Gemini stopped early (${out.error?.message}) after ${out.proposed} proposals.`,
    };
  }

  /** Decides which planner the run is attributed to, from what actually happened. */
  function resolvePlanner(ctx) {
    const out = ctx.modelOutcome;
    ctx.geminiComplete = !!model && out.finished;
    ctx.plannerMode = (!!model && out.proposed > 0) || ctx.geminiComplete ? 'gemini' : 'deterministic_fallback';
    if (!model) ctx.fallbackReason = 'MISSING_API_KEY: GEMINI_API_KEY is not configured.';
    else if (!out.finished && out.error) ctx.fallbackReason = `${out.error.code}: ${out.error.message}`;
    else ctx.fallbackReason = null;
  }

  // ----- 4. Fallback / gap-fill, only when feasible food is still unallocated -----
  async function fallback(ctx) {
    const { state } = ctx;
    const stillFeasible = [...ctx.feasibleAtStart].filter((id) => !state.assignments.has(id) && state.rankOptions(id, 1).feasible_count > 0);
    ctx.fallbackAdded = [];
    if (stillFeasible.length === 0 && ctx.geminiComplete) return;
    repo.addStage(ctx.runId, FALLBACK_STAGE.seq, FALLBACK_STAGE.key, FALLBACK_STAGE.label);
    await ctx.stage('fallback', () => {
      ctx.fallbackAdded = greedyPlan(state);
      const why = ctx.fallbackReason ?? `Gemini finished but left ${stillFeasible.length} feasible donation(s) unallocated.`;
      repo.audit(ctx.user.id, 'planner.fallback', ctx.runId, { reason: why.slice(0, 160), added: ctx.fallbackAdded.length });
      return {
        status: 'warning',
        summary: `${why} Rule-based planner added ${ctx.fallbackAdded.length} dispatch(es).`,
        error: ctx.fallbackReason ?? undefined,
        detail: { reason: why, added: ctx.fallbackAdded.map((a) => a.donation_id) },
      };
    });
  }

  // ----- 4b. Plan selection: never keep an AI plan that rescues less food than the verified baseline -----
  async function select(ctx) {
    if (ctx.plannerMode !== 'gemini') {
      repo.updateStage(ctx.runId, 'select', { status: 'skipped', summary: 'No Gemini plan to compare.' });
      return;
    }
    await ctx.stage('select', () => {
      const geminiKg = sumKg([...ctx.state.assignments.values()]);
      const baselineKg = sumKg(ctx.baselinePlan);
      if (geminiKg + SELECTION_TOLERANCE_KG >= baselineKg) {
        ctx.selection = { kept: 'gemini', gemini_kg: geminiKg, baseline_kg: baselineKg };
        return {
          status: 'success',
          summary: `Kept Gemini's plan: ${geminiKg} kg vs ${baselineKg} kg for the rule-based baseline on the same data.`,
          detail: ctx.selection,
        };
      }
      ctx.state = ctx.freshState();
      greedyPlan(ctx.state);
      ctx.selection = { kept: 'deterministic', gemini_kg: geminiKg, baseline_kg: baselineKg };
      ctx.plannerMode = 'deterministic_fallback';
      ctx.fallbackReason = `GEMINI_PLAN_INFERIOR: Gemini's plan allocated ${geminiKg} kg vs ${baselineKg} kg for the verified baseline, so the baseline was kept.`;
      repo.audit(ctx.user.id, 'planner.fallback', ctx.runId, { reason: 'GEMINI_PLAN_INFERIOR', gemini_kg: geminiKg, baseline_kg: baselineKg });
      return {
        status: 'warning',
        summary: `Gemini's plan allocated less food (${geminiKg} kg) than the verified baseline (${baselineKg} kg); the baseline was kept.`,
        detail: ctx.selection,
      };
    });
  }

  // ----- 5. Validate: independent re-verification against fresh database state -----
  async function validate(ctx) {
    await ctx.stage('validate', () => {
      const result = verifyAgainstDatabase({ repo, assignments: [...ctx.state.assignments.values()], planNow: ctx.started, now: clock() });
      ctx.validated = result.valid;
      ctx.reverifyRejected = result.rejected;
      const planningRejected = ctx.modelOutcome.rejected.length;
      const total = ctx.reverifyRejected.length + planningRejected;
      return {
        status: total ? 'warning' : 'success',
        summary: total
          ? `${ctx.validated.length} proposals passed. ${planningRejected} model proposal(s) were rejected during planning and ${ctx.reverifyRejected.length} failed re-verification; none of these were saved.`
          : `All ${ctx.validated.length} proposals passed ${CONSTRAINTS_CHECKED.length} hard-constraint checks against fresh database state.`,
        detail: {
          checked: ctx.state.assignments.size,
          passed: ctx.validated.length,
          rejected_on_reverification: ctx.reverifyRejected,
          rejected_during_planning: ctx.modelOutcome.rejected,
          constraints_checked: CONSTRAINTS_CHECKED,
          limitations: VERIFICATION_LIMITATIONS,
        },
      };
    });
    if (ctx.reverifyRejected.length) repo.audit(ctx.user.id, 'verification.rejected', ctx.runId, { count: ctx.reverifyRejected.length });
  }

  // ----- 6. Save: atomic persistence; donations claimed meanwhile are skipped -----
  function save(ctx) {
    return ctx.stage('save', () => {
      ctx.saveResult = repo.saveProposals(ctx.runId, ctx.validated);
      const skipped = ctx.saveResult.skipped.length;
      return {
        status: skipped ? 'warning' : 'success',
        summary: `Saved ${ctx.saveResult.saved.length} proposal(s) as pending coordinator approval${skipped ? `; skipped ${skipped} already claimed elsewhere` : ''}.`,
        detail: ctx.saveResult,
      };
    });
  }

  // ----- 7. Evaluate against explicit success criteria and a same-input baseline -----
  function evaluate(ctx) {
    const { state, metrics } = ctx;
    const savedIds = new Set(ctx.saveResult.saved);
    const saved = ctx.validated.filter((a) => savedIds.has(a.donation_id));
    const feasibleKg = sumKg([...ctx.feasibleAtStart].map((id) => state.donations.get(id)));
    const urgentFeasible = ctx.urgent.filter((d) => ctx.feasibleAtStart.has(d.id));
    const violations = ctx.reverifyRejected.length;
    Object.assign(metrics, {
      planner_mode: ctx.plannerMode,
      fallback_used: ctx.fallbackAdded.length > 0 || !ctx.geminiComplete,
      planner_ms: ctx.planDurationMs,
      model_success_rate: metrics.model_calls ? round3(metrics.model_successes / metrics.model_calls) : null,
      feasible_donations: ctx.feasibleAtStart.size,
      ...outcomeMetrics({
        saved,
        validated: ctx.validated,
        generated: state.assignments.size + ctx.modelOutcome.rejected.length,
        violations,
        feasibleKg,
        totalOpenKg: sumKg([...state.donations.values()]),
        urgentFeasible,
        savedIds,
        selection: ctx.selection,
      }),
    });
    ctx.criteria = successCriteria({ violations, coverage: metrics.coverage, urgentFeasible, savedIds });
    return ctx.stage('evaluate', () => {
      metrics.comparison = {
        this_run: { dispatches: saved.length, kg: metrics.allocated_kg, distance_km: metrics.total_distance_km },
        deterministic_only: {
          dispatches: ctx.baselinePlan.length,
          kg: sumKg(ctx.baselinePlan),
          distance_km: round1(ctx.baselinePlan.reduce((s, a) => s + a.distance_km, 0)),
        },
      };
      metrics.success = ctx.criteria.every((c) => c.passed);
      const passed = ctx.criteria.filter((c) => c.passed).length;
      return {
        status: metrics.success ? 'success' : 'warning',
        summary: `${passed}/${ctx.criteria.length} success criteria met. ${metrics.allocated_kg} kg allocated (${Math.round(metrics.coverage * 100)}% of feasible); urgent coverage ${metrics.urgent_allocated}/${metrics.urgent_feasible}.`,
        detail: { criteria: ctx.criteria, comparison: metrics.comparison },
      };
    });
  }

  // ----- 8. Summarize in plain language -----
  function summarize(ctx) {
    ctx.metrics.latency_ms = clock() - ctx.started;
    ctx.summary = buildSummary({
      plannerMode: ctx.plannerMode,
      fallbackReason: ctx.fallbackReason,
      metrics: ctx.metrics,
      infeasible: ctx.infeasible,
      modelSummary: ctx.modelOutcome.summary,
    });
    return ctx.stage('summarize', () => ({ status: 'success', summary: ctx.summary, detail: { model_summary: ctx.modelOutcome.summary } }));
  }

  async function execute(runId, objective, user) {
    const ctx = createContext(runId, objective, user);
    await analyze(ctx);
    await assess(ctx);
    ctx.planDurationMs = (await plan(ctx)).duration_ms;
    resolvePlanner(ctx);
    await fallback(ctx);
    await select(ctx);
    await validate(ctx);
    await save(ctx);
    await evaluate(ctx);
    await summarize(ctx);

    const degraded = ['analyze', 'plan', 'validate', 'evaluate'].some((k) => ctx.statuses[k] !== 'success');
    const warnings = degraded || ctx.metrics.fallback_used || ctx.saveResult.skipped.length > 0;
    return {
      plannerMode: ctx.plannerMode,
      fallbackReason: ctx.fallbackReason,
      metrics: { ...ctx.metrics, criteria: ctx.criteria },
      summary: ctx.summary,
      status: warnings ? 'completed_with_warnings' : 'completed',
    };
  }

  function finishRun(runId, user, result) {
    const { plannerMode, fallbackReason, metrics, summary, status } = result;
    repo.finishRun(runId, {
      status,
      planner_mode: plannerMode,
      fallback_reason: fallbackReason,
      summary,
      metrics,
      model: metrics.models_used.join(', ') || null,
    });
    repo.audit(user.id, 'run.complete', runId, { planner_mode: plannerMode, status, saved: metrics.proposals_saved, kg: metrics.allocated_kg });
    logger?.info('run.completed', { runId, planner_mode: plannerMode, status, latency_ms: metrics.latency_ms });
  }

  function failRun(runId, user, err) {
    const message = safeError(err);
    try {
      repo.finishRun(runId, { status: 'failed', planner_mode: 'none', error: message });
      repo.audit(user.id, 'run.failed', runId, { error: message });
    } catch (persistErr) {
      logger?.error('run.persist_failed', { runId, error: safeError(persistErr) });
    }
    logger?.error('run.failed', { runId, error: message });
  }

  return {
    get busy() {
      return active !== null;
    },

    /** Starts a run in the background and returns its id immediately. */
    start(user, objective) {
      if (active) return { conflict: true };
      const runId = repo.createRun(user.id, objective, model?.name, STAGES);
      repo.audit(user.id, 'run.start', runId, { gemini_configured: !!model });
      active = execute(runId, objective, user)
        .then((result) => finishRun(runId, user, result))
        .catch((err) => failRun(runId, user, err))
        .finally(() => {
          active = null;
        });
      return { runId, done: active };
    },

    /** Resolves when the active run (if any) finishes. Used for graceful shutdown and tests. */
    idle: () => active ?? Promise.resolve(),
  };
}
