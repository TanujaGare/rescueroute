/**
 * Truthful planner badge. It reflects the newest real evidence: the user's
 * latest finished run or a live connection check, whichever is more recent.
 * A configured key alone is never reported as working.
 */
export function buildPlannerStatus({ model, lastCheck, latestRun, stats, busy }) {
  const runAt = latestRun?.finished_at ? Date.parse(latestRun.finished_at) : 0;
  const checkAt = lastCheck?.at ? Date.parse(lastCheck.at) : 0;
  // A run that fell back only because no key was set says nothing once a key exists.
  const runIsStale = !!model && /^MISSING_API_KEY/.test(latestRun?.fallback_reason ?? '');
  const useRun = latestRun && !runIsStale && runAt >= checkAt;

  let state;
  let label;
  let detail;
  if (useRun && latestRun.status === 'failed') {
    state = 'unavailable';
    label = 'Planner unavailable';
    detail = 'The latest run failed. See Run history for the error.';
  } else if (useRun && latestRun.planner_mode === 'gemini') {
    state = 'gemini_active';
    label = 'Gemini AI active';
    detail = `Latest run was planned by ${latestRun.model ?? 'Gemini'}.`;
  } else if (useRun && latestRun.planner_mode === 'deterministic_fallback') {
    state = 'fallback';
    label = 'Deterministic fallback';
    detail = `Latest run used the fallback: ${latestRun.fallback_reason ?? 'Gemini was not used.'}`;
  } else if (!model) {
    state = 'fallback';
    label = 'Deterministic fallback';
    detail = 'GEMINI_API_KEY is not configured on the server.';
  } else if (lastCheck?.ok) {
    state = 'gemini_active';
    label = 'Gemini AI active';
    detail = `Live connection test passed at ${new Date(lastCheck.at).toLocaleTimeString()}.`;
  } else if (lastCheck) {
    state = 'unavailable';
    label = 'Planner unavailable';
    detail = `Connection test failed: ${lastCheck.code}: ${lastCheck.message}`;
  } else {
    state = 'unverified';
    label = 'Gemini configured (not yet verified)';
    detail = 'A key is configured. Click "Test Gemini connection" or run the agent to verify it.';
  }
  return {
    state, label, detail, busy,
    gemini_configured: !!model,
    model: model?.name ?? null,
    latest_run: latestRun,
    last_check: lastCheck,
    stats: {
      ...stats,
      gemini_run_rate: stats.runs ? Math.round((stats.gemini_runs / stats.runs) * 1000) / 1000 : null,
      fallback_rate: stats.runs ? Math.round((stats.fallback_runs / stats.runs) * 1000) / 1000 : null,
    },
  };
}
