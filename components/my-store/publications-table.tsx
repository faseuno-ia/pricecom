"use client";

import { useEffect, useState } from "react";
import {
  ImageOff,
  ExternalLink,
  RefreshCw,
  Edit,
  Search,
  Loader2,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { toast } from "sonner";
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

type Filter =
  | "ALL"
  | "ACTIVE"
  | "DRAFT"
  | "PAUSED"
  | "ERROR"
  | "PENDING_SYNC"
  | "OUTDATED";

const statusBadgeFor: Record<PubStatus, { label: string; cls: string }> = {
  ACTIVE: { label: "Publicado", cls: "bg-accent/15 text-accent border-accent/30" },
  DRAFT: { label: "Borrador", cls: "bg-blue-500/15 text-blue-300 border-blue-500/30" },
  PAUSED: { label: "Pausado", cls: "bg-amber-500/15 text-amber-300 border-amber-500/30" },
  REMOVED: { label: "Removido", cls: "bg-muted/30 text-muted-foreground border-border" },
  ERROR: { label: "Error", cls: "bg-red-500/15 text-red-300 border-red-500/30" },
};

const syncBadgeFor: Record<SyncStatus, { label: string; cls: string }> = {
  READY: { label: "Listo", cls: "bg-blue-500/15 text-blue-300 border-blue-500/30" },
  PENDING_SYNC: { label: "Pend. sync", cls: "bg-amber-500/15 text-amber-300 border-amber-500/30" },
  SYNCED: { label: "Sincronizado", cls: "bg-green-500/15 text-green-300 border-green-500/30" },
  OUTDATED: { label: "Desactualizado", cls: "bg-orange-500/15 text-orange-300 border-orange-500/30" },
  ERROR: { label: "Error sync", cls: "bg-red-500/15 text-red-300 border-red-500/30" },
  PAUSED: { label: "Pausado", cls: "bg-muted/30 text-muted-foreground border-border" },
};

const FILTER_LABELS: Record<Filter, string> = {
  ALL: "Todos",
  ACTIVE: "Publicados",
  DRAFT: "Borradores",
  PAUSED: "Pausados",
  ERROR: "Errores",
  PENDING_SYNC: "Pend. sync",
  OUTDATED: "Desactualizados",
};

function formatPrice(p: number | null): string {
  if (p == null) return "—";
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 0,
  }).format(p);
}

