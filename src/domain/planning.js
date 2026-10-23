import { roadKm, travelMinutes, round1 } from './geo.js';

export const CATEGORIES = ['cooked_meal', 'bakery', 'produce', 'dairy', 'packaged'];
export const LOADING_MINUTES = 10;
export const UNLOADING_MINUTES = 5;
/** Food must arrive at least this long before it expires so the NGO can serve it. */
export const SAFETY_MARGIN_MINUTES = 20;
export const BEST_FIT_WINDOW_MINUTES = 30;

/** Hard constraints verified in code for every allocation. */
export const CONSTRAINTS_CHECKED = [
  'donation_open_and_unexpired', 'vehicle_available', 'quantity_matches_donation', 'food_category_accepted',
  'vehicle_capacity', 'recipient_capacity', 'cold_chain_vehicle', 'cold_chain_recipient',
  'arrives_before_expiry_with_margin', 'arrives_before_recipient_closes', 'no_duplicate_allocation',
];

/** Known limitations of the checks above, disclosed with every proposal instead of being hidden. */
export const VERIFICATION_LIMITATIONS = [
  'Travel time is estimated from straight-line distance x 1.35 at a fixed vehicle speed; live traffic is not modelled.',
];

/** Deterministic urgency band from minutes until expiry. */
export function urgencyFor(expiresInMin) {
  if (expiresInMin <= 90) return 'critical';
  if (expiresInMin <= 180) return 'high';
  if (expiresInMin <= 480) return 'normal';
  return 'low';
}

export class PlanError extends Error {
  constructor(message, violations) {
    super(message);
    this.name = 'PlanError';
    this.violations = violations;
  }
}

/**
 * Deterministic, in-memory planning state for one agent run. Every constraint
 * (capacity, cold chain, expiry, opening hours) is enforced here in code, so a
 * model can propose assignments but can never commit an infeasible one.
 */
export class PlanState {
  constructor({ donations, recipients, vehicles, now }) {
    this.now = now;
    this.donations = new Map(donations.map((d) => [d.id, d]));
    this.recipients = new Map(
      recipients.map((r) => [r.id, { ...r, remainingKg: r.capacity_kg }]),
    );
    this.vehicles = new Map(
      vehicles.map((v) => [v.id, { ...v, available: v.available ?? true, pos: { lat: v.lat, lng: v.lng }, freeAtMin: 0, trips: 0 }]),
    );
    this.assignments = new Map();
    this.rankCache = new Map();
  }

  minutesFromNow(iso) {
    return Math.floor((Date.parse(iso) - this.now) / 60_000);
  }

  isoAt(minutes) {
    return new Date(this.now + minutes * 60_000).toISOString();
  }

  /** Checks one (donation, recipient, vehicle) option without changing state. */
  evaluate(donationId, recipientId, vehicleId, quantityKg = undefined) {
    const donation = this.donations.get(donationId);
    const recipient = this.recipients.get(recipientId);
    const vehicle = this.vehicles.get(vehicleId);
    const violations = [];
    if (!donation) violations.push(v('UNKNOWN_DONATION', `No open donation ${donationId}`));
    if (!recipient) violations.push(v('UNKNOWN_RECIPIENT', `No recipient ${recipientId}`));
    if (!vehicle) violations.push(v('UNKNOWN_VEHICLE', `No vehicle ${vehicleId}`));
    if (violations.length) return { feasible: false, violations, metrics: null };

    if (this.assignments.has(donationId)) {
      violations.push(v('ALREADY_PLANNED', 'Donation is already assigned in this plan'));
    }
    if (this.minutesFromNow(donation.expires_at) <= 0) {
      violations.push(v('DONATION_EXPIRED', 'Donation has already expired'));
    }
    if (!vehicle.available) {
      violations.push(v('VEHICLE_UNAVAILABLE', `${vehicle.name} is not available`));
    }
    if (quantityKg !== undefined && !(quantityKg > 0 && quantityKg <= donation.quantity_kg)) {
      violations.push(v('INVALID_QUANTITY', `Quantity must be positive and at most ${donation.quantity_kg} kg`));
    } else if (quantityKg !== undefined && quantityKg !== donation.quantity_kg) {
      violations.push(v('PARTIAL_NOT_SUPPORTED', `Split loads are not supported; allocate the full ${donation.quantity_kg} kg`));
    }
    if (!recipient.accepts.includes(donation.category)) {
      violations.push(v('CATEGORY_NOT_ACCEPTED', `${recipient.name} does not accept ${donation.category}`));
    }
    if (donation.quantity_kg > vehicle.capacity_kg) {
      violations.push(v('VEHICLE_CAPACITY', `${donation.quantity_kg} kg exceeds vehicle capacity ${vehicle.capacity_kg} kg`));
    }
    if (donation.quantity_kg > recipient.remainingKg) {
      violations.push(v('RECIPIENT_CAPACITY', `${donation.quantity_kg} kg exceeds remaining capacity ${round1(recipient.remainingKg)} kg`));
    }
    if (donation.needs_cold && !vehicle.refrigerated) {
      violations.push(v('COLD_CHAIN_VEHICLE', 'Donation needs cold chain but vehicle is not refrigerated'));
    }
    if (donation.needs_cold && !recipient.has_cold_storage) {
      violations.push(v('COLD_CHAIN_RECIPIENT', 'Donation needs cold storage but recipient has none'));
    }

    const donor = { lat: donation.donor_lat, lng: donation.donor_lng };
    const toDonorKm = roadKm(vehicle.pos, donor);
    const toRecipientKm = roadKm(donor, recipient);
    const arriveDonor = vehicle.freeAtMin + travelMinutes(toDonorKm, vehicle.speed_kmh);
    const pickupMin = Math.max(arriveDonor, this.minutesFromNow(donation.ready_at), 0);
    const deliverMin = pickupMin + LOADING_MINUTES + travelMinutes(toRecipientKm, vehicle.speed_kmh);
    const expiryLimit = this.minutesFromNow(donation.expires_at) - SAFETY_MARGIN_MINUTES;
    const closesLimit = this.minutesFromNow(recipient.closes_at);
    const slackMinutes = Math.min(expiryLimit, closesLimit) - deliverMin;

    if (deliverMin > expiryLimit) {
      violations.push(v('ARRIVES_AFTER_EXPIRY', `Arrives ${deliverMin - expiryLimit} min too late for safe consumption`));
    }
    if (deliverMin > closesLimit) {
      violations.push(v('RECIPIENT_CLOSED', `Recipient closes ${deliverMin - closesLimit} min before arrival`));
    }

    return {
      feasible: violations.length === 0,
      violations,
      metrics: {
        distance_km: round1(toDonorKm + toRecipientKm),
        pickup_in_min: pickupMin,
        deliver_in_min: deliverMin,
        slack_minutes: slackMinutes,
        pickup_at: this.isoAt(pickupMin),
        deliver_at: this.isoAt(deliverMin),
      },
    };
  }

