// 2G-R8-Q2.1-B · §4 — Partición de la reconciliación en conjuntos de acción. PURO.
//
// A partir de los SkuResult del clasificador (Q2.1-A/R1) + el catálogo + las variantes observadas,
// construye el PRICE_WRITE_SET (única entrada a D y a la escritura PRICE_ONLY) y los conteos por
// clase. La suma de las CUATRO clases de fila de catálogo debe cubrir exactamente el catálogo.
//
// Contrato duro: el PRICE_WRITE_SET SÓLO contiene SKU_VERIFIED_PRESENT_WITH_PRICE con newPrice
// persistible (número finito > 0). Así WRITESET_NEW_NULL/NONPOSITIVE = 0 POR CONSTRUCCIÓN (§6.1).

import { type SkuResult, type ObservedVariant, isPersistablePrice } from "./sku-reconciliation";

export interface PartitionCatalogRow {
  sku: string;
  fichaCanonicalUrl: string | null;
  wholesalePrice: number | null;
}

export interface PriceWriteEntry {
  sku: string;
  oldPrice: number | null; // catálogo (puede ser null → NULL_TO_VALID)
  newPrice: number; // observado, persistible por construcción
  fichaCanonicalUrl: string | null;
}

export interface PartitionResult {
  priceWriteSet: PriceWriteEntry[];
  priceWriteSetSize: number;
  presentWithoutPriceCount: number;
  verifiedAbsentCount: number;
  unverifiedCount: number;
  unverifiedCountByReason: Record<string, number>;
  totalCatalogRows: number;
  /** present_with_price + present_without_price + verified_absent + unverified. */
  fourClassSum: number;
  /** true si las cuatro clases cubren exactamente el catálogo (§4: si no → STOP). */
  partitionCoversCatalog: boolean;
  /** SKUs marcados PRESENT_WITH_PRICE cuyo precio observado NO resultó persistible (debería ser 0). */
  presentWithPriceButUnpersistable: string[];
}

/**
 * Particiona los resultados de reconciliación. `results` debe tener EXACTAMENTE una entrada por
 * fila del catálogo (el clasificador clasifica cada catalogRow). `observedVariants` provee el
 * newPrice de los SKUs presentes con precio.
 */
export function partitionReconciliation(
  results: SkuResult[],
  catalogRows: PartitionCatalogRow[],
  observedVariants: Map<string, ObservedVariant[]>,
): PartitionResult {
  const rowBySku = new Map(catalogRows.map((r) => [r.sku, r]));
  // sku → primer precio observado persistible (el sku mapea a una única ficha; ambiguo → UNVERIFIED).
  const observedPriceBySku = new Map<string, number>();
  for (const variants of observedVariants.values()) {
    for (const v of variants) {
      const s = (v.sku ?? "").trim();
      if (s !== "" && isPersistablePrice(v.priceNumber) && !observedPriceBySku.has(s)) {
        observedPriceBySku.set(s, v.priceNumber as number);
      }
    }
  }

  const priceWriteSet: PriceWriteEntry[] = [];
  const presentWithPriceButUnpersistable: string[] = [];
  let presentWithoutPriceCount = 0;
  let verifiedAbsentCount = 0;
  let unverifiedCount = 0;
  const unverifiedCountByReason: Record<string, number> = {};

  for (const r of results) {
    switch (r.classification) {
      case "SKU_VERIFIED_PRESENT_WITH_PRICE": {
        const newPrice = observedPriceBySku.get(r.sku);
        const row = rowBySku.get(r.sku);
        if (newPrice === undefined || !isPersistablePrice(newPrice)) {
          // No debería ocurrir: el clasificador exige precio persistible para esta clase.
          presentWithPriceButUnpersistable.push(r.sku);
          break;
        }
        priceWriteSet.push({ sku: r.sku, oldPrice: row?.wholesalePrice ?? null, newPrice, fichaCanonicalUrl: row?.fichaCanonicalUrl ?? null });
        break;
      }
      case "SKU_PRESENT_WITHOUT_PRICE":
        presentWithoutPriceCount++;
        break;
      case "SKU_VERIFIED_ABSENT":
        verifiedAbsentCount++;
        break;
      case "SKU_UNVERIFIED":
        unverifiedCount++;
        if (r.reason) unverifiedCountByReason[r.reason] = (unverifiedCountByReason[r.reason] ?? 0) + 1;
        break;
    }
  }

  // El conteo de la clase present-with-price es el tamaño del write-set MÁS los descartados por
  // precio no persistible (que igual pertenecen a la clase, aunque no entren a escribir).
  const presentWithPriceClassCount = priceWriteSet.length + presentWithPriceButUnpersistable.length;
  const fourClassSum = presentWithPriceClassCount + presentWithoutPriceCount + verifiedAbsentCount + unverifiedCount;

  return {
    priceWriteSet,
    priceWriteSetSize: priceWriteSet.length,
    presentWithoutPriceCount,
    verifiedAbsentCount,
    unverifiedCount,
    unverifiedCountByReason,
    totalCatalogRows: catalogRows.length,
    fourClassSum,
    partitionCoversCatalog: fourClassSum === catalogRows.length,
    presentWithPriceButUnpersistable,
  };
}
