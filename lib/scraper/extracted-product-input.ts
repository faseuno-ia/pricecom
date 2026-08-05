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
}

export function mapScrapedToExtractedProductInput(
  p: ScrapedProduct,
  jobId: string,
  providerId: string,
): ExtractedProductCreateInput {
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
  };
}
