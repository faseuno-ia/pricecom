import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import {
  Activity,
  Info,
  AlertTriangle,
  XCircle,
  Zap,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
} from "lucide-react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { es } from "date-fns/locale";
import type { EventSeverity, EventSource, Prisma } from "@prisma/client";

export const metadata = {
  title: "Actividad — PricEcom",
};

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

const VALID_SEVERITY: EventSeverity[] = [
  "INFO",
  "WARNING",
  "ERROR",
  "CRITICAL",
];

const VALID_SOURCE: EventSource[] = [
  "USER",
  "WORKER",
  "SYSTEM",
  "SYNC",
  "IMPORT",
  "EXTRACTION",
  "WOOCOMMERCE",
];

const sourceLabel: Record<EventSource, string> = {
  USER: "Usuario",
  WORKER: "Worker",
  SYSTEM: "Sistema",
  SYNC: "Sync",
  IMPORT: "Import",
  EXTRACTION: "Extracción",
  WOOCOMMERCE: "WooCommerce",
};

const sourceCls: Record<EventSource, string> = {
  USER: "bg-blue-500/15 text-blue-300 border-blue-500/30",
  WORKER: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
  SYSTEM: "bg-slate-500/15 text-slate-300 border-slate-500/30",
  SYNC: "bg-violet-500/15 text-violet-300 border-violet-500/30",
  IMPORT: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  EXTRACTION: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  WOOCOMMERCE: "bg-pink-500/15 text-pink-300 border-pink-500/30",
};

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

type DateRange = "24h" | "7d" | "30d" | "all";

function parseDateRange(raw: string | undefined): DateRange {
  if (raw === "24h" || raw === "7d" || raw === "30d" || raw === "all") {
    return raw;
  }
  return "all";
}

