import { estimateImpact, IMPACT_FACTORS } from '../domain/impact.js';
import { round1, round3, sumKg } from '../lib/util.js';

/** Minimum share of feasible kilograms a run must allocate to pass the coverage criterion. */
export const COVERAGE_TARGET = 0.9;

/** Explains, in one phrase, why a donation has no feasible option at all. */
export function explainInfeasible(state, donation) {
  const codes = new Set();
  for (const recipientId of state.recipients.keys()) {
    for (const vehicleId of state.vehicles.keys()) {
      for (const v of state.evaluate(donation.id, recipientId, vehicleId).violations) codes.add(v.code);
    }
  }
  const vehicles = [...state.vehicles.values()];
  const recipients = [...state.recipients.values()];
  if (vehicles.every((v) => !v.available || v.capacity_kg < donation.quantity_kg)) {
    return 'Exceeds the capacity of every available vehicle';
  }
  if (recipients.every((r) => r.capacity_kg < donation.quantity_kg)) return 'Exceeds the capacity of every recipient';
  if (codes.has('ARRIVES_AFTER_EXPIRY')) return 'No option arrives before it expires';
  return `No option satisfies all constraints (${[...codes].slice(0, 4).join(', ')})`;
}

/** Explicit, checkable success criteria for a run. */
export function successCriteria({ violations, coverage, urgentFeasible, savedIds }) {
  const missedUrgent = urgentFeasible.filter((d) => !savedIds.has(d.id)).map((d) => d.id);
  return [
    { id: 'no_violations', label: 'No saved dispatch violates a hard constraint', passed: violations === 0 },
    { id: 'coverage', label: 'At least 90% of feasible kg allocated', passed: coverage >= COVERAGE_TARGET, value: round3(coverage) },
    { id: 'urgent', label: 'Every feasible urgent (< 3 h) donation allocated', passed: missedUrgent.length === 0, missed: missedUrgent },
    { id: 'human_approval', label: 'All dispatches held for coordinator approval', passed: true },
  ];
}

/** Outcome metrics computed from saved (not merely proposed) dispatches. */
export function outcomeMetrics({ saved, validated, generated, violations, feasibleKg, totalOpenKg, urgentFeasible, savedIds, selection }) {
  const allocatedKg = sumKg(saved);
  const urgentAllocated = urgentFeasible.filter((d) => savedIds.has(d.id)).length;
  return {
    proposals_generated: generated,
    proposals_validated: validated.length,
    proposals_saved: saved.length,
    validation_rate: generated ? round3(validated.length / generated) : null,
    by_source: {
      gemini: saved.filter((a) => a.source === 'gemini').length,
      deterministic: saved.filter((a) => a.source === 'deterministic').length,
    },
    violations,
    urgent_feasible: urgentFeasible.length,
    urgent_allocated: urgentAllocated,
    urgent_allocation_rate: urgentFeasible.length ? round3(urgentAllocated / urgentFeasible.length) : 1,
    allocated_kg: allocatedKg,
    feasible_kg: feasibleKg,
    total_open_kg: totalOpenKg,
    coverage: round3(feasibleKg > 0 ? allocatedKg / feasibleKg : 1),
    total_distance_km: round1(saved.reduce((s, a) => s + a.distance_km, 0)),
    plan_selected: selection.kept,
    impact_estimate: { ...estimateImpact(allocatedKg), basis: IMPACT_FACTORS.sources },
  };
}

/** Plain-language run summary; model text is quoted and labelled as unverified. */
export function buildSummary({ plannerMode, fallbackReason, metrics, infeasible, modelSummary }) {
  const lines = [
    plannerMode === 'gemini'
      ? `Gemini planned this run (${metrics.by_source.gemini} dispatch(es) from Gemini, ${metrics.by_source.deterministic} from the rule-based gap-fill).`
      : `Gemini was not used (${(fallbackReason ?? 'unavailable').replace(/\.$/, '')}); the rule-based planner produced every dispatch.`,
    `${metrics.proposals_saved} dispatch(es) covering ${metrics.allocated_kg} kg are awaiting coordinator approval (${Math.round(metrics.coverage * 100)}% of feasible food, ${metrics.total_distance_km} km).`,
  ];
  if (infeasible.length) {
    lines.push(`${infeasible.length} donation(s) cannot be placed: ${infeasible.map((i) => `${i.donation_id} (${i.reason})`).join('; ')}.`);
  }
  if (metrics.violations) lines.push(`${metrics.violations} proposal(s) failed re-verification and were not saved.`);
  if (modelSummary) lines.push(`Gemini's own summary (unverified): ${modelSummary}`);
  return lines.join(' ');
}
