"use client";

import { useState, useEffect, useMemo } from "react";
import { toast } from "sonner";
import {
  ImageOff,
  Edit,
  ChevronLeft,
  ChevronRight,
  Download,
  FileSpreadsheet,
  Loader2,
  Search,
  MoreHorizontal,
  ExternalLink,
  Lock,
  Plus,
  Ban,
  Archive,
  Eye,
} from "lucide-react";
import { CatalogProductDrawer } from "./catalog-product-drawer";

type SupplierStatus = "ACTIVE" | "SUPPLIER_REMOVED" | "IGNORED" | "ARCHIVED";
type PubStatusFilter = "ALL" | "NONE" | "DRAFT" | "ACTIVE" | "PAUSED";

interface CatalogRow {
  id: string;
  sku: string | null;
  productUrl: string | null;
  supplierName: string;
  commercialTitle: string | null;
  commercialName: string | null;
  wholesalePrice: number | null;
  manualPrice: number | null;
  finalPrice: number | null;
  manualMargin: number | null;
  stock: string | null;
  supplierCategory: string | null;
  imageUrl: string | null;
  supplierStatus: SupplierStatus;
  provider: { id: string; name: string; baseUrl: string };
  images: { id: string; url: string; isPrimary: boolean }[];
  assignedCategory: { id: string; name: string } | null;
  publications: { status: string; storeId: string; externalProductId: string | null }[];
}

interface Props {
  providers: { id: string; name: string }[];
  initialProviderId: string | null;
}

const providerPalette = [
  "bg-purple-500/15 text-purple-300 border-purple-500/30",
  "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
  "bg-pink-500/15 text-pink-300 border-pink-500/30",
  "bg-yellow-500/15 text-yellow-300 border-yellow-500/30",
  "bg-indigo-500/15 text-indigo-300 border-indigo-500/30",
  "bg-rose-500/15 text-rose-300 border-rose-500/30",
];

function providerColorClass(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return providerPalette[Math.abs(h) % providerPalette.length];
}

function formatPriceCompact(p: number | null | undefined): string {
  if (p == null) return "—";
  if (Math.abs(p % 1) < 0.005) return "$" + Math.round(p).toLocaleString("es-AR");
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 2,
  }).format(p);
}

// Precio de venta a mostrar: finalPrice si está, sino wholesalePrice + margen.
function effectivePrice(p: CatalogRow): number | null {
  if (p.finalPrice != null) return p.finalPrice;
  if (p.manualPrice != null) return p.manualPrice;
  if (p.wholesalePrice != null && p.manualMargin != null) {
    return p.wholesalePrice * (1 + p.manualMargin / 100);
  }
  return null;
}

function marginPercent(p: CatalogRow): number | null {
  const sell = effectivePrice(p);
  if (sell == null || p.wholesalePrice == null || p.wholesalePrice <= 0) return null;
  return ((sell - p.wholesalePrice) / p.wholesalePrice) * 100;
}

function marginBadge(margin: number | null): { label: string; cls: string } | null {
  if (margin == null) return null;
  const rounded = Math.round(margin);
  if (margin >= 30)
    return {
      label: `${rounded}%`,
      cls: "bg-green-500/15 text-green-300 border-green-500/30",
    };
  if (margin >= 15)
    return {
      label: `${rounded}%`,
      cls: "bg-amber-500/15 text-amber-300 border-amber-500/30",
    };
  return {
    label: `${rounded}%`,
    cls: "bg-red-500/15 text-red-300 border-red-500/30",
  };
}

const supplierBadgeFor: Record<SupplierStatus, { label: string; cls: string }> = {
  ACTIVE: { label: "Activo", cls: "bg-accent/15 text-accent border-accent/30" },
  SUPPLIER_REMOVED: { label: "Removido", cls: "bg-red-500/15 text-red-300 border-red-500/30" },
  IGNORED: { label: "Ignorado", cls: "bg-muted/40 text-muted-foreground border-border" },
  ARCHIVED: { label: "Archivado", cls: "bg-muted/40 text-muted-foreground border-border" },
};