function dateRangeStart(range: DateRange): Date | null {
  if (range === "all") return null;
  const now = Date.now();
  const ms =
    range === "24h"
      ? 24 * 3600 * 1000
      : range === "7d"
        ? 7 * 24 * 3600 * 1000
        : 30 * 24 * 3600 * 1000;
  return new Date(now - ms);
}

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Record<string, string | undefined>;
}) {
  const session = await requireSession();
  const userId = session.user.id;

  const severity =
    searchParams.severity &&
    VALID_SEVERITY.includes(searchParams.severity as EventSeverity)
      ? (searchParams.severity as EventSeverity)
      : null;
  const source =
    searchParams.source &&
    VALID_SOURCE.includes(searchParams.source as EventSource)
      ? (searchParams.source as EventSource)
      : null;
  const providerId = searchParams.providerId ?? null;
  const range = parseDateRange(searchParams.range);
  const page = Math.max(1, parseInt(searchParams.page ?? "1", 10) || 1);

  // Filtramos por usuario vía cualquier relación. EventLog.userId puede ser
  // null (eventos del worker o del sistema), por eso aceptamos también
  // eventos cuyo provider/store pertenezca a este usuario.
  const userScope: Prisma.EventLogWhereInput = {
    OR: [
      { userId },
      { provider: { userId } },
      { store: { userId } },
      { product: { userId } },
    ],
  };

  const where: Prisma.EventLogWhereInput = {
    AND: [
      userScope,
      ...(severity ? [{ severity }] : []),
      ...(source ? [{ source }] : []),
      ...(providerId ? [{ providerId }] : []),
      ...(dateRangeStart(range)
        ? [{ createdAt: { gte: dateRangeStart(range)! } }]
        : []),
    ],
  };

  const [total, events, providers] = await Promise.all([
    prisma.eventLog.count({ where }),
    prisma.eventLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        createdAt: true,
        severity: true,
        source: true,
        type: true,
        title: true,
        description: true,
        providerId: true,
        productId: true,
        publicationId: true,
        storeId: true,
        jobId: true,
        product: {
          select: { sku: true, publicationSku: true },
        },
        provider: { select: { name: true } },
      },
    }),
    prisma.provider.findMany({
      where: { userId },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Helper para mantener los filtros vigentes al construir links de página.
  function buildQuery(overrides: Record<string, string | null>): string {
    const params = new URLSearchParams();
    if (severity) params.set("severity", severity);
    if (source) params.set("source", source);
    if (providerId) params.set("providerId", providerId);
    if (range !== "all") params.set("range", range);
    if (page > 1) params.set("page", String(page));
    for (const [k, v] of Object.entries(overrides)) {
      if (v === null) params.delete(k);
      else params.set(k, v);
    }
    const s = params.toString();
    return s ? `?${s}` : "";
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Actividad</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Bitácora de acciones automáticas y manuales en PricEcom.{" "}
          {total.toLocaleString("es-AR")} evento{total === 1 ? "" : "s"}.
        </p>
      </div>

      {/* Filtros */}
      <div className="bg-card border border-border rounded-xl p-3 flex items-center gap-3 flex-wrap">
        <form
          method="GET"
          className="flex items-center gap-2 flex-wrap"
        >
          <select
            name="severity"
            defaultValue={severity ?? ""}
            className="text-xs bg-background border border-border rounded-md px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/60"
          >
            <option value="">Severidad: todas</option>
            {VALID_SEVERITY.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select
            name="source"
            defaultValue={source ?? ""}
            className="text-xs bg-background border border-border rounded-md px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/60"
          >
            <option value="">Fuente: todas</option>
            {VALID_SOURCE.map((s) => (
              <option key={s} value={s}>
                {sourceLabel[s]}
              </option>
            ))}
          </select>
          <select
            name="providerId"
            defaultValue={providerId ?? ""}
            className="text-xs bg-background border border-border rounded-md px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/60"
          >
            <option value="">Proveedor: todos</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select
            name="range"
            defaultValue={range}
            className="text-xs bg-background border border-border rounded-md px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/60"
          >
            <option value="24h">Últimas 24h</option>
            <option value="7d">Últimos 7 días</option>
            <option value="30d">Últimos 30 días</option>
            <option value="all">Todo</option>
          </select>
          <button
            type="submit"
            className="text-xs bg-primary text-primary-foreground px-3 py-1.5 rounded-md hover:bg-primary/90"
          >
            Aplicar
          </button>
          {(severity || source || providerId || range !== "all") && (
            <Link
              href="/activity"
              className="text-xs px-3 py-1.5 border border-border rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/40"
            >
              Limpiar
            </Link>
          )}
        </form>
      </div>

      {/* Lista */}
      {events.length === 0 ? (
        <div className="bg-card border border-border rounded-xl py-12 text-center text-sm text-muted-foreground">
          Sin eventos para los filtros aplicados.
        </div>
      ) : (
        <div className="bg-card border border-border rounded-xl divide-y divide-border">
          {events.map((e) => {
            const Icon = severityIcon[e.severity];
            const sCls = sourceCls[e.source];
            // Links contextuales: producto → /catalog?search=sku, provider → /providers/[id]
            const productHref =
              e.productId && e.product?.publicationSku
                ? `/catalog?search=${encodeURIComponent(e.product.publicationSku)}`
                : e.productId && e.product?.sku
                  ? `/catalog?search=${encodeURIComponent(e.product.sku)}`
                  : null;
            const providerHref = e.providerId
              ? `/providers/${e.providerId}`
              : null;
            const storeHref = e.storeId ? "/my-store" : null;
            return (
              <div
                key={e.id}
                className="px-5 py-3 flex items-start gap-3 hover:bg-muted/10 transition-colors"
              >
                <Icon
                  className={`w-4 h-4 mt-0.5 flex-shrink-0 ${severityIconCls[e.severity]}`}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full border font-medium ${sCls}`}
                    >
                      {sourceLabel[e.source]}
                    </span>
                    <p className="text-sm font-medium">{e.title}</p>
                  </div>
                  {e.description && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {e.description}
                    </p>
                  )}
                  <div className="flex items-center gap-3 mt-1 flex-wrap">
                    <span className="text-[11px] text-muted-foreground/70">
                      {formatDistanceToNow(e.createdAt, {
                        locale: es,
                        addSuffix: true,
                      })}
                    </span>
                    <span className="text-[10px] font-mono text-muted-foreground/50">
                      {e.type}
                    </span>
                    {productHref && (
                      <Link
                        href={productHref}
                        className="text-[11px] text-primary hover:underline inline-flex items-center gap-0.5"
                      >
                        Producto <ExternalLink className="w-2.5 h-2.5" />
                      </Link>
                    )}
                    {providerHref && e.provider?.name && (
                      <Link
                        href={providerHref}
                        className="text-[11px] text-primary hover:underline inline-flex items-center gap-0.5"
                      >
                        {e.provider.name} <ExternalLink className="w-2.5 h-2.5" />
                      </Link>
                    )}
                    {storeHref && (
                      <Link
                        href={storeHref}
                        className="text-[11px] text-primary hover:underline inline-flex items-center gap-0.5"
                      >
                        Mi Tienda <ExternalLink className="w-2.5 h-2.5" />
                      </Link>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Paginación */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            Página {page} de {totalPages} · {total.toLocaleString("es-AR")} evento
            {total === 1 ? "" : "s"}
          </span>
          <div className="flex items-center gap-2">
            {page > 1 ? (
              <Link
                href={`/activity${buildQuery({ page: String(page - 1) })}`}
                className="flex items-center gap-1 px-3 py-1.5 rounded-md border border-border hover:bg-muted/40"
              >
                <ChevronLeft className="w-3.5 h-3.5" /> Anterior
              </Link>
            ) : (
              <span className="flex items-center gap-1 px-3 py-1.5 rounded-md border border-border opacity-40 cursor-not-allowed">
                <ChevronLeft className="w-3.5 h-3.5" /> Anterior
              </span>
            )}
            {page < totalPages ? (
              <Link
                href={`/activity${buildQuery({ page: String(page + 1) })}`}
                className="flex items-center gap-1 px-3 py-1.5 rounded-md border border-border hover:bg-muted/40"
              >
                Siguiente <ChevronRight className="w-3.5 h-3.5" />
              </Link>
            ) : (
              <span className="flex items-center gap-1 px-3 py-1.5 rounded-md border border-border opacity-40 cursor-not-allowed">
                Siguiente <ChevronRight className="w-3.5 h-3.5" />
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
