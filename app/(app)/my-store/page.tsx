import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import { Onboarding } from "@/components/my-store/onboarding";
import { MyStoreDashboard } from "@/components/my-store/my-store-dashboard";
import { MyStoreTabs } from "@/components/my-store/my-store-tabs";
import { buildActiveUnmatchedWhere } from "@/lib/store/unmatched-where";

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

  // KPIs.
  // De INTENCIÓN del usuario (cuentan por cp.internalStatus, no por pp.status):
  //   - Publicados:  cp.internalStatus = PUBLISHED
  //   - Pausados:    cp.internalStatus = PAUSED + pausedBySystem=false (pausa manual real;
  //                  los auto-pausados por SUPPLIER_REMOVED entran en "Sin stock").
  //   - Ignorados:   cp.internalStatus = IGNORED (decisión comercial duradera; ocultos por
  //                  default en la tabla con toggle).
  //   - Preparados:  cp.internalStatus = PREPARED (listos para republicar; existen en Woo
  //                  como private/draft según el diag pre-fix).
  // OPERATIVOS (siguen contando por sus campos actuales, dimensión distinta):
  //   - Sin stock:        cp.supplierStatus = SUPPLIER_REMOVED.
  //   - Pendientes sync:  pp.pendingSync = true.
  //   - Errores:          pp.status = ERROR.
  // Universo de los KPIs de intención: pp en esta store (cps con publicación). Los
  // NOT_PUBLISHED sin pp no entran a Mi Tienda.
  const [
    active,
    sinStock,
    paused,
    ignored,
    prepared,
    pubError,
    pendingSync,
    unmatchedCount,
    categories,
  ] = await Promise.all([
      prisma.productPublication.count({
        where: {
          storeId: store.id,
          catalogProduct: { is: { internalStatus: "PUBLISHED" } },
        },
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
          catalogProduct: {
            is: { internalStatus: "PAUSED", pausedBySystem: false },
          },
        },
      }),
      prisma.productPublication.count({
        where: {
          storeId: store.id,
          catalogProduct: { is: { internalStatus: "IGNORED" } },
        },
      }),
      prisma.productPublication.count({
        where: {
          storeId: store.id,
          catalogProduct: { is: { internalStatus: "PREPARED" } },
        },
      }),
      prisma.productPublication.count({
        where: { storeId: store.id, status: "ERROR" },
      }),
      prisma.productPublication.count({
        where: { storeId: store.id, pendingSync: true },
      }),
      // ⚠ NO contar unmatched crudo por `resolved: false` acá. Usar el
      // helper buildActiveUnmatchedWhere SIEMPRE. Duplicar el filtro
      // causó el bug del contador 63 vs lista 1: el endpoint de la
      // pestaña usaba un filtro (cruzando ProductPublication.externalProductId)
      // y este count contaba crudo → divergieron. La lógica vive en UN
      // solo lugar: lib/store/unmatched-where.ts. Cualquier cambio de
      // definición de "unmatched" se hace ahí.
      buildActiveUnmatchedWhere(prisma, store.id).then((where) =>
        prisma.unmatchedStoreProduct.count({ where })
      ),
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
          ignored,
          prepared,
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