function pubBadge(pubs: CatalogRow["publications"]): { label: string; cls: string } {
  if (pubs.length === 0) return { label: "Sin pub.", cls: "bg-muted/40 text-muted-foreground border-border" };
  const hasActive = pubs.find((p) => p.status === "ACTIVE");
  if (hasActive) return { label: "Activo", cls: "bg-accent/15 text-accent border-accent/30" };
  const hasError = pubs.find((p) => p.status === "ERROR");
  if (hasError) return { label: "Error", cls: "bg-red-500/15 text-red-300 border-red-500/30" };
  const hasPaused = pubs.find((p) => p.status === "PAUSED");
  if (hasPaused) return { label: "Pausado", cls: "bg-amber-500/15 text-amber-300 border-amber-500/30" };
  return { label: "Borrador", cls: "bg-blue-500/15 text-blue-300 border-blue-500/30" };
}

export function CatalogTable({ providers, initialProviderId }: Props) {
  const [search, setSearch] = useState("");
  const [providerId, setProviderId] = useState<string>(initialProviderId ?? "all");
  const [supplierStatus, setSupplierStatus] = useState<SupplierStatus | "all">("all");
  const [pubFilter, setPubFilter] = useState<PubStatusFilter>("ALL");
  const [noImage, setNoImage] = useState(false);
  const [noCategory, setNoCategory] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(50);
  const [data, setData] = useState<{ products: CatalogRow[]; total: number }>({
    products: [],
    total: 0,
  });
  const [loading, setLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [contextMenuFor, setContextMenuFor] = useState<string | null>(null);

  // Reset page al cambiar filtros
  useEffect(() => {
    setPage(1);
  }, [search, providerId, supplierStatus, pubFilter, noImage, noCategory]);

  // Fetch
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (search.trim()) params.set("search", search.trim());
        if (providerId !== "all") params.set("providerId", providerId);
        if (supplierStatus !== "all") params.set("supplierStatus", supplierStatus);
        if (pubFilter !== "ALL") params.set("publicationStatus", pubFilter);
        if (noImage) params.set("noImage", "true");
        if (noCategory) params.set("noCategory", "true");
        params.set("page", String(page));
        params.set("pageSize", String(pageSize));

        const res = await fetch(`/api/catalog?${params.toString()}`);
        if (!res.ok) throw new Error("Error al cargar catálogo");
        const json = (await res.json()) as { products: CatalogRow[]; total: number };
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
  }, [search, providerId, supplierStatus, pubFilter, noImage, noCategory, page, pageSize]);

  // Cerrar menú al click fuera
  useEffect(() => {
    function onClick() {
      setContextMenuFor(null);
    }
    if (contextMenuFor) {
      window.addEventListener("click", onClick);
      return () => window.removeEventListener("click", onClick);
    }
  }, [contextMenuFor]);

  const totalPages = Math.max(1, Math.ceil(data.total / pageSize));

  const visibleIds = useMemo(() => data.products.map((p) => p.id), [data.products]);
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

  // Reusa la API de download-images apuntando a los productos vinculados al
  // último snapshot extraído. Como CatalogProduct no tiene relación 1:1 con
  // ExtractedProduct, lo aproximamos buscando el latestExtractedProductId
  // server-side via API. Para v1: deshabilitado con tooltip explicativo.
  async function handleDownloadImages() {
    toast.info("Próximamente — descarga masiva desde catálogo");
  }

  async function handleExportExcel() {
    toast.info("Próximamente — exportar catálogo a Excel");
  }

  async function handleSupplierStatusChange(
    id: string,
    status: "IGNORED" | "ARCHIVED" | "ACTIVE"
  ) {
    try {
      // ACTIVE no es válido en el endpoint pub para CatalogProduct; usamos el bypass:
      // IGNORED y ARCHIVED van por /publication, "des-archivar" toca el campo directo.
      // Para v1 sólo exponemos IGNORED y ARCHIVED en el menú.
      const res = await fetch(`/api/catalog/${id}/publication`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Error");
      }
      toast.success(
        status === "IGNORED" ? "Producto ignorado" : "Producto archivado"
      );
      // Refetch
      setData((d) => ({ ...d, products: d.products.filter((p) => p.id !== id) }));
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  function notImplemented() {
    toast.info("Próximamente — feature en desarrollo");
  }

  // Sticky positions (igual estructura que /changes)
  const sticky = {
    checkbox: { left: 0, width: 40 },
    image: { left: 40, width: 56 },
    sku: { left: 96, width: 100 },
    product: { left: 196, width: 260 },
  };

  return (
    <div className="space-y-4">
      {/* Header operativo */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Catálogo</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {data.total.toLocaleString("es-AR")} producto
            {data.total === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={handleExportExcel}
            disabled={exporting || data.total === 0}
            className="flex items-center gap-1.5 text-xs border border-border bg-card px-3 py-2 rounded-lg hover:bg-muted/40 transition-colors disabled:opacity-60"
          >
            {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileSpreadsheet className="w-3.5 h-3.5" />}
            Exportar
          </button>
          <button
            type="button"
            onClick={notImplemented}
            disabled
            title="Próximamente"
            className="flex items-center gap-1.5 text-xs bg-primary/10 text-primary border border-primary/30 px-3 py-2 rounded-lg cursor-not-allowed opacity-60"
          >
            <Plus className="w-3.5 h-3.5" /> Agregar
          </button>
        </div>
      </div>

      {/* Filtros */}
      <div className="bg-card border border-border rounded-xl p-3 flex items-center gap-3 flex-wrap">
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar nombre, SKU…"
            className="text-xs bg-background border border-border rounded-md pl-8 pr-3 py-1.5 w-64 focus:outline-none focus:ring-1 focus:ring-primary/60"
          />
        </div>

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
          value={supplierStatus}
          onChange={(e) => setSupplierStatus(e.target.value as SupplierStatus | "all")}
          className="text-xs bg-background border border-border rounded-md px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/60"
        >
          <option value="all">Estado prov.: Todos</option>
          <option value="ACTIVE">Activo</option>
          <option value="SUPPLIER_REMOVED">Removido</option>
          <option value="IGNORED">Ignorado</option>
          <option value="ARCHIVED">Archivado</option>
        </select>

        <select
          value={pubFilter}
          onChange={(e) => setPubFilter(e.target.value as PubStatusFilter)}
          className="text-xs bg-background border border-border rounded-md px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/60"
        >
          <option value="ALL">Estado pub.: Todos</option>
          <option value="NONE">Sin publicar</option>
          <option value="DRAFT">Borrador</option>
          <option value="ACTIVE">Activo</option>
          <option value="PAUSED">Pausado</option>
        </select>

        <div className="flex items-center gap-1.5 ml-auto">
          <button
            type="button"
            onClick={() => setNoImage((v) => !v)}
            className={`text-[11px] px-2 py-0.5 rounded-full border transition-colors ${
              noImage
                ? "bg-primary/15 text-primary border-primary/40"
                : "border-border text-muted-foreground hover:text-foreground hover:bg-muted/40"
            }`}
          >
            Sin imagen
          </button>
          <button
            type="button"
            onClick={() => setNoCategory((v) => !v)}
            className={`text-[11px] px-2 py-0.5 rounded-full border transition-colors ${
              noCategory
                ? "bg-primary/15 text-primary border-primary/40"
                : "border-border text-muted-foreground hover:text-foreground hover:bg-muted/40"
            }`}
          >
            Sin categoría
          </button>
        </div>
      </div>

      {/* Tabla */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="overflow-x-auto relative">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-border bg-muted/20">
                <th className="sticky z-30 bg-muted/20 px-2 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider" style={{ left: sticky.checkbox.left, width: sticky.checkbox.width }}>
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleAllVisible}
                    className="cursor-pointer accent-primary"
                  />
                </th>
                <th className="sticky z-30 bg-muted/20 px-2 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider" style={{ left: sticky.image.left, width: sticky.image.width }}>
                  Img
                </th>
                <th className="sticky z-30 bg-muted/20 px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider" style={{ left: sticky.sku.left, minWidth: sticky.sku.width }}>
                  SKU
                </th>
                <th className="sticky z-30 bg-muted/20 px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider" style={{ left: sticky.product.left, minWidth: sticky.product.width }}>
                  Producto
                </th>
                {/* Scrollables */}
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap" style={{ minWidth: 110 }}>
                  Proveedor
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap" style={{ minWidth: 90 }}>
                  Costo
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap" style={{ minWidth: 100 }}>
                  Pr. venta
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap" style={{ minWidth: 70 }}>
                  Margen
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap" style={{ minWidth: 70 }}>
                  Stock
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap" style={{ minWidth: 80 }}>
                  Prov. est.
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap" style={{ minWidth: 80 }}>
                  Publ. est.
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap" style={{ minWidth: 70 }}>
                  Acc.
                </th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={12} className="px-4 py-8 text-center text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin inline-block mr-2" />
                    Cargando catálogo...
                  </td>
                </tr>
              )}
              {!loading && data.products.length === 0 && (
                <tr>
                  <td colSpan={12} className="px-4 py-12 text-center text-muted-foreground">
                    <Search className="w-6 h-6 mx-auto mb-2 opacity-30" />
                    Sin productos para los filtros aplicados
                  </td>
                </tr>
              )}
              {!loading &&
                data.products.map((p) => {
                  const margin = marginPercent(p);
                  const marginB = marginBadge(margin);
                  const sBadge = supplierBadgeFor[p.supplierStatus];
                  const pBadge = pubBadge(p.publications);
                  const displayName = p.commercialTitle?.trim() || p.supplierName;
                  const displayImage = p.images[0]?.url ?? p.imageUrl ?? null;
                  const sellPrice = effectivePrice(p);
                  return (
                    <tr
                      key={p.id}
                      className="group border-b border-border hover:bg-muted/10 transition-colors"
                    >
                      <td className="sticky z-20 bg-card group-hover:bg-muted/20 px-2 py-2" style={{ left: sticky.checkbox.left, width: sticky.checkbox.width }}>
                        <input
                          type="checkbox"
                          checked={selectedIds.has(p.id)}
                          onChange={() => toggleOne(p.id)}
                          className="cursor-pointer accent-primary"
                        />
                      </td>
                      <td className="sticky z-20 bg-card group-hover:bg-muted/20 px-2 py-2" style={{ left: sticky.image.left, width: sticky.image.width }}>
                        {displayImage ? (
                          <a
                            href={displayImage}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block w-9 h-9 rounded-md overflow-hidden bg-muted/30 border border-border hover:border-primary/50"
                          >
                            <img
                              src={displayImage}
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
                      <td className="sticky z-20 bg-card group-hover:bg-muted/20 px-3 py-2 font-mono text-muted-foreground" style={{ left: sticky.sku.left, minWidth: sticky.sku.width }}>
                        {p.sku ?? "—"}
                      </td>
                      <td className="sticky z-20 bg-card group-hover:bg-muted/20 px-3 py-2" style={{ left: sticky.product.left, minWidth: sticky.product.width, maxWidth: 260 }}>
                        <p className="font-medium truncate" title={displayName}>
                          {displayName}
                        </p>
                        {(p.assignedCategory?.name || p.supplierCategory) && (
                          <p className="text-[10px] text-muted-foreground truncate">
                            {p.assignedCategory?.name ?? p.supplierCategory}
                          </p>
                        )}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span
                          title={p.provider.name}
                          className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${providerColorClass(p.provider.name)}`}
                        >
                          {p.provider.name.length > 12
                            ? p.provider.name.slice(0, 12) + "…"
                            : p.provider.name}
                        </span>
                      </td>
                      <td className="px-3 py-2 font-mono text-muted-foreground whitespace-nowrap">
                        {formatPriceCompact(p.wholesalePrice)}
                      </td>
                      <td className="px-3 py-2 font-mono whitespace-nowrap">
                        {formatPriceCompact(sellPrice)}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {marginB ? (
                          <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${marginB.cls}`}>
                            {marginB.label}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                        {p.stock ?? "—"}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${sBadge.cls}`}>
                          {sBadge.label}
                        </span>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${pBadge.cls}`}>
                          {pBadge.label}
                        </span>
                      </td>
                      <td className="px-3 py-2 relative">
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => setDrawerId(p.id)}
                            title="Editar"
                            className="text-primary hover:text-primary/80"
                          >
                            <Edit className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setContextMenuFor(contextMenuFor === p.id ? null : p.id);
                            }}
                            title="Más"
                            className="text-muted-foreground hover:text-foreground"
                          >
                            <MoreHorizontal className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        {contextMenuFor === p.id && (
                          <div
                            className="absolute right-2 top-full mt-1 z-40 bg-card border border-border rounded-lg shadow-2xl shadow-black/40 py-1 min-w-[180px]"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              type="button"
                              onClick={() => {
                                setDrawerId(p.id);
                                setContextMenuFor(null);
                              }}
                              className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted/40 flex items-center gap-2"
                            >
                              <Eye className="w-3 h-3" /> Ver detalle
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setDrawerId(p.id);
                                setContextMenuFor(null);
                              }}
                              className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted/40 flex items-center gap-2"
                            >
                              <Edit className="w-3 h-3" /> Editar
                            </button>
                            <button
                              type="button"
                              disabled
                              title="Próximamente"
                              className="w-full text-left px-3 py-1.5 text-xs text-muted-foreground/50 flex items-center gap-2 cursor-not-allowed"
                            >
                              <Lock className="w-3 h-3" /> Activar publicación
                            </button>
                            <button
                              type="button"
                              disabled
                              title="Próximamente"
                              className="w-full text-left px-3 py-1.5 text-xs text-muted-foreground/50 flex items-center gap-2 cursor-not-allowed"
                            >
                              <Lock className="w-3 h-3" /> Pausar publicación
                            </button>
                            {p.productUrl && (
                              <a
                                href={p.productUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted/40 flex items-center gap-2"
                                onClick={() => setContextMenuFor(null)}
                              >
                                <ExternalLink className="w-3 h-3" /> Ver en proveedor
                              </a>
                            )}
                            <div className="border-t border-border my-1" />
                            <button
                              type="button"
                              onClick={() => {
                                handleSupplierStatusChange(p.id, "IGNORED");
                                setContextMenuFor(null);
                              }}
                              className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted/40 flex items-center gap-2 text-muted-foreground"
                            >
                              <Ban className="w-3 h-3" /> Marcar ignorado
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                handleSupplierStatusChange(p.id, "ARCHIVED");
                                setContextMenuFor(null);
                              }}
                              className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted/40 flex items-center gap-2 text-muted-foreground"
                            >
                              <Archive className="w-3 h-3" /> Archivar
                            </button>
                          </div>
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

      {/* Barra de acciones masivas */}
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
                {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileSpreadsheet className="w-3.5 h-3.5" />}
                Excel
              </button>
              <button
                type="button"
                onClick={handleDownloadImages}
                disabled={downloading}
                className="text-xs flex items-center gap-1.5 border border-border px-3 py-1.5 rounded-md hover:bg-muted/40 disabled:opacity-60"
              >
                {downloading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                Imágenes
              </button>
              {[
                { label: "Activar pub.", icon: Lock },
                { label: "Pausar pub.", icon: Lock },
                { label: "Archivar", icon: Lock },
                { label: "Ignorar", icon: Lock },
                { label: "Categoría", icon: Lock },
                { label: "Margen", icon: Lock },
              ].map((b) => (
                <button
                  key={b.label}
                  type="button"
                  disabled
                  title="Próximamente"
                  className="text-xs flex items-center gap-1.5 border border-border px-3 py-1.5 rounded-md text-muted-foreground/50 cursor-not-allowed"
                >
                  <b.icon className="w-3 h-3" /> {b.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <CatalogProductDrawer
        productId={drawerId}
        onClose={() => setDrawerId(null)}
        onSaved={(updated) => {
          setData((d) => ({
            ...d,
            products: d.products.map((p) =>
              p.id === updated.id
                ? {
                    ...p,
                    commercialTitle: updated.commercialTitle,
                    commercialName: updated.commercialName,
                    finalPrice: updated.finalPrice,
                    manualMargin: updated.manualMargin,
                    assignedCategory: updated.assignedCategory,
                  }
                : p
            ),
          }));
        }}
      />
    </div>
  );
}
