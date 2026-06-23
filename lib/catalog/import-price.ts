// Decisión de precios del importador, compartida por el API route y el script
// CLI. Default seguro: a partir del precio de venta del Excel deriva un
// `manualMargin` recalculable; NUNCA congela `finalPrice`. Solo limpia un
// finalPrice previo cuando era un freeze INVOLUNTARIO (predicado compartido) y
// la fila trae precio de venta.

import { deriveMarginFromWebPrice } from "./derive-margin";
import { isInvoluntaryFreeze, type FreezeSignals } from "./involuntary-freeze";

export interface ResolveImportSalePriceOpts {
  /** Precio de venta del Excel (columna "PRECIO WEB"/"PRECIO FINAL"/...). */
  webPrice: number | null;
  /** Costo del proveedor a usar para derivar (nuevo del Excel o el existente). */
  wholesalePrice: number | null;
  /** listDiscountPercent del proveedor (necesario para el effectiveCost real). */
  listDiscountPercent: number;
  /** Estado previo del CatalogProduct, para decidir si limpiar un freeze. */
  existing?: FreezeSignals | null;
}

export interface ResolveImportSalePriceResult {
  /** Margen a escribir (full precision). null = no setear manualMargin. */
  manualMargin: number | null;
  /** Si hay que anular un finalPrice previo (freeze involuntario). */
  clearFinalPrice: boolean;
  /** Había precio de venta + costo → se pudo derivar. */
  derivable: boolean;
  /** El margen derivado es negativo (venta bajo costo). */
  negativeMargin: boolean;
}

export function resolveImportSalePrice(
  opts: ResolveImportSalePriceOpts
): ResolveImportSalePriceResult {
  const margin = deriveMarginFromWebPrice(
    opts.webPrice,
    opts.wholesalePrice,
    opts.listDiscountPercent
  );
  const derivable = margin != null;
  const negativeMargin = margin != null && margin < 0;

  // Solo limpiamos finalPrice cuando: (a) se pudo derivar un margen válido que
  // lo reemplace —NUNCA dejar el producto sin precio ni override—, (b) la fila
  // trae precio de venta, y (c) el freeze previo es involuntario. Si hay señales
  // de intención manual, se respeta.
  const hasSalePrice =
    opts.webPrice != null && Number.isFinite(opts.webPrice) && opts.webPrice > 0;
  const clearFinalPrice =
    derivable &&
    hasSalePrice &&
    opts.existing != null &&
    isInvoluntaryFreeze(opts.existing);

  return { manualMargin: margin, clearFinalPrice, derivable, negativeMargin };
}
