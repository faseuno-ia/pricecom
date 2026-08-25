// C2-MINI-A · Autoridad de espejo de la taxonomía del proveedor.
//
// SEPARADA de los writers de precio. Estos NO se tocan y siguen escribiendo exactamente
// wholesalePrice + lastSeenAt + latestExtractedProductId:
//   lib/catalog/upsert-catalog-products.ts   (rama PRICE_ONLY)
//   lib/catalog/price-only-partial-write.ts
// "PRICE_ONLY significa exactamente tres columnas mutables" sigue siendo cierto después de este
// módulo, y este módulo escribe otras tres, disjuntas.
//
// ENTRADA = jobId, y NADA MÁS.
// El writer deriva userId y providerId leyendo el ExtractionJob. Eso elimina POR CONSTRUCCIÓN el
// caso "jobId de A + providerId de B": no hay forma de pasar identificadores inconsistentes porque
// sólo se acepta uno. Es preferible a confiar en que cada caller recuerde validar tres.
//
// LEE del snapshot durable (ExtractedProduct), no del array en memoria del scraper. Ésa es la
// propiedad que hace posible `mirror_can_be_rebuilt_from_snapshot_alone`: re-ejecutar con el mismo
// jobId reconstruye el espejo sin volver a scrapear.
//
// POST-COMMIT. La razón NO es que una transacción no vea sus propias escrituras —sí las ve—, sino
// AISLAMIENTO DE AUTORIDAD: un fallo al espejar un breadcrumb no puede revertir precios ya
// validados ni el terminal del job. Por eso además NUNCA lanza.

import { Prisma } from "@prisma/client";
import { logInfo, logWarning, logError } from "@/lib/events/event-log";

/** Fila del snapshot: sólo lo necesario. Ningún campo comercial ni de precio. */
interface SnapshotRow {
  sku: string | null;
  supplierTaxonomyPath: string[];
  supplierTaxonomyObservedAt: Date | null;
  supplierTaxonomyUncategorized: boolean | null;
}

/**
 * Cliente mínimo. `PrismaClient` y una tx lo satisfacen estructuralmente; un doble de test también,
 * lo que permite observar el argumento REAL enviado a Prisma en vez de inspeccionar texto.
 */
export interface TaxonomyMirrorClient {
  extractionJob: {
    findUnique(args: unknown): Promise<{ userId: string | null; providerId: string } | null>;
  };
  extractedProduct: {
    findMany(args: unknown): Promise<SnapshotRow[]>;
  };
  catalogProduct: {
    findMany(args: unknown): Promise<{ id: string; sku: string | null }[]>;
  };
  /** Set-based: UN statement por lote, parametrizado. Ver `buildMirrorUpdate`. */
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
}

/**
 * Máximo de filas por statement. Postgres tope 65535 parámetros por sentencia y cada fila usa 4
 * (sku, path, observedAt, uncategorized), así que 2000 filas = 8000 parámetros: un octavo del
 * límite. Para el volumen real de DT (1121) es UN solo lote ⇒ los round-trips no dependen de N.
 * El troceo existe para degradar con gracia en catálogos mucho mayores, no como patrón por fila.
 */
export const MIRROR_UPDATE_CHUNK_ROWS = 2000;

/**
 * UN UPDATE set-based, enteramente parametrizado.
 *
 * TIPOS EXPLÍCITOS EN CADA COLUMNA de `v`. Postgres no puede inferir el tipo de una columna de
 * VALUES cuyos valores son todos parámetros: sin cast falla con "could not determine data type".
 * Y este proyecto ya pagó una vez el precio de confiar en la inferencia implícita entre Prisma y
 * Postgres, así que acá no se infiere nada:
 *   sku            ::text
 *   path           ::text[]      ← el array viaja como UN parámetro, nunca concatenado
 *   observed_at    ::timestamp(3)
 *   uncategorized  ::boolean
 *
 * TENANCY EN EL WHERE. La versión per-row resolvía `CatalogProduct.id` antes y actualizaba por id;
 * al volver a matchear filas hay que reponer los tres componentes, porque `cp.sku = v.sku` solo
 * cruzaría tenants: el mismo SKU puede existir para otro usuario u otro proveedor.
 *
 * MONOTONICIDAD DENTRO DEL STATEMENT. La condición temporal es parte del WHERE del UPDATE, no una
 * comparación en JS entre un SELECT y una escritura posterior.
 *
 * `RETURNING cp."sku"` devuelve exactamente las filas escritas ⇒ `written` sin round-trips extra.
 */
