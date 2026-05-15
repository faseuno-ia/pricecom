import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import { Prisma, ProductChangeType } from "@prisma/client";

const VALID_CHANGE_TYPES: ProductChangeType[] = [
  "NEW",
  "REMOVED",
  "PRICE_UP",
  "PRICE_DOWN",
  "STOCK_CHANGED",
];

const MAX_PAGE_SIZE = 100;

export async function GET(req: NextRequest) {
  const session = await requireSession();
  const url = new URL(req.url);

  const providerId = url.searchParams.get("providerId");
  const changeTypeParams = url.searchParams.getAll("changeType");
  const fromParam = url.searchParams.get("from");
  const pageParam = parseInt(url.searchParams.get("page") ?? "1", 10);
  const pageSizeParam = parseInt(url.searchParams.get("pageSize") ?? "50", 10);

  const page = Math.max(1, Number.isFinite(pageParam) ? pageParam : 1);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Number.isFinite(pageSizeParam) ? pageSizeParam : 50)
  );

  const changeTypes = changeTypeParams.filter((t): t is ProductChangeType =>
    VALID_CHANGE_TYPES.includes(t as ProductChangeType)
  );

  // Filtros sobre ProductChange. La pertenencia al usuario y el filtro de fecha
  // se aplican via la cadena change → comparison → job. Filtramos por
  // job.finishedAt (cuándo ocurrió la extracción real) en vez de ProductChange.createdAt,
  // porque los registros backfilleados tienen createdAt = fecha del backfill,
  // no la fecha de la extracción original.
  const jobFilter: Prisma.ExtractionJobWhereInput = {
    userId: session.user.id,
    ...(providerId ? { providerId } : {}),
    ...(fromParam ? { finishedAt: { gte: new Date(fromParam) } } : {}),
  };

  const where: Prisma.ProductChangeWhereInput = {
    comparison: { job: jobFilter },
    ...(changeTypes.length > 0 ? { changeType: { in: changeTypes } } : {}),
  };

  const [total, changes] = await Promise.all([
    prisma.productChange.count({ where }),
    prisma.productChange.findMany({
      where,
      orderBy: { comparison: { job: { finishedAt: "desc" } } },
      take: pageSize,
      skip: (page - 1) * pageSize,
      include: {
        comparison: {
          select: {
            jobId: true,
            job: {
              select: {
                providerId: true,
                provider: { select: { name: true } },
              },
            },
          },
        },
      },
    }),
  ]);

  // Enriquecer con datos de ExtractedProduct (imagen, categoría, etc.) en un
  // único batch fuera del loop, evitando N+1 queries.
  const enrichable = changes.filter((c) => c.changeType !== "REMOVED" && c.sku);
  const jobIds = Array.from(new Set(enrichable.map((c) => c.comparison.jobId)));
  const skus = Array.from(
    new Set(enrichable.map((c) => c.sku!).filter((s) => s.length > 0))
  );

  const products =
    jobIds.length > 0 && skus.length > 0
      ? await prisma.extractedProduct.findMany({
          where: { jobId: { in: jobIds }, sku: { in: skus } },
          select: {
            id: true,
            jobId: true,
            sku: true,
            imageUrl: true,
            category: true,
            publicationStatus: true,
            productUrl: true,
            description: true,
          },
        })
      : [];

  const productByKey = new Map<
    string,
    {
      id: string;
      imageUrl: string | null;
      category: string | null;
      publicationStatus: string | null;
      productUrl: string | null;
      description: string | null;
    }
  >();
  for (const p of products) {
    if (p.sku) {
      productByKey.set(`${p.jobId}:${p.sku}`, {
        id: p.id,
        imageUrl: p.imageUrl,
        category: p.category,
        publicationStatus: p.publicationStatus,
        productUrl: p.productUrl,
        description: p.description,
      });
    }
  }

  const enriched = changes.map((c) => ({
    id: c.id,
    sku: c.sku,
    name: c.name,
    changeType: c.changeType,
    previousPrice: c.previousPrice,
    currentPrice: c.currentPrice,
    priceChangePercent: c.priceChangePercent,
    previousStock: c.previousStock,
    currentStock: c.currentStock,
    createdAt: c.createdAt,
    providerId: c.comparison.job.providerId,
    providerName: c.comparison.job.provider.name,
    jobId: c.comparison.jobId,
    product:
      c.changeType !== "REMOVED" && c.sku
        ? productByKey.get(`${c.comparison.jobId}:${c.sku}`) ?? null
        : null,
  }));

  return NextResponse.json({
    changes: enriched,
    total,
    page,
    pageSize,
  });
}
