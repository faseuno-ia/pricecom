// Mantenemos el import relativo (no `@/...`) porque este módulo lo consume el
// worker (tsx) además de Next.js, y el alias `@` puede no resolver en tsx.
import type { PrismaClient } from "@prisma/client";
import { createHash } from "crypto";
import { buildPublicationSku } from "./publication-sku";
import { logWarning } from "../events/event-log";

interface IdentityInputs {
  sku?: string | null;
  productUrl?: string | null;
  name: string;
  providerId: string;
}

interface IdentityKey {
  sku?: string;
  productUrl?: string;
  identityHash?: string;
}

function identityKey(p: IdentityInputs): IdentityKey {
  if (p.sku?.trim()) return { sku: p.sku.trim() };
  if (p.productUrl?.trim()) return { productUrl: p.productUrl.trim() };
  const hash = createHash("sha256")
    .update((p.name + p.providerId).toLowerCase().trim())
    .digest("hex")
    .slice(0, 16);
  return { identityHash: hash };
}

/**
 * Upsert de CatalogProduct para todos los productos extraídos en `jobId`.
 *
 * Reglas:
 *  - Sólo los campos `supplier*` y `lastSeenAt` se actualizan automáticamente.
 *  - Los campos comerciales (commercialName, assignedCategory, manualPrice,
 *    pricingRule, notes) NUNCA se tocan en updates.
 *  - Productos del proveedor que ya estaban en el catálogo pero no aparecieron
 *    en esta extracción se marcan como `SUPPLIER_REMOVED`.
 *  - Si un producto aparece de nuevo tras haber estado SUPPLIER_REMOVED, vuelve
 *    a ACTIVE; NO tocamos `internalStatus` (esa decisión comercial es del usuario).
 */
