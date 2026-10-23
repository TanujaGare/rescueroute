import express from 'express';
import { decisionSchema, donationSchema, idParam, parseBody, runIdParam, runSchema } from '../../validation.js';
import { buildOverview } from '../../services/overview.js';
import { seedDemoData } from '../../db/seed.js';
import { createLimiter, sendError } from '../middleware.js';

const ONE_HOUR = 60 * 60_000;
const FIFTEEN_MINUTES = 15 * 60_000;

/** Dashboard data and donation intake. */
export function donationRoutes({ repo, clock, auth, coordinator }) {
  const router = express.Router();

  router.get('/overview', auth, (req, res) => res.json(buildOverview(repo, clock())));

  router.post('/donations', auth, coordinator, (req, res) => {
    const body = parseBody(donationSchema, req, res);
    if (!body) return;
    if (!repo.donorExists(body.donor_id)) return sendError(res, 400, 'UNKNOWN_DONOR', 'Donor does not exist');
    if (Date.parse(body.expires_at) <= clock()) return sendError(res, 400, 'ALREADY_EXPIRED', 'Donation has already expired');
    const id = repo.createDonation(body, req.user.id);
    repo.audit(req.user.id, 'donation.create', id, { kg: body.quantity_kg, category: body.category });
    res.status(201).json({ id });
  });

  return router;
}

/** Agent runs: start, list and inspect (owner only). */
export function runRoutes({ repo, config, orchestrator, auth, coordinator }) {
  const router = express.Router();

  router.post('/runs', auth, coordinator, createLimiter(20, ONE_HOUR, { keyByUser: true }), async (req, res) => {
    const body = parseBody(runSchema, req, res);
    if (!body) return;
    const started = orchestrator.start(req.user, body.objective);
    if (started.conflict) {
      return sendError(res, 409, 'RUN_IN_PROGRESS', 'Another planning run is in progress. Try again shortly.');
    }
    if (!config.serverless) return res.status(202).json({ id: started.runId });
    // Serverless: finish within the request and return the full result, since work after the response may be frozen.
    await started.done;
    res.status(201).json({ id: started.runId, run: repo.getRunForUser(started.runId, req.user.id) });
  });

  router.get('/runs', auth, (req, res) => {
    res.json({ runs: repo.listRunsForUser(req.user.id), stats: repo.runStats(req.user.id) });
  });

  router.get('/runs/:id', auth, (req, res) => {
    const run = runIdParam.safeParse(req.params.id).success ? repo.getRunForUser(req.params.id, req.user.id) : null;
    // 404 (not 403) for other users' runs so ids cannot be probed.
    if (!run) return sendError(res, 404, 'NOT_FOUND', 'Run not found');
    res.json({ run });
  });

  return router;
}

/** Human-in-the-loop decisions on dispatches the requesting coordinator owns. */
export function dispatchRoutes({ repo, auth, coordinator }) {
  const router = express.Router();
  const findOwned = (req) => (idParam.safeParse(req.params.id).success ? repo.findDispatchForUser(req.params.id, req.user.id) : null);

  router.post('/dispatches/:id/decision', auth, coordinator, (req, res) => {
    const body = parseBody(decisionSchema, req, res);
    if (!body) return;
    const dispatch = findOwned(req);
    if (!dispatch) return sendError(res, 404, 'NOT_FOUND', 'Dispatch not found');
    if (!repo.decideDispatch(dispatch, body.decision, req.user.id)) {
      return sendError(res, 409, 'ALREADY_DECIDED', 'Dispatch was already decided');
    }
    repo.audit(req.user.id, `dispatch.${body.decision}`, dispatch.id, { donation: dispatch.donation_id });
    res.json({ id: dispatch.id, status: body.decision === 'approve' ? 'approved' : 'rejected' });
  });

  router.post('/dispatches/:id/delivered', auth, coordinator, (req, res) => {
    const dispatch = findOwned(req);
    if (!dispatch) return sendError(res, 404, 'NOT_FOUND', 'Dispatch not found');
    if (!repo.markDelivered(dispatch)) {
      return sendError(res, 409, 'NOT_APPROVED', 'Only approved dispatches can be marked delivered');
    }
    repo.audit(req.user.id, 'dispatch.delivered', dispatch.id, { donation: dispatch.donation_id, kg: dispatch.quantity_kg });
    res.json({ id: dispatch.id, status: 'delivered' });
  });

  return router;
}

/** Audit trail and demo maintenance. */
export function adminRoutes({ db, repo, config, clock, logger, orchestrator, auth, coordinator }) {
  const router = express.Router();

  router.get('/audit', auth, (req, res) => res.json({ entries: repo.listAudit(req.user.id) }));

  router.post('/demo/reset', auth, coordinator, createLimiter(5, FIFTEEN_MINUTES, { keyByUser: true }), (req, res) => {
    if (orchestrator.busy) return sendError(res, 409, 'RUN_IN_PROGRESS', 'Wait for the current run to finish.');
    seedDemoData(db, { now: clock(), demoPassword: config.demoPassword });
    logger.info('demo.reset', { by: req.user.id });
    res.json({ reset: true });
  });

  return router;
}
