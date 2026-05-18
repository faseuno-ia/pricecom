"use client";

import { useState, useEffect, useMemo } from "react";
import { toast } from "sonner";
import {
  ImageOff,
  Eye,
  ChevronLeft,
  ChevronRight,
  FileSpreadsheet,
  Check,
  Ban,
  ExternalLink,
  Loader2,
  PlusCircle,
  MinusCircle,
  TrendingUp,
  TrendingDown,
  Package,
} from "lucide-react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { es } from "date-fns/locale";
import { ProductDrawer } from "./product-drawer";

export type ChangeType =
  | "NEW"
  | "REMOVED"
  | "PRICE_UP"
  | "PRICE_DOWN"
  | "STOCK_CHANGED";
export type ReviewStatus = "PENDING" | "REVIEWED" | "IGNORED";
export type Mode = "recent" | "48h" | "7d" | "all";

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
  reviewStatus: ReviewStatus;
  reviewedAt: string | null;
  createdAt: string;
  providerId: string;
  providerName: string;
  jobId: string;
  previousJobId: string | null;
  jobFinishedAt: string | null;
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

const typeBadge: Record<ChangeType, { label: string; cls: string }> = {
  NEW: { label: "Nuevo", cls: "bg-green-500/15 text-green-300 border-green-500/30" },
  PRICE_UP: { label: "Precio ↑", cls: "bg-orange-500/15 text-orange-300 border-orange-500/30" },
  PRICE_DOWN: { label: "Precio ↓", cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" },
  STOCK_CHANGED: { label: "Stock", cls: "bg-blue-500/15 text-blue-300 border-blue-500/30" },
  REMOVED: { label: "Removido", cls: "bg-red-500/15 text-red-300 border-red-500/30" },
};

const reviewBadge: Record<ReviewStatus, { label: string; cls: string }> = {
  PENDING: { label: "Pendiente", cls: "bg-muted/30 text-muted-foreground border-border" },
  REVIEWED: { label: "Revisado", cls: "bg-green-500/15 text-green-300 border-green-500/30" },
  IGNORED: { label: "Ignorado", cls: "bg-muted/20 text-muted-foreground/60 border-border" },
};

const providerPalette = [
  "bg-purple-500/10 text-purple-300 border-purple-500/30",
  "bg-cyan-500/10 text-cyan-300 border-cyan-500/30",
  "bg-pink-500/10 text-pink-300 border-pink-500/30",
  "bg-yellow-500/10 text-yellow-300 border-yellow-500/30",
  "bg-indigo-500/10 text-indigo-300 border-indigo-500/30",
  "bg-rose-500/10 text-rose-300 border-rose-500/30",
];

function providerColorClass(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return providerPalette[Math.abs(h) % providerPalette.length];
}

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

function getSeverity(pct: number | null): { label: string; cls: string } {
  if (pct == null) return { label: "—", cls: "text-muted-foreground" };
  const abs = Math.abs(pct);
  if (abs >= 20) return { label: "Crítica", cls: "text-red-400 font-semibold" };
  if (abs >= 5) return { label: "Media", cls: "text-amber-400" };
  return { label: "Menor", cls: "text-muted-foreground" };
}

function getDeltaStyle(pct: number | null): string {
  if (pct == null) return "text-muted-foreground";
  const abs = Math.abs(pct);
  if (pct > 0) {
    if (abs >= 20) return "text-red-400 font-bold";
    if (abs >= 5) return "text-orange-400 font-semibold";
    return "text-orange-300";
  }
  if (abs >= 20) return "text-green-400 font-bold";
  if (abs >= 5) return "text-emerald-400 font-semibold";
  return "text-emerald-300";
}

function formatDelta(pct: number | null): string {
  if (pct == null) return "—";
  const rounded = Math.round(pct * 10) / 10;
  return pct >= 0 ? `↑${rounded}%` : `↓${Math.abs(rounded)}%`;
}

const MODE_LABEL: Record<Mode, string> = {
  recent: "Última actualización por proveedor",
  "48h": "Últimas 48 horas",
  "7d": "Últimos 7 días",
  all: "Histórico completo",
};

interface ApiResponse {
  changes: ChangeRow[];
  total: number;
  page: number;
  pageSize: number;
  mode: Mode;
  counts: Record<ChangeType, number>;
  providersCompared: number;
  lastUpdatedAt: string | null;
}

export function ChangesTable({ providers, initialProviderId }: Props) {
  const [mode, setMode] = useState<Mode>("recent");
  const [providerId, setProviderId] = useState<string>(initialProviderId ?? "all");
  const [activeTab, setActiveTab] = useState<ChangeType | "ALL">("ALL");
  const [onlyCritical, setOnlyCritical] = useState(false);
  const [onlyPending, setOnlyPending] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(50);
  const [data, setData] = useState<ApiResponse>({
    changes: [],
    total: 0,
    page: 1,
    pageSize: 50,
    mode: "recent",
    counts: { NEW: 0, REMOVED: 0, PRICE_UP: 0, PRICE_DOWN: 0, STOCK_CHANGED: 0 },
    providersCompared: 0,
    lastUpdatedAt: null,
  });
  const [loading, setLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [drawerChange, setDrawerChange] = useState<ChangeRow | null>(null);
  const [exporting, setExporting] = useState(false);
  const [pending, setPending] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    setPage(1);
    setSelectedIds(new Set());
  }, [mode, providerId, activeTab, onlyPending]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        params.set("mode", mode);
        if (providerId !== "all") params.set("providerId", providerId);
        if (activeTab !== "ALL") params.append("changeType", activeTab);
        if (onlyPending) params.set("reviewStatus", "PENDING");
        params.set("page", String(page));
        params.set("pageSize", String(pageSize));

        const res = await fetch(`/api/changes?${params.toString()}`);
        if (!res.ok) throw new Error("Error al cargar cambios");
        const json = (await res.json()) as ApiResponse;
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
  }, [mode, providerId, activeTab, onlyPending, page, pageSize, reload]);

  function refresh() {
    setReload((k) => k + 1);
  }

  // "Solo críticos" se aplica client-side sobre la página actual.
  const filteredChanges = useMemo(() => {
    if (!onlyCritical) return data.changes;
    return data.changes.filter((c) => {
      if (c.priceChangePercent == null) return false;
      return Math.abs(c.priceChangePercent) >= 20;
    });
  }, [data.changes, onlyCritical]);

  const totalPages = Math.max(1, Math.ceil(data.total / pageSize));

  const visibleIds = useMemo(
    () => filteredChanges.map((c) => c.id),
    [filteredChanges]
  );
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));

  function toggleOne(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) for (const id of visibleIds) next.delete(id);
      else for (const id of visibleIds) next.add(id);
      return next;
    });
  }

  function deselectAll() {
    setSelectedIds(new Set());
  }

  async function bulkReview(status: ReviewStatus) {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setPending(true);
    try {
      const res = await fetch("/api/changes/bulk-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changeIds: ids, status }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error ?? `HTTP ${res.status}`);
      }
      const { updated } = (await res.json()) as { updated: number };
      const verb =
        status === "REVIEWED" ? "marcados como revisados"
        : status === "IGNORED" ? "ignorados"
        : "reabiertos";
      toast.success(`${updated} cambios ${verb}`);
      deselectAll();
      refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setPending(false);
    }
  }

  async function reviewOne(id: string, status: ReviewStatus) {
    try {
      const res = await fetch(`/api/changes/${id}/review`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      refresh();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function handleExportExcel() {
    setExporting(true);
    try {
      const body = {
        filters: {
          ...(providerId !== "all" ? { providerId } : {}),
          ...(activeTab !== "ALL" ? { changeType: activeTab } : {}),
          mode,
          ...(selectedIds.size > 0
            ? { changeIds: Array.from(selectedIds) }
            : {}),
        },
      };
      const res = await fetch("/api/changes/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error ?? `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const filename =
        res.headers
          .get("content-disposition")
          ?.match(/filename="?([^";]+)"?/)?.[1] ?? "cambios.xlsx";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success("Excel descargado");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setExporting(false);
    }
  }

  // KPI cards
  const kpis: {
    key: ChangeType;
    label: string;
    cls: string;
    icon: typeof PlusCircle;
  }[] = [
    { key: "NEW", label: "Nuevos", cls: "text-green-400", icon: PlusCircle },
    { key: "PRICE_UP", label: "Precio ↑", cls: "text-orange-400", icon: TrendingUp },
    { key: "PRICE_DOWN", label: "Precio ↓", cls: "text-emerald-400", icon: TrendingDown },
    { key: "STOCK_CHANGED", label: "Stock", cls: "text-blue-400", icon: Package },
    { key: "REMOVED", label: "Removidos", cls: "text-red-400", icon: MinusCircle },
  ];

  const tabs: { key: "ALL" | ChangeType; label: string; count: number }[] = [
    { key: "ALL", label: "Todos", count: Object.values(data.counts).reduce((a, b) => a + b, 0) },
    { key: "NEW", label: "Nuevos", count: data.counts.NEW },
    { key: "PRICE_UP", label: "↑ Precio", count: data.counts.PRICE_UP },
    { key: "PRICE_DOWN", label: "↓ Precio", count: data.counts.PRICE_DOWN },
    { key: "STOCK_CHANGED", label: "Stock", count: data.counts.STOCK_CHANGED },
    { key: "REMOVED", label: "Removidos", count: data.counts.REMOVED },
  ];

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Cambios comerciales</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {data.providersCompared > 0 ? (
            <>
              Comparando últimas actualizaciones de{" "}
              <span className="text-foreground">{data.providersCompared}</span>{" "}
              proveedor{data.providersCompared === 1 ? "" : "es"}
              {data.lastUpdatedAt && (
                <>
                  {" "}· Última actualización:{" "}
                  {formatDistanceToNow(new Date(data.lastUpdatedAt), {
                    locale: es,
                    addSuffix: true,
                  })}
                </>
              )}
            </>
          ) : (
            "Sin comparaciones para el filtro actual."
          )}
        </p>
      </div>

      {/* Filtros + modo */}
      <div className="bg-card border border-border rounded-xl p-3 flex items-center gap-3 flex-wrap">
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as Mode)}
          className="text-xs bg-background border border-border rounded-md px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/60"
        >
          {(Object.keys(MODE_LABEL) as Mode[]).map((m) => (
            <option key={m} value={m}>
              {MODE_LABEL[m]}
            </option>
          ))}
        </select>

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

        <div className="flex items-center gap-1.5 ml-auto">
          <button
            type="button"
            onClick={() => setOnlyCritical((v) => !v)}
            className={`text-[11px] px-2.5 py-0.5 rounded-full border transition-colors ${
              onlyCritical
                ? "bg-red-500/15 text-red-300 border-red-500/40"
                : "border-border text-muted-foreground hover:text-foreground hover:bg-muted/40"
            }`}
            title="Filtra precios con variación ≥ 20%"
          >
            Solo críticos
          </button>
          <button
            type="button"
            onClick={() => setOnlyPending((v) => !v)}
            className={`text-[11px] px-2.5 py-0.5 rounded-full border transition-colors ${
              onlyPending
                ? "bg-primary/15 text-primary border-primary/40"
                : "border-border text-muted-foreground hover:text-foreground hover:bg-muted/40"
            }`}
          >
            Solo pendientes
          </button>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {kpis.map((k) => {
          const Icon = k.icon;
          return (
            <button
              key={k.key}
              type="button"
              onClick={() =>
                setActiveTab((cur) => (cur === k.key ? "ALL" : k.key))
              }
              className={`text-left bg-card border rounded-xl p-4 hover:border-primary/40 transition-colors ${
                activeTab === k.key ? "border-primary/50" : "border-border"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {k.label}
                </span>
                <Icon className={`w-3.5 h-3.5 ${k.cls}`} />
              </div>
              <p className={`text-2xl font-semibold mt-1 ${k.cls}`}>
                {data.counts[k.key].toLocaleString("es-AR")}
              </p>
            </button>
          );
        })}
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setActiveTab(t.key)}
            className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${
              activeTab === t.key
                ? "bg-primary/15 text-primary border-primary/40"
                : "border-border text-muted-foreground hover:text-foreground hover:bg-muted/40"
            }`}
          >
            {t.label}{" "}
            <span className="opacity-70 font-mono ml-1">{t.count}</span>
          </button>
        ))}
      </div>

      {/* Tabla */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-muted/20">
                <th className="px-2 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider w-[40px]">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleAllVisible}
                    className="cursor-pointer accent-primary"
                  />
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider">
                  Tipo
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider">
                  Producto
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider">
                  Proveedor
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider">
                  Precio ant.
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider">
                  Precio nuevo
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider">
                  Δ%
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider">
                  Severidad
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider">
                  Estado rev.
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider w-[120px]">
                  Acc.
                </th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={10} className="px-4 py-8 text-center text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin inline-block mr-2" />
                    Cargando…
                  </td>
                </tr>
              )}
              {!loading && filteredChanges.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-4 py-12 text-center text-muted-foreground">
                    Sin cambios para el filtro actual
                  </td>
                </tr>
              )}
              {!loading &&
                filteredChanges.map((c) => {
                  const tb = typeBadge[c.changeType];
                  const rb = reviewBadge[c.reviewStatus];
                  const sev = getSeverity(c.priceChangePercent);
                  const deltaCls = getDeltaStyle(c.priceChangePercent);
                  const image = c.product?.imageUrl ?? null;
                  return (
                    <tr
                      key={c.id}
                      className={`border-b border-border hover:bg-muted/10 transition-colors ${
                        c.reviewStatus === "IGNORED" ? "opacity-50" : ""
                      }`}
                    >
                      <td className="px-2 py-2">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(c.id)}
                          onChange={() => toggleOne(c.id)}
                          className="cursor-pointer accent-primary"
                        />
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span
                          className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${tb.cls}`}
                        >
                          {tb.label}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2 min-w-0">
                          {image ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={image}
                              alt=""
                              loading="lazy"
                              className="w-9 h-9 rounded-md object-cover bg-muted/30 border border-border flex-shrink-0"
                            />
                          ) : (
                            <div className="w-9 h-9 rounded-md bg-muted/20 border border-border flex items-center justify-center text-muted-foreground/50 flex-shrink-0">
                              <ImageOff className="w-3.5 h-3.5" />
                            </div>
                          )}
                          <div className="min-w-0">
                            <p
                              className="font-medium truncate"
                              style={{ maxWidth: 240 }}
                              title={c.name}
                            >
                              {c.name}
                            </p>
                            {c.product?.category && (
                              <p
                                className="text-[10px] text-muted-foreground truncate"
                                style={{ maxWidth: 240 }}
                              >
                                {c.product.category}
                              </p>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${providerColorClass(c.providerName)}`}
                          title={c.providerName}
                        >
                          {c.providerName.length > 12
                            ? c.providerName.slice(0, 12) + "…"
                            : c.providerName}
                        </span>
                      </td>
                      <td className="px-3 py-2 font-mono text-muted-foreground whitespace-nowrap">
                        {formatPriceCompact(c.previousPrice)}
                      </td>
                      <td className="px-3 py-2 font-mono whitespace-nowrap">
                        {formatPriceCompact(c.currentPrice)}
                      </td>
                      <td
                        className={`px-3 py-2 font-mono whitespace-nowrap ${deltaCls}`}
                      >
                        {formatDelta(c.priceChangePercent)}
                      </td>
                      <td className={`px-3 py-2 whitespace-nowrap ${sev.cls}`}>
                        {sev.label}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span
                          className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${rb.cls}`}
                        >
                          {rb.label}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => setDrawerChange(c)}
                            title="Ver detalle"
                            className="text-primary hover:text-primary/80"
                          >
                            <Eye className="w-3.5 h-3.5" />
                          </button>
                          {c.sku && (
                            <Link
                              href={`/catalog?search=${encodeURIComponent(c.sku)}`}
                              title="Ver en catálogo"
                              className="text-muted-foreground hover:text-foreground"
                            >
                              <ExternalLink className="w-3.5 h-3.5" />
                            </Link>
                          )}
                          {c.reviewStatus !== "REVIEWED" && (
                            <button
                              type="button"
                              onClick={() => reviewOne(c.id, "REVIEWED")}
                              title="Marcar revisado"
                              className="text-muted-foreground hover:text-green-400"
                            >
                              <Check className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {c.reviewStatus !== "IGNORED" && (
                            <button
                              type="button"
                              onClick={() => reviewOne(c.id, "IGNORED")}
                              title="Ignorar"
                              className="text-muted-foreground hover:text-foreground"
                            >
                              <Ban className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>

        {data.total > 0 && (
          <div className="px-5 py-3 border-t border-border flex items-center justify-between text-xs text-muted-foreground">
            <span>
              Mostrando {(page - 1) * pageSize + 1}–
              {Math.min(page * pageSize, data.total)} de {data.total}
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

      {/* Barra masiva — solo Exportar + Revisar/Ignorar */}
      {selectedIds.size > 0 && (
        <div className="sticky bottom-4 z-30">
          <div className="bg-card border border-border rounded-xl p-3 shadow-2xl shadow-black/40 flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              <span className="text-sm font-semibold">
                {selectedIds.size} seleccionado{selectedIds.size === 1 ? "" : "s"}
              </span>
              <button
                type="button"
                onClick={deselectAll}
                className="text-xs text-muted-foreground hover:text-foreground border border-border px-2.5 py-1 rounded-md hover:bg-muted/40"
              >
                Deseleccionar
              </button>
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <button
                type="button"
                onClick={handleExportExcel}
                disabled={exporting}
                className="text-xs flex items-center gap-1.5 border border-border px-3 py-1.5 rounded-md hover:bg-muted/40 disabled:opacity-60"
              >
                {exporting ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <FileSpreadsheet className="w-3.5 h-3.5" />
                )}
                Exportar
              </button>
              <button
                type="button"
                onClick={() => bulkReview("REVIEWED")}
                disabled={pending}
                className="text-xs flex items-center gap-1.5 border border-border px-3 py-1.5 rounded-md hover:bg-muted/40 disabled:opacity-60"
              >
                <Check className="w-3.5 h-3.5" /> Marcar revisado
              </button>
              <button
                type="button"
                onClick={() => bulkReview("IGNORED")}
                disabled={pending}
                className="text-xs flex items-center gap-1.5 border border-border px-3 py-1.5 rounded-md hover:bg-muted/40 disabled:opacity-60"
              >
                <Ban className="w-3.5 h-3.5" /> Ignorar
              </button>
            </div>
          </div>
        </div>
      )}

      <ProductDrawer
        change={drawerChange}
        onClose={() => setDrawerChange(null)}
        onReviewed={() => {
          setDrawerChange(null);
          refresh();
        }}
      />
    </div>
  );
}
