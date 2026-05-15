"use client";

import { useState, useEffect, useMemo } from "react";
import { toast } from "sonner";
import {
  ImageOff,
  Eye,
  ChevronLeft,
  ChevronRight,
  Download,
  FileSpreadsheet,
  Check,
  Ban,
  Lock,
  Loader2,
  Search,
} from "lucide-react";
import { ProductDrawer } from "./product-drawer";

type ChangeType = "NEW" | "REMOVED" | "PRICE_UP" | "PRICE_DOWN" | "STOCK_CHANGED";
type DateRange = "24h" | "7d" | "30d" | "all";
type CatalogPill = "noCategory" | "noImage" | "notPublished";

export interface ChangeRow {
  id: string;
  sku: string | null;
  name: string;
  changeType: ChangeType;
  previousPrice: number | null;
  currentPrice: number | null;
  priceChangePercent: number | null;
  previousStock: string | null;
  currentStock: string | null;
  createdAt: string;
  providerId: string;
  providerName: string;
  jobId: string;
  product: {
    id: string;
    imageUrl: string | null;
    category: string | null;
    publicationStatus: string | null;
    productUrl: string | null;
    description: string | null;
  } | null;
}

interface Props {
  providers: { id: string; name: string }[];
  initialProviderId: string | null;
}

const changeTypeOrder: ChangeType[] = [
  "NEW",
  "PRICE_UP",
  "PRICE_DOWN",
  "STOCK_CHANGED",
  "REMOVED",
];

const changeTypeMeta: Record<
  ChangeType,
  { icon: string; label: string; short: string; className: string }
> = {
  NEW: {
    icon: "+",
    label: "Nuevo",
    short: "Nuevo",
    className: "bg-green-500/15 text-green-300 border-green-500/30",
  },
  REMOVED: {
    icon: "×",
    label: "Removido",
    short: "Removido",
    className: "bg-red-500/15 text-red-300 border-red-500/30",
  },
  PRICE_UP: {
    icon: "↑",
    label: "Precio subió",
    short: "↑Precio",
    className: "bg-orange-500/15 text-orange-300 border-orange-500/30",
  },
  PRICE_DOWN: {
    icon: "↓",
    label: "Precio bajó",
    short: "↓Precio",
    className: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  },
  STOCK_CHANGED: {
    icon: "~",
    label: "Stock cambió",
    short: "Stock",
    className: "bg-blue-500/15 text-blue-300 border-blue-500/30",
  },
};

const dateRangeLabel: Record<DateRange, string> = {
  "24h": "Últimas 24h",
  "7d": "7 días",
  "30d": "30 días",
  all: "Todo",
};

function fromForRange(range: DateRange): Date | null {
  const now = new Date();
  if (range === "24h") return new Date(now.getTime() - 24 * 60 * 60 * 1000);
  if (range === "7d") return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  if (range === "30d") return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  return null;
}

function providerColorClass(name: string): string {
  const palette = [
    "bg-purple-500/15 text-purple-300 border-purple-500/30",
    "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
    "bg-pink-500/15 text-pink-300 border-pink-500/30",
    "bg-yellow-500/15 text-yellow-300 border-yellow-500/30",
    "bg-indigo-500/15 text-indigo-300 border-indigo-500/30",
    "bg-rose-500/15 text-rose-300 border-rose-500/30",
  ];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return palette[Math.abs(h) % palette.length];
}

function pubStatusBadge(
  status: string | null
): { label: string; className: string } {
  switch (status) {
    case "published":
      return { label: "Pub.", className: "bg-accent/15 text-accent border-accent/30" };
    case "prepared":
      return { label: "Pend.", className: "bg-blue-500/15 text-blue-300 border-blue-500/30" };
    case "selected":
      return { label: "Sel.", className: "bg-amber-500/15 text-amber-300 border-amber-500/30" };
    default:
      return { label: "Nuevo", className: "bg-muted/40 text-muted-foreground border-border" };
  }
}

