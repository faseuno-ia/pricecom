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
  Tag,
  PlayCircle,
  PauseCircle,
  RotateCcw,
  X,
} from "lucide-react";
import { normalizeImageUrl } from "@/lib/utils";
import { CatalogProductDrawer } from "./catalog-product-drawer";
import { ApplyMarginModal } from "./apply-margin-modal";

type SupplierStatus = "ACTIVE" | "SUPPLIER_REMOVED" | "IGNORED" | "ARCHIVED";
type InternalStatus = "NOT_PUBLISHED" | "PREPARED" | "PAUSED" | "IGNORED" | "ARCHIVED";
type PubStatusFilter = "ALL" | "NONE" | "DRAFT" | "ACTIVE" | "PAUSED";
type BulkAction = "archive" | "ignore" | "restore" | "prepare" | "pause";
type SourceType = "SCRAPED" | "MANUAL" | "IMPORTED";

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
  internalStatus: InternalStatus;
  sourceType: SourceType;
  provider: { id: string; name: string; baseUrl: string };
  images: { id: string; url: string; isPrimary: boolean }[];
  assignedCategory: { id: string; name: string } | null;
  publications: { status: string; storeId: string; externalProductId: string | null }[];
  pricing?: {
    calculatedPrice: number | null;
    effectivePrice: number | null;
    marginPercent: number | null;
    ruleApplied: "manual" | "category" | "provider" | "global" | "none";
    ruleName: string | null;
    ruleId: string | null;
  };
  assignedCategoryId?: string | null;
}

