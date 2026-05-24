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
  Upload,
  FileSpreadsheet,
  Hand,
  Globe,
  Boxes,
} from "lucide-react";
import Link from "next/link";
import { ProviderActions } from "@/components/providers/provider-actions";
import { requireSession } from "@/lib/auth";
import type { ProviderType } from "@prisma/client";

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

export default async function ProvidersPage() {
  const session = await requireSession();
  const [providers, ownStockCount, ownStockProvider] = await Promise.all([
    prisma.provider.findMany({
      where: { userId: session.user.id },
      orderBy: { createdAt: "desc" },
      include: {
        _count: {
          select: {
            extractionJobs: true,
            // Conteo "usable": excluye ignorados y excluye removidos por proveedor
            // **solo** cuando dependen del proveedor. OWN/HYBRID sobreviven.
            catalogProducts: {
              where: {
                NOT: [
                  { internalStatus: "IGNORED" },
                  {
                    AND: [
                      { supplierStatus: "SUPPLIER_REMOVED" },
                      { stockSource: "SUPPLIER" },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    }),
    // Total de productos en stock propio del usuario (cualquier provider).
    // Excluye IGNORED para que el número coincida con el resto del UI, donde
    // los ignorados se ocultan por defecto.
    prisma.catalogProduct.count({
      where: {
        userId: session.user.id,
        stockSource: "OWN",
        internalStatus: { not: "IGNORED" },
      },
    }),
    // Provider OWN_STOCK del usuario, si existe — destino default para los
    // botones de "Agregar" e "Importar".
    prisma.provider.findFirst({
      where: { userId: session.user.id, providerType: "OWN_STOCK" },
      select: { id: true },
    }),
  ]);
  // ownStockProvider se sigue cargando porque la card OWN_STOCK en la grilla
  // de abajo usa sus botones internos de "Agregar" e "Importar Excel". El
  // conteo cross-provider (ownStockCount) lo consume la misma card para
  // mostrar el número total de productos OWN.

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

      {/* Barra "Stock propio" eliminada: el punto de entrada unificado es
          la card del provider OWN_STOCK ("Mi stock") en la grilla, que ahora
          linkea directo a /catalog?stockSource=OWN y muestra los productos
          cross-provider con stockSource=OWN. */}

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
            const tBadge = typeBadge[p.providerType];
            const TypeIcon = tBadge.icon;
            const isScraper = p.providerType === "SCRAPER";
            return (
              <div
                key={p.id}
                className="relative bg-card border border-border rounded-xl p-5 flex flex-col gap-4 hover:border-primary/40 transition-colors"
              >
                <Link
                  href={
                    p.providerType === "OWN_STOCK"
                      ? "/catalog?stockSource=OWN"
                      : `/providers/${p.id}`
                  }
                  className="absolute inset-0 rounded-xl"
                  aria-label={`Ver ${p.name}`}
                />

                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                      <Store className="w-5 h-5 text-primary" />
                    </div>
                    <div className="min-w-0">
                      <p className="font-semibold text-sm truncate">{p.name}</p>
                      {p.baseUrl ? (
                        <a
                          href={p.baseUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="relative text-xs text-muted-foreground hover:text-primary flex items-center gap-1 w-fit"
                        >
                          <span className="truncate">{hostname}</span>
                          <ExternalLink className="w-3 h-3 flex-shrink-0" />
                        </a>
                      ) : (
                        <span className="text-xs text-muted-foreground/60">
                          Sin URL
                        </span>
                      )}
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

                <div className="flex items-center gap-1.5 flex-wrap">
                  <span
                    className={`inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full border whitespace-nowrap ${tBadge.className}`}
                  >
                    <TypeIcon className="w-2.5 h-2.5" />
                    {tBadge.label}
                  </span>
                  {p.requiresLogin && (
                    <span className="inline-flex items-center gap-1 text-[10px] text-amber-300 bg-amber-500/10 border border-amber-500/30 px-2 py-0.5 rounded-full">
                      <Lock className="w-2.5 h-2.5" /> Requiere login
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-3 text-xs">
                  {isScraper ? (
                    <>
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
                    </>
                  ) : (
                    <>
                      <div>
                        <p className="text-muted-foreground text-[10px] uppercase tracking-wider">
                          Productos
                        </p>
                        <p className="font-mono font-semibold mt-0.5">
                          {/* Para OWN_STOCK usamos el conteo unificado (cross-provider,
                              stockSource=OWN, excluye IGNORED) — mismo número que la card
                              "Stock propio" de arriba. Para el resto, el conteo "usable"
                              específico del provider. */}
                          {(p.providerType === "OWN_STOCK"
                            ? ownStockCount
                            : p._count.catalogProducts
                          ).toLocaleString("es-AR")}
                        </p>
                      </div>
                      <div>
                        <p className="text-muted-foreground text-[10px] uppercase tracking-wider">
                          Creado
                        </p>
                        <p className="font-medium mt-0.5 truncate">
                          {formatDate(p.createdAt)}
                        </p>
                      </div>
                    </>
                  )}
                </div>

                <div className="relative flex items-center gap-1.5 pt-2 border-t border-border">
                  {isScraper ? (
                    <>
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
                    </>
                  ) : (
                    <>
                      <Link
                        href={`/catalog/new?providerId=${p.id}`}
                        className="flex-1 flex items-center justify-center gap-1.5 text-xs bg-primary/10 text-primary hover:bg-primary hover:text-primary-foreground rounded-md px-2 py-1.5 transition-colors font-medium"
                        title="Agregar producto manual"
                      >
                        <PlusCircle className="w-3 h-3" /> Agregar producto
                      </Link>
                      <Link
                        href={`/catalog/import?providerId=${p.id}`}
                        className="flex items-center justify-center gap-1 text-xs border border-border text-muted-foreground hover:text-foreground hover:bg-muted/40 rounded-md px-2 py-1.5 transition-colors"
                        title="Importar Excel"
                      >
                        <Upload className="w-3.5 h-3.5" />
                      </Link>
                    </>
                  )}
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
