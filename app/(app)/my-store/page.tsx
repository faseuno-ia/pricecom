import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import { Onboarding } from "@/components/my-store/onboarding";
import { MyStoreDashboard } from "@/components/my-store/my-store-dashboard";
import { MyStoreTabs } from "@/components/my-store/my-store-tabs";

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

  // KPIs alineados a deriveVisualStatus:
  //   - Publicados: pub ACTIVE
  //   - Pausados: pub PAUSED + proveedor activo (la pausa por SUPPLIER_REMOVED
  //     entra en Sin stock).
  //   - Sin stock: catalogProduct.supplierStatus = SUPPLIER_REMOVED.
  //   - Errores: pub ERROR
  //   - Desactualizadas: syncStatus OUTDATED. (Reemplaza el viejo "pendientes"
  //     que mezclaba PENDING_SYNC y OUTDATED.)
  const [active, sinStock, paused, pubError, pendingSync, unmatchedCount, categories] =
    await Promise.all([
      prisma.productPublication.count({
        where: { storeId: store.id, status: "ACTIVE" },
      }),
      prisma.productPublication.count({
        where: {
          storeId: store.id,
          catalogProduct: { is: { supplierStatus: "SUPPLIER_REMOVED" } },
        },
      }),
      prisma.productPublication.count({
        where: {
          storeId: store.id,
          status: "PAUSED",
          catalogProduct: {
            is: { supplierStatus: { not: "SUPPLIER_REMOVED" } },
          },
        },
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
      prisma.category.findMany({
        orderBy: { name: "asc" },
        select: { id: true, name: true },
      }),
    ]);

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
          sinStock,
          paused,
          error: pubError,
          pendingSync,
          unmatched: unmatchedCount,
        }}
      />

      <MyStoreTabs
        publicationsTotal={store._count.publications}
        unmatchedCount={unmatchedCount}
        categories={categories}
        categoriesTotal={store._count.categories}
      />
    </div>
  );
}
