import { prisma } from "@/lib/db/client";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { es } from "date-fns/locale";
import {
  ArrowLeft,
  Lock,
  Play,
  Settings,
  Edit,
  Download,
  Package,
  TrendingUp,
  TrendingDown,
  PlusCircle,
  MinusCircle,
  ExternalLink,
  Upload,
  Hand,
  Globe,
  FileSpreadsheet,
  Boxes,
  ChevronDown,
  ImageOff,
  Tag,
} from "lucide-react";
import type { ProviderType } from "@prisma/client";
import { normalizeImageUrl } from "@/lib/utils";
import {
  deriveVisualStatus,
  visualStatusConfig,
} from "@/lib/catalog/visual-status";

const typeBadge: Record<
  ProviderType,
  { label: string; className: string; icon: typeof Globe }
> = {
  SCRAPER: {
    label: "Automático",
    className: "bg-blue-500/20 text-blue-300 border-blue-500/30",
    icon: Globe,
  },
  MANUAL: {
    label: "Manual",
    className: "bg-violet-500/20 text-violet-300 border-violet-500/30",
    icon: Hand,
  },
  IMPORTED: {
    label: "Importado",
    className: "bg-amber-500/20 text-amber-300 border-amber-500/30",
    icon: FileSpreadsheet,
  },
  OWN_STOCK: {
    label: "Stock propio",
    className: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
    icon: Boxes,
  },
};

// Badges del estado del producto: deriveVisualStatus + visualStatusConfig
// (lib/catalog/visual-status.ts). Misma fuente de verdad que /catalog.

