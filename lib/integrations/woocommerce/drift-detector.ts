// Detector de drift entre el catálogo interno y la tienda externa.
// Devuelve los campos donde el valor "lo que queremos publicar" difiere del
// "lo que actualmente está publicado". Si hay drift, el sync engine debería
// marcar la publicación como OUTDATED o PENDING_SYNC.

export interface DriftDiff {
  field: string;
  catalog: string | number | null;
  store: string | number | null;
}

export interface DriftResult {
  hasDrift: boolean;
  diffs: DriftDiff[];
}

interface CatalogShape {
  finalPrice?: number | null;
  wholesalePrice?: number | null;
  supplierName: string;
  commercialTitle?: string | null;
  stock?: string | null;
}

interface PublicationShape {
  priceInStore?: number | null;
  stockInStore?: number | null;
  categoryInStore?: string | null;
}

interface PricingShape {
  effectivePrice: number | null;
}

const PRICE_TOLERANCE = 1; // pesos
const STOCK_TOLERANCE = 0; // unidades exactas

export function detectDrift(
  catalog: CatalogShape,
  publication: PublicationShape,
  pricing: PricingShape
): DriftResult {
  const diffs: DriftDiff[] = [];

  const effectivePrice = catalog.finalPrice ?? pricing.effectivePrice;
  if (
    effectivePrice != null &&
    publication.priceInStore != null &&
    Math.abs(effectivePrice - publication.priceInStore) > PRICE_TOLERANCE
  ) {
    diffs.push({
      field: "precio",
      catalog: effectivePrice,
      store: publication.priceInStore,
    });
  }

  // Stock: solo si nuestro lado expresa una cantidad numérica clara (parsed
  // del campo string `stock`); si no, no podemos decidir si hay drift.
  const internalStockNum = parseStockNumber(catalog.stock);
  if (
    internalStockNum != null &&
    publication.stockInStore != null &&
    Math.abs(internalStockNum - publication.stockInStore) > STOCK_TOLERANCE
  ) {
    diffs.push({
      field: "stock",
      catalog: internalStockNum,
      store: publication.stockInStore,
    });
  }

  return { hasDrift: diffs.length > 0, diffs };
}

function parseStockNumber(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const m = String(raw).match(/-?\d+/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}
