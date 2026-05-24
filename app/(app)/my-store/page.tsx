import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import { Onboarding } from "@/components/my-store/onboarding";
import { MyStoreDashboard } from "@/components/my-store/my-store-dashboard";
import { MyStoreTabs } from "@/components/my-store/my-store-tabs";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { es } from "date-fns/locale";
import { Activity, Info, AlertTriangle, XCircle, Zap } from "lucide-react";
import type { EventSeverity } from "@prisma/client";

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
  const [
    active,
    sinStock,
    paused,
    pubError,
    pendingSync,
    unmatchedCount,
    categories,
    storeEvents,
  ] = await Promise.all([
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
      prisma.eventLog.findMany({
        where: {
          storeId: store.id,
          source: { in: ["SYNC", "WOOCOMMERCE", "SYSTEM"] },
        },
        orderBy: { createdAt: "desc" },
        take: 8,
        select: {
          id: true,
          createdAt: true,
          severity: true,
          type: true,
          title: true,
          productId: true,
          product: { select: { sku: true, publicationSku: true } },
        },
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

      <RecentEcommerceActivity events={storeEvents} />

      <MyStoreTabs
        publicationsTotal={store._count.publications}
        unmatchedCount={unmatchedCount}
        categories={categories}
        categoriesTotal={store._count.categories}
      />
    </div>
  );
}

const severityIcon: Record<EventSeverity, typeof Info> = {
  INFO: Info,
  WARNING: AlertTriangle,
  ERROR: XCircle,
  CRITICAL: Zap,
};

const severityIconCls: Record<EventSeverity, string> = {
  INFO: "text-blue-400",
  WARNING: "text-amber-400",
  ERROR: "text-red-400",
  CRITICAL: "text-red-500",
};

function RecentEcommerceActivity({
  events,
}: {
  events: Array<{
    id: string;
    createdAt: Date;
    severity: EventSeverity;
    type: string;
    title: string;
    productId: string | null;
    product: { sku: string | null; publicationSku: string | null } | null;
  }>;
}) {
  if (events.length === 0) return null;
  return (
    <section className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <Activity className="w-3.5 h-3.5 text-muted-foreground" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Actividad ecommerce reciente
          </h3>
        </div>
        <Link
          href="/activity?source=SYNC"
          className="text-[11px] text-primary hover:underline"
        >
          Ver toda la actividad
        </Link>
      </div>
      <ul className="divide-y divide-border">
        {events.map((e) => {
          const Icon = severityIcon[e.severity];
          const sku = e.product?.publicationSku ?? e.product?.sku ?? null;
          const href = sku
            ? `/catalog?search=${encodeURIComponent(sku)}`
            : "/activity";
          return (
            <li key={e.id}>
              <Link
                href={href}
                className="flex items-start justify-between gap-3 px-5 py-3 hover:bg-muted/20 transition-colors"
              >
                <div className="flex items-start gap-2.5 min-w-0">
                  <Icon
                    className={`w-3.5 h-3.5 mt-0.5 flex-shrink-0 ${severityIconCls[e.severity]}`}
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{e.title}</p>
                    <p className="text-[10px] font-mono text-muted-foreground/60">
                      {e.type}
                    </p>
                  </div>
                </div>
                <span className="text-[10px] text-muted-foreground/70 whitespace-nowrap mt-0.5">
                  {formatDistanceToNow(e.createdAt, {
                    locale: es,
                    addSuffix: true,
                  })}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
