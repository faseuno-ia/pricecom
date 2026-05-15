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
  PlusCircle,
  MinusCircle,
  TrendingUp,
  TrendingDown,
  Boxes,
  Send,
} from "lucide-react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { es } from "date-fns/locale";
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
    productsReadyToPublish,
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
    prisma.extractedProduct.count({
      where: { job: { userId }, OR: [{ imageUrl: null }, { imageUrl: "" }] },
    }),
    prisma.extractedProduct.count({
      where: { job: { userId }, OR: [{ category: null }, { category: "" }] },
    }),
    prisma.extractionJob.count({ where: { userId, status: "FAILED" } }),
    // Placeholder para feature futura de publicación masiva: cuenta productos
    // ya marcados como "prepared" (workflow aún no implementado, dará 0).
    prisma.extractedProduct.count({
      where: { job: { userId }, publicationStatus: "prepared" },
    }),
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
    productsReadyToPublish,
  };
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

  const kpiCards = [
    {
      label: "Proveedores activos",
      value: stats.activeProviders,
      sub: `${stats.totalProviders} en total`,
      icon: Store,
      tone: "primary" as const,
    },
    {
      label: "Productos en catálogo",
      value: stats.totalProducts.toLocaleString("es-AR"),
      sub: "Histórico acumulado",
      icon: Boxes,
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

  const providerCards = stats.providers
    .map((p) => ({ provider: p, job: p.extractionJobs[0] }))
    .filter((x) => x.job != null);

  const catalogStatus = [
    {
      key: "sin-imagen",
      icon: ImageOff,
      tone: "text-amber-400 bg-amber-500/10 border-amber-500/20",
      count: stats.productsSinImagen,
      label: "Productos sin imagen",
      cta: "Revisar",
      href: "/extractions",
      disabled: false,
    },
    {
      key: "sin-categoria",
      icon: FolderX,
      tone: "text-amber-400 bg-amber-500/10 border-amber-500/20",
      count: stats.productsSinCategoria,
      label: "Productos sin categoría",
      cta: "Revisar",
      href: "/extractions",
      disabled: false,
    },
    {
      key: "fallidas",
      icon: XCircle,
      tone: "text-red-400 bg-red-500/10 border-red-500/20",
      count: stats.extraccionesFallidas,
      label: "Extracciones fallidas",
      cta: "Ver",
      href: "/extractions?status=FAILED",
      disabled: false,
    },
    {
      key: "publicar",
      icon: Send,
      tone: "text-blue-400 bg-blue-500/10 border-blue-500/20",
      count: stats.productsReadyToPublish,
      label: "Listos para publicar",
      cta: "Próximamente",
      href: "#",
      disabled: true,
    },
  ];

  const allCatalogClean =
    stats.productsSinImagen === 0 &&
    stats.productsSinCategoria === 0 &&
    stats.extraccionesFallidas === 0;

  return (
    <div className="space-y-10">
      {/* ─── Header ────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Centro operativo
          </h1>
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

      {/* ─── KPIs ──────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        {kpiCards.map((card) => (
          <div
            key={card.label}
            className="bg-card border border-border rounded-xl p-6"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-2">
                <p className="text-[11px] text-muted-foreground font-medium uppercase tracking-wider">
                  {card.label}
                </p>
                <p className="text-3xl font-semibold leading-none truncate">
                  {card.value}
                </p>
                <p className="text-xs text-muted-foreground">{card.sub}</p>
              </div>
              <div
                className={cn(
                  "w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0",
                  card.tone === "primary"
                    ? "bg-primary/10 text-primary"
                    : "bg-accent/10 text-accent"
                )}
              >
                <card.icon className="w-4.5 h-4.5" />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* ─── Inteligencia de precios ───────────────────────────────────── */}
      <section>
        <div className="mb-4">
          <h2 className="text-lg font-semibold tracking-tight">
            Inteligencia de precios
          </h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Cambios detectados en la última extracción de cada proveedor
          </p>
        </div>

        {providerCards.length === 0 ? (
          <div className="bg-card border border-border rounded-xl py-12 text-center text-sm text-muted-foreground">
            Sin extracciones completadas todavía.{" "}
            <Link href="/new-extraction" className="text-primary hover:underline">
              Iniciar primera extracción →
            </Link>
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

              const metrics: { icon: typeof PlusCircle; label: string; value: number; color: string }[] = [
                { icon: PlusCircle, label: "Nuevos", value: c?.newProducts ?? 0, color: "text-green-400" },
                { icon: MinusCircle, label: "Removidos", value: c?.removedProducts ?? 0, color: "text-red-400" },
                { icon: TrendingUp, label: "Precio ↑", value: c?.priceUp ?? 0, color: "text-orange-400" },
                { icon: TrendingDown, label: "Precio ↓", value: c?.priceDown ?? 0, color: "text-emerald-400" },
                { icon: Package, label: "Stock", value: c?.stockChanged ?? 0, color: "text-blue-400" },
              ];

              return (
                <div
                  key={provider.id}
                  className="bg-card border border-border rounded-xl p-5 flex flex-col gap-4 hover:border-primary/30 transition-colors"
                >
                  {/* Header de la card */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                        <Store className="w-4.5 h-4.5 text-primary" />
                      </div>
                      <div className="min-w-0">
                        <p className="font-semibold text-sm truncate">
                          {provider.name}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">
                          {hostnameOf(provider.baseUrl)}
                        </p>
                      </div>
                    </div>
                    {hasComparison && c!.createdAt && (
                      <span className="text-[10px] text-muted-foreground/70 bg-muted/30 border border-border px-2 py-0.5 rounded-full whitespace-nowrap">
                        {formatDistanceToNow(c!.createdAt, {
                          locale: es,
                          addSuffix: true,
                        })}
                      </span>
                    )}
                  </div>

                  {/* Cuerpo: métricas o estado */}
                  {hasComparison ? (
                    <>
                      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                        {metrics.map((m) => (
                          <div key={m.label} className="flex items-center gap-2">
                            <m.icon className={`w-3.5 h-3.5 ${m.color}`} />
                            <span className="text-xs">
                              <span className={`font-semibold ${m.color}`}>
                                {m.value}
                              </span>{" "}
                              <span className="text-muted-foreground">
                                {m.label}
                              </span>
                            </span>
                          </div>
                        ))}
                      </div>
                      <div className="border-t border-border pt-3">
                        <p className="text-xs text-muted-foreground">
                          Total
                        </p>
                        <p className="text-2xl font-semibold leading-none mt-1">
                          {total}{" "}
                          <span className="text-sm font-normal text-muted-foreground">
                            cambio{total === 1 ? "" : "s"}
                          </span>
                        </p>
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

                  {/* Acciones */}
                  <div className="flex flex-wrap items-center gap-1.5 pt-1">
                    <Link
                      href={`/providers/${provider.id}`}
                      className="text-[11px] border border-border px-2.5 py-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
                    >
                      Historial
                    </Link>
                    <Link
                      href={`/changes?providerId=${provider.id}`}
                      className="text-[11px] border border-border px-2.5 py-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
                    >
                      Cambios
                    </Link>
                    <Link
                      href={`/extractions/${job!.id}`}
                      className="text-[11px] border border-border px-2.5 py-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
                    >
                      Productos
                    </Link>
                    <button
                      type="button"
                      disabled
                      title="Próximamente"
                      className="text-[11px] border border-border px-2.5 py-1 rounded-md text-muted-foreground/50 inline-flex items-center gap-1 cursor-not-allowed ml-auto"
                    >
                      <Lock className="w-2.5 h-2.5" /> Publicar
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ─── Estado del catálogo ──────────────────────────────────────── */}
      <section>
        <div className="mb-4 flex items-end justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">
              Estado del catálogo
            </h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              Optimizaciones pendientes y preparación para publicación
            </p>
          </div>
          {allCatalogClean && (
            <div className="flex items-center gap-1.5 text-xs text-accent">
              <CheckCircle2 className="w-3.5 h-3.5" />
              Catálogo al día
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {catalogStatus.map((item) => (
            <div
              key={item.key}
              className={cn(
                "bg-card border border-border rounded-xl p-5 flex flex-col gap-3",
                item.disabled && "opacity-60"
              )}
            >
              <div className="flex items-center justify-between">
                <div
                  className={cn(
                    "w-9 h-9 rounded-lg border flex items-center justify-center flex-shrink-0",
                    item.tone
                  )}
                >
                  <item.icon className="w-4.5 h-4.5" />
                </div>
                {item.disabled && (
                  <Lock className="w-3 h-3 text-muted-foreground/40" />
                )}
              </div>
              <div>
                <p className="text-3xl font-semibold leading-none">
                  {item.count.toLocaleString("es-AR")}
                </p>
                <p className="text-xs text-muted-foreground mt-1.5">
                  {item.label}
                </p>
              </div>
              {item.disabled ? (
                <span className="text-xs text-muted-foreground/60 self-start">
                  {item.cta}
                </span>
              ) : (
                <Link
                  href={item.href}
                  className="text-xs text-primary hover:underline self-start mt-auto"
                >
                  {item.cta} →
                </Link>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* ─── Pie: actividad reciente + worker (compactos, secundarios) ── */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4 pt-2">
        {/* Actividad reciente (2/3) */}
        <div className="lg:col-span-2 bg-card border border-border rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3 border-b border-border">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Actividad reciente
            </h3>
            <Link
              href="/extractions"
              className="text-[11px] text-primary hover:underline"
            >
              Ver todas
            </Link>
          </div>
          {stats.recentJobs.length === 0 ? (
            <div className="px-5 py-6 text-center text-xs text-muted-foreground">
              Sin extracciones todavía
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {stats.recentJobs.map((job) => {
                const tone =
                  job.status === "COMPLETED"
                    ? "text-accent"
                    : job.status === "FAILED"
                    ? "text-red-400"
                    : job.status === "RUNNING"
                    ? "text-blue-400"
                    : "text-muted-foreground";
                const icon =
                  job.status === "COMPLETED" ? "✔" :
                  job.status === "FAILED" ? "✖" :
                  job.status === "RUNNING" ? "•" : "·";
                const statusLabel =
                  job.status === "COMPLETED" ? "completado" :
                  job.status === "FAILED" ? "falló" :
                  job.status === "RUNNING" ? "en curso" :
                  job.status === "PENDING" ? "pendiente" : "cancelado";
                return (
                  <li key={job.id}>
                    <Link
                      href={`/extractions/${job.id}`}
                      className="flex items-center justify-between gap-3 px-5 py-2.5 hover:bg-muted/20 transition-colors text-sm"
                    >
                      <span className="flex items-center gap-2.5 min-w-0">
                        <span className={`font-mono text-base leading-none ${tone}`}>
                          {icon}
                        </span>
                        <span className="truncate">{job.provider.name}</span>
                        <span className="text-muted-foreground text-xs">
                          — {statusLabel}
                        </span>
                      </span>
                      <span className="text-[10px] text-muted-foreground/60 whitespace-nowrap">
                        {formatDistanceToNow(job.createdAt, {
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

        {/* Worker status (compacto, 1/3) */}
        <div className="bg-card border border-border rounded-xl p-4 flex items-center gap-3">
          <div className="relative flex items-center justify-center w-8 h-8 rounded-lg bg-muted/40 flex-shrink-0">
            <Activity
              className={cn(
                "w-4 h-4",
                worker.status === "active" && "text-accent",
                worker.status === "stalled" && "text-red-400",
                worker.status === "idle" && "text-muted-foreground"
              )}
            />
            {worker.status === "active" && (
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-accent ring-2 ring-card animate-pulse" />
            )}
          </div>
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Sistema
            </p>
            <p className="text-sm font-semibold leading-tight">
              {worker.status === "active" && "Worker activo"}
              {worker.status === "idle" && "Worker en espera"}
              {worker.status === "stalled" && "Sin respuesta"}
            </p>
            <p className="text-[10px] text-muted-foreground mt-0.5 truncate">
              {worker.status === "active" &&
                `${worker.runningJobs} en proceso`}
              {worker.status === "idle" && "Sin jobs activos"}
              {worker.status === "stalled" &&
                worker.lastSeenAt &&
                `Último: ${formatDistanceToNow(worker.lastSeenAt, { locale: es, addSuffix: true })}`}
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
