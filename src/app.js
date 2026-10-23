import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { requireAuth, requireRole, signToken, verifyPassword } from './security/auth.js';
import { decisionSchema, donationSchema, idParam, loginSchema, parseBody, runIdParam, runSchema } from './validation.js';
import { buildOverview } from './services/overview.js';
import { seedDemoData } from './db/seed.js';
import { classifyGeminiError, plannerError } from './agent/gemini.js';
import { buildPlannerStatus } from './services/planner-status.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

/** Builds the Express app. All dependencies are injected for testability. */
export function createApp({ db, repo, config, orchestrator, logger, clock = () => Date.now(), model = null }) {
  // Result of the most recent live connection check (in memory; never contains the key).
  let lastCheck = null;
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));

  app.use((req, res, next) => {
    req.id = randomUUID();
    res.setHeader('X-Request-Id', req.id);
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      if (!req.path.startsWith('/api') && req.path !== '/healthz') return;
      logger.info('http', {
        id: req.id, method: req.method, path: req.path, status: res.statusCode,
        ms: Number((process.hrtime.bigint() - start) / 1_000_000n), user: req.user?.id,
      });
    });
    next();
  });

  app.use(express.json({ limit: '16kb' }));

  const limiter = (limit, windowMs, keyByUser = false) => rateLimit({
    windowMs, limit, standardHeaders: 'draft-8', legacyHeaders: false,
    ...(keyByUser ? { keyGenerator: (req) => req.user.id } : {}),
    handler: (req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests, slow down.' } }),
  });

  app.get('/healthz', (req, res) => {
    let dbOk = true;
    try {
      db.prepare('SELECT 1').get();
    } catch {
      dbOk = false;
    }
    res.status(dbOk ? 200 : 503).json({
      status: dbOk ? 'ok' : 'degraded',
      db: dbOk ? 'ok' : 'error',
      gemini_configured: !!model,
      gemini_model: model?.name ?? null,
      gemini_last_check: lastCheck ? { ok: lastCheck.ok, code: lastCheck.code, at: lastCheck.at } : null,
      agent_busy: orchestrator.busy,
    });
  });

  const api = express.Router();
  api.use(limiter(600, 15 * 60_000));
  const auth = requireAuth({ repo, config, clock });
  const coordinator = requireRole('coordinator');

  api.post('/auth/login', limiter(10, 15 * 60_000), (req, res) => {
    const body = parseBody(loginSchema, req, res);
    if (!body) return;
    const user = repo.findUserByEmail(body.email);
    if (!user || !verifyPassword(body.password, user.password_hash)) {
      return res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect' } });
    }
    repo.audit(user.id, 'auth.login', null, null);
    const token = signToken({ sub: user.id, role: user.role }, config.sessionSecret, config.sessionTtlSeconds, clock());
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  });

  // One-click demo access: signs in as a dedicated guest coordinator with its own run history.
  api.post('/auth/demo', limiter(20, 15 * 60_000), (req, res) => {
    const user = config.demoLoginEnabled ? repo.findUserById('usr_demo') : null;
    if (!user) return res.status(404).json({ error: { code: 'DEMO_DISABLED', message: 'Demo access is not enabled' } });
    repo.audit(user.id, 'auth.demo', null, null);
    const token = signToken({ sub: user.id, role: user.role }, config.sessionSecret, Math.min(config.sessionTtlSeconds, 2 * 3600), clock());
    res.json({ token, user });
  });

  api.get('/me', auth, (req, res) => res.json({ user: req.user }));

  api.get('/planner/status', auth, (req, res) => {
    res.json(buildPlannerStatus({ model, lastCheck, latestRun: repo.latestFinishedRun(req.user.id), stats: repo.runStats(req.user.id), busy: orchestrator.busy }));
  });

  // Makes one minimal live Gemini request (no application data) to prove the key and model work.
  api.post('/planner/check', auth, coordinator, limiter(10, 15 * 60_000, true), async (req, res) => {
    const at = new Date(clock()).toISOString();
    if (!model) {
      lastCheck = { ok: false, code: 'MISSING_API_KEY', message: plannerError('MISSING_API_KEY').message, at };
    } else {
      const t0 = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.agent.modelTimeoutMs);
      try {
        await Promise.race([
          model.ping({ signal: controller.signal }),
          new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(plannerError('TIMEOUT')))),
        ]);
        lastCheck = { ok: true, code: 'OK', message: `Gemini responded (${model.name}).`, at, latency_ms: Date.now() - t0 };
        model.reset?.();
      } catch (err) {
        const e = classifyGeminiError(err);
        lastCheck = { ok: false, code: e.code, message: e.message, at, latency_ms: Date.now() - t0 };
      } finally {
        clearTimeout(timer);
      }
    }
    repo.audit(req.user.id, 'planner.check', model?.name ?? null, { ok: lastCheck.ok, code: lastCheck.code });
    logger.info('planner.check', { ok: lastCheck.ok, code: lastCheck.code });
    res.status(lastCheck.ok ? 200 : 503).json({ ...lastCheck, model: model?.name ?? null });
  });

  api.get('/overview', auth, (req, res) => res.json(buildOverview(repo, clock())));

  api.post('/donations', auth, coordinator, (req, res) => {
    const body = parseBody(donationSchema, req, res);
    if (!body) return;
    if (!repo.donorExists(body.donor_id)) {
      return res.status(400).json({ error: { code: 'UNKNOWN_DONOR', message: 'Donor does not exist' } });
    }
    if (Date.parse(body.expires_at) <= clock()) {
      return res.status(400).json({ error: { code: 'ALREADY_EXPIRED', message: 'Donation has already expired' } });
    }
    const id = repo.createDonation(body, req.user.id);
    repo.audit(req.user.id, 'donation.create', id, { kg: body.quantity_kg, category: body.category });
    res.status(201).json({ id });
  });

  api.post('/runs', auth, coordinator, limiter(20, 60 * 60_000, true), async (req, res) => {
    const body = parseBody(runSchema, req, res);
    if (!body) return;
    const started = orchestrator.start(req.user, body.objective);
    if (started.conflict) {
      return res.status(409).json({ error: { code: 'RUN_IN_PROGRESS', message: 'Another planning run is in progress. Try again shortly.' } });
    }
    if (!config.serverless) return res.status(202).json({ id: started.runId });
    // Serverless: finish within the request and return the full result, since work after the response may be frozen.
    await started.done;
    res.status(201).json({ id: started.runId, run: repo.getRunForUser(started.runId, req.user.id) });
  });

  api.get('/runs', auth, (req, res) => res.json({ runs: repo.listRunsForUser(req.user.id), stats: repo.runStats(req.user.id) }));

  api.get('/runs/:id', auth, (req, res) => {
    const run = runIdParam.safeParse(req.params.id).success ? repo.getRunForUser(req.params.id, req.user.id) : null;
    // 404 (not 403) for other users' runs so ids cannot be probed.
    if (!run) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Run not found' } });
    res.json({ run });
  });

  api.post('/dispatches/:id/decision', auth, coordinator, (req, res) => {
    const body = parseBody(decisionSchema, req, res);
    if (!body) return;
    const dispatch = idParam.safeParse(req.params.id).success ? repo.findDispatchForUser(req.params.id, req.user.id) : null;
    if (!dispatch) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Dispatch not found' } });
    if (!repo.decideDispatch(dispatch, body.decision, req.user.id)) {
      return res.status(409).json({ error: { code: 'ALREADY_DECIDED', message: 'Dispatch was already decided' } });
    }
    repo.audit(req.user.id, `dispatch.${body.decision}`, dispatch.id, { donation: dispatch.donation_id });
    res.json({ id: dispatch.id, status: body.decision === 'approve' ? 'approved' : 'rejected' });
  });

  api.post('/dispatches/:id/delivered', auth, coordinator, (req, res) => {
    const dispatch = idParam.safeParse(req.params.id).success ? repo.findDispatchForUser(req.params.id, req.user.id) : null;
    if (!dispatch) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Dispatch not found' } });
    if (!repo.markDelivered(dispatch)) {
      return res.status(409).json({ error: { code: 'NOT_APPROVED', message: 'Only approved dispatches can be marked delivered' } });
    }
    repo.audit(req.user.id, 'dispatch.delivered', dispatch.id, { donation: dispatch.donation_id, kg: dispatch.quantity_kg });
    res.json({ id: dispatch.id, status: 'delivered' });
  });

  api.get('/audit', auth, (req, res) => res.json({ entries: repo.listAudit(req.user.id) }));

  api.post('/demo/reset', auth, coordinator, limiter(5, 15 * 60_000, true), (req, res) => {
    if (orchestrator.busy) {
      return res.status(409).json({ error: { code: 'RUN_IN_PROGRESS', message: 'Wait for the current run to finish.' } });
    }
    seedDemoData(db, { now: clock(), demoPassword: config.demoPassword });
    logger.info('demo.reset', { by: req.user.id });
    res.json({ reset: true });
  });

  api.use((req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown API route' } }));
  app.use('/api', api);

  app.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: '1h' }));

  // Central error handler: never leak stack traces to clients.
  app.use((err, req, res, _next) => {
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
      return res.status(err.status ?? 400).json({ error: { code: 'BAD_REQUEST', message: 'Malformed or oversized JSON body' } });
    }
    logger.error('unhandled', { id: req.id, error: String(err?.message ?? err).slice(0, 200) });
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Unexpected error', request_id: req.id } });
  });

  return app;
}
