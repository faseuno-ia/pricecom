import { prisma } from "@/lib/db/client";
import { notFound } from "next/navigation";
import { formatDate, formatPrice } from "@/lib/utils";
import { Download, ExternalLink, ArrowLeft } from "lucide-react";
import Link from "next/link";

const statusLabel: Record<string, string> = {
  PENDING: "Pendiente", RUNNING: "En proceso",
  COMPLETED: "Completado", FAILED: "Fallido",
};
const statusClass: Record<string, string> = {
  PENDING: "badge-pending", RUNNING: "badge-running",
  COMPLETED: "badge-completed", FAILED: "badge-failed",
};

export default async function ExtractionDetailPage({ params }: { params: { id: string } }) {
  const job = await prisma.extractionJob.findUnique({
    where: { id: params.id },
    include: {
      provider: { select: { name: true } },
      products: { orderBy: { extractedAt: "desc" }, take: 50 },
      logs: { orderBy: { createdAt: "asc" }, take: 100 },
    },
  });
  if (!job) notFound();

  const levelColor: Record<string, string> = {
    INFO: "text-blue-700", WARN: "text-amber-600",
    ERROR: "text-red-600", DEBUG: "text-muted-foreground",
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <Link href="/extractions" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-2">
            <ArrowLeft className="w-3.5 h-3.5" /> Volver
          </Link>
          <h1 className="text-2xl font-semibold">{job.provider.name}</h1>
          <p className="text-muted-foreground mt-1 text-sm">{formatDate(job.createdAt)}</p>
        </div>
        <div className="flex items-center gap-3">
          <span className={`text-sm px-3 py-1 rounded-full font-medium ${statusClass[job.status]}`}>
            {statusLabel[job.status]}
          </span>
          {job.excelFileUrl && (
            <a
              href={job.excelFileUrl}
              download
              className="flex items-center gap-2 bg-emerald-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-emerald-700 transition-colors"
            >
              <Download className="w-4 h-4" /> Descargar Excel
            </a>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: "Total productos", value: job.totalProducts },
          { label: "Con precio", value: job.productsWithPrice },
          { label: "Sin precio", value: job.productsWithoutPrice },
          { label: "Sin SKU", value: job.productsWithoutSku },
        ].map((s) => (
          <div key={s.label} className="bg-card border rounded-xl p-4">
            <p className="text-xs text-muted-foreground">{s.label}</p>
            <p className="text-2xl font-semibold mt-1">{s.value}</p>
          </div>
        ))}
      </div>

      {job.errorMessage && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700">
          <strong>Error:</strong> {job.errorMessage}
        </div>
      )}

      {/* Products table */}
      {job.products.length > 0 && (
        <div className="bg-card border rounded-xl overflow-hidden">
          <div className="px-5 py-3 border-b flex items-center justify-between">
            <h2 className="font-semibold text-sm">
              Productos ({job.products.length}{job.products.length === 50 ? "+" : ""})
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b bg-muted/40">
                  {["SKU", "Nombre", "Precio", "Precio ant.", "Stock", "Categoría", "URL"].map((h) => (
                    <th key={h} className="text-left px-4 py-2.5 font-medium text-muted-foreground uppercase tracking-wide">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y">
                {job.products.map((p) => (
                  <tr key={p.id} className="hover:bg-muted/20">
                    <td className="px-4 py-2.5 font-mono text-muted-foreground">{p.sku ?? "—"}</td>
                    <td className="px-4 py-2.5 max-w-xs truncate font-medium">{p.name}</td>
                    <td className="px-4 py-2.5 font-mono text-emerald-700">
                      {p.wholesalePrice ? formatPrice(Number(p.wholesalePrice)) : "—"}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-muted-foreground line-through">
                      {p.oldPrice ? formatPrice(Number(p.oldPrice)) : ""}
                    </td>
                    <td className="px-4 py-2.5">{p.stock ?? "—"}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">{p.category ?? "—"}</td>
                    <td className="px-4 py-2.5">
                      {p.productUrl && (
                        <a href={p.productUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline flex items-center gap-1">
                          Ver <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Logs */}
      <div className="bg-card border rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b">
          <h2 className="font-semibold text-sm">Logs ({job.logs.length})</h2>
        </div>
        <div className="h-64 overflow-y-auto p-4 bg-[hsl(214,30%,97%)] font-mono text-xs space-y-0.5">
          {job.logs.map((log) => (
            <div key={log.id} className="flex gap-2">
              <span className="text-muted-foreground/50 select-none">{formatDate(log.createdAt)}</span>
              <span className={`font-medium w-12 flex-shrink-0 ${levelColor[log.level] ?? ""}`}>[{log.level}]</span>
              <span className="text-foreground/80">{log.message}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
