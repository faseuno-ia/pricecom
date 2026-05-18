"use client";

import { useState, useMemo } from "react";
import { ImageOff, ExternalLink, RefreshCw, Edit } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { es } from "date-fns/locale";
import { PublicationDrawer, type PubDetail } from "./publication-drawer";

type PubStatus = "DRAFT" | "ACTIVE" | "PAUSED" | "REMOVED" | "ERROR";
type SyncStatus =
  | "READY"
  | "PENDING_SYNC"
  | "SYNCED"
  | "OUTDATED"
  | "ERROR"
  | "PAUSED";

interface PubRow {
  id: string;
  status: PubStatus;
  syncStatus: SyncStatus;
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
    finalPrice: number | null;
    stock: string | null;
    stockSource: "SUPPLIER" | "OWN" | "HYBRID";
    pricing?: { effectivePrice: number | null };
  };
}

interface Props {
  publications: PubRow[];
}

type Filter =
  | "ALL"
  | "ACTIVE"
  | "DRAFT"
  | "PAUSED"
  | "ERROR"
  | "PENDING_SYNC"
  | "OUTDATED";

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

const syncBadgeFor: Record<SyncStatus, { label: string; cls: string }> = {
  READY: {
    label: "Listo",
    cls: "bg-blue-500/15 text-blue-300 border-blue-500/30",
  },
  PENDING_SYNC: {
    label: "Pend. sync",
    cls: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  },
  SYNCED: {
    label: "Sincronizado",
    cls: "bg-green-500/15 text-green-300 border-green-500/30",
  },
  OUTDATED: {
    label: "Desactualizado",
    cls: "bg-orange-500/15 text-orange-300 border-orange-500/30",
  },
  ERROR: {
    label: "Error sync",
    cls: "bg-red-500/15 text-red-300 border-red-500/30",
  },
  PAUSED: {
    label: "Pausado",
    cls: "bg-muted/30 text-muted-foreground border-border",
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
  const [drawerFor, setDrawerFor] = useState<PubRow | null>(null);

  const filtered = useMemo(() => {
    if (filter === "ALL") return publications;
    if (filter === "PENDING_SYNC")
      return publications.filter(
        (p) => p.syncStatus === "PENDING_SYNC" || p.pendingSync
      );
    if (filter === "OUTDATED")
      return publications.filter((p) => p.syncStatus === "OUTDATED");
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
      key: "PENDING_SYNC",
      label: "Pend. sync",
      count: publications.filter(
        (p) => p.syncStatus === "PENDING_SYNC" || p.pendingSync
      ).length,
    },
    {
      key: "OUTDATED",
      label: "Desactualizados",
      count: publications.filter((p) => p.syncStatus === "OUTDATED").length,
    },
  ];

  const drawerDetail: PubDetail | null = drawerFor
    ? { ...drawerFor }
    : null;

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
                  Sync
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider">
                  Stock
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider">
                  Última sync
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider w-[100px]">
                  Acc.
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td
                    colSpan={9}
                    className="px-4 py-8 text-center text-muted-foreground"
                  >
                    Sin publicaciones para este filtro
                  </td>
                </tr>
              )}
              {filtered.map((p) => {
                const sBadge = statusBadgeFor[p.status];
                const syncB = syncBadgeFor[p.syncStatus];
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
                        className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${sBadge.cls}`}
                      >
                        {sBadge.label}
                      </span>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span
                        className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${syncB.cls}`}
                      >
                        {syncB.label}
                      </span>
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
                        <button
                          type="button"
                          onClick={() => setDrawerFor(p)}
                          title="Ver detalle"
                          className="text-primary hover:text-primary/80"
                        >
                          <Edit className="w-3.5 h-3.5" />
                        </button>
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

      <PublicationDrawer
        publication={drawerDetail}
        onClose={() => setDrawerFor(null)}
        onChanged={() => setDrawerFor(null)}
      />
    </div>
  );
}
