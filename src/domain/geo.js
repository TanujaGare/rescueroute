const EARTH_RADIUS_KM = 6371;

/** Multiplier from straight-line to approximate road distance in Indian cities. */
export const ROAD_FACTOR = 1.35;

export function haversineKm(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

export function roadKm(a, b) {
  return round1(haversineKm(a, b) * ROAD_FACTOR);
}

export function travelMinutes(km, speedKmh) {
  return Math.ceil((km / speedKmh) * 60);
}

export function round1(n) {
  return Math.round(n * 10) / 10;
}
