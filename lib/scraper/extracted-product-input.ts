// GATE A2 — Paso 6: seam puro del transporte ScrapedProduct → ExtractedProduct.
//
// Función extraída del map inline de `worker/src/index.ts`
// (`prisma.extractedProduct.createMany`). Comportamiento BYTE-EQUIVALENTE al
// original: mismos campos, mismo orden conceptual, mismo default de nombre. Su
// único propósito es poder testear que `rawData` (con las variantes SKU-first)
// llega intacto al límite de persistencia, sin tocar el resto del worker.
//
// `ExtractedProduct.rawData` conserva el JSON completo (incluidas todas las
// variantes). `CatalogProduct` NO tiene rawData: recibe solo campos canónicos
// del ganador vía `upsertCatalogProducts`. Eso es suficiente para el alta
// SKU-first; agregar `CatalogProduct.rawData` sería otro gate.

import type { Prisma } from "@prisma/client";
import type { ScrapedProduct } from "./scraper.service";

export interface ExtractedProductCreateInput {
  jobId: string;
  providerId: string;
  sku: string | null;
  name: string;
  description: string | null;
  wholesalePrice: number | null;
  oldPrice: number | null;
  stock: string | null;
  category: string | null;
  brand: string | null;
  productUrl: string | null;
  imageUrl: string | null;
  rawData: Prisma.InputJsonValue;
  /// C2-MINI-A · transporte de la observación de taxonomía hacia el snapshot durable, que es de
  /// donde el mirror writer la lee. `observedAt` es el DISCRIMINANTE de los tres estados.
  supplierTaxonomyPath: string[];
  supplierTaxonomyObservedAt: Date | null;
  supplierTaxonomyUncategorized: boolean | null;
}

/**
 * C2-MINI-A · `attemptObservedAt` es OBLIGATORIO y viene del caller: UN timestamp por attempt, no
 * uno por producto. `products.map(() => new Date())` produciría cientos de instantes distintos para
 * una sola observación y volvería inútil la comparación de frescura del espejo.
 *
 * Es parámetro requerido a propósito: si fuera opcional, un call site que lo olvide degradaría en
 * silencio a "no observado" y perdería el dato sin que nada falle.
 */
export function mapScrapedToExtractedProductInput(
  p: ScrapedProduct,
  jobId: string,
  providerId: string,
  attemptObservedAt: Date,
): ExtractedProductCreateInput {
  // Tres estados. `null`/`undefined` = NOT_OBSERVED: no se inventa timestamp, y por eso el espejo
  // sabe después que esa fila no puede pisar una observación válida anterior.
  const t = p.supplierTaxonomy ?? null;
  return {
    jobId,
    providerId,
    sku: p.sku,
    name: p.name || "Sin nombre",
    description: p.description,
    wholesalePrice: p.wholesalePrice,
    oldPrice: p.oldPrice,
    stock: p.stock,
    category: p.category,
    brand: p.brand,
    productUrl: p.productUrl,
    imageUrl: p.imageUrl,
    // rawData del scraper es Record<string, unknown> por API genérica; se
    // transporta como InputJsonValue de Prisma en el boundary de persistencia.
    rawData: p.rawData as Prisma.InputJsonValue,
    supplierTaxonomyPath: t ? t.path : [],
    supplierTaxonomyObservedAt: t ? attemptObservedAt : null,
    supplierTaxonomyUncategorized: t ? t.uncategorized : null,
  };
}
