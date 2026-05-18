// GET /api/my-store/unmatched — lista productos WooCommerce sin vincular,
// con scoring de match sugerido contra CatalogProduct.
//
// Query params:
//   includeIgnored=true → incluye los que fueron marcados como ignorados.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const session = await requireSession();
  const url = new URL(req.url);
  const includeIgnored = url.searchParams.get("includeIgnored") === "true";

  const store = await prisma.store.findFirst({
    where: { userId: session.user.id },
    select: { id: true },
  });
  if (!store) return NextResponse.json({ unmatched: [] });

  const items = await prisma.unmatchedStoreProduct.findMany({
    where: {
      storeId: store.id,
      ...(includeIgnored ? {} : { ignored: false }),
    },
    orderBy: { updatedAt: "desc" },
    take: 500,
  });

  // Scoring: para cada unmatched, sugerimos un CatalogProduct si encontramos
  // matchs por SKU o nombre. Tres niveles:
  //   - publicationSku === externalSku (score 95)
  //   - sku === externalSku (score 90)
  //   - supplierName/commercialTitle contiene name o viceversa (60-80)
  const suggestions: Array<{
    unmatchedId: string;
    catalogProductId: string;
    name: string;
    score: number;
    reason: string;
  }> = [];

  for (const it of items) {
    let suggestion: typeof suggestions[number] | null = null;

    if (it.externalSku) {
      const byPub = await prisma.catalogProduct.findFirst({
        where: { userId: session.user.id, publicationSku: it.externalSku },
        select: { id: true, supplierName: true, commercialTitle: true },
      });
      if (byPub) {
        suggestion = {
          unmatchedId: it.id,
          catalogProductId: byPub.id,
          name: byPub.commercialTitle ?? byPub.supplierName,
          score: 95,
          reason: "publicationSku exacto",
        };
      } else {
        const bySku = await prisma.catalogProduct.findFirst({
          where: { userId: session.user.id, sku: it.externalSku },
          select: { id: true, supplierName: true, commercialTitle: true },
        });
        if (bySku) {
          suggestion = {
            unmatchedId: it.id,
            catalogProductId: bySku.id,
            name: bySku.commercialTitle ?? bySku.supplierName,
            score: 90,
            reason: "sku exacto",
          };
        }
      }
    }

    // Fallback por nombre — solo si no encontramos por SKU. Búsqueda contains
    // case-insensitive. Score baja a 60-80 según largo del nombre matcheado.
    if (!suggestion && it.name.length >= 5) {
      const namePrefix = it.name.slice(0, Math.min(24, it.name.length));
      const byName = await prisma.catalogProduct.findFirst({
        where: {
          userId: session.user.id,
          OR: [
            { supplierName: { contains: namePrefix, mode: "insensitive" } },
            { commercialTitle: { contains: namePrefix, mode: "insensitive" } },
          ],
        },
        select: { id: true, supplierName: true, commercialTitle: true },
      });
      if (byName) {
        const score = Math.min(80, 60 + Math.floor(namePrefix.length / 3));
        suggestion = {
          unmatchedId: it.id,
          catalogProductId: byName.id,
          name: byName.commercialTitle ?? byName.supplierName,
          score,
          reason: "nombre similar",
        };
      }
    }

    if (suggestion) suggestions.push(suggestion);
  }

  const suggestionByUnmatched = new Map(
    suggestions.map((s) => [s.unmatchedId, s])
  );

  return NextResponse.json({
    unmatched: items.map((it) => ({
      id: it.id,
      externalProductId: it.externalProductId,
      externalSku: it.externalSku,
      name: it.name,
      price: it.price,
      stockQuantity: it.stockQuantity,
      imageUrl: it.imageUrl,
      categories: it.categories ? safeJsonArray(it.categories) : [],
      permalink: it.permalink,
      ignored: it.ignored,
      suggestedMatch: suggestionByUnmatched.get(it.id) ?? null,
    })),
  });
}

function safeJsonArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
