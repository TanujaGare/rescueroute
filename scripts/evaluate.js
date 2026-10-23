/**
 * Reproducible evaluation.
 *
 * Part A (always runs, offline): 200 seeded synthetic scenarios comparing a
 * naive first-come-first-served dispatcher (what a busy coordinator with a
 * spreadsheet typically does) against RescueRoute's verified planner.
 *
 * Part B (only if GEMINI_API_KEY is set): runs the full Gemini agent loop on
 * the demo scenario and reports real latency, calls, tokens and criteria.
 *
 * Usage: npm run evaluate [-- --scenarios 200 --gemini-runs 3]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { PlanState, greedyPlan, CATEGORIES } from '../src/domain/planning.js';
import { roadKm } from '../src/domain/geo.js';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { createRepository } from '../src/db/repository.js';
import { seedDemoData } from '../src/db/seed.js';
import { createGeminiModel } from '../src/agent/gemini.js';
import { createOrchestrator } from '../src/agent/orchestrator.js';

const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map((s) => s.trim().split(/\s+/)));
const SCENARIOS = Number(args.scenarios ?? 200);
const GEMINI_RUNS = Number(args['gemini-runs'] ?? 3);
const NOW = Date.parse('2026-10-23T12:00:00Z');

// Deterministic PRNG so results are reproducible.
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function scenario(seed) {
  const rnd = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const loc = () => ({ lat: 18.45 + rnd() * 0.25, lng: 73.7 + rnd() * 0.25 });
  const at = (min) => new Date(NOW + min * 60_000).toISOString();
  const donations = Array.from({ length: 8 + Math.floor(rnd() * 10) }, (_, i) => {
    const category = pick(CATEGORIES);
    const perishable = category === 'cooked_meal' || category === 'dairy';
    const p = loc();
    return {
      id: `d${i}`, category, quantity_kg: Math.round(5 + rnd() * 80), needs_cold: category === 'dairy',
      ready_at: at(Math.floor(rnd() * 60)), expires_at: at(perishable ? 60 + Math.floor(rnd() * 240) : 300 + Math.floor(rnd() * 900)),
      donor_lat: p.lat, donor_lng: p.lng, notes: '', created_order: rnd(),
    };
  });
  const recipients = Array.from({ length: 4 + Math.floor(rnd() * 4) }, (_, i) => {
    const accepts = CATEGORIES.filter(() => rnd() > 0.35);
    return {
      id: `r${i}`, name: `R${i}`, ...loc(), capacity_kg: Math.round(40 + rnd() * 120),
      accepts: accepts.length ? accepts : ['packaged'], has_cold_storage: rnd() > 0.5, closes_at: at(120 + Math.floor(rnd() * 400)),
    };
  });
  const vehicles = Array.from({ length: 2 + Math.floor(rnd() * 3) }, (_, i) => ({
    id: `v${i}`, name: `V${i}`, ...loc(), capacity_kg: pick([25, 80, 150, 300]), refrigerated: rnd() > 0.6, speed_kmh: 18 + rnd() * 8,
  }));
  return { donations, recipients, vehicles, now: NOW };
}

/** Naive baseline: FIFO order, nearest recipient accepting the category, round-robin vehicles, no timing checks. */
function naivePlan(s) {
  const state = new PlanState(s);
  const order = [...s.donations].sort((a, b) => a.created_order - b.created_order);
  let delivered = 0, attempted = 0, violations = 0, vi = 0;
  const vehicleIds = [...state.vehicles.keys()];
  for (const d of order) {
    const donor = { lat: d.donor_lat, lng: d.donor_lng };
    const candidates = [...state.recipients.values()].filter((r) => r.accepts.includes(d.category))
      .sort((a, b) => roadKm(donor, a) - roadKm(donor, b));
    if (!candidates.length) continue;
    const vehicleId = vehicleIds[vi++ % vehicleIds.length];
    attempted += 1;
    try {
      state.commit(d.id, candidates[0].id, vehicleId, { rationale: 'naive', source: 'deterministic' });
      delivered += d.quantity_kg;
    } catch {
      violations += 1; // would spoil, overflow, break cold chain or arrive after closing
    }
  }
  return { delivered, attempted, violations };
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

const totals = { open: 0, feasible: 0, naive: 0, naiveViolations: 0, naiveAttempted: 0, planner: 0, plannerAssignments: 0 };
const plannerLatency = [];
for (let seed = 1; seed <= SCENARIOS; seed++) {
  const s = scenario(seed);
  const probe = new PlanState(s);
  totals.open += s.donations.reduce((a, d) => a + d.quantity_kg, 0);
  totals.feasible += s.donations.filter((d) => probe.rankOptions(d.id, 1).feasible_count > 0).reduce((a, d) => a + d.quantity_kg, 0);

  const naive = naivePlan(s);
  totals.naive += naive.delivered;
  totals.naiveViolations += naive.violations;
  totals.naiveAttempted += naive.attempted;

  const t = performance.now();
  const state = new PlanState(s);
  const plan = greedyPlan(state);
  plannerLatency.push(performance.now() - t);
  totals.planner += plan.reduce((a, x) => a + x.quantity_kg, 0);
  totals.plannerAssignments += plan.length;
}

const pct = (n, d) => `${((100 * n) / d).toFixed(1)}%`;
const partA = {
  scenarios: SCENARIOS,
  data: 'synthetic, seeded (mulberry32 seeds 1..N), Pune bounding box',
  open_kg: Math.round(totals.open),
  feasible_kg_upper_bound: Math.round(totals.feasible),
  naive_baseline: {
    safely_delivered_kg: Math.round(totals.naive),
    share_of_feasible: pct(totals.naive, totals.feasible),
    unsafe_or_invalid_dispatches: totals.naiveViolations,
    unsafe_rate: pct(totals.naiveViolations, totals.naiveAttempted),
  },
  rescueroute_planner: {
    safely_delivered_kg: Math.round(totals.planner),
    share_of_feasible: pct(totals.planner, totals.feasible),
    unsafe_or_invalid_dispatches: 0,
    latency_ms_p50: +percentile(plannerLatency, 50).toFixed(2),
    latency_ms_p95: +percentile(plannerLatency, 95).toFixed(2),
  },
  improvement_kg_vs_naive: pct(totals.planner - totals.naive, totals.naive),
};

console.log('\nPart A: verified planner vs naive FIFO baseline (synthetic data)');
console.table({
  'Naive FIFO': { 'kg delivered safely': partA.naive_baseline.safely_delivered_kg, 'of feasible': partA.naive_baseline.share_of_feasible, 'unsafe dispatches': totals.naiveViolations },
  RescueRoute: { 'kg delivered safely': partA.rescueroute_planner.safely_delivered_kg, 'of feasible': partA.rescueroute_planner.share_of_feasible, 'unsafe dispatches': 0 },
});
console.log(`Planner latency per scenario: p50 ${partA.rescueroute_planner.latency_ms_p50} ms, p95 ${partA.rescueroute_planner.latency_ms_p95} ms`);

// ---------- Part B: live Gemini agent ----------
const config = loadConfig();
const model = createGeminiModel(config.gemini);
let partB = { skipped: 'GEMINI_API_KEY not set. No Gemini results are reported.' };
if (model) {
  const runs = [];
  for (let i = 0; i < GEMINI_RUNS; i++) {
    const db = openDatabase(':memory:');
    seedDemoData(db, { now: Date.now(), demoPassword: 'eval-only' });
    const repo = createRepository(db);
    const orchestrator = createOrchestrator({ repo, config, model });
    const { runId, done } = orchestrator.start({ id: 'usr_coord' }, 'Route all open donations to NGOs before they expire, prioritising perishables.');
    await done;
    const run = repo.getRunForUser(runId, 'usr_coord');
    runs.push({ status: run.status, planner_mode: run.planner_mode, fallback_reason: run.fallback_reason, ...run.metrics, criteria: undefined, criteria_passed: run.metrics?.criteria?.filter((c) => c.passed).length });
    console.log(`Gemini run ${i + 1}: ${run.status} / ${run.planner_mode} / ${run.metrics?.allocated_kg} kg / ${run.metrics?.latency_ms} ms`);
  }
  const lat = runs.map((r) => r.latency_ms).filter(Boolean);
  partB = {
    model: model.name,
    runs: runs.length,
    completed_without_fallback: runs.filter((r) => r.planner_mode === 'gemini' && !r.fallback_used).length,
    success_criteria_met: runs.filter((r) => r.success).length,
    latency_ms_p50: percentile(lat, 50),
    latency_ms_p95: percentile(lat, 95),
    avg_model_calls: avg(runs.map((r) => r.model_calls)),
    avg_tool_calls: avg(runs.map((r) => r.tool_calls)),
    avg_tokens_in: avg(runs.map((r) => r.input_tokens)),
    avg_tokens_out: avg(runs.map((r) => r.output_tokens)),
    avg_gap_filled: avg(runs.map((r) => r.gap_filled)),
    runs_detail: runs,
  };
  console.log('\nPart B: live Gemini agent on demo scenario');
  console.table(Object.fromEntries(Object.entries(partB).filter(([k]) => k !== 'runs_detail')));
} else {
  console.log(`\nPart B skipped: ${partB.skipped}`);
}

mkdirSync('evaluation', { recursive: true });
const out = { generated_at: new Date().toISOString(), node: process.version, part_a: partA, part_b: partB };
writeFileSync('evaluation/results.json', `${JSON.stringify(out, null, 2)}\n`);
console.log('\nWrote evaluation/results.json');

function avg(xs) {
  const v = xs.filter((x) => typeof x === 'number');
  return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
}
