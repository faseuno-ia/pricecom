import { prisma } from "@/lib/db/client";
import { notFound } from "next/navigation";
import { formatDate } from "@/lib/utils";
import { requireSession } from "@/lib/auth";
import { StatusBadge } from "@/components/ui/status-badge";
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
  Layers,
  TrendingUp,
  TrendingDown,
  PlusCircle,
  MinusCircle,
  ExternalLink,
} from "lucide-react";

function formatDuration(start: Date | null, end: Date | null): string {
  if (!start) return "—";
  const e = end ?? new Date();
  const sec = Math.round((e.getTime() - start.getTime()) / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem === 0 ? `${min}m` : `${min}m ${rem}s`;
}

export default async function ProviderDashboardPage({
  params,
}: {
  params: { id: string };
}) {
  const session = await requireSession();

  const provider = await prisma.provider.findFirst({
    where: { id: params.id, userId: session.user.id },
    include: {
      scraperConfig: true,
      extractionJobs: {
        orderBy: { createdAt: "desc" },
        take: 50,
        include: {
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
      },
    },
  });
  if (!provider) notFound();

  // KPIs agregados
  const totalProducts =
    provider.extractionJobs.find((j) => j.status === "COMPLETED")
      ?.totalProducts ?? 0;

  const allComparisons = provider.extractionJobs
    .filter((j) => j.comparison?.previousJobId)
    .map((j) => j.comparison!);

  const kpis = {
    totalExtractions: provider.extractionJobs.length,
    currentProducts: totalProducts,
    totalChanges: allComparisons.reduce(
      (acc, c) =>
        acc +
        c.newProducts +
        c.removedProducts +
        c.priceUp +
        c.priceDown +
        c.stockChanged,
      0
    ),
    totalPriceUp: allComparisons.reduce((acc, c) => acc + c.priceUp, 0),
    totalPriceDown: allComparisons.reduce((acc, c) => acc + c.priceDown, 0),
    totalRemoved: allComparisons.reduce((acc, c) => acc + c.removedProducts, 0),
    totalNew: allComparisons.reduce((acc, c) => acc + c.newProducts, 0),
  };

  // Último Excel descargable
  const lastExcelJob = provider.extractionJobs.find(
    (j) => j.status === "COMPLETED" && j.excelFileUrl
  );

  const hostname = (() => {
    try {
      return new URL(provider.baseUrl).hostname.replace(/^www\./, "");
    } catch {
      return provider.baseUrl;
    }
  })();

  const kpiCards: {
    label: string;
    value: number | string;
    icon: typeof Package;
    tone: string;
  }[] = [
    { label: "Productos actuales", value: kpis.currentProducts, icon: Package, tone: "text-primary" },
    { label: "Total extracciones", value: kpis.totalExtractions, icon: Layers, tone: "text-primary" },
    { label: "Precios subieron", value: kpis.totalPriceUp, icon: TrendingUp, tone: "text-orange-400" },
    { label: "Precios bajaron", value: kpis.totalPriceDown, icon: TrendingDown, tone: "text-emerald-400" },
    { label: "Productos nuevos", value: kpis.totalNew, icon: PlusCircle, tone: "text-green-400" },
    { label: "Removidos", value: kpis.totalRemoved, icon: MinusCircle, tone: "text-red-400" },
  ];

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
              <span className="opacity-40">·</span>
              <span>Requiere login: {provider.requiresLogin ? "Sí" : "No"}</span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Última extracción:{" "}
              {provider.lastExtractionAt
                ? formatDistanceToNow(provider.lastExtractionAt, {
                    locale: es,
                    addSuffix: true,
                  })
                : "Nunca"}
            </p>
          </div>

          {/* Acciones rápidas */}
          <div className="flex items-center gap-2 flex-wrap">
            <Link
              href={`/new-extraction?providerId=${provider.id}`}
              className="flex items-center gap-1.5 bg-primary text-primary-foreground px-3.5 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors"
            >
              <Play className="w-3.5 h-3.5" /> Nueva extracción
            </Link>
            <Link
              href={`/providers/${provider.id}/config`}
              className="flex items-center gap-1.5 border border-border px-3.5 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
            >
              <Settings className="w-3.5 h-3.5" /> Configuración
            </Link>
            <Link
              href={`/providers/${provider.id}/edit`}
              className="flex items-center gap-1.5 border border-border px-3.5 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
            >
              <Edit className="w-3.5 h-3.5" /> Editar
            </Link>
            {lastExcelJob?.excelFileUrl && (
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

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {kpiCards.map((card) => (
          <div
            key={card.label}
            className="bg-card border border-border rounded-xl p-4"
          >
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <card.icon className={`w-3.5 h-3.5 ${card.tone}`} />
              <p className="text-[10px] uppercase tracking-wider font-medium">
                {card.label}
              </p>
            </div>
            <p className="text-2xl font-semibold mt-1.5">{card.value}</p>
          </div>
        ))}
      </div>

      {/* Historial de extracciones */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-border">
          <h2 className="font-semibold text-sm">
            Historial de extracciones ({provider.extractionJobs.length})
          </h2>
        </div>

        {provider.extractionJobs.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            Sin extracciones todavía
          </div>
        ) : (
          <div className="divide-y divide-border">
            {provider.extractionJobs.map((job) => {
              const c = job.comparison;
              const isFirst = c != null && !c.previousJobId;
              const hasComparison = c != null && c.previousJobId != null;
              return (
                <div
                  key={job.id}
                  className="px-5 py-3.5 hover:bg-muted/20 transition-colors"
                >
                  <div className="flex items-center justify-between gap-4 flex-wrap">
                    <div className="flex items-center gap-4 text-sm flex-wrap">
                      <span className="font-medium">
                        {formatDate(job.createdAt)}
                      </span>
                      <span className="text-muted-foreground font-mono text-xs">
                        {formatDuration(job.startedAt, job.finishedAt)}
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {job.totalProducts} productos
                      </span>
                      <StatusBadge status={job.status} />
                    </div>
                    <Link
                      href={`/extractions/${job.id}`}
                      className="text-xs text-primary hover:underline flex items-center gap-1"
                    >
                      Ver detalle →
                    </Link>
                  </div>

                  {/* Comparación inline */}
                  <div className="mt-2 flex items-center gap-3 text-xs flex-wrap">
                    {isFirst && (
                      <span className="text-[10px] text-muted-foreground bg-muted/40 border border-border px-2 py-0.5 rounded-full">
                        Primera extracción
                      </span>
                    )}
                    {hasComparison && (
                      <>
                        <span className="text-green-400">
                          Nuevos +{c!.newProducts}
                        </span>
                        <span className="text-red-400">
                          Removidos {c!.removedProducts}
                        </span>
                        <span className="text-orange-400">
                          ↑ {c!.priceUp}
                        </span>
                        <span className="text-emerald-400">
                          ↓ {c!.priceDown}
                        </span>
                        <span className="text-blue-400">
                          Stock {c!.stockChanged}
                        </span>
                      </>
                    )}
                    {!isFirst && !hasComparison && (
                      <span className="text-[10px] text-muted-foreground/50">
                        Sin comparación
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
