import { prisma } from "@/lib/db/client";
import { formatDate, cn } from "@/lib/utils";
import {
  Store,
  Package,
  Calendar,
  Clock,
  ArrowRight,
  Activity,
  ImageOff,
  FolderX,
  XCircle,
  CheckCircle2,
  Lock,
} from "lucide-react";
import Link from "next/link";
import { StatusBadge } from "@/components/ui/status-badge";
import { getWorkerStatus } from "@/lib/system/health";
import { requireSession } from "@/lib/auth";

async function getDashboardStats(userId: string) {
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const [
    activeProviders,
    totalProviders,
    totalProducts,
    extractionsThisMonth,
    lastJob,
    recentJobs,
    providers,
    productsSinImagen,
    productsSinCategoria,
    extraccionesFallidas,
  ] = await Promise.all([
    prisma.provider.count({ where: { userId, isActive: true } }),
    prisma.provider.count({ where: { userId } }),
    prisma.extractedProduct.count({ where: { job: { userId } } }),
    prisma.extractionJob.count({
      where: { userId, createdAt: { gte: startOfMonth }, status: "COMPLETED" },
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
      include: { provider: { select: { name: true } } },
    }),
    // Última extracción completada de cada proveedor activo, con su comparación.
    prisma.provider.findMany({
      where: { userId, isActive: true },
      orderBy: { name: "asc" },
      include: {
        extractionJobs: {
          where: { status: "COMPLETED" },
          orderBy: { createdAt: "desc" },
          take: 1,
          include: {
            comparison: {
              select: {
                newProducts: true,
                removedProducts: true,
                priceUp: true,
                priceDown: true,
                stockChanged: true,
                previousJobId: true,
                createdAt: true,
              },
            },
          },
        },
      },
    }),
    // Acciones pendientes
    prisma.extractedProduct.count({
      where: { job: { userId }, OR: [{ imageUrl: null }, { imageUrl: "" }] },
    }),
    prisma.extractedProduct.count({
      where: { job: { userId }, OR: [{ category: null }, { category: "" }] },
    }),
    prisma.extractionJob.count({ where: { userId, status: "FAILED" } }),
  ]);

  return {
    activeProviders,
    totalProviders,
    totalProducts,
    extractionsThisMonth,
    lastJob,
    recentJobs,
    providers,
    productsSinImagen,
    productsSinCategoria,
    extraccionesFallidas,
  };
}

