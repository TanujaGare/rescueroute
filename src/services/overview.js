import { URGENT_WINDOW_MIN } from '../agent/orchestrator.js';

/** Builds the dashboard view model from live data; every number is computed, none are stored. */
export function buildOverview(repo, now) {
  const minutesUntil = (iso) => Math.floor((Date.parse(iso) - now) / 60_000);
  const donations = repo.listDonations().map((d) => {
    const expiresIn = minutesUntil(d.expires_at);
    const state = d.status === 'open' && expiresIn <= 0 ? 'expired' : d.status;
    return {
      id: d.id,
      donor_id: d.donor_id,
      donor_name: d.donor_name,
      donor_lat: d.donor_lat,
      donor_lng: d.donor_lng,
      category: d.category,
      description: d.description,
      quantity_kg: d.quantity_kg,
      needs_cold: d.needs_cold,
      ready_at: d.ready_at,
      expires_at: d.expires_at,
      expires_in_min: expiresIn,
      notes: d.notes,
      status: state,
    };
  });
  const open = donations.filter((d) => d.status === 'open');
  const atRisk = open.filter((d) => d.expires_in_min <= URGENT_WINDOW_MIN);
  const recipients = repo.listRecipients().map((r) => ({ ...r, closes_in_min: minutesUntil(r.closes_at) }));
  const vehicles = repo.listVehicles();
  const kg = (list) => Math.round(list.reduce((s, d) => s + d.quantity_kg, 0) * 10) / 10;

  return {
    generated_at: new Date(now).toISOString(),
    kpis: {
      open_donations: open.length,
      open_kg: kg(open),
      at_risk_kg: kg(atRisk),
      awaiting_approval: donations.filter((d) => d.status === 'proposed').length,
      proposed_kg: kg(donations.filter((d) => d.status === 'proposed')),
      assigned_kg: kg(donations.filter((d) => d.status === 'assigned')),
      delivered_kg: kg(donations.filter((d) => d.status === 'delivered')),
      expired_kg: kg(donations.filter((d) => d.status === 'expired')),
      recipient_capacity_kg: kg(recipients.map((r) => ({ quantity_kg: r.capacity_kg }))),
      cold_vehicles: vehicles.filter((v) => v.refrigerated).length,
      available_vehicles: vehicles.filter((v) => v.available).length,
      vehicles: vehicles.length,
    },
    donations,
    donors: repo.listDonors(),
    recipients,
    vehicles,
  };
}
