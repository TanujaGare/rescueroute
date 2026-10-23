import express from 'express';
import { classifyGeminiError, plannerError } from '../../agent/gemini.js';
import { buildPlannerStatus } from '../../services/planner-status.js';
import { createLimiter } from '../middleware.js';

const FIFTEEN_MINUTES = 15 * 60_000;

/** Truthful planner status and a minimal live Gemini connection check. */
export function plannerRoutes({ repo, config, clock, logger, model, orchestrator, plannerHealth, auth, coordinator }) {
  const router = express.Router();

  router.get('/planner/status', auth, (req, res) => {
    res.json(buildPlannerStatus({
      model,
      lastCheck: plannerHealth.lastCheck,
      latestRun: repo.latestFinishedRun(req.user.id),
      stats: repo.runStats(req.user.id),
      busy: orchestrator.busy,
    }));
  });

  // Sends one fixed prompt (no application data) to prove the key and model work.
  router.post('/planner/check', auth, coordinator, createLimiter(10, FIFTEEN_MINUTES, { keyByUser: true }), async (req, res) => {
    const check = await checkGemini({ model, config, at: new Date(clock()).toISOString() });
    plannerHealth.lastCheck = check;
    repo.audit(req.user.id, 'planner.check', model?.name ?? null, { ok: check.ok, code: check.code });
    logger.info('planner.check', { ok: check.ok, code: check.code });
    res.status(check.ok ? 200 : 503).json({ ...check, model: model?.name ?? null });
  });

  return router;
}

async function checkGemini({ model, config, at }) {
  if (!model) return { ok: false, code: 'MISSING_API_KEY', message: plannerError('MISSING_API_KEY').message, at };
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.agent.modelTimeoutMs);
  try {
    await Promise.race([
      model.ping({ signal: controller.signal }),
      new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(plannerError('TIMEOUT')))),
    ]);
    const message = `Gemini responded (${model.name}).`;
    model.reset?.();
    return { ok: true, code: 'OK', message, at, latency_ms: Date.now() - startedAt };
  } catch (err) {
    const e = classifyGeminiError(err);
    return { ok: false, code: e.code, message: e.message, at, latency_ms: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}
