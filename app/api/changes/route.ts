import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import {
  Prisma,
  ProductChangeType,
  ChangeReviewStatus,
} from "@prisma/client";

const VALID_CHANGE_TYPES: ProductChangeType[] = [
  "NEW",
  "REMOVED",
  "PRICE_UP",
  "PRICE_DOWN",
  "STOCK_CHANGED",
];

const VALID_REVIEW_STATUSES: ChangeReviewStatus[] = [
  "PENDING",
  "REVIEWED",
  "IGNORED",
];

type Mode = "recent" | "48h" | "7d" | "all";
const VALID_MODES: Mode[] = ["recent", "48h", "7d", "all"];

const MAX_PAGE_SIZE = 100;

export async function GET(req: NextRequest) {
  const session = await requireSession();
  const url = new URL(req.url);

  const providerId = url.searchParams.get("providerId");
  const changeTypeParams = url.searchParams.getAll("changeType");
  const reviewStatusParam = url.searchParams.get("reviewStatus");
  const modeParam = (url.searchParams.get("mode") ?? "recent") as Mode;
  const mode: Mode = VALID_MODES.includes(modeParam) ? modeParam : "recent";

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

  // ─── Determinar el universo de comparison.jobIds según el modo ──────────
  let latestJobIds: string[] | null = null;
  let providersCompared = 0;
  let lastUpdatedAt: Date | null = null;

  if (mode === "recent") {
    // Última comparación COMPLETED de cada proveedor del usuario.
    const latestPerProvider = await prisma.extractionJob.findMany({
      where: {
        userId: session.user.id,
        status: "COMPLETED",
        comparison: { isNot: null },
        ...(providerId ? { providerId } : {}),
      },
      orderBy: [{ providerId: "asc" }, { finishedAt: "desc" }],
      distinct: ["providerId"],
      select: { id: true, providerId: true, finishedAt: true },
    });
    latestJobIds = latestPerProvider.map((j) => j.id);
    providersCompared = latestPerProvider.length;
    lastUpdatedAt = latestPerProvider.reduce<Date | null>((max, j) => {
      if (!j.finishedAt) return max;
      return max == null || j.finishedAt > max ? j.finishedAt : max;
    }, null);
  } else {
    // Ventanas temporales — filtramos por job.finishedAt.
    const since = mode === "48h"
      ? new Date(Date.now() - 48 * 3600 * 1000)
      : mode === "7d"
        ? new Date(Date.now() - 7 * 24 * 3600 * 1000)
        : null; // "all"

    const providers = await prisma.extractionJob.groupBy({
      by: ["providerId"],
      where: {
        userId: session.user.id,
        status: "COMPLETED",
        comparison: { isNot: null },
        ...(since ? { finishedAt: { gte: since } } : {}),
        ...(providerId ? { providerId } : {}),
      },
    });
    providersCompared = providers.length;
    const maxJob = await prisma.extractionJob.findFirst({
      where: {
        userId: session.user.id,
        status: "COMPLETED",
        comparison: { isNot: null },
        ...(since ? { finishedAt: { gte: since } } : {}),
        ...(providerId ? { providerId } : {}),
      },
      orderBy: { finishedAt: "desc" },
      select: { finishedAt: true },
    });
    lastUpdatedAt = maxJob?.finishedAt ?? null;
  }

  // ─── Where común a count/list/counts-por-tipo ───────────────────────────
  const jobFilter: Prisma.ExtractionJobWhereInput = {
    userId: session.user.id,
    ...(providerId ? { providerId } : {}),
  };
  if (mode === "48h") {
    jobFilter.finishedAt = {
      gte: new Date(Date.now() - 48 * 3600 * 1000),
    };
  } else if (mode === "7d") {
    jobFilter.finishedAt = {
      gte: new Date(Date.now() - 7 * 24 * 3600 * 1000),
    };
  }

  const where: Prisma.ProductChangeWhereInput = {
    comparison:
      mode === "recent" && latestJobIds
        ? { jobId: { in: latestJobIds } }
        : { job: jobFilter },
    ...(changeTypes.length > 0 ? { changeType: { in: changeTypes } } : {}),
    ...(reviewStatusParam &&
    VALID_REVIEW_STATUSES.includes(reviewStatusParam as ChangeReviewStatus)
      ? { reviewStatus: reviewStatusParam as ChangeReviewStatus }
      : {}),
  };

  // `whereForCounts` = mismo where pero SIN el filtro changeType, para que
  // los KPIs muestren los totales por tipo dentro del modo/proveedor elegido.
  const whereForCounts: Prisma.ProductChangeWhereInput = {
    comparison:
      mode === "recent" && latestJobIds
        ? { jobId: { in: latestJobIds } }
        : { job: jobFilter },
    ...(reviewStatusParam &&
    VALID_REVIEW_STATUSES.includes(reviewStatusParam as ChangeReviewStatus)
      ? { reviewStatus: reviewStatusParam as ChangeReviewStatus }
      : {}),
  };

  const [total, changes, countsByType] = await Promise.all([
    prisma.productChange.count({ where }),
    prisma.productChange.findMany({
      where,
      orderBy: [
        { reviewStatus: "asc" }, // PENDING primero
        { comparison: { job: { finishedAt: "desc" } } },
      ],
      take: pageSize,
      skip: (page - 1) * pageSize,
      include: {
        comparison: {
          select: {
            jobId: true,
            previousJobId: true,
            job: {
              select: {
                providerId: true,
                finishedAt: true,
                provider: { select: { name: true } },
              },
            },
          },
        },
      },
    }),
    prisma.productChange.groupBy({
      by: ["changeType"],
      where: whereForCounts,
      _count: { _all: true },
    }),
  ]);

  const counts: Record<ProductChangeType, number> = {
    NEW: 0,
    REMOVED: 0,
    PRICE_UP: 0,
    PRICE_DOWN: 0,
    STOCK_CHANGED: 0,
  };
  for (const c of countsByType) counts[c.changeType] = c._count._all;

  // Enriquecer con datos de ExtractedProduct (imagen, categoría, etc.).
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
    reviewStatus: c.reviewStatus,
    reviewedAt: c.reviewedAt,
    createdAt: c.createdAt,
    providerId: c.comparison.job.providerId,
    providerName: c.comparison.job.provider.name,
    jobId: c.comparison.jobId,
    previousJobId: c.comparison.previousJobId,
    jobFinishedAt: c.comparison.job.finishedAt,
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
    mode,
    counts,
    providersCompared,
    lastUpdatedAt,
  });
}
