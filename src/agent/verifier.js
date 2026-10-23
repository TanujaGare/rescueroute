import { PlanState } from '../domain/planning.js';
import { safeError } from '../lib/util.js';

/**
 * Re-checks proposals against a fresh read of the database, independent of
 * the state used for planning. Returns { valid, rejected } with reasons.
 */
export function verifyAgainstDatabase({ repo, assignments, planNow, now }) {
  const donations = new Map(repo.listDonations().map((d) => [d.id, d]));
  const recipients = new Map(repo.listRecipients().map((r) => [r.id, r]));
  const vehicles = new Map(repo.listVehicles().map((v) => [v.id, v]));
  const fresh = new PlanState({
    donations: [...donations.values()].filter((d) => d.status === 'open'),
    recipients: [...recipients.values()],
    vehicles: [...vehicles.values()],
    now: planNow,
  });
  const seen = new Set();
  const valid = [];
  const rejected = [];

  for (const a of assignments) {
    const reasons = [
      ...donationChecks(donations.get(a.donation_id), a, now),
      ...recipientChecks(recipients.get(a.recipient_id)),
      ...vehicleChecks(vehicles.get(a.vehicle_id)),
    ];
    if (seen.has(a.donation_id)) reasons.push(violation('DUPLICATE_ALLOCATION', 'Donation allocated twice in this plan'));
    seen.add(a.donation_id);

    if (reasons.length === 0) {
      // Replays capacity, cold-chain and timing constraints in plan order.
      try {
        fresh.commit(a.donation_id, a.recipient_id, a.vehicle_id, { ...a });
      } catch (err) {
        reasons.push(...(err.violations ?? [violation('ERROR', safeError(err))]));
      }
    }
    if (reasons.length) rejected.push({ donation_id: a.donation_id, source: a.source, violations: reasons });
    else valid.push(a);
  }
  return { valid, rejected };
}

function donationChecks(donation, assignment, now) {
  if (!donation) return [violation('DONATION_NOT_FOUND', 'Donation does not exist')];
  const out = [];
  if (donation.status !== 'open') out.push(violation('DONATION_NOT_OPEN', `Donation is ${donation.status}`));
  if (Date.parse(donation.expires_at) <= now) out.push(violation('DONATION_EXPIRED', 'Donation expired before saving'));
  if (!(assignment.quantity_kg > 0) || assignment.quantity_kg > donation.quantity_kg) {
    out.push(violation('INVALID_QUANTITY', 'Quantity is not positive or exceeds the donation'));
  }
  return out;
}

function recipientChecks(recipient) {
  return recipient ? [] : [violation('RECIPIENT_NOT_FOUND', 'Recipient does not exist')];
}

function vehicleChecks(vehicle) {
  if (!vehicle) return [violation('VEHICLE_NOT_FOUND', 'Vehicle does not exist')];
  return vehicle.available ? [] : [violation('VEHICLE_UNAVAILABLE', `${vehicle.name} is unavailable`)];
}

const violation = (code, message) => ({ code, message });
