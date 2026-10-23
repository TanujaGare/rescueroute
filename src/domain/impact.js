/**
 * Impact estimates for rescued food. These are conversion factors from
 * published sources, applied to verified kilograms; they are estimates,
 * not measurements, and the UI labels them as such.
 */
export const IMPACT_FACTORS = {
  // WRAP (UK) uses 420 g of food as one meal in its redistribution reporting.
  kgPerMeal: 0.42,
  // FAO, Food Wastage Footprint (2013): ~3.3 Gt CO2e for ~1.3 Gt of food wasted, about 2.5 kg CO2e per kg.
  co2eKgPerKgFood: 2.5,
  sources: [
    'WRAP: 420 g of food = 1 meal (food redistribution reporting convention)',
    'FAO (2013) Food Wastage Footprint: ~3.3 Gt CO2e from ~1.3 Gt food wasted (~2.5 kg CO2e/kg)',
  ],
};

/** Estimated meals and greenhouse-gas emissions avoided for a quantity of food. */
export function estimateImpact(kg) {
  return {
    meals: Math.round(kg / IMPACT_FACTORS.kgPerMeal),
    co2e_kg: Math.round(kg * IMPACT_FACTORS.co2eKgPerKgFood),
  };
}
