import { prisma } from "@/lib/db/client";
import { formatDate } from "@/lib/utils";
import {
  Download,
  FileText,
  Store,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import Link from "next/link";
import { StatusBadge } from "@/components/ui/status-badge";
import { requireSession } from "@/lib/auth";

const PAGE_SIZE = 20;

function formatDuration(start: Date | null, end: Date | null): string {
  if (!start) return "—";
  const e = end ?? new Date();
  const sec = Math.round((e.getTime() - start.getTime()) / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem === 0 ? `${min}m` : `${min}m ${rem}s`;
}

export default async function ExtractionsPage({
  searchParams,
}: {
  searchParams: { page?: string };
}) {
  const session = await requireSession();
  const pageNum = Math.max(1, parseInt(searchParams.page ?? "1", 10) || 1);
  const skip = (pageNum - 1) * PAGE_SIZE;
  const where = { userId: session.user.id };

  const [total, jobs] = await Promise.all([
    prisma.extractionJob.count({ where }),
    prisma.extractionJob.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: { provider: { select: { name: true } } },
      take: PAGE_SIZE,
      skip,
    }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Extracciones</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {total} extracci{total === 1 ? "ón" : "ones"} en total
          </p>
        </div>
        <Link
          href="/new-extraction"
          className="bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors"
        >
          Nueva extracción
        </Link>
      </div>

      {jobs.length === 0 ? (
        <div className="bg-card border border-border rounded-xl flex flex-col items-center py-16 text-muted-foreground">
          <FileText className="w-10 h-10 mb-3 opacity-20" />
          <p className="text-sm font-medium">Sin extracciones todavía</p>
        </div>
      ) : (
        <>
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/20">
                    {[
                      "Proveedor",
                      "Fecha",
                      "Duración",
                      "Productos",
                      "Con precio",
                      "Estado",
                      "Acciones",
                    ].map((h) => (
                      <th
                        key={h}
                        className="text-left px-4 py-3 text-[11px] font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((job, i) => (
                    <tr
                      key={job.id}
                      className={
                        i % 2 === 1
                          ? "bg-[hsl(var(--surface-row))] hover:bg-muted/30 transition-colors"
                          : "hover:bg-muted/20 transition-colors"
                      }
                    >
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <Store className="w-3.5 h-3.5 text-muted-foreground" />
                          <span className="font-medium">{job.provider.name}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs whitespace-nowrap">
                        {formatDate(job.createdAt)}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground font-mono text-xs whitespace-nowrap">
                        {formatDuration(job.startedAt, job.finishedAt)}
                      </td>
                      <td className="px-4 py-3 font-mono">{job.totalProducts}</td>
                      <td className="px-4 py-3 font-mono text-accent">
                        {job.productsWithPrice}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={job.status} />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <Link
                            href={`/extractions/${job.id}`}
                            className="text-xs text-primary hover:underline"
                          >
                            Ver
                          </Link>
                          {job.status === "COMPLETED" && job.excelFileUrl && (
                            <a
                              href={job.excelFileUrl}
                              download
                              className="inline-flex items-center gap-1 text-xs bg-accent/10 text-accent hover:bg-accent hover:text-white border border-accent/30 px-2 py-1 rounded-md transition-colors"
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
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                Página {pageNum} de {totalPages} · {total} registros
              </p>
              <div className="flex items-center gap-2">
                <Link
                  href={`/extractions?page=${pageNum - 1}`}
                  aria-disabled={pageNum === 1}
                  className={`flex items-center gap-1 text-xs px-3 py-1.5 rounded-md border border-border ${
                    pageNum === 1
                      ? "opacity-40 pointer-events-none"
                      : "hover:bg-muted/30"
                  }`}
                >
                  <ChevronLeft className="w-3.5 h-3.5" /> Anterior
                </Link>
                <Link
                  href={`/extractions?page=${pageNum + 1}`}
                  aria-disabled={pageNum >= totalPages}
                  className={`flex items-center gap-1 text-xs px-3 py-1.5 rounded-md border border-border ${
                    pageNum >= totalPages
                      ? "opacity-40 pointer-events-none"
                      : "hover:bg-muted/30"
                  }`}
                >
                  Siguiente <ChevronRight className="w-3.5 h-3.5" />
                </Link>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