export function buildMirrorUpdate(
  userId: string,
  providerId: string,
  rows: { sku: string; path: string[]; observedAt: Date; uncategorized: boolean | null }[],
): Prisma.Sql {
  const values = Prisma.join(
    rows.map(
      (r) =>
        Prisma.sql`(${r.sku}::text, ${r.path}::text[], ${r.observedAt}::timestamp(3), ${r.uncategorized}::boolean)`,
    ),
    ",",
  );
  return Prisma.sql`
    WITH scope AS (SELECT ${userId}::text AS user_id, ${providerId}::text AS provider_id)
    UPDATE "CatalogProduct" cp
    SET "supplierTaxonomyPath"          = v.path,
        "supplierTaxonomyObservedAt"    = v.observed_at,
        "supplierTaxonomyUncategorized" = v.uncategorized
    FROM (VALUES ${values}) AS v(sku, path, observed_at, uncategorized), scope
    WHERE cp."userId"     = scope.user_id
      AND cp."providerId" = scope.provider_id
      AND cp."sku"        = v.sku
      AND (cp."supplierTaxonomyObservedAt" IS NULL
           OR cp."supplierTaxonomyObservedAt" <= v.observed_at)
    RETURNING cp."sku"
  `;
}

export interface TaxonomyMirrorResult {
  /** Filas del snapshot leídas para este job, antes de clasificar. */
  totalSnapshots: number;
  /** Filas que sobrevivieron la clasificación (observadas, con sku válido, sin conflicto). */
  candidates: number;
  /** Filas sin observación utilizable (observedAt = null). No pueden pisar nada. */
  skippedNotObserved: number;
  /** Filas observadas cuyo sku es null, "" o sólo espacios: sin sku no hay destino resoluble. */
  skippedNoSku: number;
  /** SKUs con dos observaciones distintas dentro del mismo snapshot: no se escribe ninguna. */
  conflicted: number;
  conflictedSkus: string[];
  /** SKUs observados que no existen en CatalogProduct. Esta autoridad NO crea filas. */
  notInCatalog: number;
  /** SKUs resueltos a una fila del catálogo. */
  matched: number;
  /** Filas efectivamente actualizadas. */
  written: number;
  /** Matcheadas cuyo UPDATE afectó 0 filas por la condición de frescura: el espejo era más nuevo. */
  stale: number;
  /** true si hubo un fallo; el llamador NO debe abortar por esto. */
  failed: boolean;
  /**
   * true si se emitió el resumen durable. Es true en TODA terminación normal, incluso con
   * `written = 0`: es exactamente lo que permite distinguir "corrió y no escribió" de "nunca corrió".
   */
  emittedSummary: boolean;
}

const empty = (): TaxonomyMirrorResult => ({
  totalSnapshots: 0,
  candidates: 0,
  skippedNotObserved: 0,
  skippedNoSku: 0,
  conflicted: 0,
  conflictedSkus: [],
  notInCatalog: 0,
  matched: 0,
  written: 0,
  stale: 0,
  failed: false,
  emittedSummary: false,
});

const sameObservation = (a: SnapshotRow, b: SnapshotRow): boolean =>
  a.supplierTaxonomyObservedAt?.getTime() === b.supplierTaxonomyObservedAt?.getTime() &&
  a.supplierTaxonomyUncategorized === b.supplierTaxonomyUncategorized &&
  a.supplierTaxonomyPath.length === b.supplierTaxonomyPath.length &&
  a.supplierTaxonomyPath.every((n, i) => n === b.supplierTaxonomyPath[i]);

/**
 * Materializa en CatalogProduct la observación de taxonomía del snapshot de `jobId`.
 *
 * NUNCA lanza: devuelve el resultado con `failed: true` y deja testigo durable.
 */
