// Derivación del margen manual (recalculable) a partir del precio de venta que
// el cliente trae en el Excel. Es la INVERSA EXACTA del pricing-engine, para que
// el motor, al recalcular con este margen, reproduzca el precio del Excel.
//
// Importante: NO congela `finalPrice`. Devuelve un `manualMargin` que el motor
// recalcula cuando cambia el costo (a diferencia del override de finalPrice).

/**
 * effectiveCost del pricing-engine: wholesale × (1 − discount/100), redondeado a
 * 2 decimales con el MISMO criterio (`Math.round(x*100)/100`) que
 * `lib/pricing/pricing-engine.ts:109-110`. discount se clampea a [0,100] igual
 * que el motor (`:95-98`).
 */
function effectiveCostOf(wholesalePrice: number, listDiscountPercent: number): number {
  const disc =
    Number.isFinite(listDiscountPercent) && listDiscountPercent > 0
      ? Math.min(listDiscountPercent, 100)
      : 0;
  return Math.round(wholesalePrice * (1 - disc / 100) * 100) / 100;
}

/**
 * manualMargin (en %) tal que el motor recalcule `webPrice`:
 *   manualMargin = (webPrice / effectiveCost − 1) × 100
 *
 * Devuelve `null` cuando no se puede derivar (sin costo, sin precio de venta, o
 * effectiveCost 0). Permite margen NEGATIVO (venta bajo costo). NO redondea el
 * margen: persistirlo a precisión completa mantiene el round-trip < $0.01.
 */
export function deriveMarginFromWebPrice(
  webPrice: number | null | undefined,
  wholesalePrice: number | null | undefined,
  listDiscountPercent: number
): number | null {
  if (webPrice == null || !Number.isFinite(webPrice) || webPrice <= 0) return null;
  if (
    wholesalePrice == null ||
    !Number.isFinite(wholesalePrice) ||
    wholesalePrice <= 0
  ) {
    return null;
  }
  const effectiveCost = effectiveCostOf(wholesalePrice, listDiscountPercent);
  if (effectiveCost <= 0) return null; // disc=100 u otro degenerado
  return (webPrice / effectiveCost - 1) * 100;
}
