// 2G-R8-Q2.1-B · §9.2 / addendum A — Escritura PRICE_ONLY de PARTIAL COMMIT sobre una LISTA EXPLÍCITA
// EN MEMORIA (el PRICE_WRITE_SET preflighteado), NUNCA derivada de una query sobre ExtractedProduct.
//
// A diferencia de upsertCatalogProducts (que lee job.products = ExtractedProduct y escribiría TODAS
// las observaciones), este writer recibe el set N explícito y actualiza EXCLUSIVAMENTE esas filas.
// Campos escritos (mismos que el PRICE_ONLY vigente): wholesalePrice, lastSeenAt, latestExtractedProductId.
// NO toca: name/description/category/image/productUrl/stock/supplierStatus/internalStatus/pausedBySystem/
// publication/Woo. NO inserta filas nuevas (un sku sin fila de catálogo NO se escribe → NEW_PROVIDER
// SKUs quedan afuera por construcción). NO ejecuta lifecycle/removal/reactivación.
//
// El precio NUNCA se deriva: llega en `entries`. `OBSERVATION_METADATA_CAN_EXPAND_PRICE_WRITE_SET=false`.

export interface PartialPriceWriteEntry {
  /** SKU del catálogo (existente). */
  sku: string;
  /** Precio a persistir (persistible por construcción del PRICE_WRITE_SET: número finito > 0). */
  newPrice: number;
  /** id del ExtractedProduct-observación de esta corrida para este sku (latestExtractedProductId). */
  extractedProductId: string;
}

/** Cliente mínimo (tx de Prisma o mock). Sólo lo que este writer necesita. */
export interface PartialWriteCatalogClient {
  catalogProduct: {
    findMany: (args: { where: { userId: string; providerId: string; sku: { in: string[] } }; select: { id: true; sku: true } }) => Promise<Array<{ id: string; sku: string | null }>>;
    update: (args: { where: { id: string }; data: { wholesalePrice: number; lastSeenAt: Date; latestExtractedProductId: string } }) => Promise<unknown>;
  };
}

export interface PartialPriceWriteResult {
  requested: number;
  written: number;
  /** SKUs del set que NO existen en el catálogo (no se escriben; deberían ser 0 — el set viene de filas de catálogo). */
  skippedNonexistentSkus: string[];
}

/**
 * Escribe wholesalePrice + lastSeenAt + latestExtractedProductId SÓLO para las filas de `entries`.
 * Resuelve id por (userId, providerId, sku) — set-based, sin N+1 en la lectura. Un sku del set que no
 * exista NO se inserta (se reporta en skippedNonexistentSkus). Determinístico. Corre dentro de la tx
 * fenced del worker; un fallo mid-loop es revertido por el rollback de esa transacción.
 */
export async function writePriceOnlyExplicit(
  client: PartialWriteCatalogClient,
  args: { userId: string; providerId: string; entries: PartialPriceWriteEntry[]; lastSeenAt: Date },
): Promise<PartialPriceWriteResult> {
  const bySku = new Map<string, PartialPriceWriteEntry>();
  for (const e of args.entries) {
    const sku = (e.sku ?? "").trim();
    if (sku !== "" && !bySku.has(sku)) bySku.set(sku, e);
  }
  const skus = [...bySku.keys()];
  if (skus.length === 0) return { requested: 0, written: 0, skippedNonexistentSkus: [] };

  const existing = await client.catalogProduct.findMany({
    where: { userId: args.userId, providerId: args.providerId, sku: { in: skus } },
    select: { id: true, sku: true },
  });
  const idBySku = new Map<string, string>();
  for (const r of existing) {
    const sku = (r.sku ?? "").trim();
    if (sku !== "") idBySku.set(sku, r.id);
  }

  let written = 0;
  const skipped: string[] = [];
  for (const [sku, e] of bySku) {
    const id = idBySku.get(sku);
    if (!id) { skipped.push(sku); continue; } // no existe → NO se inserta (por construcción no debería pasar)
    await client.catalogProduct.update({
      where: { id },
      data: { wholesalePrice: e.newPrice, lastSeenAt: args.lastSeenAt, latestExtractedProductId: e.extractedProductId },
    });
    written++;
  }
  return { requested: bySku.size, written, skippedNonexistentSkus: skipped.sort() };
}