interface Props {
  providers: { id: string; name: string }[];
  initialProviderId: string | null;
  initialSourceType?: SourceType | null;
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

// Margen efectivo: el del motor (cuando hay regla) o el real derivado del
// effectivePrice cuando hay override sin regla aplicable.
function effectiveMargin(p: CatalogRow): number | null {
  if (p.pricing?.marginPercent != null) return p.pricing.marginPercent;
  const eff = p.pricing?.effectivePrice ?? null;
  if (eff == null || p.wholesalePrice == null || p.wholesalePrice <= 0) return null;
  return ((eff - p.wholesalePrice) / p.wholesalePrice) * 100;
}

type RuleOrigin = "manual" | "category" | "provider" | "global" | "none";

const originMeta: Record<
  RuleOrigin,
  { label: string; cls: string; tooltip: string }
> = {
  manual: {
    label: "Manual",
    cls: "bg-violet-500/15 text-violet-300 border-violet-500/30",
    tooltip: "Margen manual cargado en el producto",
  },
  category: {
    label: "Categoría",
    cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    tooltip: "Regla aplicada por categoría",
  },
  provider: {
    label: "Proveedor",
    cls: "bg-amber-500/15 text-amber-300 border-amber-500/30",
    tooltip: "Regla aplicada por proveedor",
  },
  global: {
    label: "Global",
    cls: "bg-zinc-500/15 text-zinc-300 border-zinc-500/30",
    tooltip: "Regla global por defecto",
  },
  none: {
    label: "—",
    cls: "bg-muted/40 text-muted-foreground border-border",
    tooltip: "Sin regla aplicable (falta costo o regla activa)",
  },
};

const supplierBadgeFor: Record<SupplierStatus, { label: string; cls: string }> = {
  ACTIVE: { label: "Activo", cls: "bg-accent/15 text-accent border-accent/30" },
  SUPPLIER_REMOVED: { label: "Removido", cls: "bg-red-500/15 text-red-300 border-red-500/30" },
  IGNORED: { label: "Ignorado", cls: "bg-muted/40 text-muted-foreground border-border" },
  ARCHIVED: { label: "Archivado", cls: "bg-muted/40 text-muted-foreground border-border" },
};

const sourceBadgeFor: Record<SourceType, { label: string; cls: string; tooltip: string }> = {
  SCRAPED: {
    label: "Web",
    cls: "bg-blue-500/15 text-blue-300 border-blue-500/30",
    tooltip: "Producto obtenido por scraping del proveedor",
  },
  MANUAL: {
    label: "Manual",
    cls: "bg-violet-500/15 text-violet-300 border-violet-500/30",
    tooltip: "Producto cargado manualmente",
  },
  IMPORTED: {
    label: "Excel",
    cls: "bg-amber-500/15 text-amber-300 border-amber-500/30",
    tooltip: "Producto importado por archivo Excel/CSV",
  },
};

const internalBadgeFor: Record<InternalStatus, { label: string; cls: string }> = {
  NOT_PUBLISHED: { label: "Sin pub.", cls: "bg-muted/40 text-muted-foreground border-border" },
  PREPARED: { label: "Preparado", cls: "bg-green-500/15 text-green-300 border-green-500/30" },
  PAUSED: { label: "Pausado", cls: "bg-amber-500/15 text-amber-300 border-amber-500/30" },
  IGNORED: { label: "Ignorado", cls: "bg-muted/30 text-muted-foreground/70 border-border" },
  ARCHIVED: {
    label: "Archivado",
    cls: "bg-muted/30 text-muted-foreground/70 border-border line-through",
  },
};

export function CatalogTable({ providers, initialProviderId, initialSourceType }: Props) {
  const [search, setSearch] = useState("");
  const [providerId, setProviderId] = useState<string>(initialProviderId ?? "all");
  const [supplierStatus, setSupplierStatus] = useState<SupplierStatus | "all">("all");
  const [internalStatus, setInternalStatus] = useState<InternalStatus | "all">("all");
  const [pubFilter, setPubFilter] = useState<PubStatusFilter>("ALL");
  const [sourceFilter, setSourceFilter] = useState<SourceType | "all">(
    initialSourceType ?? "all"
  );
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
  const [failedImages, setFailedImages] = useState<Set<string>>(new Set());
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [marginModalOpen, setMarginModalOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [contextMenuFor, setContextMenuFor] = useState<string | null>(null);

  // Reset page al cambiar filtros
  useEffect(() => {
    setPage(1);
  }, [search, providerId, supplierStatus, internalStatus, pubFilter, sourceFilter, noImage, noCategory]);

  // Construye los filtros activos para mandarlos al export (mismo formato que la API)
  const currentFilters = useMemo(
    () => ({
      ...(search.trim() ? { search: search.trim() } : {}),
      ...(providerId !== "all" ? { providerId } : {}),
      ...(supplierStatus !== "all" ? { supplierStatus } : {}),
      ...(internalStatus !== "all" ? { internalStatus } : {}),
      ...(sourceFilter !== "all" ? { sourceType: sourceFilter } : {}),
      ...(noImage ? { noImage: true } : {}),
      ...(noCategory ? { noCategory: true } : {}),
    }),
    [search, providerId, supplierStatus, internalStatus, sourceFilter, noImage, noCategory]
  );

  const [reloadKey, setReloadKey] = useState(0);
  function refresh() {
    setReloadKey((k) => k + 1);
  }

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
        if (internalStatus !== "all") params.set("internalStatus", internalStatus);
        if (pubFilter !== "ALL") params.set("publicationStatus", pubFilter);
        if (sourceFilter !== "all") params.set("sourceType", sourceFilter);
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
  }, [search, providerId, supplierStatus, internalStatus, pubFilter, sourceFilter, noImage, noCategory, page, pageSize, reloadKey]);

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

  async function handleExportExcel() {
    setExporting(true);
    try {
      const body =
        selectedIds.size > 0
          ? { catalogProductIds: Array.from(selectedIds) }
          : { filters: currentFilters };
      const res = await fetch("/api/catalog/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const filename =
        res.headers.get("content-disposition")?.match(/filename="?([^";]+)"?/)?.[1] ??
        "catalogo.xlsx";
      triggerBlobDownload(blob, filename);
      toast.success(
        `Excel descargado (${
          selectedIds.size > 0 ? `${selectedIds.size} seleccionados` : `${data.total} productos`
        })`
      );
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setExporting(false);
    }
  }

