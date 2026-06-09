import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import { Onboarding } from "@/components/my-store/onboarding";
import { MyStoreDashboard } from "@/components/my-store/my-store-dashboard";
import { MyStoreTabs } from "@/components/my-store/my-store-tabs";
import { buildActiveUnmatchedWhere } from "@/lib/store/unmatched-where";
import { visualStatusToWhere } from "@/lib/catalog/list-filters";
import { SYNC_ERRORS_WHERE } from "@/lib/store/sync-buckets";

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
  // De INTENCIÓN del usuario (reusan visualStatusToWhere de Catálogo — UNA sola
  // fuente de verdad para la jerarquía visual:
  //   OUTDATED > SIN_STOCK > PAUSED > PUBLISHED > PREPARED > NOT_PUBLISHED > IGNORED).
  // Esto garantiza que un cp con estado contradictorio (ej. PREPARED + SUPPLIER_REMOVED)
  // se cuente UNA sola vez, en el balde de mayor prioridad (SIN_STOCK), y que el KPI
  // de Mi Tienda y el filtro del Catálogo muestren los mismos números.
  //   - Publicados:  visualStatusToWhere("PUBLISHED")  (excluye OUTDATED/SR)
  //   - Pausados:    visualStatusToWhere("PAUSED") + pausedBySystem=false   ← refuerzo:
  //                  el KPI exige pausa MANUAL (no la auto-pausa del worker). hoy no
  //                  cambia el conteo (todos los auto-pausados tienen SR), pero
  //                  protege la semántica si aparece un caso futuro.
  //   - Ignorados:   visualStatusToWhere("IGNORED")    (sin filtro extra; IGNORED
  //                  es prioridad más baja por diseño)
  //   - Preparados:  visualStatusToWhere("PREPARED")   (excluye SR)
  // OPERATIVOS (dimensión distinta, NO de intención):
  //   - Sin stock:        visualStatusToWhere("SIN_STOCK") — SUPPLIER_REMOVED +
  //                       stockSource=SUPPLIER (los OWN/HYBRID removidos NO son
  //                       "sin stock": sobreviven en su balde de intención).
  //   - Pendientes sync:  pp.pendingSync = true.
  //   - Errores:          syncStatus IN (ERROR, ERROR_SKU_CONFLICT) — SYNC_ERRORS_WHERE.
  // Universo de los KPIs de intención: pp en esta store. Los NOT_PUBLISHED sin pp
  // no entran a Mi Tienda.
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
          catalogProduct: { is: visualStatusToWhere("PUBLISHED") },
        },
      }),
      prisma.productPublication.count({
        where: {
          storeId: store.id,
          catalogProduct: { is: visualStatusToWhere("SIN_STOCK") },
        },
      }),
      prisma.productPublication.count({
        where: {
          storeId: store.id,
          catalogProduct: {
            is: { ...visualStatusToWhere("PAUSED"), pausedBySystem: false },
          },
        },
      }),
      prisma.productPublication.count({
        where: {
          storeId: store.id,
          catalogProduct: { is: visualStatusToWhere("IGNORED") },
        },
      }),
      prisma.productPublication.count({
        where: {
          storeId: store.id,
          catalogProduct: { is: visualStatusToWhere("PREPARED") },
        },
      }),
      prisma.productPublication.count({
        where: { storeId: store.id, ...SYNC_ERRORS_WHERE },
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
