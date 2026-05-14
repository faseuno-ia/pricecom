import { prisma } from "@/lib/db/client";
import { notFound } from "next/navigation";
import { formatDate } from "@/lib/utils";
import { Download, ArrowLeft } from "lucide-react";
import Link from "next/link";
import { StatusBadge } from "@/components/ui/status-badge";
import { ProgressBar } from "@/components/ui/progress-bar";
import { ProductsTable } from "@/components/extractions/products-table";
import { requireSession } from "@/lib/auth";

function formatDuration(start: Date | null, end: Date | null): string {
  if (!start) return "—";
  const e = end ?? new Date();
  const sec = Math.round((e.getTime() - start.getTime()) / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem === 0 ? `${min}m` : `${min}m ${rem}s`;
}

const levelColor: Record<string, string> = {
  INFO: "text-muted-foreground",
  WARN: "text-amber-400",
  ERROR: "text-red-400",
  DEBUG: "text-muted-foreground/40",
};

export default async function ExtractionDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const session = await requireSession();
  const job = await prisma.extractionJob.findFirst({
    where: { id: params.id, userId: session.user.id },
    include: {
      provider: { select: { name: true } },
      products: { orderBy: { extractedAt: "desc" } },
      logs: { orderBy: { createdAt: "asc" }, take: 200 },
    },
  });
  if (!job) notFound();

  const running = job.status === "RUNNING" || job.status === "PENDING";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <Link
            href="/extractions"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-2"
          >
            <ArrowLeft className="w-3.5 h-3.5" /> Volver a extracciones
          </Link>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-semibold">{job.provider.name}</h1>
            <StatusBadge status={job.status} size="md" />
          </div>
          <p className="text-muted-foreground mt-1 text-sm">
            {formatDate(job.createdAt)}
          </p>
        </div>
        {job.status === "COMPLETED" && job.excelFileUrl && (
          <a
            href={job.excelFileUrl}
            download
            className="flex items-center gap-2 bg-accent text-white px-5 py-2.5 rounded-lg text-sm font-semibold hover:bg-accent/90 transition-colors shadow-lg shadow-accent/20 flex-shrink-0"
          >
            <Download className="w-4 h-4" /> Descargar Excel
          </a>
        )}
      </div>

      {/* Progress (only RUNNING/PENDING) */}
      {running && (
        <div className="bg-card border border-border rounded-xl p-5">
          <ProgressBar value={job.progress} label="Progreso de extracción" />
          <p className="text-xs text-muted-foreground mt-3">
            {job.totalProducts} productos extraídos hasta ahora
          </p>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          {
            label: "Duración",
            value: formatDuration(job.startedAt, job.finishedAt),
          },
          { label: "Total productos", value: job.totalProducts },
          {
            label: "Con precio",
            value: job.productsWithPrice,
            color: "text-accent",
          },
          {
            label: "Sin SKU",
            value: job.productsWithoutSku,
            color: "text-amber-400",
          },
        ].map((s) => (
          <div
            key={s.label}
            className="bg-card border border-border rounded-xl p-4"
          >
            <p className="text-[11px] text-muted-foreground uppercase tracking-wider">
              {s.label}
            </p>
            <p className={`text-2xl font-semibold mt-1 ${s.color ?? ""}`}>
              {s.value}
            </p>
          </div>
        ))}
      </div>

      {job.errorMessage && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 text-sm text-red-300">
          <strong className="font-semibold">Error:</strong> {job.errorMessage}
        </div>
      )}

      {/* Products table with search/filter (client) */}
      {job.products.length > 0 && <ProductsTable products={job.products} />}

      {/* Logs */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-border">
          <h2 className="font-semibold text-sm">Logs ({job.logs.length})</h2>
        </div>
        <div className="h-72 overflow-y-auto p-4 bg-[hsl(var(--surface-row))] font-mono text-xs space-y-0.5">
          {job.logs.map((log) => (
            <div key={log.id} className="flex gap-2">
              <span className="text-muted-foreground/40 select-none">
                {formatDate(log.createdAt)}
              </span>
              <span
                className={`font-medium w-12 flex-shrink-0 ${levelColor[log.level] ?? ""}`}
              >
                [{log.level}]
              </span>
              <span className="text-foreground/90">{log.message}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
