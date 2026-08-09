// 2G-R8-Q2.1-B · §3.1 pre-run snapshot + §11 post-write diff. PURO, determinístico.
// Cubre TODOS los campos de CatalogProduct que Q2.1-B puede modificar (wholesalePrice, lastSeenAt,
// latestExtractedProductId) MÁS los campos "estables" que NO debe tocar (para detectar mutaciones
// prohibidas). Orden estable por id antes de hashear. Nunca imprime precios (el módulo sólo calcula).

import { createHash } from "crypto";

export interface CatalogSnapshotRow {
  id: string;
  sku: string | null;
  // mutables por Q2.1-B
  wholesalePrice: number | null;
  lastSeenAt: string | null; // ISO
  latestExtractedProductId: string | null;
  // estables (Q2.1-B NO debe tocarlos)
  supplierName: string | null;
  supplierDescription: string | null;
  supplierCategory: string | null;
  imageUrl: string | null;
  productUrl: string | null;
  stock: string | null;
  supplierStatus: string | null;
  internalStatus: string | null;
  pausedBySystem: boolean | null;
}

export interface CatalogSnapshot {
  rows: CatalogSnapshotRow[];
  rowCount: number;
  snapshotSha256: string;
  stableFieldsSha256: string;
  priceVectorSha256: string;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const sortById = (rows: CatalogSnapshotRow[]) => [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

const STABLE_KEYS: (keyof CatalogSnapshotRow)[] = [
  "supplierName", "supplierDescription", "supplierCategory", "imageUrl", "productUrl",
  "stock", "supplierStatus", "internalStatus", "pausedBySystem",
];

export function buildCatalogSnapshot(rows: CatalogSnapshotRow[]): CatalogSnapshot {
  const sorted = sortById(rows);
  const full = sorted.map((r) => JSON.stringify(r)).join("\n");
  const stable = sorted.map((r) => JSON.stringify([r.id, ...STABLE_KEYS.map((k) => r[k])])).join("\n");
  const price = sorted.map((r) => JSON.stringify([r.id, r.wholesalePrice])).join("\n");
  return {
    rows: sorted,
    rowCount: sorted.length,
    snapshotSha256: sha(full),
    stableFieldsSha256: sha(stable),
    priceVectorSha256: sha(price),
  };
}

export interface CatalogDiffResult {
  wholesalePriceChangedCount: number;
  priceVectorPostSha256: string;
  rowsAdded: number;
  rowsRemoved: number;
  existingPricedToNullCount: number;
  // mutaciones prohibidas (deben ser 0):
  supplierNameChanged: number;
  descriptionChanged: number;
  categoryChanged: number;
  imageUrlChanged: number;
  productUrlChanged: number;
  stockChanged: number;
  supplierStatusChanged: number;
  internalStatusChanged: number;
  pausedBySystemChanged: number;
  /** true si NINGÚN campo estable (no-precio) cambió. */
  allNonPriceInvariantsZero: boolean;
  /** SKUs cuyo wholesalePrice cambió (para cotejar contra el write-set esperado). */
  changedPriceSkus: string[];
  /** Sólo presente si se pasó expectedWriteSkus: los precios cambiados == exactamente lo esperado. */
  preflightMatchedActualWrites?: boolean;
}

/**
 * Compara snapshot PRE contra POST. Empareja por id. `expectedWriteSkus` (opcional) = los SKUs que el
 * PRICE_WRITE_SET debía escribir; si se pasa, verifica que el conjunto de precios cambiados coincida
 * EXACTAMENTE (PREFLIGHT_MATCHED_ACTUAL_WRITES).
 */
export function diffCatalogSnapshots(
  pre: CatalogSnapshotRow[],
  post: CatalogSnapshotRow[],
  expectedWriteSkus?: string[],
): CatalogDiffResult {
  const preById = new Map(pre.map((r) => [r.id, r]));
  const postById = new Map(post.map((r) => [r.id, r]));

  let wholesalePriceChanged = 0, existingPricedToNull = 0;
  let nameC = 0, descC = 0, catC = 0, imgC = 0, urlC = 0, stockC = 0, supStatusC = 0, intStatusC = 0, pausedC = 0;
  const changedPriceSkus: string[] = [];

  for (const [id, preRow] of preById) {
    const postRow = postById.get(id);
    if (!postRow) continue; // removido → contado abajo
    if (preRow.wholesalePrice !== postRow.wholesalePrice) {
      wholesalePriceChanged++;
      const sku = (preRow.sku ?? "").trim();
      if (sku !== "") changedPriceSkus.push(sku);
      if (typeof preRow.wholesalePrice === "number" && preRow.wholesalePrice > 0 && postRow.wholesalePrice == null) {
        existingPricedToNull++;
      }
    }
    if (preRow.supplierName !== postRow.supplierName) nameC++;
    if (preRow.supplierDescription !== postRow.supplierDescription) descC++;
    if (preRow.supplierCategory !== postRow.supplierCategory) catC++;
    if (preRow.imageUrl !== postRow.imageUrl) imgC++;
    if (preRow.productUrl !== postRow.productUrl) urlC++;
    if (preRow.stock !== postRow.stock) stockC++;
    if (preRow.supplierStatus !== postRow.supplierStatus) supStatusC++;
    if (preRow.internalStatus !== postRow.internalStatus) intStatusC++;
    if (preRow.pausedBySystem !== postRow.pausedBySystem) pausedC++;
  }
  const rowsAdded = [...postById.keys()].filter((id) => !preById.has(id)).length;
  const rowsRemoved = [...preById.keys()].filter((id) => !postById.has(id)).length;

  const allNonPriceInvariantsZero =
    nameC === 0 && descC === 0 && catC === 0 && imgC === 0 && urlC === 0 && stockC === 0 &&
    supStatusC === 0 && intStatusC === 0 && pausedC === 0 && rowsAdded === 0 && rowsRemoved === 0;

  const result: CatalogDiffResult = {
    wholesalePriceChangedCount: wholesalePriceChanged,
    priceVectorPostSha256: buildCatalogSnapshot(post).priceVectorSha256,
    rowsAdded, rowsRemoved, existingPricedToNullCount: existingPricedToNull,
    supplierNameChanged: nameC, descriptionChanged: descC, categoryChanged: catC, imageUrlChanged: imgC,
    productUrlChanged: urlC, stockChanged: stockC, supplierStatusChanged: supStatusC,
    internalStatusChanged: intStatusC, pausedBySystemChanged: pausedC,
    allNonPriceInvariantsZero, changedPriceSkus: changedPriceSkus.sort(),
  };
  if (expectedWriteSkus) {
    const expected = new Set(expectedWriteSkus.map((s) => s.trim()).filter((s) => s !== ""));
    const actual = new Set(changedPriceSkus);
    result.preflightMatchedActualWrites = expected.size === actual.size && [...expected].every((s) => actual.has(s));
  }
  return result;
}
