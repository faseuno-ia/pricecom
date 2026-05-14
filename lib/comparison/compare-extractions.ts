// Import relativo (no "@/...") porque este módulo lo consume tanto Next.js como
// el worker corrido con tsx; el alias @ no siempre resuelve en el contexto del worker.
import { PrismaClient, ProductChangeType } from "@prisma/client";
import { prisma as defaultPrisma } from "../db/client";
import { createHash } from "crypto";

// Producto normalizado: wholesalePrice convertido de Prisma.Decimal a number
// para poder comparar y persistir como Float sin fricción de tipos.
interface NormalizedProduct {
  sku: string | null;
  productUrl: string | null;
  name: string;
  brand: string | null;
  wholesalePrice: number | null;
  stock: string | null;
}

function normalize(p: {
  sku: string | null;
  productUrl: string | null;
  name: string;
  brand: string | null;
  wholesalePrice: unknown;
  stock: string | null;
}): NormalizedProduct {
  return {
    sku: p.sku,
    productUrl: p.productUrl,
    name: p.name,
    brand: p.brand,
    wholesalePrice: p.wholesalePrice != null ? Number(p.wholesalePrice) : null,
    stock: p.stock,
  };
}

// Clave de identidad: sku → productUrl → hash(name+brand). Cada producto tiene
// exactamente una clave, calculada una sola vez al construir los Maps.
function productIdentityKey(p: NormalizedProduct): string {
  if (p.sku?.trim()) return `sku:${p.sku.trim()}`;
  if (p.productUrl?.trim()) return `url:${p.productUrl.trim()}`;
  const hash = createHash("sha256")
    .update((p.name + (p.brand ?? "")).toLowerCase().trim())
    .digest("hex")
    .slice(0, 16);
  return `hash:${hash}`;
}

interface ChangeRecord {
  sku?: string | null;
  productUrl?: string | null;
  nameHash?: string | null;
  name: string;
  changeType: ProductChangeType;
  previousPrice?: number | null;
  currentPrice?: number | null;
  priceChangePercent?: number | null;
  previousStock?: string | null;
  currentStock?: string | null;
}

export async function compareWithPreviousExtraction(
  jobId: string,
  prismaClient: PrismaClient = defaultPrisma
): Promise<void> {
  const currentJob = await prismaClient.extractionJob.findUnique({
    where: { id: jobId },
    include: { products: true },
  });
  if (!currentJob) return;

  const previousJob = await prismaClient.extractionJob.findFirst({
    where: {
      providerId: currentJob.providerId,
      status: "COMPLETED",
      id: { not: jobId },
      createdAt: { lt: currentJob.createdAt },
    },
    orderBy: { createdAt: "desc" },
    include: { products: true },
  });

  // Primera extracción del proveedor: no hay base de comparación.
  if (!previousJob) {
    await prismaClient.extractionComparison.create({
      data: {
        jobId,
        previousJobId: null,
        newProducts: currentJob.products.length,
        removedProducts: 0,
        priceUp: 0,
        priceDown: 0,
        stockChanged: 0,
        unchanged: 0,
      },
    });
    return;
  }

  const currentByKey = new Map<string, NormalizedProduct>();
  for (const p of currentJob.products) {
    const n = normalize(p);
    currentByKey.set(productIdentityKey(n), n);
  }
  const previousByKey = new Map<string, NormalizedProduct>();
  for (const p of previousJob.products) {
    const n = normalize(p);
    previousByKey.set(productIdentityKey(n), n);
  }

  const changes: ChangeRecord[] = [];
  let newProducts = 0;
  let removedProducts = 0;
  let priceUp = 0;
  let priceDown = 0;
  let stockChanged = 0;

  for (const [key, current] of currentByKey) {
    const previous = previousByKey.get(key);
    const nameHash = key.startsWith("hash:") ? key.slice(5) : null;

    if (!previous) {
      newProducts++;
      changes.push({
        sku: current.sku,
        productUrl: current.productUrl,
        nameHash,
        name: current.name,
        changeType: ProductChangeType.NEW,
        currentPrice: current.wholesalePrice,
      });
      continue;
    }

    // Precio y stock se evalúan de forma independiente: un producto puede
    // tener ambos cambios y genera un ProductChange separado por cada uno.
    if (
      current.wholesalePrice != null &&
      previous.wholesalePrice != null &&
      current.wholesalePrice !== previous.wholesalePrice
    ) {
      const percent =
        ((current.wholesalePrice - previous.wholesalePrice) / previous.wholesalePrice) * 100;
      if (current.wholesalePrice > previous.wholesalePrice) {
        priceUp++;
        changes.push({
          sku: current.sku,
          productUrl: current.productUrl,
          nameHash,
          name: current.name,
          changeType: ProductChangeType.PRICE_UP,
          previousPrice: previous.wholesalePrice,
          currentPrice: current.wholesalePrice,
          priceChangePercent: Math.round(percent * 100) / 100,
        });
      } else {
        priceDown++;
        changes.push({
          sku: current.sku,
          productUrl: current.productUrl,
          nameHash,
          name: current.name,
          changeType: ProductChangeType.PRICE_DOWN,
          previousPrice: previous.wholesalePrice,
          currentPrice: current.wholesalePrice,
          priceChangePercent: Math.round(percent * 100) / 100,
        });
      }
    }

    if (current.stock !== previous.stock) {
      stockChanged++;
      changes.push({
        sku: current.sku,
        productUrl: current.productUrl,
        nameHash,
        name: current.name,
        changeType: ProductChangeType.STOCK_CHANGED,
        previousStock: previous.stock,
        currentStock: current.stock,
      });
    }
  }

  // Productos presentes en la extracción anterior pero ausentes en la actual.
  for (const [key, previous] of previousByKey) {
    if (currentByKey.has(key)) continue;
    const nameHash = key.startsWith("hash:") ? key.slice(5) : null;
    removedProducts++;
    changes.push({
      sku: previous.sku,
      productUrl: previous.productUrl,
      nameHash,
      name: previous.name,
      changeType: ProductChangeType.REMOVED,
      previousPrice: previous.wholesalePrice,
    });
  }

  // unchanged = total actual menos los que generaron algún cambio. Se deriva
  // así (en vez de contar) para no doble-contar productos con cambio de precio
  // Y stock simultáneo. No se persisten registros "unchanged".
  const unchanged =
    currentJob.products.length - newProducts - priceUp - priceDown - stockChanged;

  const comparison = await prismaClient.extractionComparison.create({
    data: {
      jobId,
      previousJobId: previousJob.id,
      newProducts,
      removedProducts,
      priceUp,
      priceDown,
      stockChanged,
      unchanged: Math.max(0, unchanged),
    },
  });

  if (changes.length > 0) {
    await prismaClient.productChange.createMany({
      data: changes.map((c) => ({ ...c, comparisonId: comparison.id })),
    });
  }
}