export async function persistSupplierTaxonomyObservation(
  client: TaxonomyMirrorClient,
  args: { jobId: string },
): Promise<TaxonomyMirrorResult> {
  const result = empty();
  const { jobId } = args;
  let providerId: string | undefined;

  try {
    // ── 1 · TENANCY derivada, no recibida ──────────────────────────────────
    const job = await client.extractionJob.findUnique({
      where: { id: jobId },
      select: { userId: true, providerId: true },
    });
    if (!job || !job.userId) return result; // sin dueño no hay destino: cero escrituras
    const userId = job.userId;
    providerId = job.providerId;

    // ── 2 · Snapshot ───────────────────────────────────────────────────────
    //
    // Se leen TODAS las filas del job, no sólo las observadas, para poder contar
    // `skippedNotObserved`. Ese contador es lo que distingue "proveedor legacy, nada que
    // materializar" de "proveedor con taxonomía cuyos breadcrumbs fallaron", y sin él el testigo
    // no permitiría diagnosticar el segundo caso. Son cuatro columnas chicas de un job acotado.
    const rows = await client.extractedProduct.findMany({
      where: { jobId },
      select: {
        sku: true,
        supplierTaxonomyPath: true,
        supplierTaxonomyObservedAt: true,
        supplierTaxonomyUncategorized: true,
      },
    });
    result.totalSnapshots = rows.length;

    // ── 3 · Clasificación ──────────────────────────────────────────────────
    const bySku = new Map<string, SnapshotRow>();
    const conflicted = new Set<string>();
    for (const row of rows) {
      if (row.supplierTaxonomyObservedAt === null) {
        // Ausencia NO da autoridad de borrado: queda fuera y no puede degradar el espejo.
        result.skippedNotObserved++;
        continue;
      }
      const sku = typeof row.sku === "string" ? row.sku.trim() : "";
      if (sku === "") {
        result.skippedNoSku++;
        continue;
      }
      const previo = bySku.get(sku);
      if (!previo) {
        bySku.set(sku, row);
        continue;
      }
      // ExtractedProduct no tiene unicidad por (jobId, sku): el duplicado es posible en la base
      // aunque el walk lo evite. Si coinciden colapsan; si no, no se elige una arbitrariamente,
      // porque un breadcrumb al azar sería indistinguible de uno correcto.
      if (!sameObservation(previo, row)) conflicted.add(sku);
    }
    for (const sku of conflicted) bySku.delete(sku);
    result.conflicted = conflicted.size;
    result.conflictedSkus = [...conflicted].sort();

    result.candidates = bySku.size;

    if (bySku.size === 0) {
      // Cero candidatos NO es cero información: el resumen igual se emite. Es la lección de
      // DEFECT_T2_SUMMARY_NOT_DURABLE — un writer que corre y no deja rastro es indistinguible de
      // un writer que nunca corrió.
      await emitConflictWitness(jobId, providerId, result);
      await emitSummary(jobId, providerId, result);
      return result;
    }

    // ── 4 · Destino unívoco por (userId, providerId, sku) ──────────────────
    const skus = [...bySku.keys()];
    const existing = await client.catalogProduct.findMany({
      where: { userId, providerId, sku: { in: skus } },
      select: { id: true, sku: true },
    });
    const idBySku = new Map<string, string>();
    for (const r of existing) {
      const s = typeof r.sku === "string" ? r.sku.trim() : "";
      if (s !== "") idBySku.set(s, r.id);
    }
    result.matched = idBySku.size;
    result.notInCatalog = skus.length - idBySku.size;

    // ── 5 · Escritura SET-BASED ────────────────────────────────────────────
    //
    // CONTADORES SIN ROUND-TRIPS POR FILA. El desglose se conserva con dos conjuntos ya conocidos:
    //   candidatos existentes (paso 4, un SELECT set-based)  → matched
    //   SKUs devueltos por RETURNING                          → written
    //   matched − written                                     → stale
    //   candidatos − matched                                  → notInCatalog
    // `stale` y `notInCatalog` NO se colapsan: "el producto existe pero el espejo es más nuevo" y
    // "el producto no existe" son causas operativamente distintas, y el SUMMARY durable de R-3 las
    // va a exponer por separado.
    const writable = [...bySku.entries()]
      .filter(([sku]) => idBySku.has(sku))
      .map(([sku, row]) => ({
        sku,
        path: row.supplierTaxonomyPath,
        observedAt: row.supplierTaxonomyObservedAt as Date,
        uncategorized: row.supplierTaxonomyUncategorized,
      }));

    const writtenSkus = new Set<string>();
    for (let i = 0; i < writable.length; i += MIRROR_UPDATE_CHUNK_ROWS) {
      const chunk = writable.slice(i, i + MIRROR_UPDATE_CHUNK_ROWS);
      if (chunk.length === 0) continue;
      const returned = await client.$queryRaw<{ sku: string | null }[]>(
        buildMirrorUpdate(userId, providerId, chunk),
      );
      for (const r of returned ?? []) {
        if (typeof r.sku === "string") writtenSkus.add(r.sku.trim());
      }
    }
    result.written = writtenSkus.size;
    result.stale = result.matched - result.written;

    await emitConflictWitness(jobId, providerId, result);
    await emitSummary(jobId, providerId, result);
  } catch (err) {
    // FAIL-OPEN: el job sigue COMPLETED, el precio sigue escrito y el snapshot sigue durable.
    // Ese mismo jobId sirve después para reparar, porque el writer ES el camino de recuperación.
    result.failed = true;
    try {
      await logError({
        source: "WORKER",
        type: "SUPPLIER_TAXONOMY_MIRROR_FAILED",
        title: "Falló el espejado de taxonomía del proveedor",
        description: err instanceof Error ? err.message : String(err),
        providerId,
        jobId,
        metadata: { jobId, providerId, reason: err instanceof Error ? err.message : String(err) },
      });
    } catch {
      // El audit trail jamás puede convertir un fallo tolerado en una excepción propagada.
    }
  }

  return result;
}

