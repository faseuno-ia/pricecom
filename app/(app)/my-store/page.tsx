import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import { Onboarding } from "@/components/my-store/onboarding";
import { MyStoreDashboard } from "@/components/my-store/my-store-dashboard";
import { PublicationsTable } from "@/components/my-store/publications-table";

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
            Conectá tu ecommerce existente para sincronizar tu catálogo.
          </p>
        </div>
        <Onboarding />
      </div>
    );
  }

  // KPIs + publicaciones para la tabla
  const [
    active,
    draft,
    paused,
    pubError,
    pendingSync,
    publications,
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
          },
        },
      },
    }),
  ]);

  const integration = store.integrations[0];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Mi Tienda</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Estado de la sincronización con tu ecommerce.
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
          unmatched: 0,
        }}
      />

      <div>
        <h2 className="text-lg font-semibold tracking-tight mb-3">
          Publicaciones
        </h2>
        <PublicationsTable
          publications={publications.map((p) => ({
            id: p.id,
            status: p.status,
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
            catalogProduct: p.catalogProduct,
          }))}
        />
      </div>
    </div>
  );
}
