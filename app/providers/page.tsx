import { prisma } from "@/lib/db/client";
import { formatDate } from "@/lib/utils";
import {
  PlusCircle,
  Store,
  ExternalLink,
  Settings,
  Edit,
  Play,
  Lock,
} from "lucide-react";
import Link from "next/link";
import { ProviderActions } from "@/components/providers/provider-actions";

export default async function ProvidersPage() {
  const providers = await prisma.provider.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { extractionJobs: true } } },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Proveedores</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {providers.length} proveedor{providers.length === 1 ? "" : "es"}{" "}
            registrado{providers.length === 1 ? "" : "s"}
          </p>
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
        <div className="bg-card border border-border rounded-xl flex flex-col items-center py-16 text-muted-foreground">
          <Store className="w-10 h-10 mb-3 opacity-20" />
          <p className="text-sm font-medium">Sin proveedores todavía</p>
          <Link
            href="/providers/new"
            className="text-primary text-sm mt-2 hover:underline"
          >
            Crear primer proveedor
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {providers.map((p) => {
            const hostname = (() => {
              try {
                return new URL(p.baseUrl).hostname.replace(/^www\./, "");
              } catch {
                return p.baseUrl;
              }
            })();
            return (
              <div
                key={p.id}
                className="bg-card border border-border rounded-xl p-5 flex flex-col gap-4 hover:border-primary/40 transition-colors"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                      <Store className="w-5 h-5 text-primary" />
                    </div>
                    <div className="min-w-0">
                      <p className="font-semibold text-sm truncate">{p.name}</p>
                      <a
                        href={p.baseUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1"
                      >
                        <span className="truncate">{hostname}</span>
                        <ExternalLink className="w-3 h-3 flex-shrink-0" />
                      </a>
                    </div>
                  </div>
                  <span
                    className={`text-[10px] font-medium px-2 py-0.5 rounded-full border whitespace-nowrap ${
                      p.isActive
                        ? "bg-accent/10 text-accent border-accent/30"
                        : "bg-muted/40 text-muted-foreground border-border"
                    }`}
                  >
                    {p.isActive ? "Activo" : "Inactivo"}
                  </span>
                </div>

                {p.requiresLogin && (
                  <div className="inline-flex items-center gap-1.5 text-[10px] text-amber-300 bg-amber-500/10 border border-amber-500/30 px-2 py-0.5 rounded self-start">
                    <Lock className="w-2.5 h-2.5" /> Requiere login
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <p className="text-muted-foreground text-[10px] uppercase tracking-wider">
                      Extracciones
                    </p>
                    <p className="font-mono font-semibold mt-0.5">
                      {p._count.extractionJobs}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-[10px] uppercase tracking-wider">
                      Última
                    </p>
                    <p className="font-medium mt-0.5 truncate">
                      {p.lastExtractionAt ? formatDate(p.lastExtractionAt) : "—"}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 pt-2 border-t border-border">
                  <Link
                    href={`/new-extraction?providerId=${p.id}`}
                    className="flex-1 flex items-center justify-center gap-1.5 text-xs bg-primary/10 text-primary hover:bg-primary hover:text-primary-foreground rounded-md px-2 py-1.5 transition-colors font-medium"
                    title="Nueva extracción"
                  >
                    <Play className="w-3 h-3" /> Extraer
                  </Link>
                  <Link
                    href={`/providers/${p.id}/config`}
                    className="flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/40 rounded-md p-1.5 transition-colors"
                    title="Selectores"
                  >
                    <Settings className="w-3.5 h-3.5" />
                  </Link>
                  <Link
                    href={`/providers/${p.id}/edit`}
                    className="flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/40 rounded-md p-1.5 transition-colors"
                    title="Editar"
                  >
                    <Edit className="w-3.5 h-3.5" />
                  </Link>
                  <ProviderActions providerId={p.id} isActive={p.isActive} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