function formatDuration(start: Date | null, end: Date | null): string {
  if (!start) return "—";
  const e = end ?? new Date();
  const sec = Math.round((e.getTime() - start.getTime()) / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem === 0 ? `${min}m` : `${min}m ${rem}s`;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export default async function DashboardPage() {
  const session = await requireSession();
  const [stats, worker] = await Promise.all([
    getDashboardStats(session.user.id),
    getWorkerStatus(session.user.id),
  ]);

  const cards = [
    {
      label: "Proveedores activos",
      value: stats.activeProviders,
      sub: `${stats.totalProviders} en total`,
      icon: Store,
      tone: "primary" as const,
    },
    {
      label: "Productos extraídos",
      value: stats.totalProducts.toLocaleString("es-AR"),
      sub: "Histórico",
      icon: Package,
      tone: "accent" as const,
    },
    {
      label: "Extracciones este mes",
      value: stats.extractionsThisMonth,
      sub: "Completadas",
      icon: Calendar,
      tone: "primary" as const,
    },
    {
      label: "Última extracción",
      value: stats.lastJob ? stats.lastJob.provider.name : "—",
      sub: stats.lastJob ? formatDate(stats.lastJob.finishedAt) : "Sin datos",
      icon: Clock,
      tone: "primary" as const,
    },
  ];

  // Proveedores con al menos una extracción completada (los que no tienen, se omiten).
  const providerCards = stats.providers
    .map((p) => ({ provider: p, job: p.extractionJobs[0] }))
    .filter((x) => x.job != null);

  // Acciones pendientes (solo las que tienen valor > 0)
  const pendingActions: {
    key: string;
    label: string;
    count: number;
    icon: typeof ImageOff;
    tone: string;
    href: string;
    cta: string;
  }[] = [
    {
      key: "sin-imagen",
      label: "productos sin imagen",
      count: stats.productsSinImagen,
      icon: ImageOff,
      tone: "text-amber-400",
      href: "/extractions",
      cta: "Revisar",
    },
    {
      key: "sin-categoria",
      label: "productos sin categoría",
      count: stats.productsSinCategoria,
      icon: FolderX,
      tone: "text-amber-400",
      href: "/extractions",
      cta: "Revisar",
    },
    {
      key: "fallidas",
      label: "extracciones fallidas",
      count: stats.extraccionesFallidas,
      icon: XCircle,
      tone: "text-red-400",
      href: "/extractions?status=FAILED",
      cta: "Ver",
    },
  ].filter((a) => a.count > 0);

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Centro operativo</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Monitoreo de precios y cambios en tiempo real
          </p>
        </div>
        <Link
          href="/new-extraction"
          className="flex items-center gap-2 bg-primary text-primary-foreground px-5 py-2.5 rounded-lg text-sm font-semibold hover:bg-primary/90 transition-colors shadow-lg shadow-primary/20"
        >
          Nueva extracción
          <ArrowRight className="w-4 h-4" />
        </Link>
      </div>

      {/* Worker health */}
      <div className="bg-card border border-border rounded-xl px-5 py-3.5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="relative flex items-center justify-center w-9 h-9 rounded-lg bg-muted/40">
            <Activity
              className={cn(
                "w-4.5 h-4.5",
                worker.status === "active" && "text-accent",
                worker.status === "stalled" && "text-red-400",
                worker.status === "idle" && "text-muted-foreground"
              )}
            />
            {worker.status === "active" && (
              <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-accent ring-2 ring-card animate-pulse" />
            )}
          </div>
          <div>
            <p className="text-sm font-semibold">
              {worker.status === "active" && "Worker activo"}
              {worker.status === "idle" && "Worker en espera"}
              {worker.status === "stalled" && "Worker sin respuesta"}
            </p>
            <p className="text-xs text-muted-foreground">
              {worker.status === "active" &&
                `${worker.runningJobs} job${worker.runningJobs > 1 ? "s" : ""} procesando · último update ${formatDate(worker.lastSeenAt!)}`}
              {worker.status === "idle" && "Sin jobs activos en este momento"}
              {worker.status === "stalled" &&
                `Último heartbeat: ${formatDate(worker.lastSeenAt!)}`}
            </p>
          </div>
        </div>
      </div>

      {/* Metric cards */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        {cards.map((card) => (
          <div
            key={card.label}
            className="bg-card border border-border rounded-xl p-5"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11px] text-muted-foreground font-medium uppercase tracking-wider">
                  {card.label}
                </p>
                <p className="text-2xl font-semibold mt-2 truncate">
                  {card.value}
                </p>
                <p className="text-xs text-muted-foreground mt-1">{card.sub}</p>
              </div>
              <div
                className={cn(
                  "w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0",
                  card.tone === "primary"
                    ? "bg-primary/10 text-primary"
                    : "bg-accent/10 text-accent"
                )}
              >
                <card.icon className="w-4 h-4" />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Recent activity */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="font-semibold text-sm">Actividad reciente</h2>
          <Link
            href="/extractions"
            className="text-xs text-primary hover:underline flex items-center gap-1"
          >
            Ver todas <ArrowRight className="w-3 h-3" />
          </Link>
        </div>
        {stats.recentJobs.length === 0 ? (
          <div className="flex flex-col items-center py-12 text-muted-foreground">
            <Clock className="w-8 h-8 mb-2 opacity-30" />
            <p className="text-sm">Sin extracciones todavía</p>
            <Link
              href="/new-extraction"
              className="text-primary text-sm mt-2 hover:underline"
            >
              Iniciar primera extracción
            </Link>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {stats.recentJobs.map((job) => (
              <Link
                key={job.id}
                href={`/extractions/${job.id}`}
                className="flex items-center justify-between px-6 py-3.5 hover:bg-muted/20 transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-8 h-8 rounded-lg bg-muted/40 flex items-center justify-center flex-shrink-0">
                    <Store className="w-3.5 h-3.5 text-muted-foreground" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">
                      {job.provider.name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatDate(job.createdAt)}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-4 flex-shrink-0">
                  {job.totalProducts > 0 && (
                    <span className="text-xs text-muted-foreground font-mono">
                      {job.totalProducts} productos
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground font-mono">
                    {formatDuration(job.startedAt, job.finishedAt)}
                  </span>
                  <StatusBadge status={job.status} />
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Inteligencia de precios */}
      <div>
        <div className="mb-3">
          <h2 className="font-semibold text-sm">Inteligencia de precios</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Cambios detectados en la última extracción por proveedor
          </p>
        </div>

        {providerCards.length === 0 ? (
          <div className="bg-card border border-border rounded-xl py-10 text-center text-sm text-muted-foreground">
            Sin extracciones completadas todavía
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {providerCards.map(({ provider, job }) => {
              const c = job!.comparison;
              const hasComparison = c != null && c.previousJobId != null;
              const total = hasComparison
                ? c!.newProducts +
                  c!.removedProducts +
                  c!.priceUp +
                  c!.priceDown +
                  c!.stockChanged
                : 0;
              return (
                <div
                  key={provider.id}
                  className="bg-card border border-border rounded-xl p-5 flex flex-col gap-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold text-sm truncate">
                        {provider.name}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">
                        {hostnameOf(provider.baseUrl)}
                      </p>
                    </div>
                    {hasComparison && c!.createdAt && (
                      <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                        {formatDate(c!.createdAt)}
                      </span>
                    )}
                  </div>

                  {hasComparison ? (
                    <>
                      <div className="space-y-1 text-xs">
                        <div className="flex gap-4">
                          <span className="text-green-400">
                            +{c!.newProducts} nuevos
                          </span>
                          <span className="text-red-400">
                            ×{c!.removedProducts} removidos
                          </span>
                        </div>
                        <div className="flex gap-4">
                          <span className="text-orange-400">
                            ↑{c!.priceUp} precio subió
                          </span>
                          <span className="text-emerald-400">
                            ↓{c!.priceDown} precio bajó
                          </span>
                        </div>
                        <div className="text-blue-400">
                          ~ {c!.stockChanged} stock cambió
                        </div>
                      </div>
                      <p className="text-sm font-semibold">
                        {total} cambio{total === 1 ? "" : "s"} totales
                      </p>
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground py-2">
                      Sin comparaciones disponibles aún
                    </p>
                  )}

                  <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-border">
                    <Link
                      href={`/providers/${provider.id}`}
                      className="text-[11px] border border-border px-2 py-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
                    >
                      Ver historial
                    </Link>
                    <Link
                      href={`/changes?providerId=${provider.id}`}
                      className="text-[11px] border border-border px-2 py-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
                    >
                      Ver cambios
                    </Link>
                    <Link
                      href={`/extractions/${job!.id}`}
                      className="text-[11px] border border-border px-2 py-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
                    >
                      Ver productos
                    </Link>
                    <button
                      type="button"
                      disabled
                      title="Próximamente"
                      className="text-[11px] border border-border px-2 py-1 rounded-md text-muted-foreground/50 inline-flex items-center gap-1 cursor-not-allowed"
                    >
                      <Lock className="w-2.5 h-2.5" /> Publicar
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Acciones pendientes */}
      <div>
        <h2 className="font-semibold text-sm mb-3">Acciones pendientes</h2>
        {pendingActions.length === 0 ? (
          <div className="bg-card border border-border rounded-xl px-5 py-4 flex items-center gap-2 text-sm">
            <CheckCircle2 className="w-4 h-4 text-accent" />
            <span>Todo al día — no hay acciones pendientes</span>
          </div>
        ) : (
          <div className="bg-card border border-border rounded-xl divide-y divide-border">
            {pendingActions.map((action) => (
              <div
                key={action.key}
                className="flex items-center justify-between px-5 py-3.5 gap-4"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <action.icon className={`w-4 h-4 flex-shrink-0 ${action.tone}`} />
                  <p className="text-sm">
                    <span className="font-semibold">{action.count}</span>{" "}
                    {action.label}
                  </p>
                </div>
                <Link
                  href={action.href}
                  className="text-xs text-primary hover:underline flex-shrink-0"
                >
                  {action.cta}
                </Link>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
