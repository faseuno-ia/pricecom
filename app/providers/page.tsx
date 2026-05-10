import { prisma } from "@/lib/db/client";
import { formatDate } from "@/lib/utils";
import { PlusCircle, Store, ExternalLink, Settings, CheckCircle, XCircle } from "lucide-react";
import Link from "next/link";

export default async function ProvidersPage() {
  const providers = await prisma.provider.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { extractionJobs: true } },
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Proveedores</h1>
          <p className="text-muted-foreground mt-1 text-sm">{providers.length} proveedores registrados</p>
        </div>
        <Link
          href="/providers/new"
          className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors"
        >
          <PlusCircle className="w-4 h-4" />
          Nuevo proveedor
        </Link>
      </div>

      {providers.length === 0 ? (
        <div className="bg-card border rounded-xl flex flex-col items-center py-16 text-muted-foreground">
          <Store className="w-10 h-10 mb-3 opacity-20" />
          <p className="text-sm font-medium">Sin proveedores todavía</p>
          <Link href="/providers/new" className="text-primary text-sm mt-2 hover:underline">
            Crear primer proveedor
          </Link>
        </div>
      ) : (
        <div className="grid gap-3">
          {providers.map((p) => (
            <div key={p.id} className="bg-card border rounded-xl p-5 flex items-center justify-between hover:border-primary/30 transition-colors">
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center">
                  <Store className="w-5 h-5 text-muted-foreground" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <p className="font-semibold text-sm">{p.name}</p>
                    {p.isActive ? (
                      <span className="flex items-center gap-1 text-xs text-emerald-600 font-medium">
                        <CheckCircle className="w-3 h-3" /> Activo
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-xs text-red-500 font-medium">
                        <XCircle className="w-3 h-3" /> Inactivo
                      </span>
                    )}
                    {p.requiresLogin && (
                      <span className="text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded font-medium">
                        Requiere login
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-0.5">
                    <a
                      href={p.baseUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1"
                    >
                      {p.baseUrl.slice(0, 50)}... <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                  {p.lastExtractionAt && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Última extracción: {formatDate(p.lastExtractionAt)}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">{p._count.extractionJobs} extracciones</span>
                <Link
                  href={`/providers/${p.id}/config`}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground border rounded-lg px-3 py-1.5 hover:border-primary/40 transition-colors"
                >
                  <Settings className="w-3.5 h-3.5" /> Selectores
                </Link>
                <Link
                  href={`/providers/${p.id}/edit`}
                  className="text-xs text-primary border border-primary/30 rounded-lg px-3 py-1.5 hover:bg-primary hover:text-white transition-colors"
                >
                  Editar
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
