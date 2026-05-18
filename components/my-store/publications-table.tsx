"use client";

import { useState, useMemo } from "react";
import { ImageOff, ExternalLink, RefreshCw } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { es } from "date-fns/locale";

type PubStatus = "DRAFT" | "ACTIVE" | "PAUSED" | "REMOVED" | "ERROR";

interface PubRow {
  id: string;
  status: PubStatus;
  externalProductId: string | null;
  externalSku: string | null;
  externalStatus: string | null;
  externalUrl: string | null;
  priceInStore: number | null;
  stockInStore: number | null;
  categoryInStore: string | null;
  lastSyncedAt: string | null;
  pendingSync: boolean;
  syncError: string | null;
  catalogProduct: {
    id: string;
    publicationSku: string | null;
    commercialTitle: string | null;
    supplierName: string;
    imageUrl: string | null;
  };
}

interface Props {
  publications: PubRow[];
}

type Filter = "ALL" | "ACTIVE" | "DRAFT" | "PAUSED" | "ERROR" | "PENDING";

const statusBadgeFor: Record<PubStatus, { label: string; cls: string }> = {
  ACTIVE: {
    label: "Publicado",
    cls: "bg-accent/15 text-accent border-accent/30",
  },
  DRAFT: {
    label: "Borrador",
    cls: "bg-blue-500/15 text-blue-300 border-blue-500/30",
  },
  PAUSED: {
    label: "Pausado",
    cls: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  },
  REMOVED: {
    label: "Removido",
    cls: "bg-muted/30 text-muted-foreground border-border",
  },
  ERROR: {
    label: "Error",
    cls: "bg-red-500/15 text-red-300 border-red-500/30",
  },
};

function formatPrice(p: number | null): string {
  if (p == null) return "—";
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 0,
  }).format(p);
}

export function PublicationsTable({ publications }: Props) {
  const [filter, setFilter] = useState<Filter>("ALL");
  const [failedImages, setFailedImages] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    if (filter === "ALL") return publications;
    if (filter === "PENDING") return publications.filter((p) => p.pendingSync);
    return publications.filter((p) => p.status === filter);
  }, [publications, filter]);

  if (publications.length === 0) {
    return (
      <div className="bg-card border border-border rounded-xl p-10 text-center text-sm text-muted-foreground">
        Todavía no hay publicaciones sincronizadas. Importá productos para
        empezar.
      </div>
    );
  }

  const filters: { key: Filter; label: string; count: number }[] = [
    { key: "ALL", label: "Todos", count: publications.length },
    {
      key: "ACTIVE",
      label: "Publicados",
      count: publications.filter((p) => p.status === "ACTIVE").length,
    },
    {
      key: "DRAFT",
      label: "Borradores",
      count: publications.filter((p) => p.status === "DRAFT").length,
    },
    {
      key: "PAUSED",
      label: "Pausados",
      count: publications.filter((p) => p.status === "PAUSED").length,
    },
    {
      key: "ERROR",
      label: "Errores",
      count: publications.filter((p) => p.status === "ERROR").length,
    },
    {
      key: "PENDING",
      label: "Pend. sync",
      count: publications.filter((p) => p.pendingSync).length,
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5 flex-wrap">
        {filters.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${
              filter === f.key
                ? "bg-primary/15 text-primary border-primary/40"
                : "border-border text-muted-foreground hover:text-foreground hover:bg-muted/40"
            }`}
          >
            {f.label}{" "}
            <span className="opacity-70 font-mono ml-1">{f.count}</span>
          </button>
        ))}
      </div>

      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-muted/20">
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider w-[56px]">
                  Img
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider">
                  SKU tienda
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider">
                  Producto
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider">
                  Precio tienda
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider">
                  Estado
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider">
                  Stock
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider">
                  Última sync
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider w-[80px]">
                  Acc.
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td
                    colSpan={8}
                    className="px-4 py-8 text-center text-muted-foreground"
                  >
                    Sin publicaciones para este filtro
                  </td>
                </tr>
              )}
              {filtered.map((p) => {
                const badge = statusBadgeFor[p.status];
                const sku =
                  p.externalSku ?? p.catalogProduct.publicationSku ?? "—";
                const displayName =
                  p.catalogProduct.commercialTitle ??
                  p.catalogProduct.supplierName;
                const image = p.catalogProduct.imageUrl;
                const imageFailed = failedImages.has(p.id);
                return (
                  <tr
                    key={p.id}
                    className="border-b border-border hover:bg-muted/10 transition-colors"
                  >
                    <td className="px-3 py-2">
                      {image && !imageFailed ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={image}
                          alt=""
                          loading="lazy"
                          className="w-9 h-9 rounded-md object-cover bg-muted/30 border border-border"
                          onError={() =>
                            setFailedImages((s) => new Set(s).add(p.id))
                          }
                        />
                      ) : (
                        <div className="w-9 h-9 rounded-md bg-muted/20 border border-border flex items-center justify-center text-muted-foreground/50">
                          <ImageOff className="w-3.5 h-3.5" />
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono text-sm font-semibold">
                      {sku}
                    </td>
                    <td className="px-3 py-2">
                      <p
                        className="font-medium truncate"
                        style={{ maxWidth: 240 }}
                      >
                        {displayName}
                      </p>
                      {p.categoryInStore && (
                        <p className="text-[10px] text-muted-foreground truncate">
                          {p.categoryInStore}
                        </p>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono">
                      {formatPrice(p.priceInStore)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span
                        className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${badge.cls}`}
                      >
                        {badge.label}
                      </span>
                      {p.pendingSync && (
                        <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded border font-medium bg-orange-500/10 text-orange-300 border-orange-500/30">
                          Pend.
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {p.stockInStore ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                      {p.lastSyncedAt
                        ? formatDistanceToNow(new Date(p.lastSyncedAt), {
                            locale: es,
                            addSuffix: true,
                          })
                        : "—"}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        {p.externalUrl && (
                          <a
                            href={p.externalUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="Ver en la tienda"
                            className="text-muted-foreground hover:text-foreground"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                          </a>
                        )}
                        <button
                          type="button"
                          disabled
                          title="Próximamente — forzar sync individual"
                          className="text-muted-foreground/40 cursor-not-allowed"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