export default async function ProviderDashboardPage({
  params,
}: {
  params: { id: string };
}) {
  const session = await requireSession();

  const provider = await prisma.provider.findFirst({
    where: { id: params.id, userId: session.user.id },
    select: {
      id: true,
      name: true,
      baseUrl: true,
      providerType: true,
      isActive: true,
      requiresLogin: true,
      lastExtractionAt: true,
    },
  });
  if (!provider) notFound();

  const isScraper = provider.providerType === "SCRAPER";
  // SCRAPER y IMPORTED comparten la infraestructura de ExtractionJob +
  // Comparison + ProductChange. SCRAPER lo alimenta el worker, IMPORTED lo
  // alimenta POST /api/catalog/import con un job sintético source="IMPORT".
  // Los botones de "Extraer" / "Configurar" siguen siendo exclusivos de
  // SCRAPER.
  const hasExtractionHistory =
    provider.providerType === "SCRAPER" ||
    provider.providerType === "IMPORTED";

  // Where común para queries del catálogo. Excluye ignorados y removidos del
  // proveedor cuando dependen del proveedor (los OWN/HYBRID sobreviven).
  const catalogWhere = {
    providerId: provider.id,
    userId: session.user.id,
    NOT: [
      { internalStatus: "IGNORED" as const },
      {
        AND: [
          { supplierStatus: "SUPPLIER_REMOVED" as const },
          { stockSource: "SUPPLIER" as const },
        ],
      },
    ],
  };

  const [
    catalogProducts,
    catalogTotal,
    withPrice,
    withoutImage,
    publishedInStore,
    lastJob,
    lastExcelJob,
    extractionJobsTotal,
  ] = await Promise.all([
    prisma.catalogProduct.findMany({
      where: catalogWhere,
      select: {
        id: true,
        sku: true,
        publicationSku: true,
        supplierName: true,
        commercialTitle: true,
        wholesalePrice: true,
        imageUrl: true,
        supplierStatus: true,
        internalStatus: true,
        stockSource: true,
        assignedCategory: { select: { name: true } },
        images: {
          where: { isPrimary: true },
          select: { url: true },
          take: 1,
        },
        publications: {
          where: { status: "ACTIVE" },
          select: { pendingSync: true, syncStatus: true },
          take: 1,
        },
      },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    prisma.catalogProduct.count({ where: catalogWhere }),
    prisma.catalogProduct.count({
      where: { ...catalogWhere, wholesalePrice: { not: null } },
    }),
    prisma.catalogProduct.count({
      where: {
        ...catalogWhere,
        OR: [{ imageUrl: null }, { imageUrl: "" }],
        images: { none: {} },
      },
    }),
    // Publications ACTIVE de este provider: cuenta cuántos productos del
    // proveedor están publicados en alguna tienda (status=ACTIVE en la
    // ProductPublication). Multi-store-safe (cuenta cada publication).
    prisma.productPublication.count({
      where: {
        catalogProduct: {
          providerId: provider.id,
          userId: session.user.id,
        },
        status: "ACTIVE",
      },
    }),
    hasExtractionHistory
      ? prisma.extractionJob.findFirst({
          where: {
            providerId: provider.id,
            status: "COMPLETED",
            comparison: { isNot: null },
          },
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            createdAt: true,
            source: true,
            comparison: {
              select: {
                newProducts: true,
                removedProducts: true,
                priceUp: true,
                priceDown: true,
                stockChanged: true,
                previousJobId: true,
              },
            },
          },
        })
      : Promise.resolve(null),
    isScraper
      ? prisma.extractionJob.findFirst({
          where: {
            providerId: provider.id,
            status: "COMPLETED",
            excelFileUrl: { not: null },
          },
          orderBy: { createdAt: "desc" },
          select: { excelFileUrl: true },
        })
      : Promise.resolve(null),
    // Historial de jobs: para SCRAPER cuenta extracciones reales; para IMPORTED
    // cuenta los jobs sintéticos de import. El link discreto al final solo
    // aparece para SCRAPER (los jobs IMPORT no se ven en /extractions).
    isScraper
      ? prisma.extractionJob.count({ where: { providerId: provider.id } })
      : Promise.resolve(0),
  ]);

  const tBadge = typeBadge[provider.providerType];
  const TypeIcon = tBadge.icon;

  const hostname = (() => {
    try {
      return new URL(provider.baseUrl).hostname.replace(/^www\./, "");
    } catch {
      return provider.baseUrl;
    }
  })();

  // KPIs del catálogo — counts reales sobre la DB (no sobre la muestra).
  const kpis: {
    label: string;
    value: number;
    icon: typeof Package;
    tone: string;
    href?: string;
  }[] = [
    {
      label: "Productos activos",
      value: catalogTotal,
      icon: Package,
      tone: "text-primary",
    },
    {
      label: "Con precio",
      value: withPrice,
      icon: Tag,
      tone: "text-emerald-400",
    },
    {
      label: "Sin imagen",
      value: withoutImage,
      icon: ImageOff,
      tone: "text-amber-400",
    },
    {
      label: "Publicados en tienda",
      value: publishedInStore,
      icon: Globe,
      tone: "text-emerald-400",
      href: `/catalog?providerId=${provider.id}&internalStatus=PUBLISHED`,
    },
  ];

  const comparison = lastJob?.comparison ?? null;
  // Para SCRAPER, `previousJobId != null` indica que hubo una extracción
  // anterior contra la que comparar (la primera extracción no tiene diff).
  // Para IMPORT, los jobs no encadenan a un previousJob por ahora — el diff
  // se compara contra el estado actual del catálogo. Por eso lo medimos por
  // totalChanges > 0 directamente.
  const totalChanges = comparison
    ? comparison.newProducts +
      comparison.removedProducts +
      comparison.priceUp +
      comparison.priceDown +
      comparison.stockChanged
    : 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <Link
          href="/providers"
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-3 w-fit"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Volver a proveedores
        </Link>

        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl font-semibold">{provider.name}</h1>
              <span
                className={`text-[10px] font-medium px-2 py-0.5 rounded-full border whitespace-nowrap ${
                  provider.isActive
                    ? "bg-accent/10 text-accent border-accent/30"
                    : "bg-muted/40 text-muted-foreground border-border"
                }`}
              >
                {provider.isActive ? "Activo" : "Inactivo"}
              </span>
              <span
                className={`inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full border whitespace-nowrap ${tBadge.className}`}
              >
                <TypeIcon className="w-2.5 h-2.5" />
                {tBadge.label}
              </span>
              {provider.requiresLogin && (
                <span className="inline-flex items-center gap-1 text-[10px] text-amber-300 bg-amber-500/10 border border-amber-500/30 px-2 py-0.5 rounded-full">
                  <Lock className="w-2.5 h-2.5" /> Requiere login
                </span>
              )}
            </div>
            <div className="flex items-center gap-3 mt-1.5 text-sm text-muted-foreground flex-wrap">
              <a
                href={provider.baseUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 hover:text-primary"
              >
                {hostname} <ExternalLink className="w-3 h-3" />
              </a>
              {isScraper && (
                <>
                  <span className="opacity-40">·</span>
                  <span>
                    Última extracción:{" "}
                    {provider.lastExtractionAt
                      ? formatDistanceToNow(provider.lastExtractionAt, {
                          locale: es,
                          addSuffix: true,
                        })
                      : "Nunca"}
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Acciones rápidas */}
          <div className="flex items-center gap-2 flex-wrap">
            {isScraper ? (
              <>
                <Link
                  href={`/new-extraction?providerId=${provider.id}`}
                  className="flex items-center gap-1.5 bg-primary text-primary-foreground px-3.5 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors"
                >
                  <Play className="w-3.5 h-3.5" /> Extraer
                </Link>
                <Link
                  href={`/providers/${provider.id}/config`}
                  className="flex items-center gap-1.5 border border-border px-3.5 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
                >
                  <Settings className="w-3.5 h-3.5" /> Configurar
                </Link>
              </>
            ) : (
              <>
                <Link
                  href={`/catalog/new?providerId=${provider.id}`}
                  className="flex items-center gap-1.5 bg-primary text-primary-foreground px-3.5 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors"
                >
                  <PlusCircle className="w-3.5 h-3.5" /> Agregar producto
                </Link>
                <Link
                  href={`/catalog/import?providerId=${provider.id}`}
                  className="flex items-center gap-1.5 border border-border px-3.5 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
                >
                  <Upload className="w-3.5 h-3.5" /> Importar Excel
                </Link>
              </>
            )}
            <Link
              href={`/providers/${provider.id}/edit`}
              className="flex items-center gap-1.5 border border-border px-3.5 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
            >
              <Edit className="w-3.5 h-3.5" /> Editar
            </Link>
            {isScraper && lastExcelJob?.excelFileUrl && (
              <a
                href={lastExcelJob.excelFileUrl}
                download
                className="flex items-center gap-1.5 border border-accent/30 bg-accent/10 text-accent px-3.5 py-2 rounded-lg text-sm hover:bg-accent hover:text-white transition-colors"
              >
                <Download className="w-3.5 h-3.5" /> Último Excel
              </a>
            )}
          </div>
        </div>
      </div>

      {/* KPIs del catálogo — iguales para todos los tipos */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {kpis.map((k) => {
          const Icon = k.icon;
          const isClickable = k.href && k.value > 0;
          const card = (
            <div
              className={`bg-card border border-border rounded-xl p-4 ${
                isClickable
                  ? "hover:border-primary/40 hover:bg-muted/20 transition-colors cursor-pointer"
                  : ""
              }`}
            >
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Icon className={`w-3.5 h-3.5 ${k.tone}`} />
                <p className="text-[10px] uppercase tracking-wider font-medium">
                  {k.label}
                </p>
              </div>
              <p className="text-2xl font-semibold mt-1.5">
                {k.value.toLocaleString("es-AR")}
              </p>
            </div>
          );
          return isClickable ? (
            <Link key={k.label} href={k.href!}>
              {card}
            </Link>
          ) : (
            <div key={k.label}>{card}</div>
          );
        })}
      </div>

      {/* Cambios de última extracción o importación */}
      {comparison && lastJob && totalChanges > 0 && (
        <details className="bg-card border border-border rounded-xl overflow-hidden group">
          <summary className="px-5 py-4 cursor-pointer flex items-center justify-between hover:bg-muted/20 transition-colors list-none">
            <div className="min-w-0">
              <p className="font-medium text-sm">
                Cambios vs{" "}
                {lastJob.source === "IMPORT"
                  ? "importación anterior"
                  : "extracción anterior"}
                <span className="text-xs text-muted-foreground ml-2">
                  · {totalChanges} cambio{totalChanges === 1 ? "" : "s"} ·{" "}
                  {formatDistanceToNow(lastJob.createdAt, {
                    locale: es,
                    addSuffix: true,
                  })}
                </span>
              </p>
            </div>
            <ChevronDown className="w-4 h-4 text-muted-foreground group-open:rotate-180 transition-transform flex-shrink-0" />
          </summary>
          <div className="px-5 pb-5 pt-1 space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              {[
                {
                  label: "Nuevos",
                  value: comparison.newProducts,
                  icon: PlusCircle,
                  tone: "text-green-400",
                },
                {
                  label: "Removidos",
                  value: comparison.removedProducts,
                  icon: MinusCircle,
                  tone: "text-red-400",
                },
                {
                  label: "Precio ↑",
                  value: comparison.priceUp,
                  icon: TrendingUp,
                  tone: "text-orange-400",
                },
                {
                  label: "Precio ↓",
                  value: comparison.priceDown,
                  icon: TrendingDown,
                  tone: "text-emerald-400",
                },
                {
                  label: "Stock",
                  value: comparison.stockChanged,
                  icon: Package,
                  tone: "text-blue-400",
                },
              ].map((m) => {
                const Icon = m.icon;
                return (
                  <div
                    key={m.label}
                    className="bg-background/40 border border-border rounded-lg p-3"
                  >
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <Icon className={`w-3 h-3 ${m.tone}`} />
                      <p className="text-[10px] uppercase tracking-wider font-medium">
                        {m.label}
                      </p>
                    </div>
                    <p className={`text-lg font-semibold mt-1 ${m.tone}`}>
                      {m.value}
                    </p>
                  </div>
                );
              })}
            </div>
            <Link
              href={`/changes?providerId=${provider.id}&reviewStatus=PENDING`}
              className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
            >
              Ver tabla completa de cambios <ExternalLink className="w-3 h-3" />
            </Link>
          </div>
        </details>
      )}

      {/* Productos del catálogo — igual para todos los tipos */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-border flex items-center justify-between">
          <h2 className="font-semibold text-sm">
            Productos del catálogo ({catalogTotal.toLocaleString("es-AR")})
          </h2>
          <Link
            href={`/catalog?providerId=${provider.id}`}
            className="text-xs text-primary hover:underline"
          >
            Ver todos →
          </Link>
        </div>
        {catalogTotal === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            Sin productos cargados.{" "}
            {isScraper ? (
              <Link
                href={`/new-extraction?providerId=${provider.id}`}
                className="text-primary hover:underline"
              >
                Lanzar primera extracción
              </Link>
            ) : (
              <Link
                href={`/catalog/new?providerId=${provider.id}`}
                className="text-primary hover:underline"
              >
                Agregar el primero
              </Link>
            )}
            .
          </div>
        ) : (
          <div className="divide-y divide-border">
            {catalogProducts.map((p) => {
              const img = normalizeImageUrl(p.images[0]?.url ?? p.imageUrl);
              const visualStatus = deriveVisualStatus({
                internalStatus: p.internalStatus,
                supplierStatus: p.supplierStatus,
                pendingSync: p.publications[0]?.pendingSync,
                syncStatus: p.publications[0]?.syncStatus,
              });
              const badge = visualStatusConfig[visualStatus];
              return (
                <div
                  key={p.id}
                  className="px-5 py-2.5 flex items-center gap-3 hover:bg-muted/20 transition-colors"
                >
                  {img ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={img}
                      alt=""
                      className="w-10 h-10 rounded-md object-cover bg-muted/30 border border-border flex-shrink-0"
                    />
                  ) : (
                    <div className="w-10 h-10 rounded-md bg-muted/30 border border-border flex-shrink-0 flex items-center justify-center">
                      <ImageOff className="w-4 h-4 text-muted-foreground/40" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">
                      {p.commercialTitle ?? p.supplierName}
                    </p>
                    <p className="text-[11px] text-muted-foreground truncate">
                      <span className="font-mono">
                        {p.publicationSku ?? p.sku ?? "—"}
                      </span>
                      {p.assignedCategory?.name
                        ? ` · ${p.assignedCategory.name}`
                        : ""}
                    </p>
                  </div>
                  <span className="text-xs font-mono text-muted-foreground whitespace-nowrap">
                    {p.wholesalePrice != null
                      ? `$${Math.round(p.wholesalePrice).toLocaleString("es-AR")}`
                      : "—"}
                  </span>
                  <span
                    className={`text-[10px] font-medium px-2 py-0.5 rounded-full border whitespace-nowrap ${badge.className}`}
                  >
                    {badge.label}
                  </span>
                </div>
              );
            })}
            {catalogTotal > catalogProducts.length && (
              <div className="px-5 py-3 text-center">
                <Link
                  href={`/catalog?providerId=${provider.id}`}
                  className="text-xs text-primary hover:underline"
                >
                  Ver los {catalogTotal.toLocaleString("es-AR")} productos →
                </Link>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Link discreto al historial (solo SCRAPER) */}
      {isScraper && extractionJobsTotal > 0 && (
        <div className="text-center">
          <Link
            href={`/extractions?providerId=${provider.id}`}
            className="text-xs text-muted-foreground hover:text-primary inline-flex items-center gap-1"
          >
            Ver historial de extracciones ({extractionJobsTotal}) →
          </Link>
        </div>
      )}
    </div>
  );
}
