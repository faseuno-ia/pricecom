import { prisma } from "@/lib/db/client";
import { formatDate } from "@/lib/utils";
import { Download, FileText, Store } from "lucide-react";
import Link from "next/link";

const statusLabel: Record<string, string> = {
  PENDING: "Pendiente", RUNNING: "En proceso",
  COMPLETED: "Completado", FAILED: "Fallido", CANCELLED: "Cancelado",
};
const statusClass: Record<string, string> = {
  PENDING: "badge-pending", RUNNING: "badge-running",
  COMPLETED: "badge-completed", FAILED: "badge-failed", CANCELLED: "badge-cancelled",
};

export default async function ExtractionsPage() {
  const jobs = await prisma.extractionJob.findMany({
    orderBy: { createdAt: "desc" },
    include: { provider: { select: { name: true } } },
    take: 50,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Extracciones</h1>
          <p className="text-muted-foreground mt-1 text-sm">Historial de extracciones realizadas</p>
        </div>
        <Link
          href="/new-extraction"
          className="bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors"
        >
          Nueva extracción
        </Link>
      </div>

      {jobs.length === 0 ? (
        <div className="bg-card border rounded-xl flex flex-col items-center py-16 text-muted-foreground">
          <FileText className="w-10 h-10 mb-3 opacity-20" />
          <p className="text-sm font-medium">Sin extracciones todavía</p>
        </div>
      ) : (
        <div className="bg-card border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40">
                {["Proveedor", "Fecha", "Estado", "Productos", "Con precio", "Sin SKU", "Acciones"].map((h) => (
                  <th key={h} className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {jobs.map((job) => (
                <tr key={job.id} className="hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Store className="w-3.5 h-3.5 text-muted-foreground" />
                      <span className="font-medium">{job.provider.name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground text-xs">{formatDate(job.createdAt)}</td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusClass[job.status]}`}>
                      {statusLabel[job.status]}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono">{job.totalProducts}</td>
                  <td className="px-4 py-3 font-mono text-emerald-700">{job.productsWithPrice}</td>
                  <td className="px-4 py-3 font-mono text-amber-600">{job.productsWithoutSku}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Link href={`/extractions/${job.id}`} className="text-xs text-primary hover:underline">
                        Ver
                      </Link>
                      {job.excelFileUrl && (
                        <a
                          href={job.excelFileUrl}
                          download
                          className="flex items-center gap-1 text-xs text-emerald-700 hover:underline"
                        >
                          <Download className="w-3 h-3" /> Excel
                        </a>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
