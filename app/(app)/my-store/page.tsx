import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import { Onboarding } from "@/components/my-store/onboarding";
import { MyStoreDashboard } from "@/components/my-store/my-store-dashboard";
import { MyStoreTabs } from "@/components/my-store/my-store-tabs";
import {
  resolvePricing,
  type PricingRuleForCalc,
} from "@/lib/pricing/pricing-engine";

export const metadata = {
  title: "Mi Tienda — PricEcom",
};

export const dynamic = "force-dynamic";

export default async function MyStorePage() {
  const session = await requireSession();

  const store = await prisma.store.findFirst({
    where: { userId: session.user.id },
    include: {
      integrations: { orderBy: { createdAt: "desc" }, take: 1 },
      _count: { select: { publications: true, categories: true } },
    },
  });

  if (!store) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Mi Tienda</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Sincronizá tu tienda, publicaciones, precios y stock desde un solo lugar.
          </p>
        </div>
        <Onboarding />
      </div>
    );
  }

  const [
    active,
    draft,
    paused,
    pubError,
    pendingSync,
    unmatchedCount,
    publications,
    rules,
    categories,
  ] = await Promise.all([
    prisma.productPublication.count({
      where: { storeId: store.id, status: "ACTIVE" },
    }),
    prisma.productPublication.count({
      where: { storeId: store.id, status: "DRAFT" },
    }),
    prisma.productPublication.count({
      where: { storeId: store.id, status: "PAUSED" },
    }),
    prisma.productPublication.count({
      where: { storeId: store.id, status: "ERROR" },
    }),
    prisma.productPublication.count({
      where: { storeId: store.id, pendingSync: true },
    }),
    prisma.unmatchedStoreProduct.count({
      where: { storeId: store.id, ignored: false },
    }),
    prisma.productPublication.findMany({
      where: { storeId: store.id },
      orderBy: { lastSyncedAt: "desc" },
      take: 200,
      include: {
        catalogProduct: {
          select: {
            id: true,
            publicationSku: true,
            commercialTitle: true,
            supplierName: true,
            imageUrl: true,
            finalPrice: true,
            stock: true,
            stockSource: true,
            wholesalePrice: true,
            manualMargin: true,
            assignedCategoryId: true,
            providerId: true,
          },
        },
      },
    }),
    prisma.pricingRule.findMany({
      where: { userId: session.user.id, isActive: true },
      select: {
        id: true,
        name: true,
        scope: true,
        scopeId: true,
        marginPercent: true,
        roundingMode: true,
        isActive: true,
        priority: true,
      },
    }),
    // Category interna (global) — la usamos en el modal de mapping de categorías.
    prisma.category.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);

  const rulesForCalc: PricingRuleForCalc[] = rules;

  const integration = store.integrations[0];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Mi Tienda</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Sincronizá tu tienda, publicaciones, precios y stock desde un solo lugar.
        </p>
      </div>

      <MyStoreDashboard
        store={{
          id: store.id,
          name: store.name,
          platform: store.platform,
          url: store.url,
          publicationsCount: store._count.publications,
          categoriesCount: store._count.categories,
        }}
        integration={
          integration
            ? {
                status: integration.status,
                lastConnectionCheck: integration.lastConnectionCheck
                  ? integration.lastConnectionCheck.toISOString()
                  : null,
                lastError: integration.lastError,
                hasCredentials: !!integration.consumerKeyEncrypted,
              }
            : null
        }
        kpis={{
          active,
          draft,
          paused,
          error: pubError,
          pendingSync,
          unmatched: unmatchedCount,
        }}
      />

      <MyStoreTabs
        publications={publications.map((p) => {
          const pricing = resolvePricing(
            {
              wholesalePrice: p.catalogProduct.wholesalePrice,
              manualMargin: p.catalogProduct.manualMargin,
              finalPrice: p.catalogProduct.finalPrice,
              assignedCategoryId: p.catalogProduct.assignedCategoryId,
              providerId: p.catalogProduct.providerId,
            },
            rulesForCalc
          );
          return {
            id: p.id,
            status: p.status,
            syncStatus: p.syncStatus,
            externalProductId: p.externalProductId,
            externalSku: p.externalSku,
            externalStatus: p.externalStatus,
            externalUrl: p.externalUrl,
            priceInStore: p.priceInStore,
            stockInStore: p.stockInStore,
            categoryInStore: p.categoryInStore,
            lastSyncedAt: p.lastSyncedAt ? p.lastSyncedAt.toISOString() : null,
            pendingSync: p.pendingSync,
            syncError: p.syncError,
            catalogProduct: {
              id: p.catalogProduct.id,
              publicationSku: p.catalogProduct.publicationSku,
              commercialTitle: p.catalogProduct.commercialTitle,
              supplierName: p.catalogProduct.supplierName,
              imageUrl: p.catalogProduct.imageUrl,
              finalPrice: p.catalogProduct.finalPrice,
              stock: p.catalogProduct.stock,
              stockSource: p.catalogProduct.stockSource,
              // pricing es interno del drawer; se calcula acá y se pasa al cliente.
              pricing: { effectivePrice: pricing.effectivePrice },
            },
          };
        })}
        unmatchedCount={unmatchedCount}
        categories={categories}
      />
    </div>
  );
}
