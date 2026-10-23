import express from 'express';
import { fileURLToPath } from 'node:url';
import { requireAuth, requireRole } from './security/auth.js';
import { compress, createLimiter, errorHandler, jsonBody, requestLogger, securityHeaders, sendError, staticFiles } from './http/middleware.js';
import { authRoutes } from './http/routes/auth.js';
import { plannerRoutes } from './http/routes/planner.js';
import { adminRoutes, dispatchRoutes, donationRoutes, runRoutes } from './http/routes/operations.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
const API_LIMIT_PER_15_MIN = 600;

/** Builds the Express app. All dependencies are injected for testability. */
export function createApp({ db, repo, config, orchestrator, logger, clock = () => Date.now(), model = null }) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use(securityHeaders());
  app.use(compress());
  app.use(requestLogger(logger));
  app.use(jsonBody());

  // Most recent live Gemini connection check (in memory; never contains the key).
  const plannerHealth = { lastCheck: null };
  const deps = {
    db, repo, config, orchestrator, logger, clock, model, plannerHealth,
    auth: requireAuth({ repo, config, clock }),
    coordinator: requireRole('coordinator'),
  };

  app.get('/healthz', (req, res) => {
    let dbOk = true;
    try {
      db.prepare('SELECT 1').get();
    } catch {
      dbOk = false;
    }
    const check = plannerHealth.lastCheck;
    res.status(dbOk ? 200 : 503).json({
      status: dbOk ? 'ok' : 'degraded',
      db: dbOk ? 'ok' : 'error',
      gemini_configured: !!model,
      gemini_model: model?.name ?? null,
      gemini_last_check: check ? { ok: check.ok, code: check.code, at: check.at } : null,
      agent_busy: orchestrator.busy,
    });
  });

  const api = express.Router();
  api.use(createLimiter(API_LIMIT_PER_15_MIN, 15 * 60_000));
  for (const routes of [authRoutes, plannerRoutes, donationRoutes, runRoutes, dispatchRoutes, adminRoutes]) {
    api.use(routes(deps));
  }
  api.use((req, res) => sendError(res, 404, 'NOT_FOUND', 'Unknown API route'));
  app.use('/api', api);

  app.use(staticFiles(PUBLIC_DIR));
  app.use(errorHandler(logger));
  return app;
}
