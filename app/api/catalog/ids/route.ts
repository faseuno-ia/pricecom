// GET /api/catalog/ids — devuelve solo los IDs de los productos que matchean
// los filtros actuales. Usado por el flujo "Seleccionar todos los del filtro"
// en /catalog para operaciones masivas que exceden la página visible.
//
// Reusa exactamente el mismo builder de where que /api/catalog para que la
// selección masiva coincida 1:1 con lo que el usuario ve filtrado.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import { buildCatalogListWhere } from "@/lib/catalog/list-filters";

// Tope duro para evitar response gigantes y traer media DB. Si en algún momento
// hay >10k productos en un filtro, la UI debe pedirle al usuario que filtre
// más antes de operar masivo.
const MAX_IDS = 10_000;

export async function GET(req: NextRequest) {
  const session = await requireSession();
  const url = new URL(req.url);

  const where = buildCatalogListWhere(session.user.id, url.searchParams);

  const rows = await prisma.catalogProduct.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    select: { id: true },
    take: MAX_IDS,
  });

  return NextResponse.json({
    ids: rows.map((r) => r.id),
    total: rows.length,
    truncated: rows.length === MAX_IDS,
  });
}
