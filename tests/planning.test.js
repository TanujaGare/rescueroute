import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineKm, roadKm, travelMinutes } from '../src/domain/geo.js';
import { PlanError, PlanState, greedyPlan } from '../src/domain/planning.js';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const at = (min) => new Date(NOW + min * 60_000).toISOString();

function fixture(overrides = {}) {
  return new PlanState({
    now: NOW,
    donations: [
      { id: 'd_meal', category: 'cooked_meal', quantity_kg: 30, needs_cold: false, ready_at: at(0), expires_at: at(120), donor_lat: 18.53, donor_lng: 73.85, notes: '' },
      { id: 'd_milk', category: 'dairy', quantity_kg: 20, needs_cold: true, ready_at: at(0), expires_at: at(300), donor_lat: 18.53, donor_lng: 73.85, notes: '' },
      ...(overrides.donations ?? []),
    ],
    recipients: [
      { id: 'r_shelter', name: 'Shelter', lat: 18.52, lng: 73.86, capacity_kg: 50, accepts: ['cooked_meal'], has_cold_storage: false, closes_at: at(240) },
      { id: 'r_home', name: 'Home', lat: 18.56, lng: 73.80, capacity_kg: 100, accepts: ['cooked_meal', 'dairy'], has_cold_storage: true, closes_at: at(360) },
    ],
    vehicles: [
      { id: 'v_van', name: 'Van', capacity_kg: 200, refrigerated: false, lat: 18.53, lng: 73.85, speed_kmh: 24 },
      { id: 'v_cold', name: 'Cold', capacity_kg: 100, refrigerated: true, lat: 18.53, lng: 73.85, speed_kmh: 24 },
    ],
  });
}

test('haversine distance Pune Shivajinagar to Hadapsar is about 9 km', () => {
  const km = haversineKm({ lat: 18.5308, lng: 73.8475 }, { lat: 18.5089, lng: 73.926 });
  assert.ok(km > 8 && km < 10, `got ${km}`);
  assert.ok(roadKm({ lat: 18.5308, lng: 73.8475 }, { lat: 18.5089, lng: 73.926 }) > km);
  assert.equal(travelMinutes(12, 24), 30);
});

test('feasible option returns verified timing metrics', () => {
  const r = fixture().evaluate('d_meal', 'r_shelter', 'v_van');
  assert.equal(r.feasible, true);
  assert.ok(r.metrics.deliver_in_min > 0);
  assert.ok(r.metrics.slack_minutes >= 0);
});

test('category, cold chain and capacity violations are detected', () => {
  const s = fixture();
  const codes = (r) => r.violations.map((v) => v.code);
  assert.deepEqual(codes(s.evaluate('d_milk', 'r_shelter', 'v_van')), ['CATEGORY_NOT_ACCEPTED', 'COLD_CHAIN_VEHICLE', 'COLD_CHAIN_RECIPIENT']);
  const big = fixture({ donations: [{ id: 'd_big', category: 'cooked_meal', quantity_kg: 150, needs_cold: false, ready_at: at(0), expires_at: at(200), donor_lat: 18.53, donor_lng: 73.85, notes: '' }] });
  assert.ok(codes(big.evaluate('d_big', 'r_shelter', 'v_van')).includes('RECIPIENT_CAPACITY'));
  assert.ok(codes(big.evaluate('d_big', 'r_home', 'v_cold')).includes('VEHICLE_CAPACITY'));
});

test('food that would arrive after expiry or after closing is rejected', () => {
  const s = fixture({ donations: [{ id: 'd_soon', category: 'cooked_meal', quantity_kg: 5, needs_cold: false, ready_at: at(0), expires_at: at(25), donor_lat: 18.53, donor_lng: 73.85, notes: '' }] });
  assert.ok(s.evaluate('d_soon', 'r_home', 'v_van').violations.some((v) => v.code === 'ARRIVES_AFTER_EXPIRY'));
  const late = fixture({ donations: [{ id: 'd_late', category: 'cooked_meal', quantity_kg: 5, needs_cold: false, ready_at: at(250), expires_at: at(900), donor_lat: 18.53, donor_lng: 73.85, notes: '' }] });
  assert.ok(late.evaluate('d_late', 'r_shelter', 'v_van').violations.some((v) => v.code === 'RECIPIENT_CLOSED'));
});

test('unknown ids are reported, not thrown', () => {
  const r = fixture().evaluate('nope', 'r_shelter', 'v_van');
  assert.equal(r.feasible, false);
  assert.equal(r.violations[0].code, 'UNKNOWN_DONATION');
});

test('commit updates capacity and vehicle availability; double-booking is refused', () => {
  const s = fixture();
  s.commit('d_meal', 'r_shelter', 'v_van', { rationale: 'test', source: 'deterministic' });
  assert.equal(s.recipients.get('r_shelter').remainingKg, 20);
  assert.ok(s.vehicles.get('v_van').freeAtMin > 0);
  assert.throws(() => s.commit('d_meal', 'r_home', 'v_van', { rationale: 'again', source: 'deterministic' }), (err) => err instanceof PlanError && err.violations[0].code === 'ALREADY_PLANNED');
});

test('greedy planner allocates everything feasible with zero violations', () => {
  const s = fixture();
  const plan = greedyPlan(s);
  assert.equal(plan.length, 2);
  const milk = plan.find((a) => a.donation_id === 'd_milk');
  assert.equal(milk.vehicle_id, 'v_cold');
  assert.equal(milk.recipient_id, 'r_home');
});

test('greedy best-fit keeps the large recipient free for a large donation', () => {
  const s = new PlanState({
    now: NOW,
    donations: [
      { id: 'd_small', category: 'cooked_meal', quantity_kg: 30, needs_cold: false, ready_at: at(0), expires_at: at(100), donor_lat: 18.53, donor_lng: 73.85, notes: '' },
      { id: 'd_large', category: 'cooked_meal', quantity_kg: 90, needs_cold: false, ready_at: at(0), expires_at: at(200), donor_lat: 18.53, donor_lng: 73.85, notes: '' },
    ],
    recipients: [
      { id: 'r_big', name: 'Big', lat: 18.531, lng: 73.851, capacity_kg: 100, accepts: ['cooked_meal'], has_cold_storage: false, closes_at: at(400) },
      { id: 'r_small', name: 'Small', lat: 18.535, lng: 73.855, capacity_kg: 40, accepts: ['cooked_meal'], has_cold_storage: false, closes_at: at(400) },
    ],
    vehicles: [{ id: 'v1', name: 'Van', capacity_kg: 200, refrigerated: false, lat: 18.53, lng: 73.85, speed_kmh: 24 }],
  });
  const plan = greedyPlan(s);
  assert.equal(plan.length, 2);
  assert.equal(plan.find((a) => a.donation_id === 'd_small').recipient_id, 'r_small');
});