  // Descarga imágenes: si selección ≤ 100, un POST; si más, batches de 100
  // y merge con JSZip en el cliente (mismo patrón que products-table).
  async function handleDownloadImages() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) {
      toast.error("Seleccioná al menos un producto");
      return;
    }
    setDownloading(true);
    try {
      const BATCH = 100;
      if (ids.length <= BATCH) {
        const res = await fetch("/api/catalog/download-images", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ catalogProductIds: ids }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error ?? `HTTP ${res.status}`);
        }
        const blob = await res.blob();
        const filename =
          res.headers.get("content-disposition")?.match(/filename="?([^";]+)"?/)?.[1] ??
          "catalog-images.zip";
        triggerBlobDownload(blob, filename);
        toast.success(`ZIP descargado (${ids.length} imágenes)`);
      } else {
        const JSZip = (await import("jszip")).default;
        const batches: string[][] = [];
        for (let i = 0; i < ids.length; i += BATCH) batches.push(ids.slice(i, i + BATCH));
        const merged = new JSZip();
        let added = 0;
        let failed = 0;
        for (let i = 0; i < batches.length; i++) {
          try {
            const res = await fetch("/api/catalog/download-images", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ catalogProductIds: batches[i] }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const buf = await res.arrayBuffer();
            const z = await JSZip.loadAsync(buf);
            for (const [name, file] of Object.entries(z.files)) {
              if (file.dir) continue;
              const content = await file.async("arraybuffer");
              const finalName = merged.files[name]
                ? name.replace(/(\.[^.]+)$/, `-lote${i + 1}$1`)
                : name;
              merged.file(finalName, content);
              added++;
            }
          } catch (err) {
            failed++;
            toast.error(`Lote ${i + 1}/${batches.length} falló: ${(err as Error).message}`);
          }
        }
        if (added === 0) throw new Error("Ningún lote pudo descargarse");
        const zipBlob = await merged.generateAsync({ type: "blob" });
        triggerBlobDownload(zipBlob, `catalog-images-${new Date().toISOString().slice(0, 10)}.zip`);
        if (failed > 0)
          toast.warning(`ZIP descargado (${added}). ${failed} lote(s) fallaron.`);
        else toast.success(`ZIP descargado (${added} imágenes en ${batches.length} lotes)`);
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setDownloading(false);
    }
  }

  // Acción masiva → /api/catalog/bulk-update. Confirma con window.confirm,
  // refresca la tabla al terminar y limpia la selección.
  async function handleBulkAction(action: BulkAction, ids?: string[]) {
    const targetIds = ids ?? Array.from(selectedIds);
    if (targetIds.length === 0) return;

    const labels: Record<BulkAction, string> = {
      archive: "archivar",
      ignore: "ignorar",
      restore: "restaurar",
      prepare: "preparar para publicar",
      pause: "pausar",
    };
    const verb = labels[action];

    // confirm sólo para masivas (>1); las acciones individuales del menú contextual
    // las disparamos sin doble confirm para no entorpecer el workflow.
    if (targetIds.length > 1) {
      if (!window.confirm(`¿${verb[0].toUpperCase() + verb.slice(1)} ${targetIds.length} productos?`)) {
        return;
      }
    }

    try {
      const res = await fetch("/api/catalog/bulk-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productIds: targetIds, action }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const { updated } = (await res.json()) as { updated: number };
      toast.success(`${updated} productos: ${verb}`);
      if (ids) {
        // acción individual: vaciar el contextual no hace falta acá
      } else {
        deselectAll();
      }
      refresh();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  function notImplemented() {
    toast.info("Próximamente — feature en desarrollo");
  }

  // Quita manualMargin (devuelve los productos a heredar la regla de pricing).
  // Confirma sólo para masivas (>1); individual del menú contextual va directo.
  async function handleClearMargin(ids: string[]) {
    if (ids.length === 0) return;
    if (
      ids.length > 1 &&
      !window.confirm(
        `¿Quitar margen manual de ${ids.length} producto${ids.length > 1 ? "s" : ""}? Volverán a heredar la regla de pricing activa.`
      )
    ) {
      return;
    }
    try {
      const res = await fetch("/api/catalog/bulk-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productIds: ids, action: "clear_margin" }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const { updated } = (await res.json()) as { updated: number };
      toast.success(
        ids.length === 1
          ? "Margen manual quitado"
          : `Margen manual quitado de ${updated} producto${updated !== 1 ? "s" : ""}`
      );
      if (ids.length > 1) deselectAll();
      refresh();
    } catch (err) {
      toast.error((err as Error).message);
    }
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
          <a
            href="/catalog/new"
            className="flex items-center gap-1.5 text-xs bg-primary/10 text-primary border border-primary/30 px-3 py-2 rounded-lg hover:bg-primary/20 transition-colors"
            title="Agregar producto manual"
          >
            <Plus className="w-3.5 h-3.5" /> Agregar
          </a>
          <a
            href="/catalog/import"
            className="flex items-center gap-1.5 text-xs border border-border bg-card px-3 py-2 rounded-lg hover:bg-muted/40 transition-colors"
            title="Importar Excel"
          >
            <FileSpreadsheet className="w-3.5 h-3.5" /> Importar
          </a>
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
          value={internalStatus}
          onChange={(e) => setInternalStatus(e.target.value as InternalStatus | "all")}
          className="text-xs bg-background border border-border rounded-md px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/60"
        >
          <option value="all">Estado interno: Todos</option>
          <option value="NOT_PUBLISHED">Sin publicar</option>
          <option value="PREPARED">Preparado</option>
          <option value="PAUSED">Pausado</option>
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

        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value as SourceType | "all")}
          className="text-xs bg-background border border-border rounded-md px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/60"
        >
          <option value="all">Origen: Todos</option>
          <option value="SCRAPED">Scrapeado</option>
          <option value="MANUAL">Manual</option>
          <option value="IMPORTED">Importado</option>
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
                <th
                  className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap"
                  style={{ minWidth: 120 }}
                  title="Precio efectivo de venta. Si hay override manual, prevalece sobre el sugerido."
                >
                  Precio final
                </th>
                <th
                  className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap"
                  style={{ minWidth: 130 }}
                  title="Precio sugerido por el motor según la regla aplicable (manual, categoría, proveedor o global)."
                >
                  Precio sugerido
                </th>
                <th
                  className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap"
                  style={{ minWidth: 100 }}
                  title="Margen efectivo sobre el costo. El color indica el origen de la regla."
                >
                  Margen
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap" style={{ minWidth: 70 }}>
                  Stock
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap" style={{ minWidth: 80 }}>
                  Prov. est.
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap" style={{ minWidth: 80 }}>
                  Estado int.
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap" style={{ minWidth: 70 }}>
                  Acc.
                </th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={13} className="px-4 py-8 text-center text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin inline-block mr-2" />
                    Cargando catálogo...
                  </td>
                </tr>
              )}
              {!loading && data.products.length === 0 && (
                <tr>
                  <td colSpan={13} className="px-4 py-12 text-center text-muted-foreground">
                    <Search className="w-6 h-6 mx-auto mb-2 opacity-30" />
                    Sin productos para los filtros aplicados
                  </td>
                </tr>
              )}
              {!loading &&
                data.products.map((p) => {
                  const sBadge = supplierBadgeFor[p.supplierStatus];
                  const iBadge = internalBadgeFor[p.internalStatus];
                  // Pricing del motor (resuelto en el server).
                  const calcPrice = p.pricing?.calculatedPrice ?? null;
                  const effPrice = p.pricing?.effectivePrice ?? null;
                  const origin: RuleOrigin = p.pricing?.ruleApplied ?? "none";
                  const originInfo = originMeta[origin];
                  const enginePct = p.pricing?.marginPercent ?? null;
                  // Override manual: el usuario fijó finalPrice y difiere del sugerido.
                  const hasManualOverride =
                    p.finalPrice != null &&
                    calcPrice != null &&
                    Math.abs(p.finalPrice - calcPrice) > 0.005;
                  const suggestedTooltip =
                    origin === "none"
                      ? originInfo.tooltip
                      : `${originInfo.tooltip}${
                          p.pricing?.ruleName ? ` — ${p.pricing.ruleName}` : ""
                        }${enginePct != null ? ` (${enginePct}%)` : ""}`;
                  const effMargin = effectiveMargin(p);
                  const displayName = p.commercialTitle?.trim() || p.supplierName;
                  // Link href: URL original (puede ser http://) — el navegador permite navegar.
                  // Img src: normalizado a https:// para evitar mixed content inline.
                  const rawImage = p.images[0]?.url ?? p.imageUrl ?? null;
                  const normalizedImage = normalizeImageUrl(rawImage);
                  const imageFailed = failedImages.has(p.id);
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
                        {normalizedImage && !imageFailed ? (
                          <a
                            href={rawImage ?? normalizedImage}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block w-9 h-9 rounded-md overflow-hidden bg-muted/30 border border-border hover:border-primary/50"
                          >
                            <img
                              src={normalizedImage}
                              alt=""
                              loading="lazy"
                              className="w-full h-full object-cover"
                              onError={() =>
                                setFailedImages((s) => new Set(s).add(p.id))
                              }
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
                        <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                          {(() => {
                            const src = sourceBadgeFor[p.sourceType];
                            return (
                              <span
                                title={src.tooltip}
                                className={`text-[9px] px-1.5 py-0.5 rounded border font-medium ${src.cls} uppercase tracking-wide`}
                              >
                                {src.label}
                              </span>
                            );
                          })()}
                          {(p.assignedCategory?.name || p.supplierCategory) && (
                            <span className="text-[10px] text-muted-foreground truncate">
                              {p.assignedCategory?.name ?? p.supplierCategory}
                            </span>
                          )}
                        </div>
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
                      <td
                        className="px-3 py-2 whitespace-nowrap"
                        title={
                          hasManualOverride
                            ? `Override manual. Sugerido: ${formatPriceCompact(
                                calcPrice
                              )}`
                            : "Precio efectivo de venta"
                        }
                      >
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono font-semibold text-foreground">
                            {formatPriceCompact(effPrice)}
                          </span>
                          {hasManualOverride && (
                            <span className="text-[9px] px-1.5 py-0.5 rounded border font-medium bg-violet-500/15 text-violet-300 border-violet-500/30 uppercase tracking-wide">
                              Manual
                            </span>
                          )}
                        </div>
                      </td>
                      <td
                        className="px-3 py-2 whitespace-nowrap"
                        title={suggestedTooltip}
                      >
                        <div className="flex flex-col leading-tight">
                          <span className="font-mono text-muted-foreground">
                            {formatPriceCompact(calcPrice)}
                          </span>
                          {origin !== "none" && (
                            <span
                              className={`mt-0.5 inline-flex items-center gap-1 text-[9px] uppercase tracking-wide font-medium ${
                                origin === "manual"
                                  ? "text-violet-300/80"
                                  : origin === "category"
                                    ? "text-emerald-300/80"
                                    : origin === "provider"
                                      ? "text-amber-300/80"
                                      : "text-zinc-300/80"
                              }`}
                            >
                              {originInfo.label}
                              {enginePct != null && (
                                <span className="opacity-80">
                                  · {Math.round(enginePct)}%
                                </span>
                              )}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {effMargin != null ? (
                          <span
                            title={originInfo.tooltip}
                            className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${originInfo.cls}`}
                          >
                            {Math.round(effMargin)}%
                          </span>
                        ) : (
                          <span className="text-muted-foreground" title={originInfo.tooltip}>
                            —
                          </span>
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
                        <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${iBadge.cls}`}>
                          {iBadge.label}
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
                              onClick={() => {
                                handleBulkAction("prepare", [p.id]);
                                setContextMenuFor(null);
                              }}
                              className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted/40 flex items-center gap-2"
                            >
                              <PlayCircle className="w-3 h-3" /> Preparar para publicar
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                handleBulkAction("pause", [p.id]);
                                setContextMenuFor(null);
                              }}
                              className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted/40 flex items-center gap-2"
                            >
                              <PauseCircle className="w-3 h-3" /> Pausar
                            </button>
                            {p.manualMargin != null && (
                              <button
                                type="button"
                                onClick={() => {
                                  setContextMenuFor(null);
                                  handleClearMargin([p.id]);
                                }}
                                className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted/40 flex items-center gap-2"
                              >
                                <X className="w-3 h-3" /> Quitar margen manual
                              </button>
                            )}
                            <button
                              type="button"
                              disabled
                              title="Próximamente — requiere tienda ecommerce conectada"
                              className="opacity-40 cursor-not-allowed w-full text-left px-3 py-1.5 text-xs flex items-center gap-2"
                            >
                              <Lock className="w-3 h-3" /> Publicar en tienda
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
                                handleBulkAction("ignore", [p.id]);
                                setContextMenuFor(null);
                              }}
                              className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted/40 flex items-center gap-2 text-muted-foreground"
                            >
                              <Ban className="w-3 h-3" /> Marcar ignorado
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                handleBulkAction("archive", [p.id]);
                                setContextMenuFor(null);
                              }}
                              className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted/40 flex items-center gap-2 text-muted-foreground"
                            >
                              <Archive className="w-3 h-3" /> Archivar
                            </button>
                            {(p.internalStatus === "ARCHIVED" || p.internalStatus === "IGNORED") && (
                              <button
                                type="button"
                                onClick={() => {
                                  handleBulkAction("restore", [p.id]);
                                  setContextMenuFor(null);
                                }}
                                className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted/40 flex items-center gap-2 text-muted-foreground"
                              >
                                <RotateCcw className="w-3 h-3" /> Restaurar
                              </button>
                            )}
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
              <button
                type="button"
                onClick={() => handleBulkAction("prepare")}
                className="text-xs flex items-center gap-1.5 border border-border px-3 py-1.5 rounded-md hover:bg-muted/40"
              >
                <PlayCircle className="w-3.5 h-3.5" /> Preparar
              </button>
              <button
                type="button"
                onClick={() => handleBulkAction("pause")}
                className="text-xs flex items-center gap-1.5 border border-border px-3 py-1.5 rounded-md hover:bg-muted/40"
              >
                <PauseCircle className="w-3.5 h-3.5" /> Pausar
              </button>
              <button
                type="button"
                onClick={() => handleBulkAction("archive")}
                className="text-xs flex items-center gap-1.5 border border-border px-3 py-1.5 rounded-md hover:bg-muted/40"
              >
                <Archive className="w-3.5 h-3.5" /> Archivar
              </button>
              <button
                type="button"
                onClick={() => handleBulkAction("ignore")}
                className="text-xs flex items-center gap-1.5 border border-border px-3 py-1.5 rounded-md hover:bg-muted/40"
              >
                <Ban className="w-3.5 h-3.5" /> Ignorar
              </button>
              <button
                type="button"
                onClick={() => handleBulkAction("restore")}
                className="text-xs flex items-center gap-1.5 border border-border px-3 py-1.5 rounded-md hover:bg-muted/40"
              >
                <RotateCcw className="w-3.5 h-3.5" /> Restaurar
              </button>
              <button
                type="button"
                disabled
                title="Próximamente — requiere tienda ecommerce conectada"
                className="flex items-center gap-1.5 text-xs border border-border bg-background px-2.5 py-1 rounded-md opacity-40 cursor-not-allowed"
              >
                <Lock className="w-3.5 h-3.5" /> Publicar
              </button>
              <button
                type="button"
                disabled
                title="Próximamente — gestión de categorías"
                className="text-xs flex items-center gap-1.5 border border-border px-3 py-1.5 rounded-md text-muted-foreground/50 cursor-not-allowed"
              >
                <Lock className="w-3 h-3" /> Categoría
              </button>
              <button
                type="button"
                onClick={() => setMarginModalOpen(true)}
                className="text-xs flex items-center gap-1.5 border border-border px-3 py-1.5 rounded-md hover:bg-muted/40"
              >
                <Tag className="w-3.5 h-3.5" /> Aplicar margen
              </button>
              <button
                type="button"
                onClick={() => handleClearMargin(Array.from(selectedIds))}
                className="text-xs flex items-center gap-1.5 border border-border px-3 py-1.5 rounded-md hover:bg-muted/40"
              >
                <X className="w-3.5 h-3.5" /> Quitar margen
              </button>
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
          refresh();
        }}
      />

      {marginModalOpen && (
        <ApplyMarginModal
          selectedIds={Array.from(selectedIds)}
          filters={{
            providerId: providerId !== "all" ? providerId : undefined,
          }}
          onClose={() => setMarginModalOpen(false)}
          onApplied={() => {
            setMarginModalOpen(false);
            deselectAll();
            refresh();
          }}
        />
      )}
    </div>
  );
}
