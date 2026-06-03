import { prisma } from "@/lib/db/client";
import { cn } from "@/lib/utils";
import { buildActiveUnmatchedWhere } from "@/lib/store/unmatched-where";
import {
  Store,
  Boxes,
  TrendingUp,
  CheckCircle2,
  ArrowRight,
  Activity,
  AlertCircle,
  AlertTriangle,
  Info,
  ShoppingBag,
  PlusCircle,
  MinusCircle,
  TrendingDown,
  Package,
} from "lucide-react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { es } from "date-fns/locale";
import { getWorkerStatus } from "@/lib/system/health";
import { requireSession } from "@/lib/auth";

// ─── Stats ────────────────────────────────────────────────────────────────────

async function getDashboardStats(userId: string) {
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const fortyEightHoursAgo = new Date(Date.now() - 48 * 3600 * 1000);

  // Primera ola: todo lo que no depende de otros resultados.
  const [
    activeProviders,
    totalProviders,
    activeCatalogProducts,
    activeWithoutCategory,
    activeWithoutImage,
    ownStockWithoutSupplier,
    failedJobs48h,
    activeJobs,
    lastJob,
    recentJobs,
    recentEvents,
    providers,
    latestPerProvider,
    store,
    extractionsThisMonth,
  ] = await Promise.all([
    prisma.provider.count({ where: { userId, isActive: true } }),
    prisma.provider.count({ where: { userId } }),

    // Catálogo activo: excluye ignorados y SUPPLIER_REMOVED que dependían del
    // proveedor (los OWN/HYBRID sobreviven).
    prisma.catalogProduct.count({
      where: {
        userId,
        NOT: [
          { internalStatus: "IGNORED" },
          {
            AND: [
              { supplierStatus: "SUPPLIER_REMOVED" },
              { stockSource: "SUPPLIER" },
            ],
          },
        ],
      },
    }),

    // Preparados sin categoría asignada (M2M vacío + assignedCategoryId null).
    prisma.catalogProduct.count({
      where: {
        userId,
        internalStatus: "PREPARED",
        assignedCategoryId: null,
        categories: { none: {} },
      },
    }),

    // Preparados sin imagen (campo imageUrl null/vacío Y CatalogProductImage vacío).
    prisma.catalogProduct.count({
      where: {
        userId,
        internalStatus: "PREPARED",
        OR: [{ imageUrl: null }, { imageUrl: "" }],
        images: { none: {} },
      },
    }),

    // Stock propio sin reposición del proveedor: productos OWN cuya fuente
    // original ya no figura en el catálogo del proveedor. Solo cuentan los que
    // están activos en la tienda (PREPARED o PUBLISHED): sin reposición no se
    // pueden mantener disponibles, hay que decidir qué hacer con ellos.
    prisma.catalogProduct.count({
      where: {
        userId,
        stockSource: "OWN",
        supplierStatus: "SUPPLIER_REMOVED",
        internalStatus: { in: ["PREPARED", "PUBLISHED"] },
      },
    }),

    prisma.extractionJob.count({
      where: {
        userId,
        status: "FAILED",
        createdAt: { gte: fortyEightHoursAgo },
      },
    }),

    prisma.extractionJob.count({
      where: { userId, status: { in: ["RUNNING", "PENDING"] } },
    }),

    prisma.extractionJob.findFirst({
      where: { userId, status: "COMPLETED" },
      orderBy: { finishedAt: "desc" },
      include: { provider: { select: { name: true } } },
    }),

    prisma.extractionJob.findMany({
      where: { userId },
      take: 5,
      orderBy: { createdAt: "desc" },
      include: {
        provider: { select: { name: true } },
        comparison: {
          select: {
            newProducts: true,
            removedProducts: true,
            priceUp: true,
            priceDown: true,
            stockChanged: true,
          },
        },
      },
    }),

    // Últimos eventos de cualquier source/entidad del usuario.
    prisma.eventLog.findMany({
      where: {
        OR: [
          { userId },
          { provider: { userId } },
          { store: { userId } },
          { product: { userId } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: {
        id: true,
        createdAt: true,
        severity: true,
        source: true,
        type: true,
        title: true,
        providerId: true,
        productId: true,
        publicationId: true,
        provider: { select: { name: true } },
        product: { select: { sku: true, publicationSku: true } },
      },
    }),

    prisma.provider.findMany({
      where: { userId, isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, baseUrl: true },
    }),

    // Última comparación COMPLETED por proveedor — misma lógica que /changes
    // modo "recent".
    prisma.extractionJob.findMany({
      where: {
        userId,
        status: "COMPLETED",
        comparison: { isNot: null },
      },
      orderBy: [{ providerId: "asc" }, { finishedAt: "desc" }],
      distinct: ["providerId"],
      select: {
        id: true,
        providerId: true,
        finishedAt: true,
        comparison: {
          select: {
            id: true,
            newProducts: true,
            removedProducts: true,
            priceUp: true,
            priceDown: true,
            stockChanged: true,
            previousJobId: true,
          },
        },
      },
    }),

    prisma.store.findFirst({
      where: { userId },
      include: {
        integrations: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { status: true, lastConnectionCheck: true, lastError: true },
        },
      },
    }),

    prisma.extractionJob.count({
      where: {
        userId,
        createdAt: { gte: startOfMonth },
        status: "COMPLETED",
      },
    }),
  ]);

  // Segunda ola: depende de latestPerProvider y store.
  const latestComparisonIds = latestPerProvider
    .map((j) => j.comparison?.id)
    .filter((x): x is string => !!x);

  const storeId = store?.id;

  const [criticalGroups, pendingGroups, storeKpis] = await Promise.all([
    latestComparisonIds.length > 0
      ? prisma.productChange.groupBy({
          by: ["comparisonId"],
          where: {
            comparisonId: { in: latestComparisonIds },
            changeType: { in: ["PRICE_UP", "PRICE_DOWN"] },
            reviewStatus: "PENDING",
            OR: [
              { priceChangePercent: { gte: 20 } },
              { priceChangePercent: { lte: -20 } },
            ],
          },
          _count: { _all: true },
        })
      : Promise.resolve([] as { comparisonId: string; _count: { _all: number } }[]),

    latestComparisonIds.length > 0
      ? prisma.productChange.groupBy({
          by: ["comparisonId"],
          where: {
            comparisonId: { in: latestComparisonIds },
            reviewStatus: "PENDING",
          },
          _count: { _all: true },
        })
      : Promise.resolve([] as { comparisonId: string; _count: { _all: number } }[]),

    storeId
      ? (async () => {
          const [active, draft, paused, errorPub, pendingSync, syncErrors, unmatched] =
            await Promise.all([
              prisma.productPublication.count({
                where: { storeId, status: "ACTIVE" },
              }),
              prisma.productPublication.count({
                where: { storeId, status: "DRAFT" },
              }),
              prisma.productPublication.count({
                where: { storeId, status: "PAUSED" },
              }),
              prisma.productPublication.count({
                where: { storeId, status: "ERROR" },
              }),
              prisma.productPublication.count({
                where: { storeId, pendingSync: true },
              }),
              prisma.productPublication.count({
                where: { storeId, syncStatus: "ERROR" },
              }),
              // ⚠ NO contar unmatched crudo por `resolved: false` acá. Usar
              // SIEMPRE buildActiveUnmatchedWhere (helper centralizado en
              // lib/store/unmatched-where.ts). Mismo bug que arreglamos en
              // my-store/page.tsx: contar crudo deja el dashboard divergido
              // del listado real ("63 sin vincular" en la tarjeta vs "1" en
              // la pestaña). Definición de "unmatched" vive en UN solo lugar.
              buildActiveUnmatchedWhere(prisma, storeId).then((where) =>
                prisma.unmatchedStoreProduct.count({ where })
              ),
            ]);
          return { active, draft, paused, errorPub, pendingSync, syncErrors, unmatched };
        })()
      : Promise.resolve(null),
  ]);

  const criticalByComparison = new Map<string, number>();
  for (const g of criticalGroups) {
    criticalByComparison.set(g.comparisonId, g._count._all);
  }
  const pendingByComparison = new Map<string, number>();
  for (const g of pendingGroups) {
    pendingByComparison.set(g.comparisonId, g._count._all);
  }

  // Mapeo providerId → datos resumidos para las cards de "Inteligencia de precios".
  const providerCards = latestPerProvider.map((j) => {
    const c = j.comparison;
    const compId = c?.id ?? null;
    const critical = compId ? criticalByComparison.get(compId) ?? 0 : 0;
    const pendingReview = compId ? pendingByComparison.get(compId) ?? 0 : 0;
    const provider = providers.find((p) => p.id === j.providerId);
    return {
      providerId: j.providerId,
      providerName: provider?.name ?? "—",
      providerBaseUrl: provider?.baseUrl ?? "",
      jobId: j.id,
      finishedAt: j.finishedAt,
      comparison: c,
      critical,
      pendingReview,
      hasComparison: !!(c && c.previousJobId),
    };
  });

  const totalCriticalPending = providerCards.reduce(
    (acc, p) => acc + p.critical,
    0
  );

  return {
    activeProviders,
    totalProviders,
    activeCatalogProducts,
    activeWithoutCategory,
    activeWithoutImage,
    ownStockWithoutSupplier,
    failedJobs48h,
    activeJobs,
    lastJob,
    recentJobs,
    recentEvents,
    providerCards,
    store,
    storeKpis,
    extractionsThisMonth,
    totalCriticalPending,
  };
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

type Severity = "critical" | "warning" | "info";

interface AttentionItem {
  id: string;
  label: string;
  count: number;
  severity: Severity;
  href: string;
  ctaLabel: string;
}

const severityDot: Record<Severity, string> = {
  critical: "bg-red-400",
  warning: "bg-amber-400",
  info: "bg-blue-400",
};

const severityBorder: Record<Severity, string> = {
  critical: "border-red-500/30",
  warning: "border-amber-500/30",
  info: "border-border",
};

function buildJobSummary(job: {
  status: string;
  comparison: {
    newProducts: number;
    removedProducts: number;
    priceUp: number;
    priceDown: number;
    stockChanged: number;
  } | null;
}): string {
  if (job.status === "FAILED") return "Falló";
  if (job.status === "RUNNING") return "En curso";
  if (job.status === "PENDING") return "En cola";
  if (job.status === "CANCELLED") return "Cancelado";
  const c = job.comparison;
  if (!c) return "Extracción completada";
  const parts: string[] = [];
  if (c.newProducts > 0) parts.push(`+${c.newProducts} nuevos`);
  if (c.removedProducts > 0) parts.push(`${c.removedProducts} removidos`);
  if (c.priceUp > 0) parts.push(`${c.priceUp} ↑`);
  if (c.priceDown > 0) parts.push(`${c.priceDown} ↓`);
  if (c.stockChanged > 0) parts.push(`${c.stockChanged} stock`);
  return parts.length > 0 ? parts.join(" · ") : "Sin cambios detectados";
}

export default async function DashboardPage() {
  const session = await requireSession();
  const [stats, worker] = await Promise.all([
    getDashboardStats(session.user.id),
    getWorkerStatus(session.user.id),
  ]);

  // ─── Atención requerida ───────────────────────────────────────────────────
  const allAttentionItems: AttentionItem[] = [
    {
      id: "critical_changes",
      label: "Cambios críticos sin revisar",
      count: stats.totalCriticalPending,
      severity: "critical",
      href: "/changes?reviewStatus=PENDING",
      ctaLabel: "Ver cambios",
    },
    {
      id: "failed_jobs",
      label: "Extracciones fallidas (48h)",
      count: stats.failedJobs48h,
      severity: "critical",
      href: "/extractions?status=FAILED",
      ctaLabel: "Ver extracciones",
    },
    {
      id: "pub_errors",
      label: "Publicaciones con error de sync",
      count: stats.storeKpis?.syncErrors ?? 0,
      severity: "critical",
      href: "/my-store",
      ctaLabel: "Revisar errores",
    },
    {
      id: "without_category",
      label: "Productos preparados sin categoría",
      count: stats.activeWithoutCategory,
      severity: "warning",
      href: "/catalog?internalStatus=PREPARED&noCategory=true",
      ctaLabel: "Ir al catálogo",
    },
    {
      id: "without_image",
      label: "Productos preparados sin imagen",
      count: stats.activeWithoutImage,
      severity: "warning",
      href: "/catalog?internalStatus=PREPARED&noImage=true",
      ctaLabel: "Ir al catálogo",
    },
    {
      id: "own_stock_no_supplier",
      label: "Stock propio sin stock del proveedor",
      count: stats.ownStockWithoutSupplier,
      severity: "warning",
      href: "/catalog?stockSource=OWN&supplierStatus=SUPPLIER_REMOVED",
      ctaLabel: "Ver productos",
    },
    {
      id: "unmatched",
      label: "Productos de tienda no vinculados",
      count: stats.storeKpis?.unmatched ?? 0,
      severity: "info",
      href: "/my-store",
      ctaLabel: "Ver tienda",
    },
    {
      id: "pending_sync",
      label: "Publicaciones desactualizadas",
      count: stats.storeKpis?.pendingSync ?? 0,
      severity: "info",
      href: "/my-store",
      ctaLabel: "Ir a Mi Tienda",
    },
  ];
  const attentionItems = allAttentionItems.filter((i) => i.count > 0);

  // ─── KPIs ejecutivos ──────────────────────────────────────────────────────
  const kpis: { label: string; value: string | number; href: string; icon: typeof Store }[] = [
    {
      label: "Proveedores activos",
      value: stats.activeProviders,
      href: "/providers",
      icon: Store,
    },
    {
      label: "Productos activos",
      value: stats.activeCatalogProducts.toLocaleString("es-AR"),
      href: "/catalog",
      icon: Boxes,
    },
    {
      label: "Cambios críticos sin revisar",
      value: stats.totalCriticalPending,
      href: "/changes?reviewStatus=PENDING",
      icon: TrendingUp,
    },
    {
      label: "Publicaciones activas",
      value: stats.storeKpis?.active ?? 0,
      href: "/my-store",
      icon: ShoppingBag,
    },
  ];

  // ─── Sistema ──────────────────────────────────────────────────────────────
  const systemStatus = stats.activeJobs > 0
    ? {
        label: "Jobs en proceso",
        dot: "bg-blue-400 animate-pulse",
        detail: `${stats.activeJobs} extracción${stats.activeJobs > 1 ? "es" : ""} en curso`,
      }
    : stats.failedJobs48h > 0
      ? {
          label: "Atención requerida",
          dot: "bg-red-400",
          detail: `${stats.failedJobs48h} extracción${stats.failedJobs48h > 1 ? "es" : ""} fallida${stats.failedJobs48h > 1 ? "s" : ""} en las últimas 48h`,
        }
      : {
          label: "Sistema operativo",
          dot: "bg-green-400",
          detail: stats.lastJob?.finishedAt
            ? `Última ejecución ${formatDistanceToNow(new Date(stats.lastJob.finishedAt), { locale: es, addSuffix: true })}`
            : "Sin extracciones recientes",
        };

  return (
    <div className="space-y-8">
      {/* ─── Header ────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Centro operativo</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Monitoreo comercial de tu catálogo, proveedores y ecommerce.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Link
            href="/new-extraction"
            className="text-xs bg-primary text-primary-foreground px-3 py-1.5 rounded-md hover:bg-primary/90 inline-flex items-center gap-1"
          >
            <PlusCircle className="w-3.5 h-3.5" /> Nueva extracción
          </Link>
          <Link
            href="/changes?reviewStatus=PENDING"
            className="text-xs border border-border px-3 py-1.5 rounded-md hover:bg-muted/40"
          >
            Revisar cambios
          </Link>
          <Link
            href="/catalog?internalStatus=PREPARED"
            className="text-xs border border-border px-3 py-1.5 rounded-md hover:bg-muted/40"
          >
            Catálogo
          </Link>
          <Link
            href="/my-store"
            className="text-xs border border-border px-3 py-1.5 rounded-md hover:bg-muted/40"
          >
            Mi Tienda
          </Link>
        </div>
      </div>

      {/* ─── Atención requerida ───────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-amber-400" />
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Atención requerida
          </h2>
        </div>
        {attentionItems.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-green-400 bg-green-500/10 border border-green-500/20 rounded-xl px-4 py-3">
            <CheckCircle2 className="w-4 h-4" />
            Todo en orden — no hay items que requieran atención
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {attentionItems.map((item) => (
              <div
                key={item.id}
                className={cn(
                  "bg-card border rounded-xl p-4 flex items-start justify-between gap-3",
                  severityBorder[item.severity]
                )}
              >
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "w-2 h-2 rounded-full flex-shrink-0",
                        severityDot[item.severity]
                      )}
                    />
                    <span className="text-2xl font-bold leading-none">
                      {item.count.toLocaleString("es-AR")}
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground">{item.label}</p>
                </div>
                <Link
                  href={item.href}
                  className="text-xs text-primary hover:underline whitespace-nowrap flex-shrink-0 mt-1 inline-flex items-center gap-0.5"
                >
                  {item.ctaLabel} <ArrowRight className="w-3 h-3" />
                </Link>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ─── KPIs ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        {kpis.map((card) => {
          const Icon = card.icon;
          return (
            <Link
              key={card.label}
              href={card.href}
              className="bg-card border border-border rounded-xl p-5 hover:border-primary/40 transition-colors group"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                    {card.label}
                  </p>
                  <p className="text-2xl font-semibold leading-none truncate">
                    {card.value}
                  </p>
                </div>
                <div className="w-9 h-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center flex-shrink-0 group-hover:bg-primary/20 transition-colors">
                  <Icon className="w-4 h-4" />
                </div>
              </div>
            </Link>
          );
        })}
      </div>

      {/* ─── Estado ecommerce ─────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Estado ecommerce
          </h2>
          {stats.store && (
            <Link href="/my-store" className="text-xs text-primary hover:underline">
              Ir a Mi Tienda →
            </Link>
          )}
        </div>
        {!stats.store ? (
          <div className="bg-card border border-border rounded-xl p-6 flex items-center justify-between gap-4 flex-wrap">
            <div className="space-y-1">
              <p className="font-medium">Sin tienda conectada</p>
              <p className="text-sm text-muted-foreground">
                Conectá tu WooCommerce para sincronizar publicaciones y precios.
              </p>
            </div>
            <Link
              href="/my-store"
              className="text-sm bg-primary text-primary-foreground px-4 py-2 rounded-lg hover:bg-primary/90 inline-flex items-center gap-1.5"
            >
              Conectar tienda <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        ) : (
          <div className="bg-card border border-border rounded-xl p-5 space-y-4">
            <div className="flex items-center gap-3 flex-wrap">
              <span
                className={cn(
                  "w-2 h-2 rounded-full",
                  stats.store.integrations[0]?.status === "CONNECTED"
                    ? "bg-green-400"
                    : stats.store.integrations[0]?.status === "ERROR"
                      ? "bg-red-400"
                      : "bg-amber-400"
                )}
              />
              <span className="font-medium">{stats.store.name}</span>
              <span className="text-xs text-muted-foreground">
                {hostnameOf(stats.store.url)}
              </span>
              {stats.store.integrations[0]?.lastConnectionCheck && (
                <span className="text-[11px] text-muted-foreground/70 ml-auto">
                  Verificado{" "}
                  {formatDistanceToNow(
                    new Date(stats.store.integrations[0].lastConnectionCheck),
                    { locale: es, addSuffix: true }
                  )}
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { label: "Publicadas", value: stats.storeKpis?.active ?? 0, cls: "" },
                {
                  label: "Desactualizadas",
                  value: stats.storeKpis?.pendingSync ?? 0,
                  cls: (stats.storeKpis?.pendingSync ?? 0) > 0 ? "text-violet-400" : "",
                },
                {
                  label: "Errores",
                  value: stats.storeKpis?.syncErrors ?? 0,
                  cls: (stats.storeKpis?.syncErrors ?? 0) > 0 ? "text-red-400" : "",
                },
                {
                  label: "No vinculados",
                  value: stats.storeKpis?.unmatched ?? 0,
                  cls: (stats.storeKpis?.unmatched ?? 0) > 0 ? "text-blue-400" : "",
                },
              ].map((k) => (
                <div key={k.label} className="space-y-0.5">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    {k.label}
                  </p>
                  <p className={cn("text-xl font-semibold", k.cls)}>
                    {k.value.toLocaleString("es-AR")}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* ─── Inteligencia de precios ──────────────────────────────────── */}
      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Inteligencia de precios
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Última comparación por proveedor — los conteos reflejan cambios pendientes de revisión.
          </p>
        </div>

        {stats.providerCards.length === 0 ? (
          <div className="bg-card border border-border rounded-xl py-12 text-center text-sm text-muted-foreground">
            Sin extracciones completadas todavía.{" "}
            <Link href="/new-extraction" className="text-primary hover:underline">
              Iniciar primera extracción →
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {stats.providerCards.map((p) => {
              const borderCls =
                p.critical >= 10
                  ? "border-red-500/40"
                  : p.critical >= 5
                    ? "border-amber-500/40"
                    : "border-border";
              const c = p.comparison;
              const metrics: {
                icon: typeof PlusCircle;
                label: string;
                value: number;
                color: string;
              }[] = [
                { icon: PlusCircle, label: "Nuevos", value: c?.newProducts ?? 0, color: "text-green-400" },
                { icon: TrendingUp, label: "Precio ↑", value: c?.priceUp ?? 0, color: "text-orange-400" },
                { icon: TrendingDown, label: "Precio ↓", value: c?.priceDown ?? 0, color: "text-emerald-400" },
                { icon: Package, label: "Stock", value: c?.stockChanged ?? 0, color: "text-blue-400" },
                { icon: MinusCircle, label: "Removidos", value: c?.removedProducts ?? 0, color: "text-red-400" },
              ];
              return (
                <div
                  key={p.providerId}
                  className={cn(
                    "bg-card border rounded-xl p-5 flex flex-col gap-4 hover:border-primary/30 transition-colors",
                    borderCls
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold text-sm truncate">{p.providerName}</p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        {p.finishedAt
                          ? `Última extracción ${formatDistanceToNow(new Date(p.finishedAt), { locale: es, addSuffix: true })}`
                          : "Sin extracción"}
                      </p>
                    </div>
                  </div>

                  {p.hasComparison ? (
                    <>
                      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                        {metrics.map((m) => {
                          const Icon = m.icon;
                          return (
                            <div key={m.label} className="flex items-center gap-2">
                              <Icon className={`w-3.5 h-3.5 ${m.color}`} />
                              <span className="text-xs">
                                <span className={`font-semibold ${m.color}`}>
                                  {m.value}
                                </span>{" "}
                                <span className="text-muted-foreground">
                                  {m.label}
                                </span>
                              </span>
                            </div>
                          );
                        })}
                      </div>

                      <div className="border-t border-border pt-3 space-y-1 text-xs">
                        {p.critical > 0 && (
                          <p className="text-red-400 inline-flex items-center gap-1.5">
                            <AlertTriangle className="w-3 h-3" />
                            <span className="font-semibold">{p.critical}</span>{" "}
                            cambio{p.critical === 1 ? "" : "s"} crítico
                            {p.critical === 1 ? "" : "s"}
                          </p>
                        )}
                        {p.pendingReview > 0 && (
                          <p className="text-muted-foreground inline-flex items-center gap-1.5">
                            <Info className="w-3 h-3" />
                            <span className="font-semibold text-foreground">
                              {p.pendingReview}
                            </span>{" "}
                            pendiente{p.pendingReview === 1 ? "" : "s"} de revisión
                          </p>
                        )}
                        {p.critical === 0 && p.pendingReview === 0 && (
                          <p className="text-green-400 inline-flex items-center gap-1.5">
                            <CheckCircle2 className="w-3 h-3" />
                            Todo revisado
                          </p>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="bg-muted/20 border border-border rounded-lg p-3 text-center">
                      <p className="text-xs text-muted-foreground">
                        Sin comparaciones disponibles aún
                      </p>
                      <p className="text-[10px] text-muted-foreground/60 mt-0.5">
                        La próxima extracción generará la primera comparación
                      </p>
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-1.5 pt-1">
                    <Link
                      href={`/changes?providerId=${p.providerId}&reviewStatus=PENDING`}
                      className="text-[11px] border border-border px-2.5 py-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
                    >
                      Ver cambios
                    </Link>
                    <Link
                      href={`/catalog?providerId=${p.providerId}`}
                      className="text-[11px] border border-border px-2.5 py-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
                    >
                      Ver productos
                    </Link>
                    <Link
                      href={`/providers/${p.providerId}`}
                      className="text-[11px] text-primary hover:underline ml-auto"
                    >
                      Historial →
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ─── Actividad reciente + Sistema ─────────────────────────────── */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 bg-card border border-border rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3 border-b border-border">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Actividad reciente
            </h3>
            <Link href="/activity" className="text-[11px] text-primary hover:underline">
              Ver todas
            </Link>
          </div>
          {stats.recentEvents.length === 0 ? (
            <div className="px-5 py-6 text-center text-xs text-muted-foreground">
              Sin eventos registrados todavía
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {stats.recentEvents.map((e) => {
                const dot =
                  e.severity === "CRITICAL"
                    ? "bg-red-500"
                    : e.severity === "ERROR"
                      ? "bg-red-400"
                      : e.severity === "WARNING"
                        ? "bg-amber-400"
                        : "bg-blue-400";
                const sku =
                  e.product?.publicationSku ?? e.product?.sku ?? null;
                const productHref = sku
                  ? `/catalog?search=${encodeURIComponent(sku)}`
                  : null;
                const providerHref = e.providerId
                  ? `/providers/${e.providerId}`
                  : null;
                const contextHref =
                  productHref ?? providerHref ?? "/activity";
                return (
                  <li key={e.id}>
                    <Link
                      href={contextHref}
                      className="flex items-start justify-between gap-3 px-5 py-3 hover:bg-muted/20 transition-colors"
                    >
                      <div className="flex items-start gap-2.5 min-w-0">
                        <span
                          className={cn(
                            "w-1.5 h-1.5 rounded-full flex-shrink-0 mt-1.5",
                            dot
                          )}
                        />
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">
                            {e.title}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {e.source}
                            {e.provider?.name ? ` · ${e.provider.name}` : ""}
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
          )}
        </div>

        <div className="bg-card border border-border rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2">
            <Activity
              className={cn(
                "w-4 h-4",
                worker.status === "active" && "text-accent",
                worker.status === "stalled" && "text-red-400",
                worker.status === "idle" && "text-muted-foreground"
              )}
            />
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Sistema
            </h3>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <span className={cn("w-2 h-2 rounded-full", systemStatus.dot)} />
              <p className="text-sm font-semibold">{systemStatus.label}</p>
            </div>
            <p className="text-xs text-muted-foreground">{systemStatus.detail}</p>
          </div>
          <div className="pt-2 border-t border-border text-[11px] text-muted-foreground space-y-1">
            <p>
              Worker:{" "}
              <span className="text-foreground">
                {worker.status === "active"
                  ? "activo"
                  : worker.status === "idle"
                    ? "en espera"
                    : "sin respuesta"}
              </span>
            </p>
            <p>
              Extracciones este mes:{" "}
              <span className="text-foreground font-mono">
                {stats.extractionsThisMonth}
              </span>
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