// Precio compacto: $5.000 sin decimales si son .00, $5.000,50 si tiene decimales.
function formatPriceCompact(p: number | null | undefined): string {
  if (p == null) return "—";
  if (Math.abs(p % 1) < 0.005) {
    return "$" + Math.round(p).toLocaleString("es-AR");
  }
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 2,
  }).format(p);
}

export function ChangesTable({ providers, initialProviderId }: Props) {
  const [providerId, setProviderId] = useState<string>(initialProviderId ?? "all");
  const [changeTypes, setChangeTypes] = useState<Set<ChangeType>>(new Set());
  const [pills, setPills] = useState<Set<CatalogPill>>(new Set());
  const [dateRange, setDateRange] = useState<DateRange>("all");
  const [page, setPage] = useState(1);
  const [pageSize] = useState(50);
  const [data, setData] = useState<{ changes: ChangeRow[]; total: number }>({
    changes: [],
    total: 0,
  });
  const [loading, setLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [drawerChange, setDrawerChange] = useState<ChangeRow | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    setPage(1);
  }, [providerId, changeTypes, dateRange]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (providerId !== "all") params.set("providerId", providerId);
        for (const t of changeTypes) params.append("changeType", t);
        const from = fromForRange(dateRange);
        if (from) params.set("from", from.toISOString());
        params.set("page", String(page));
        params.set("pageSize", String(pageSize));

        const res = await fetch(`/api/changes?${params.toString()}`);
        if (!res.ok) throw new Error("Error al cargar cambios");
        const json = (await res.json()) as { changes: ChangeRow[]; total: number };
        if (!cancelled) setData(json);
      } catch (err) {
        if (!cancelled) toast.error((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [providerId, changeTypes, dateRange, page, pageSize]);

  const filteredChanges = useMemo(() => {
    if (pills.size === 0) return data.changes;
    return data.changes.filter((c) => {
      if (pills.has("noCategory") && c.product?.category) return false;
      if (pills.has("noImage") && c.product?.imageUrl) return false;
      if (pills.has("notPublished") && c.product?.publicationStatus === "published") return false;
      return true;
    });
  }, [data.changes, pills]);

  const totalPages = Math.max(1, Math.ceil(data.total / pageSize));

  function toggleChangeType(t: ChangeType) {
    setChangeTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }
  function togglePill(p: CatalogPill) {
    setPills((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }
  function toggleOne(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const visibleIdsSelectable = filteredChanges
    .filter((c) => c.changeType !== "REMOVED")
    .map((c) => c.id);
  const allVisibleSelected =
    visibleIdsSelectable.length > 0 &&
    visibleIdsSelectable.every((id) => selectedIds.has(id));

  function toggleAllVisible() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const id of visibleIdsSelectable) next.delete(id);
      } else {
        for (const id of visibleIdsSelectable) next.add(id);
      }
      return next;
    });
  }
  function deselectAll() {
    setSelectedIds(new Set());
  }

  function triggerBlobDownload(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function handleDownloadImages() {
    const productIds = filteredChanges
      .filter((c) => selectedIds.has(c.id) && c.product?.id)
      .map((c) => c.product!.id);
    if (productIds.length === 0) {
      toast.error("Ningún seleccionado tiene producto asociado para descargar imagen");
      return;
    }
    if (productIds.length > 100) {
      toast.error("Máximo 100 imágenes por descarga. Reducí la selección.");
      return;
    }
    setDownloading(true);
    try {
      const res = await fetch("/api/products/download-images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productIds }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const filename =
        res.headers.get("content-disposition")?.match(/filename="?([^";]+)"?/)?.[1] ??
        "imagenes.zip";
      triggerBlobDownload(blob, filename);
      toast.success(`ZIP descargado (${productIds.length} imágenes)`);
    } catch (err) {
      toast.error((err as Error).message || "Error descargando imágenes");
    } finally {
      setDownloading(false);
    }
  }

  // Export Excel: si hay selección, exporta solo esos; si no, exporta la página actual.
  async function handleExportExcel(scope: "selected" | "page") {
    const ids =
      scope === "selected"
        ? Array.from(selectedIds)
        : filteredChanges.map((c) => c.id);
    if (ids.length === 0) {
      toast.error("Nada para exportar");
      return;
    }
    setExporting(true);
    try {
      const res = await fetch("/api/changes/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changeIds: ids }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const filename =
        res.headers.get("content-disposition")?.match(/filename="?([^";]+)"?/)?.[1] ??
        "cambios.xlsx";
      triggerBlobDownload(blob, filename);
      toast.success(`Excel descargado (${ids.length} cambios)`);
    } catch (err) {
      toast.error((err as Error).message || "Error exportando");
    } finally {
      setExporting(false);
    }
  }

  function notImplemented() {
    toast.info("Próximamente — feature en desarrollo");
  }

  // Sticky positions (px). Tienen que coincidir con los anchos de las cols a la izquierda.
  const sticky = {
    checkbox: { left: 0, width: 40 },         // 40px
    image: { left: 40, width: 56 },           // 56px
    provider: { left: 96, width: 124 },       // 124px (min)
    sku: { left: 220, width: 90 },            // 90px (min)
    product: { left: 310, width: 220 },       // 220px (min)
  };

  return (
    <div className="space-y-4">
      {/* Header operativo con título + count + export */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Cambios comerciales
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {data.total.toLocaleString("es-AR")} cambio
            {data.total === 1 ? "" : "s"} detectado
            {data.total === 1 ? "" : "s"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => handleExportExcel(selectedIds.size > 0 ? "selected" : "page")}
          disabled={exporting || data.total === 0}
          className="flex items-center gap-2 text-xs border border-border bg-card px-3 py-2 rounded-lg hover:bg-muted/40 transition-colors disabled:opacity-60"
        >
          {exporting ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <FileSpreadsheet className="w-3.5 h-3.5" />
          )}
          {selectedIds.size > 0
            ? `Exportar Excel (${selectedIds.size})`
            : "Exportar Excel"}
        </button>
      </div>

      {/* Filtros compactos */}
      <div className="bg-card border border-border rounded-xl p-3 flex items-center gap-3 flex-wrap">
        <div className="flex bg-muted/30 rounded-md p-0.5 gap-0.5 flex-wrap">
          <button
            type="button"
            onClick={() => setChangeTypes(new Set())}
            className={`text-[11px] px-2.5 py-1 rounded transition-colors ${
              changeTypes.size === 0
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Todos
          </button>
          {changeTypeOrder.map((t) => {
            const active = changeTypes.has(t);
            return (
              <button
                key={t}
                type="button"
                onClick={() => toggleChangeType(t)}
                title={changeTypeMeta[t].label}
                className={`text-[11px] px-2.5 py-1 rounded transition-colors ${
                  active
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {changeTypeMeta[t].short}
              </button>
            );
          })}
        </div>

        <span className="text-muted-foreground/30 mx-1">|</span>

        <select
          value={providerId}
          onChange={(e) => setProviderId(e.target.value)}
          className="text-xs bg-background border border-border rounded-md px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/60"
        >
          <option value="all">Todos los proveedores</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>

        <select
          value={dateRange}
          onChange={(e) => setDateRange(e.target.value as DateRange)}
          className="text-xs bg-background border border-border rounded-md px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/60"
        >
          {(["24h", "7d", "30d", "all"] as DateRange[]).map((r) => (
            <option key={r} value={r}>
              {dateRangeLabel[r]}
            </option>
          ))}
        </select>

        <div className="flex items-center gap-1.5 flex-wrap ml-auto">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Estado:
          </span>
          {(
            [
              { key: "noCategory" as CatalogPill, label: "Sin categoría" },
              { key: "noImage" as CatalogPill, label: "Sin imagen" },
              { key: "notPublished" as CatalogPill, label: "No publicados" },
            ]
          ).map(({ key, label }) => {
            const active = pills.has(key);
            return (
              <button
                key={key}
                type="button"
                onClick={() => togglePill(key)}
                className={`text-[11px] px-2 py-0.5 rounded-full border transition-colors ${
                  active
                    ? "bg-primary/15 text-primary border-primary/40"
                    : "border-border text-muted-foreground hover:text-foreground hover:bg-muted/40"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Tabla con columnas sticky */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="overflow-x-auto relative">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-border bg-muted/20">
                <th
                  className="sticky z-30 bg-muted/20 px-2 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider"
                  style={{ left: sticky.checkbox.left, width: sticky.checkbox.width }}
                >
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleAllVisible}
                    aria-label="Seleccionar todos visibles"
                    className="cursor-pointer accent-primary"
                  />
                </th>
                <th
                  className="sticky z-30 bg-muted/20 px-2 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider"
                  style={{ left: sticky.image.left, width: sticky.image.width }}
                >
                  Img
                </th>
                <th
                  className="sticky z-30 bg-muted/20 px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider"
                  style={{ left: sticky.provider.left, minWidth: sticky.provider.width }}
                >
                  Proveedor
                </th>
                <th
                  className="sticky z-30 bg-muted/20 px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider"
                  style={{ left: sticky.sku.left, minWidth: sticky.sku.width }}
                >
                  SKU
                </th>
                <th
                  className="sticky z-30 bg-muted/20 px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider"
                  style={{ left: sticky.product.left, minWidth: sticky.product.width }}
                >
                  Producto
                </th>
                {/* Scrollables */}
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap" style={{ minWidth: 70 }}>
                  Tipo
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap" style={{ minWidth: 90 }}>
                  Precio ant.
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap" style={{ minWidth: 90 }}>
                  Precio actual
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap" style={{ minWidth: 70 }}>
                  Δ%
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap" style={{ minWidth: 90 }}>
                  Stock
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap" style={{ minWidth: 80 }}>
                  Estado
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap" style={{ minWidth: 60 }}>
                  Acc.
                </th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={12} className="px-4 py-8 text-center text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin inline-block mr-2" />
                    Cargando cambios...
                  </td>
                </tr>
              )}
              {!loading && filteredChanges.length === 0 && (
                <tr>
                  <td colSpan={12} className="px-4 py-12 text-center text-muted-foreground">
                    <Search className="w-6 h-6 mx-auto mb-2 opacity-30" />
                    Sin cambios para los filtros aplicados
                  </td>
                </tr>
              )}
              {!loading &&
                filteredChanges.map((c) => {
                  const removed = c.changeType === "REMOVED";
                  const orphan = !removed && c.product == null;
                  const typeMeta = changeTypeMeta[c.changeType];
                  // Estado de publicación / catálogo (priorizado)
                  const stateBadge = removed
                    ? null
                    : orphan
                    ? { label: "Orfan.", className: "bg-muted/40 text-muted-foreground border-border" }
                    : !c.product?.imageUrl
                    ? { label: "Sin img", className: "bg-amber-500/15 text-amber-300 border-amber-500/30" }
                    : !c.product?.category
                    ? { label: "Sin cat", className: "bg-amber-500/15 text-amber-300 border-amber-500/30" }
                    : pubStatusBadge(c.product.publicationStatus);
                  // bg-card en celdas sticky para que no se transparenten
                  const stickyBg = removed
                    ? "bg-card opacity-100"
                    : "bg-card";
                  const rowOpacity = removed ? "opacity-60" : "";

                  return (
                    <tr
                      key={c.id}
                      className={`group border-b border-border hover:bg-muted/10 transition-colors ${rowOpacity}`}
                    >
                      {/* Sticky cells */}
                      <td
                        className={`sticky z-20 ${stickyBg} group-hover:bg-muted/20 px-2 py-2`}
                        style={{ left: sticky.checkbox.left, width: sticky.checkbox.width }}
                      >
                        <input
                          type="checkbox"
                          checked={selectedIds.has(c.id)}
                          onChange={() => toggleOne(c.id)}
                          disabled={removed}
                          aria-label={`Seleccionar ${c.name}`}
                          className="cursor-pointer accent-primary disabled:cursor-not-allowed"
                        />
                      </td>
                      <td
                        className={`sticky z-20 ${stickyBg} group-hover:bg-muted/20 px-2 py-2`}
                        style={{ left: sticky.image.left, width: sticky.image.width }}
                      >
                        {!removed && c.product?.imageUrl ? (
                          <a
                            href={c.product.imageUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block w-9 h-9 rounded-md overflow-hidden bg-muted/30 border border-border hover:border-primary/50"
                          >
                            <img
                              src={c.product.imageUrl}
                              alt=""
                              loading="lazy"
                              className="w-full h-full object-cover"
                              onError={(e) => {
                                (e.currentTarget as HTMLImageElement).style.display = "none";
                              }}
                            />
                          </a>
                        ) : (
                          <div className="w-9 h-9 rounded-md bg-muted/20 border border-border flex items-center justify-center text-muted-foreground/50">
                            <ImageOff className="w-3.5 h-3.5" />
                          </div>
                        )}
                      </td>
                      <td
                        className={`sticky z-20 ${stickyBg} group-hover:bg-muted/20 px-3 py-2`}
                        style={{ left: sticky.provider.left, minWidth: sticky.provider.width }}
                      >
                        <span
                          title={c.providerName}
                          className={`text-[10px] px-2 py-0.5 rounded-full border font-medium whitespace-nowrap ${providerColorClass(c.providerName)}`}
                        >
                          {c.providerName.length > 10
                            ? c.providerName.slice(0, 10) + "…"
                            : c.providerName}
                        </span>
                      </td>
                      <td
                        className={`sticky z-20 ${stickyBg} group-hover:bg-muted/20 px-3 py-2 font-mono text-muted-foreground`}
                        style={{ left: sticky.sku.left, minWidth: sticky.sku.width }}
                      >
                        {c.sku ?? "—"}
                      </td>
                      <td
                        className={`sticky z-20 ${stickyBg} group-hover:bg-muted/20 px-3 py-2`}
                        style={{ left: sticky.product.left, minWidth: sticky.product.width, maxWidth: 220 }}
                      >
                        <p className="font-medium truncate" title={c.name}>
                          {c.name}
                        </p>
                        {c.product?.category && (
                          <p className="text-[10px] text-muted-foreground truncate">
                            {c.product.category}
                          </p>
                        )}
                      </td>

                      {/* Scrollable cells */}
                      <td className="px-3 py-2">
                        <span
                          title={typeMeta.label}
                          className={`text-xs px-1.5 py-0.5 rounded-full border font-bold inline-flex items-center justify-center w-7 ${typeMeta.className}`}
                        >
                          {typeMeta.icon}
                        </span>
                      </td>
                      <td className="px-3 py-2 font-mono text-muted-foreground whitespace-nowrap">
                        {formatPriceCompact(c.previousPrice)}
                      </td>
                      <td
                        className={`px-3 py-2 font-mono whitespace-nowrap ${
                          c.changeType === "PRICE_DOWN"
                            ? "text-emerald-400"
                            : c.changeType === "PRICE_UP"
                            ? "text-orange-400"
                            : ""
                        }`}
                      >
                        {formatPriceCompact(c.currentPrice)}
                      </td>
                      <td
                        className={`px-3 py-2 font-mono whitespace-nowrap ${
                          c.priceChangePercent == null
                            ? "text-muted-foreground"
                            : c.priceChangePercent > 0
                            ? "text-orange-400"
                            : "text-emerald-400"
                        }`}
                      >
                        {c.priceChangePercent != null
                          ? `${c.priceChangePercent > 0 ? "↑+" : "↓"}${c.priceChangePercent}%`
                          : "—"}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground whitespace-nowrap font-mono text-xs">
                        {c.changeType === "STOCK_CHANGED"
                          ? `${c.previousStock ?? "—"} → ${c.currentStock ?? "—"}`
                          : "—"}
                      </td>
                      <td className="px-3 py-2">
                        {stateBadge && (
                          <span
                            className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${stateBadge.className}`}
                          >
                            {stateBadge.label}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {removed ? (
                          <button
                            type="button"
                            disabled
                            title="Producto removido"
                            className="text-muted-foreground/50 cursor-not-allowed"
                          >
                            <Lock className="w-3.5 h-3.5" />
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setDrawerChange(c)}
                            title="Ver detalle"
                            className="text-primary hover:text-primary/80"
                          >
                            <Eye className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>

        {/* Paginación */}
        {data.total > 0 && (
          <div className="px-5 py-3 border-t border-border flex items-center justify-between text-xs text-muted-foreground">
            <span>
              Mostrando {(page - 1) * pageSize + 1}–
              {Math.min(page * pageSize, data.total)} de {data.total} cambios
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

      {/* Barra sticky de acciones masivas */}
      {selectedIds.size > 0 && (
        <div className="sticky bottom-4 z-30">
          <div className="bg-card border border-border rounded-xl p-4 shadow-2xl shadow-black/40 flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <span className="text-sm font-semibold">
                {selectedIds.size} seleccionado{selectedIds.size === 1 ? "" : "s"}
              </span>
              <button
                type="button"
                onClick={deselectAll}
                className="text-xs text-muted-foreground hover:text-foreground border border-border px-2.5 py-1 rounded-md hover:bg-muted/40"
              >
                Deseleccionar todos
              </button>
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <button
                type="button"
                onClick={handleDownloadImages}
                disabled={downloading}
                className="text-xs flex items-center gap-1.5 border border-border px-3 py-1.5 rounded-md hover:bg-muted/40 disabled:opacity-60"
              >
                {downloading ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Download className="w-3.5 h-3.5" />
                )}
                Imágenes
              </button>
              <button
                type="button"
                onClick={notImplemented}
                className="text-xs flex items-center gap-1.5 border border-border px-3 py-1.5 rounded-md hover:bg-muted/40"
              >
                <Check className="w-3.5 h-3.5" /> Revisado
              </button>
              <button
                type="button"
                onClick={notImplemented}
                className="text-xs flex items-center gap-1.5 border border-border px-3 py-1.5 rounded-md hover:bg-muted/40"
              >
                <Ban className="w-3.5 h-3.5" /> Ignorar
              </button>
              <button
                type="button"
                disabled
                title="Próximamente"
                className="text-xs flex items-center gap-1.5 border border-border px-3 py-1.5 rounded-md text-muted-foreground/50 cursor-not-allowed"
              >
                <Lock className="w-3 h-3" /> Categoría
              </button>
              <button
                type="button"
                disabled
                title="Próximamente"
                className="text-xs flex items-center gap-1.5 border border-border px-3 py-1.5 rounded-md text-muted-foreground/50 cursor-not-allowed"
              >
                <Lock className="w-3 h-3" /> Margen
              </button>
              <button
                type="button"
                disabled
                title="Próximamente"
                className="text-xs flex items-center gap-1.5 bg-primary/10 text-primary border border-primary/30 px-3 py-1.5 rounded-md opacity-60 cursor-not-allowed"
              >
                <Lock className="w-3 h-3" /> Publicar
              </button>
            </div>
          </div>
        </div>
      )}

      <ProductDrawer change={drawerChange} onClose={() => setDrawerChange(null)} />
    </div>
  );
}