  /**
   * Commits a feasible option. Throws PlanError if any constraint fails.
   * meta: { rationale, source, priority?, quantity_kg?, assumptions? }
   */
  commit(donationId, recipientId, vehicleId, meta) {
    const result = this.evaluate(donationId, recipientId, vehicleId, meta.quantity_kg);
    if (!result.feasible) {
      throw new PlanError('Assignment violates constraints', result.violations);
    }
    const donation = this.donations.get(donationId);
    const recipient = this.recipients.get(recipientId);
    const vehicle = this.vehicles.get(vehicleId);
    recipient.remainingKg -= donation.quantity_kg;
    vehicle.pos = { lat: recipient.lat, lng: recipient.lng };
    vehicle.freeAtMin = result.metrics.deliver_in_min + UNLOADING_MINUTES;
    vehicle.trips += 1;
    const assignment = {
      donation_id: donationId,
      recipient_id: recipientId,
      vehicle_id: vehicleId,
      quantity_kg: donation.quantity_kg,
      rationale: meta.rationale,
      source: meta.source,
      urgency: urgencyFor(this.minutesFromNow(donation.expires_at)),
      priority: meta.priority ?? urgencyFor(this.minutesFromNow(donation.expires_at)),
      assumptions: meta.assumptions ?? null,
      constraints_checked: CONSTRAINTS_CHECKED,
      ...result.metrics,
    };
    this.assignments.set(donationId, assignment);
    // Any commit changes vehicle times and recipient capacity, so cached rankings are stale.
    this.rankCache.clear();
    return assignment;
  }

  /**
   * Returns the best feasible options for a donation, earliest delivery first.
   * Rankings are memoised until the next commit: the same donation is ranked
   * during assessment, prompt building and gap-filling, an O(recipients x vehicles) scan each time.
   */
  rankOptions(donationId, limit = 3) {
    let ranked = this.rankCache.get(donationId);
    if (!ranked) {
      const options = [];
      let rejected = 0;
      for (const recipientId of this.recipients.keys()) {
        for (const vehicleId of this.vehicles.keys()) {
          const r = this.evaluate(donationId, recipientId, vehicleId);
          if (r.feasible) options.push({ recipient_id: recipientId, vehicle_id: vehicleId, ...r.metrics });
          else rejected += 1;
        }
      }
      options.sort((a, b) => a.deliver_in_min - b.deliver_in_min || a.distance_km - b.distance_km);
      ranked = { options, rejected };
      this.rankCache.set(donationId, ranked);
    }
    return { options: ranked.options.slice(0, limit), feasible_count: ranked.options.length, rejected_count: ranked.rejected };
  }

  unallocated() {
    return [...this.donations.values()].filter((d) => !this.assignments.has(d.id));
  }

  /** Donations sorted by urgency: earliest expiry first, larger loads break ties. */
  byUrgency() {
    return [...this.donations.values()].sort(
      (a, b) => Date.parse(a.expires_at) - Date.parse(b.expires_at) || b.quantity_kg - a.quantity_kg,
    );
  }
}

/**
 * Deterministic greedy planner, used as the fallback when the model is
 * unavailable and as a reference point in the evaluation.
 */
export function greedyPlan(state, donationIds = null) {
  const allowed = donationIds ? new Set(donationIds) : null;
  const committed = [];
  for (const d of state.byUrgency()) {
    if (state.assignments.has(d.id) || (allowed && !allowed.has(d.id))) continue;
    const { options } = state.rankOptions(d.id, Infinity);
    if (options.length === 0) continue;
    // Best fit: among options delivering within BEST_FIT_WINDOW of the earliest, prefer the
    // recipient whose remaining capacity is closest to the load, keeping large NGOs free for large donations.
    const cutoff = options[0].deliver_in_min + BEST_FIT_WINDOW_MINUTES;
    const leftover = (o) => state.recipients.get(o.recipient_id).remainingKg - d.quantity_kg;
    const best = options
      .filter((o) => o.deliver_in_min <= cutoff)
      .reduce((a, b) => (leftover(b) < leftover(a) ? b : a));
    committed.push(state.commit(d.id, best.recipient_id, best.vehicle_id, {
      source: 'deterministic',
      rationale: 'Rule-based: most urgent first; best-fit recipient capacity among options delivering within 30 min of the earliest.',
    }));
  }
  return committed;
}

function v(code, message) {
  return { code, message };
}