export function PublicationsTable() {
  const [filter, setFilter] = useState<Filter>("ALL");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [data, setData] = useState<{ publications: PubRow[]; total: number }>({
    publications: [],
    total: 0,
  });
  const [loading, setLoading] = useState(false);
  const [failedImages, setFailedImages] = useState<Set<string>>(new Set());
  const [drawerFor, setDrawerFor] = useState<PubRow | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Reset de página al cambiar filtro o search.
  useEffect(() => {
    setPage(1);
  }, [filter, search]);

  async function handleSyncRow(p: PubRow) {
    setSyncingId(p.id);
    try {
      const res = await fetch("/api/my-store/sync/publications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ catalogProductIds: [p.catalogProduct.id] }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error ?? `HTTP ${res.status}`);
      }
      const { synced, errors } = (await res.json()) as {
        synced: number;
        errors: { catalogProductId: string; error: string }[];
        total: number;
      };
      if (errors.length > 0) {
        toast.error(
          `Error al sincronizar: ${errors[0].error.slice(0, 120)}`
        );
      } else {
        toast.success(
          synced > 0 ? "Publicación sincronizada" : "Sin cambios para sincronizar"
        );
      }
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSyncingId(null);
    }
  }

  // Fetch con debounce sobre search; los demás cambios disparan inmediato.
  useEffect(() => {
    let cancelled = false;
    const debounce = search ? 300 : 0;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        params.set("page", String(page));
        params.set("pageSize", String(pageSize));
        if (filter !== "ALL") params.set("filter", filter);
        if (search.trim()) params.set("search", search.trim());
        const res = await fetch(
          `/api/my-store/publications?${params.toString()}`
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as {
          publications: PubRow[];
          total: number;
        };
        if (!cancelled) setData(json);
      } catch (err) {
        if (!cancelled) toast.error((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, debounce);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [page, pageSize, filter, search, reloadKey]);

  const drawerDetail: PubDetail | null = drawerFor ? { ...drawerFor } : null;
  const totalPages = Math.max(1, Math.ceil(data.total / pageSize));

  const FILTERS_ORDER: Filter[] = [
    "ALL",
    "ACTIVE",
    "DRAFT",
    "PAUSED",
    "ERROR",
    "PENDING_SYNC",
    "OUTDATED",
  ];

  return (
    <div className="space-y-3">
      {/* Toolbar: filtros + search + pageSize */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 flex-wrap">
          {FILTERS_ORDER.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${
                filter === f
                  ? "bg-primary/15 text-primary border-primary/40"
                  : "border-border text-muted-foreground hover:text-foreground hover:bg-muted/40"
              }`}
            >
              {FILTER_LABELS[f]}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 ml-auto">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por SKU o nombre…"
              className="text-sm bg-background border border-border rounded-md pl-8 pr-3 py-1.5 w-64 focus:outline-none focus:ring-1 focus:ring-primary/60"
            />
          </div>
          <select
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              setPage(1);
            }}
            className="text-xs bg-background border border-border rounded-md px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/60"
          >
            <option value={50}>50 por página</option>
            <option value={100}>100 por página</option>
            <option value={200}>200 por página</option>
          </select>
        </div>
      </div>

      {/* Tabla */}
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
              {loading && data.publications.length === 0 && (
                <tr>
                  <td
                    colSpan={9}
                    className="px-4 py-10 text-center text-muted-foreground"
                  >
                    <Loader2 className="w-4 h-4 animate-spin inline-block mr-2" />
                    Cargando…
                  </td>
                </tr>
              )}
              {!loading && data.publications.length === 0 && (
                <tr>
                  <td
                    colSpan={9}
                    className="px-4 py-10 text-center text-muted-foreground"
                  >
                    {search
                      ? `Sin publicaciones para "${search}"`
                      : "Sin publicaciones para este filtro"}
                  </td>
                </tr>
              )}
              {data.publications.map((p) => {
                const sBadge = statusBadgeFor[p.status];
                const syncB = syncBadgeFor[p.syncStatus];
                const sku =
                  p.externalSku ?? p.catalogProduct.publicationSku ?? "—";
                const displayName =
                  p.catalogProduct.commercialTitle ?? p.catalogProduct.supplierName;
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
                        {(() => {
                          // Habilitado solo cuando hay algo que empujar:
                          // OUTDATED (drift por edición local), PENDING_SYNC
                          // (encolado por el worker / importer) o ERROR (último
                          // push falló). Para SYNCED/READY no hay nada que hacer.
                          const canSync =
                            p.syncStatus === "OUTDATED" ||
                            p.syncStatus === "PENDING_SYNC" ||
                            p.syncStatus === "ERROR" ||
                            p.pendingSync;
                          const isSyncing = syncingId === p.id;
                          return (
                            <button
                              type="button"
                              disabled={!canSync || isSyncing}
                              onClick={() => handleSyncRow(p)}
                              title={
                                canSync
                                  ? "Forzar sync individual"
                                  : "Sin cambios pendientes para sincronizar"
                              }
                              className={
                                canSync
                                  ? "text-primary hover:text-primary/80 disabled:opacity-60"
                                  : "text-muted-foreground/40 cursor-not-allowed"
                              }
                            >
                              {isSyncing ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <RefreshCw className="w-3.5 h-3.5" />
                              )}
                            </button>
                          );
                        })()}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Paginación */}
        {data.total > 0 && (
          <div className="px-5 py-3 border-t border-border flex items-center justify-between text-xs text-muted-foreground flex-wrap gap-2">
            <span>
              {(page - 1) * pageSize + 1}–
              {Math.min(page * pageSize, data.total)} de{" "}
              {data.total.toLocaleString("es-AR")}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1 || loading}
                className="flex items-center gap-1 px-3 py-1.5 rounded-md border border-border hover:bg-muted/40 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ChevronLeft className="w-3.5 h-3.5" /> Anterior
              </button>
              <span>
                {page} / {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages || loading}
                className="flex items-center gap-1 px-3 py-1.5 rounded-md border border-border hover:bg-muted/40 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Siguiente <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>

      <PublicationDrawer
        publication={drawerDetail}
        onClose={() => setDrawerFor(null)}
        onChanged={() => setDrawerFor(null)}
      />
    </div>
  );
}
