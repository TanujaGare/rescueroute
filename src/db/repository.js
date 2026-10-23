import { randomUUID } from 'node:crypto';
import { transaction } from './database.js';

/** All SQL lives here; every query is parameterised. */
export function createRepository(db, clock = () => Date.now()) {
  const nowIso = () => new Date(clock()).toISOString();

  const mapRecipient = (r) => ({ ...r, accepts: JSON.parse(r.accepts), has_cold_storage: !!r.has_cold_storage });
  const mapVehicle = (v) => ({ ...v, refrigerated: !!v.refrigerated, available: !!v.available });
  const mapDonation = (d) => ({ ...d, needs_cold: !!d.needs_cold });
  const parseJson = (s) => (s ? JSON.parse(s) : null);
  const json = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
  const mapRun = (r) => ({ ...r, metrics: parseJson(r.metrics) });

  const stmts = {
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    userById: db.prepare('SELECT id, email, name, role FROM users WHERE id = ?'),
    donations: db.prepare(`
      SELECT d.*, o.name AS donor_name, o.kind AS donor_kind, o.lat AS donor_lat, o.lng AS donor_lng
      FROM donations d JOIN donors o ON o.id = d.donor_id
      ORDER BY d.expires_at`),
    donors: db.prepare('SELECT * FROM donors ORDER BY name'),
    donorById: db.prepare('SELECT id FROM donors WHERE id = ?'),
    recipients: db.prepare('SELECT * FROM recipients ORDER BY name'),
    vehicles: db.prepare('SELECT * FROM vehicles ORDER BY name'),
    insertDonation: db.prepare(`
      INSERT INTO donations (id, donor_id, category, description, quantity_kg, needs_cold, ready_at, expires_at, notes, status, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`),

    insertRun: db.prepare(`INSERT INTO runs (id, user_id, objective, planner_mode, status, model, started_at) VALUES (?, ?, ?, 'pending', 'running', ?, ?)`),
    finishRun: db.prepare(`UPDATE runs SET status = ?, planner_mode = ?, fallback_reason = ?, summary = ?, metrics = ?, error = ?, model = COALESCE(?, model), finished_at = ? WHERE id = ?`),
    runForUser: db.prepare('SELECT * FROM runs WHERE id = ? AND user_id = ?'),
    runsForUser: db.prepare('SELECT * FROM runs WHERE user_id = ? ORDER BY started_at DESC LIMIT ?'),
    latestFinishedRun: db.prepare(`SELECT id, planner_mode, status, fallback_reason, model, finished_at FROM runs WHERE user_id = ? AND status <> 'running' ORDER BY finished_at DESC LIMIT 1`),
    runStats: db.prepare(`
      SELECT COUNT(*) AS runs,
             SUM(planner_mode = 'gemini') AS gemini_runs,
             SUM(planner_mode = 'deterministic_fallback') AS fallback_runs,
             SUM(status = 'failed') AS failed_runs
      FROM runs WHERE user_id = ? AND status <> 'running'`),

    insertStage: db.prepare(`INSERT INTO run_stages (run_id, seq, key, label, status) VALUES (?, ?, ?, ?, 'pending')`),
    updateStage: db.prepare(`
      UPDATE run_stages SET label = COALESCE(?, label), status = ?, summary = ?, detail = ?, error = ?,
             started_at = COALESCE(?, started_at), finished_at = ?, duration_ms = ?
      WHERE run_id = ? AND key = ?`),
    stagesForRun: db.prepare('SELECT * FROM run_stages WHERE run_id = ? ORDER BY seq'),

    insertStep: db.prepare(`INSERT INTO run_steps (run_id, seq, kind, tool, input, output, ok, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    stepsForRun: db.prepare('SELECT * FROM run_steps WHERE run_id = ? ORDER BY seq'),

    claimDonation: db.prepare(`UPDATE donations SET status = 'proposed' WHERE id = ? AND status = 'open' AND expires_at > ?`),
    insertDispatch: db.prepare(`
      INSERT INTO dispatches (id, run_id, donation_id, recipient_id, vehicle_id, quantity_kg, priority, source, distance_km,
        pickup_at, deliver_at, slack_minutes, rationale, constraints_checked, assumptions, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_approval', ?)`),
    setDonationStatus: db.prepare('UPDATE donations SET status = ? WHERE id = ? AND status = ?'),
    dispatchesForRun: db.prepare(`
      SELECT p.*, d.description, d.category, d.needs_cold, d.expires_at,
             o.name AS donor_name, r.name AS recipient_name, v.name AS vehicle_name
      FROM dispatches p
      JOIN donations d ON d.id = p.donation_id
      JOIN donors o ON o.id = d.donor_id
      JOIN recipients r ON r.id = p.recipient_id
      JOIN vehicles v ON v.id = p.vehicle_id
      WHERE p.run_id = ? ORDER BY p.deliver_at`),
    dispatchForUser: db.prepare(`
      SELECT p.* FROM dispatches p JOIN runs r ON r.id = p.run_id
      WHERE p.id = ? AND r.user_id = ?`),
    decideDispatch: db.prepare(`UPDATE dispatches SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending_approval'`),
    deliverDispatch: db.prepare(`UPDATE dispatches SET status = 'delivered', delivered_at = ? WHERE id = ? AND status = 'approved'`),

    insertAudit: db.prepare('INSERT INTO audit_log (user_id, action, target, details, created_at) VALUES (?, ?, ?, ?, ?)'),
    auditForUser: db.prepare('SELECT action, target, details, created_at FROM audit_log WHERE user_id = ? ORDER BY id DESC LIMIT ?'),
  };

  return {
    findUserByEmail: (email) => stmts.userByEmail.get(email),
    findUserById: (id) => stmts.userById.get(id),

    listDonations: () => stmts.donations.all().map(mapDonation),
    listDonors: () => stmts.donors.all(),
    listRecipients: () => stmts.recipients.all().map(mapRecipient),
    listVehicles: () => stmts.vehicles.all().map(mapVehicle),
    donorExists: (id) => !!stmts.donorById.get(id),

    createDonation(input, userId) {
      const id = `don_${randomUUID().slice(0, 8)}`;
      stmts.insertDonation.run(
        id, input.donor_id, input.category, input.description, input.quantity_kg,
        input.needs_cold ? 1 : 0, input.ready_at, input.expires_at, input.notes ?? '', userId, nowIso(),
      );
      return id;
    },

    // ----- runs and stages -----

    createRun(userId, objective, model, stages) {
      const id = `run_${randomUUID()}`;
      transaction(db, () => {
        stmts.insertRun.run(id, userId, objective, model ?? null, nowIso());
        for (const s of stages) stmts.insertStage.run(id, s.seq, s.key, s.label);
      });
      return id;
    },

    addStage(runId, seq, key, label) {
      stmts.insertStage.run(runId, seq, key, label);
    },

    updateStage(runId, key, s) {
      stmts.updateStage.run(
        s.label ?? null, s.status, s.summary ?? null, json(s.detail), s.error ?? null,
        s.started_at ?? null, s.finished_at ?? null, s.duration_ms ?? null, runId, key,
      );
    },

    finishRun(id, { status, planner_mode, fallback_reason, summary, metrics, error, model }) {
      stmts.finishRun.run(status, planner_mode, fallback_reason ?? null, summary ?? null, json(metrics), error ?? null, model ?? null, nowIso(), id);
    },

    addStep(runId, step) {
      stmts.insertStep.run(
        runId, step.seq, step.kind, step.tool ?? null, json(step.input), json(step.output),
        step.ok ? 1 : 0, Math.round(step.latency_ms ?? 0), nowIso(),
      );
    },

    getRunForUser(runId, userId) {
      const run = stmts.runForUser.get(runId, userId);
      if (!run) return null;
      return {
        ...mapRun(run),
        stages: stmts.stagesForRun.all(runId).map((s) => ({ ...s, detail: parseJson(s.detail) })),
        steps: stmts.stepsForRun.all(runId).map((s) => ({ ...s, ok: !!s.ok, input: parseJson(s.input), output: parseJson(s.output) })),
        dispatches: stmts.dispatchesForRun.all(runId).map((p) => ({
          ...p, needs_cold: !!p.needs_cold, constraints_checked: parseJson(p.constraints_checked),
        })),
      };
    },

    listRunsForUser: (userId, limit = 20) => stmts.runsForUser.all(userId, limit).map(mapRun),
    latestFinishedRun: (userId) => stmts.latestFinishedRun.get(userId) ?? null,
    runStats(userId) {
      const r = stmts.runStats.get(userId);
      return { runs: r.runs, gemini_runs: r.gemini_runs ?? 0, fallback_runs: r.fallback_runs ?? 0, failed_runs: r.failed_runs ?? 0 };
    },

    // ----- proposals and decisions -----

    /**
     * Persists validated proposals atomically. A donation is claimed only if it
     * is still open and unexpired at commit time, and a partial unique index
     * blocks a second live dispatch for the same donation, so concurrent runs
     * can never over-allocate food.
     */
    saveProposals(runId, assignments) {
      return transaction(db, () => {
        const saved = [];
        const skipped = [];
        const now = nowIso();
        for (const a of assignments) {
          if (stmts.claimDonation.run(a.donation_id, now).changes !== 1) {
            skipped.push({ donation_id: a.donation_id, reason: 'Donation was claimed, closed or expired before saving' });
            continue;
          }
          stmts.insertDispatch.run(
            `dsp_${randomUUID().replaceAll('-', '').slice(0, 12)}`, runId, a.donation_id, a.recipient_id, a.vehicle_id,
            a.quantity_kg, a.priority, a.source, a.distance_km, a.pickup_at, a.deliver_at, a.slack_minutes,
            a.rationale, JSON.stringify(a.constraints_checked), a.assumptions ?? null, now,
          );
          saved.push(a.donation_id);
        }
        return { saved, skipped };
      });
    },

    findDispatchForUser: (id, userId) => stmts.dispatchForUser.get(id, userId),

    decideDispatch(dispatch, decision, userId) {
      return transaction(db, () => {
        const status = decision === 'approve' ? 'approved' : 'rejected';
        if (stmts.decideDispatch.run(status, userId, nowIso(), dispatch.id).changes !== 1) return false;
        stmts.setDonationStatus.run(decision === 'approve' ? 'assigned' : 'open', dispatch.donation_id, 'proposed');
        return true;
      });
    },

    markDelivered(dispatch) {
      return transaction(db, () => {
        if (stmts.deliverDispatch.run(nowIso(), dispatch.id).changes !== 1) return false;
        stmts.setDonationStatus.run('delivered', dispatch.donation_id, 'assigned');
        return true;
      });
    },

    audit(userId, action, target, details) {
      stmts.insertAudit.run(userId, action, target ?? null, json(details), nowIso());
    },

    listAudit: (userId, limit = 50) =>
      stmts.auditForUser.all(userId, limit).map((a) => ({ ...a, details: parseJson(a.details) })),
  };
}