/**
 * Resumen durable de TODA ejecución normal, incluso con cero escrituras.
 *
 * Se eligió UN solo evento en vez de conservar también `SUPPLIER_TAXONOMY_MIRRORED`: `written > 0`
 * ya está en el payload, así que el segundo evento no aportaba información y sí obligaba a mantener
 * dos superficies consistentes. Redefinir MIRRORED para que se emitiera sin escrituras habría sido
 * peor: vacía la palabra "espejado".
 *
 * ALCANCE DE LO QUE PRUEBA — no más que eso: distingue "el writer corrió y produjo cero writes" de
 * "el writer nunca corrió". NO distingue un proveedor legacy de DT con 100% de lecturas fallidas:
 * ambos persisten sólo snapshots no observados y son indistinguibles por las tres columnas.
 */
async function emitSummary(
  jobId: string,
  providerId: string | undefined,
  r: TaxonomyMirrorResult,
): Promise<void> {
  await logInfo({
    source: "WORKER",
    type: "SUPPLIER_TAXONOMY_MIRROR_SUMMARY",
    title: `Taxonomía del proveedor — ${r.written} espejadas de ${r.candidates} candidatas`,
    providerId,
    jobId,
    metadata: {
      jobId,
      providerId,
      totalSnapshots: r.totalSnapshots,
      candidates: r.candidates,
      written: r.written,
      stale: r.stale,
      notInCatalog: r.notInCatalog,
      skippedNotObserved: r.skippedNotObserved,
      skippedNoSku: r.skippedNoSku,
      conflicted: r.conflicted,
    },
  });
  r.emittedSummary = true;
}

/** Un conflicto es señal de defecto aguas arriba, no una condición normal: merece su propio testigo. */
async function emitConflictWitness(
  jobId: string,
  providerId: string | undefined,
  r: TaxonomyMirrorResult,
): Promise<void> {
  if (r.conflicted === 0) return;
  await logWarning({
    source: "WORKER",
    type: "SUPPLIER_TAXONOMY_CONFLICT",
    title: `Taxonomía en conflicto para ${r.conflicted} SKU(s): no se espejó ninguno`,
    providerId,
    jobId,
    metadata: { jobId, providerId, conflicted: r.conflicted, skus: r.conflictedSkus.slice(0, 20) },
  });
}
