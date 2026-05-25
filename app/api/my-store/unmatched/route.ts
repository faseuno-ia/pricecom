// GET /api/my-store/unmatched — lista productos WooCommerce sin vincular,
// con scoring de match sugerido contra CatalogProduct.
//
// Query params:
//   includeDiscarded=true → en lugar de los pendientes, muestra los que el
//     usuario descartó manualmente (resolved=true SIN ProductPublication).
//     Los vinculados/creados en Mi stock (resolved=true CON publication)
//     no aparecen en ninguno de los dos modos: ya están en la tabla de
//     publicaciones.
//
// Performance: en lugar de hacer una query de scoring por cada unmatched
// (N+1 con 500 items = 500+ round-trips a la DB), pre-cargamos todos los
// CatalogProduct del usuario en memoria y matcheamos en local. Mismo patrón
// que app/api/catalog/import/route.ts.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";

interface SuggestionPlain {
  catalogProductId: string;
  name: string;
  score: number;
  reason: string;
}

export async function GET(req: NextRequest) {
  const session = await requireSession();
  const url = new URL(req.url);
  const includeDiscarded = url.searchParams.get("includeDiscarded") === "true";

  const store = await prisma.store.findFirst({
    where: { userId: session.user.id },
    select: { id: true },
  });
  if (!store) return NextResponse.json({ unmatched: [] });

  // Si el usuario pide descartados, necesitamos excluir los unmatched cuyo
  // externalProductId ya tenga ProductPublication — esos son los que
  // resolvieron por link/create-catalog, no por descarte manual.
  let externalIdsWithPublication: Set<string> | null = null;
  if (includeDiscarded) {
    const pubs = await prisma.productPublication.findMany({
      where: { storeId: store.id, externalProductId: { not: null } },
      select: { externalProductId: true },
    });
    externalIdsWithPublication = new Set(
      pubs
        .map((p) => p.externalProductId)
        .filter((x): x is string => !!x)
    );
  }

  // 1. Lista unmatched + 2. Pre-fetch de todos los CatalogProduct del usuario.
  // Las dos queries se disparan en paralelo.
  const [items, catalogProducts] = await Promise.all([
    prisma.unmatchedStoreProduct.findMany({
      where: {
        storeId: store.id,
        resolved: includeDiscarded ? true : false,
        ...(includeDiscarded && externalIdsWithPublication
          ? {
              NOT: {
                externalProductId: {
                  in: Array.from(externalIdsWithPublication),
                },
              },
            }
          : {}),
      },
      orderBy: { updatedAt: "desc" },
      take: 500,
    }),
    prisma.catalogProduct.findMany({
      where: { userId: session.user.id },
      select: {
        id: true,
        sku: true,
        publicationSku: true,
        supplierName: true,
        commercialTitle: true,
      },
    }),
  ]);

  // Indexes en memoria:
  //   - bySku / byPubSku: lookup O(1) para match exacto.
  //   - byNameLower: lista preparada con el nombre normalizado (lowercase)
  //     para el fallback contains.
  const bySku = new Map<string, (typeof catalogProducts)[number]>();
  const byPubSku = new Map<string, (typeof catalogProducts)[number]>();
  const byNameLower = catalogProducts.map((p) => ({
    cp: p,
    name: (p.commercialTitle ?? p.supplierName).toLowerCase(),
  }));
  for (const p of catalogProducts) {
    if (p.sku) bySku.set(p.sku, p);
    if (p.publicationSku) byPubSku.set(p.publicationSku, p);
  }

  function scoreFor(unmatched: (typeof items)[number]): SuggestionPlain | null {
    // 1. publicationSku exacto (score 95).
    if (unmatched.externalSku) {
      const byPub = byPubSku.get(unmatched.externalSku);
      if (byPub) {
        return {
          catalogProductId: byPub.id,
          name: byPub.commercialTitle ?? byPub.supplierName,
          score: 95,
          reason: "publicationSku exacto",
        };
      }
      // 2. sku exacto (score 90).
      const skuMatch = bySku.get(unmatched.externalSku);
      if (skuMatch) {
        return {
          catalogProductId: skuMatch.id,
          name: skuMatch.commercialTitle ?? skuMatch.supplierName,
          score: 90,
          reason: "sku exacto",
        };
      }
    }
    // 3. Fallback contains por nombre. Solo si name >= 5 chars, para evitar
    //    matches espurios sobre prefijos cortos.
    if (unmatched.name.length >= 5) {
      const prefix = unmatched.name
        .slice(0, Math.min(24, unmatched.name.length))
        .toLowerCase();
      const found = byNameLower.find(
        (e) => e.name.includes(prefix) || prefix.includes(e.name)
      );
      if (found) {
        const score = Math.min(80, 60 + Math.floor(prefix.length / 3));
        return {
          catalogProductId: found.cp.id,
          name: found.cp.commercialTitle ?? found.cp.supplierName,
          score,
          reason: "nombre similar",
        };
      }
    }
    return null;
  }

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
      resolved: it.resolved,
      suggestedMatch: scoreFor(it),
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