export async function upsertCatalogProducts(
  jobId: string,
  prismaClient: PrismaClient
): Promise<void> {
  const job = await prismaClient.extractionJob.findUnique({
    where: { id: jobId },
    include: { products: true },
  });
  if (!job || !job.userId) return;

  const userId = job.userId;
  const providerId = job.providerId;
  const lastSeenAt = new Date();

  // Prefijo comercial del proveedor (vive en scraperConfig.imageFilenamePrefix
  // — el mismo valor se usa para nombres de archivo de imágenes y para el
  // publicationSku). Si no está configurado, publicationSku === sku.
  const scraperConfig = await prismaClient.providerScraperConfig.findUnique({
    where: { providerId },
    select: { imageFilenamePrefix: true },
  });
  const publicationPrefix = scraperConfig?.imageFilenamePrefix ?? null;

  for (const product of job.products) {
    const identity = identityKey({
      sku: product.sku,
      productUrl: product.productUrl,
      name: product.name,
      providerId,
    });

    // Datos que el worker puede actualizar (siempre supplier*, nunca comerciales).
    // publicationSku NO va acá: lo decidimos abajo según si el valor existente
    // sigue siendo el default del proveedor (= nunca editado) o si el usuario
    // ya lo personalizó (en ese caso lo respetamos y no lo pisamos).
    const supplierDataBase = {
      supplierName: product.name,
      supplierDescription: product.description ?? null,
      wholesalePrice:
        product.wholesalePrice != null ? Number(product.wholesalePrice) : null,
      stock: product.stock ?? null,
      supplierCategory: product.category ?? null,
      imageUrl: product.imageUrl ?? null,
      productUrl: product.productUrl ?? null,
      lastSeenAt,
      supplierStatus: "ACTIVE" as const,
      latestExtractedProductId: product.id,
    };

    const defaultPublicationSku = buildPublicationSku(
      publicationPrefix,
      identity.sku
    );

    // Decide si el publicationSku debe escribirse en un update existente:
    //   - Siempre que el valor actual sea null/vacío (todavía no se asignó).
    //   - O cuando coincide exactamente con el default del proveedor
    //     (= prefix + sku, el patrón que el worker hubiera generado).
    // Si no coincide es porque el usuario lo editó manualmente — respetar.
    function shouldUpdatePubSku(current: string | null | undefined): boolean {
      if (!current) return true;
      return current === defaultPublicationSku;
    }

    let upsertedId: string | null = null;
    if (identity.sku) {
      const existing = await prismaClient.catalogProduct.findUnique({
        where: {
          userId_providerId_sku: {
            userId,
            providerId,
            sku: identity.sku,
          },
        },
        select: { id: true, publicationSku: true },
      });

      if (existing) {
        await prismaClient.catalogProduct.update({
          where: { id: existing.id },
          data: {
            ...supplierDataBase,
            ...(shouldUpdatePubSku(existing.publicationSku)
              ? { publicationSku: defaultPublicationSku }
              : {}),
          },
        });
        upsertedId = existing.id;
      } else {
        const created = await prismaClient.catalogProduct.create({
          data: {
            userId,
            providerId,
            sku: identity.sku,
            ...supplierDataBase,
            publicationSku: defaultPublicationSku,
          },
          select: { id: true },
        });
        upsertedId = created.id;
      }
    } else {
      // Sin SKU: buscar manualmente por productUrl o identityHash dentro del scope
      // userId×providerId. Si no hay ninguno de los dos, no podemos identificar.
      const orClauses: Array<
        | { productUrl: string }
        | { identityHash: string }
      > = [];
      if (identity.productUrl) orClauses.push({ productUrl: identity.productUrl });
      if (identity.identityHash) orClauses.push({ identityHash: identity.identityHash });

      if (orClauses.length === 0) continue;

      const existing = await prismaClient.catalogProduct.findFirst({
        where: { userId, providerId, OR: orClauses },
        select: { id: true, publicationSku: true },
      });

      if (existing) {
        await prismaClient.catalogProduct.update({
          where: { id: existing.id },
          data: {
            ...supplierDataBase,
            ...(shouldUpdatePubSku(existing.publicationSku)
              ? { publicationSku: defaultPublicationSku }
              : {}),
          },
        });
        upsertedId = existing.id;
      } else {
        const created = await prismaClient.catalogProduct.create({
          data: {
            userId,
            providerId,
            ...(identity.productUrl ? { productUrl: identity.productUrl } : {}),
            ...(identity.identityHash ? { identityHash: identity.identityHash } : {}),
            ...supplierDataBase,
            publicationSku: defaultPublicationSku,
          },
          select: { id: true },
        });
        upsertedId = created.id;
      }
    }

    // Propagar el wholesalePrice actualizado a productos derivados con
    // stockSource=OWN que apunten a este catálogo via sourceCatalogProductId.
    // Solo wholesalePrice — los datos comerciales del hijo son del usuario y no
    // se tocan. En el modelo nuevo no se crean más duplicados (copy_own_stock
    // setea stockSource sobre la misma fila), pero conservamos este puente por
    // si quedan registros legacy de instalaciones previas.
    if (upsertedId && supplierDataBase.wholesalePrice != null) {
      await prismaClient.catalogProduct.updateMany({
        where: {
          sourceCatalogProductId: upsertedId,
          stockSource: "OWN",
        },
        data: { wholesalePrice: supplierDataBase.wholesalePrice },
      });
    }
  }

  // Marcar como SUPPLIER_REMOVED los CatalogProduct activos de este proveedor
  // cuyo SKU no apareció en la extracción actual. Sólo aplicamos a productos con
  // SKU: los identificados por URL/hash son menos confiables para detectar bajas.
  //
  // Auto-pause: si el producto está PREPARED y depende del proveedor (stockSource
  // SUPPLIER), además de marcarlo removido lo pasamos a PAUSED para evitar que se
  // publique algo que ya no tenemos cómo abastecer. Los OWN y HYBRID conservan
  // internalStatus porque el cliente tiene stock propio. IGNORED no se toca.
  const seenSkus = job.products
    .map((p) => p.sku)
    .filter((s): s is string => !!s && s.length > 0);

  if (seenSkus.length > 0) {
    // Caso 1: PREPARED|PUBLISHED + stockSource SUPPLIER → PAUSED + SUPPLIER_REMOVED.
    // Pre-resolvemos los IDs para poder propagar el cambio a ProductPublication
    // (marcarlas pendingSync=true) en el mismo paso.
    const toAutoPause = await prismaClient.catalogProduct.findMany({
      where: {
        userId,
        providerId,
        supplierStatus: "ACTIVE",
        stockSource: "SUPPLIER",
        internalStatus: { in: ["PREPARED", "PUBLISHED"] },
        sku: { notIn: seenSkus },
      },
      select: { id: true, sku: true, supplierName: true, internalStatus: true },
    });

    if (toAutoPause.length > 0) {
      const pauseIds = toAutoPause.map((p) => p.id);
      await prismaClient.catalogProduct.updateMany({
        where: { id: { in: pauseIds } },
        data: {
          supplierStatus: "SUPPLIER_REMOVED",
          internalStatus: "PAUSED",
        },
      });
      // Las publications que estaban ACTIVE quedan desincronizadas: la app
      // dice PAUSED pero WooCommerce las sigue mostrando como publish. Las
      // marcamos pendingSync=true para que el próximo /sync/publications
      // las baje a draft en la tienda.
      await prismaClient.productPublication.updateMany({
        where: {
          catalogProductId: { in: pauseIds },
          status: "ACTIVE",
        },
        data: { pendingSync: true, syncStatus: "PENDING_SYNC" },
      });

      // Audit trail: un evento por producto auto-pausado.
      for (const p of toAutoPause) {
        await logWarning({
          source: "SYSTEM",
          type: "PRODUCT_AUTO_PAUSED",
          title: `Producto pausado automáticamente — SKU ${p.sku ?? "(sin SKU)"}`,
          description: "El proveedor removió el producto del catálogo.",
          productId: p.id,
          providerId,
          jobId,
          metadata: {
            previousStatus: p.internalStatus,
            sku: p.sku,
            supplierName: p.supplierName,
          },
        });
      }
    }

    // Caso 2: el resto (NOT_PUBLISHED, PAUSED, o cualquier estado con stockSource
    // OWN/HYBRID) → sólo marcar SUPPLIER_REMOVED. IGNORED queda excluido.
    // Pre-resolvemos también acá para loguear PRODUCT_SUPPLIER_REMOVED.
    const toMarkRemoved = await prismaClient.catalogProduct.findMany({
      where: {
        userId,
        providerId,
        supplierStatus: "ACTIVE",
        internalStatus: { not: "IGNORED" },
        sku: { notIn: seenSkus },
        NOT: {
          AND: [
            { stockSource: "SUPPLIER" },
            { internalStatus: { in: ["PREPARED", "PUBLISHED"] } },
          ],
        },
      },
      select: { id: true, sku: true, supplierName: true },
    });
    if (toMarkRemoved.length > 0) {
      await prismaClient.catalogProduct.updateMany({
        where: { id: { in: toMarkRemoved.map((p) => p.id) } },
        data: { supplierStatus: "SUPPLIER_REMOVED" },
      });
      for (const p of toMarkRemoved) {
        await logWarning({
          source: "WORKER",
          type: "PRODUCT_SUPPLIER_REMOVED",
          title: `Producto removido por proveedor — SKU ${p.sku ?? "(sin SKU)"}`,
          productId: p.id,
          providerId,
          jobId,
          metadata: { sku: p.sku, supplierName: p.supplierName },
        });
      }
    }
  }
}
