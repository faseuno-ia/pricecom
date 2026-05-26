"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import {
  ImageOff,
  Edit,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Download,
  FileSpreadsheet,
  Loader2,
  Search,
  MoreHorizontal,
  ExternalLink,
  Plus,
  Ban,
  Eye,
  Tag,
  PlayCircle,
  PauseCircle,
  RotateCcw,
  X,
  Clock,
  Trash2,
  Pin,
  FolderPlus,
  FolderMinus,
  PackagePlus,
  PackageMinus,
  PackageX,
  DollarSign,
  Globe,
} from "lucide-react";
import { normalizeImageUrl } from "@/lib/utils";
import { CatalogProductDrawer } from "./catalog-product-drawer";
import { ApplyMarginModal } from "./apply-margin-modal";
import { ApplyCostModal } from "./apply-cost-modal";
import { CategoryBulkModal } from "./category-bulk-modal";
import { usePinnedActions } from "@/lib/hooks/use-pinned-actions";
import {
  deriveVisualStatus,
  visualStatusConfig,
  visualStatusDescriptions,
  VISUAL_STATUS_ORDER,
  type VisualStatus,
} from "@/lib/catalog/visual-status";
import { StatusHelpModal } from "@/components/ui/status-help-modal";

type SupplierStatus = "ACTIVE" | "SUPPLIER_REMOVED";
type InternalStatus =
  | "NOT_PUBLISHED"
  | "PREPARED"
  | "PUBLISHED"
  | "PAUSED"
  | "IGNORED";
type StatusBulkAction = "ignore" | "restore" | "prepare" | "pause";
type SourceType = "SCRAPED" | "MANUAL" | "IMPORTED";
type StockSource = "SUPPLIER" | "OWN" | "HYBRID";

interface CatalogRow {
  id: string;
  sku: string | null;
  publicationSku: string | null;
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
  stockSource: StockSource;
  provider: {
    id: string;
    name: string;
    baseUrl: string;
    providerType: "SCRAPER" | "MANUAL" | "IMPORTED" | "OWN_STOCK";
  };
  images: { id: string; url: string; isPrimary: boolean }[];
  assignedCategory: { id: string; name: string } | null;
  publications: {
    status: string;
    storeId: string;
    externalProductId: string | null;
    pendingSync: boolean;
    syncStatus: string | null;
  }[];
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
  initialStockSource?: StockSource | null;
  initialSupplierStatus?: SupplierStatus | null;
}

// Paleta sutil para los chips de proveedor en la tabla.
const providerPalette = [
  "bg-purple-500/10 text-purple-300 border-purple-500/20",
  "bg-cyan-500/10 text-cyan-300 border-cyan-500/20",
  "bg-pink-500/10 text-pink-300 border-pink-500/20",
  "bg-yellow-500/10 text-yellow-300 border-yellow-500/20",
  "bg-indigo-500/10 text-indigo-300 border-indigo-500/20",
  "bg-rose-500/10 text-rose-300 border-rose-500/20",
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

type RuleOrigin = "manual" | "category" | "provider" | "global" | "none";

const originLabel: Record<RuleOrigin, string> = {
  manual: "Manual",
  category: "Categoría",
  provider: "Proveedor",
  global: "Global",
  none: "Sin regla",
};

// Badges del catálogo: ver lib/catalog/visual-status.ts. La columna única
// "Estado" muestra el VisualStatus derivado de internalStatus + supplierStatus
// + el estado de sync de las publications.

export function CatalogTable({
  providers,
  initialProviderId,
  initialSourceType,
  initialStockSource,
  initialSupplierStatus,
}: Props) {
  const [search, setSearch] = useState("");
  const [providerId, setProviderId] = useState<string>(initialProviderId ?? "all");
  const [supplierStatus, setSupplierStatus] = useState<SupplierStatus | "all">(
    initialSupplierStatus ?? "all"
  );
  // Filtro unificado: estado visual derivado (Sin publicar / Preparado /
  // Publicado / Desactualizado / Sin stock / Pausado / Ignorado). Reemplaza
  // los dos filtros viejos de internalStatus + publicationStatus.
  const [visualStatusFilter, setVisualStatusFilter] = useState<
    VisualStatus | "all"
  >("all");
  const [sourceFilter, setSourceFilter] = useState<SourceType | "all">(
    initialSourceType ?? "all"
  );
  const [stockSourceFilter, setStockSourceFilter] = useState<StockSource | "all">(
    initialStockSource ?? "all"
  );
  const [noImage, setNoImage] = useState(false);
  const [noCategory, setNoCategory] = useState(false);
  const [showRemovedIgnored, setShowRemovedIgnored] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [allFilterSelected, setAllFilterSelected] = useState(false);
  const [loadingAllIds, setLoadingAllIds] = useState(false);
  const [data, setData] = useState<{ products: CatalogRow[]; total: number }>({
    products: [],
    total: 0,
  });
  const [loading, setLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [failedImages, setFailedImages] = useState<Set<string>>(new Set());
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [marginModalOpen, setMarginModalOpen] = useState(false);
  const [costModalOpen, setCostModalOpen] = useState(false);
  const [categoryModalMode, setCategoryModalMode] = useState<
    "assign" | "remove" | null
  >(null);
  const [downloading, setDownloading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [contextMenuFor, setContextMenuFor] = useState<string | null>(null);
  // Si la fila está cerca del bottom del viewport, abrimos el menú hacia
  // arriba para que no quede cortado por el borde inferior.
  const [contextMenuDir, setContextMenuDir] = useState<"down" | "up">("down");
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const actionsMenuRef = useRef<HTMLDivElement | null>(null);

  const { pinned, togglePin, isPinned } = usePinnedActions();

  // Reset page al cambiar filtros
  useEffect(() => {
    setPage(1);
  }, [
    search,
    providerId,
    supplierStatus,
    visualStatusFilter,
    sourceFilter,
    stockSourceFilter,
    noImage,
    noCategory,
    showRemovedIgnored,
  ]);

  // Si cambian los filtros, la "selección de todo el filtro" deja de ser válida
  // — invalidamos el flag y limpiamos los IDs cacheados.
  useEffect(() => {
    setAllFilterSelected(false);
    setSelectedIds(new Set());
  }, [
    search,
    providerId,
    supplierStatus,
    visualStatusFilter,
    sourceFilter,
    stockSourceFilter,
    noImage,
    noCategory,
    showRemovedIgnored,
  ]);

  // Filtros activos para mandarlos al export (mismo formato que la API)
  const currentFilters = useMemo(
    () => ({
      ...(search.trim() ? { search: search.trim() } : {}),
      ...(providerId !== "all" ? { providerId } : {}),
      ...(supplierStatus !== "all" ? { supplierStatus } : {}),
      ...(visualStatusFilter !== "all"
        ? { visualStatus: visualStatusFilter }
        : {}),
      ...(sourceFilter !== "all" ? { sourceType: sourceFilter } : {}),
      ...(stockSourceFilter !== "all" ? { stockSource: stockSourceFilter } : {}),
      ...(noImage ? { noImage: true } : {}),
      ...(noCategory ? { noCategory: true } : {}),
      ...(showRemovedIgnored ? { showRemovedIgnored: true } : {}),
    }),
    [
      search,
      providerId,
      supplierStatus,
      visualStatusFilter,
      sourceFilter,
      stockSourceFilter,
      noImage,
      noCategory,
      showRemovedIgnored,
    ]
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
        if (supplierStatus !== "all")
          params.set("supplierStatus", supplierStatus);
        if (visualStatusFilter !== "all")
          params.set("visualStatus", visualStatusFilter);
        if (sourceFilter !== "all") params.set("sourceType", sourceFilter);
        if (stockSourceFilter !== "all")
          params.set("stockSource", stockSourceFilter);
        if (noImage) params.set("noImage", "true");
        if (noCategory) params.set("noCategory", "true");
        if (showRemovedIgnored) params.set("showRemovedIgnored", "true");
        params.set("page", String(page));
        params.set("pageSize", String(pageSize));

        const res = await fetch(`/api/catalog?${params.toString()}`);
        if (!res.ok) throw new Error("Error al cargar catálogo");
        const json = (await res.json()) as {
          products: CatalogRow[];
          total: number;
        };
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
  }, [
    search,
    providerId,
    supplierStatus,
    visualStatusFilter,
    sourceFilter,
    stockSourceFilter,
    noImage,
    noCategory,
    showRemovedIgnored,
    page,
    pageSize,
    reloadKey,
  ]);

  // Cerrar menú contextual al click fuera
  useEffect(() => {
    function onClick() {
      setContextMenuFor(null);
    }
    if (contextMenuFor) {
      window.addEventListener("click", onClick);
      return () => window.removeEventListener("click", onClick);
    }
  }, [contextMenuFor]);

  // Cerrar dropdown "Acciones" al click fuera
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (
        actionsMenuRef.current &&
        !actionsMenuRef.current.contains(e.target as Node)
      ) {
        setActionsMenuOpen(false);
      }
    }
    if (actionsMenuOpen) {
      window.addEventListener("click", onClick);
      return () => window.removeEventListener("click", onClick);
    }
  }, [actionsMenuOpen]);

  const totalPages = Math.max(1, Math.ceil(data.total / pageSize));

  // Restaurar solo aplica a productos IGNORED. En la barra masiva, ocultamos
  // el botón cuando no hay ninguno seleccionado en ese estado.
  const hasIgnoredInSelection = useMemo(
    () =>
      data.products.some(
        (p) => selectedIds.has(p.id) && p.internalStatus === "IGNORED"
      ),
    [data.products, selectedIds]
  );

  // mark_no_stock y set_cost solo aplican a productos no-SCRAPER. La acción
  // queda visible apenas hay al menos uno elegible en la selección visible
  // (el backend de bulk-update se encarga del resto en caso de mezcla).
  const hasNonScraperInSelection = useMemo(
    () =>
      data.products.some(
        (p) =>
          selectedIds.has(p.id) && p.provider.providerType !== "SCRAPER"
      ),
    [data.products, selectedIds]
  );

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
    if (allFilterSelected && allVisibleSelected) {
      deselectAll();
      return;
    }
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) for (const id of visibleIds) next.delete(id);
      else for (const id of visibleIds) next.add(id);
      return next;
    });
  }
  function deselectAll() {
    setSelectedIds(new Set());
    setAllFilterSelected(false);
  }

  async function handleSelectAllFilter() {
    setLoadingAllIds(true);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set("search", search.trim());
      if (providerId !== "all") params.set("providerId", providerId);
      if (supplierStatus !== "all") params.set("supplierStatus", supplierStatus);
      if (visualStatusFilter !== "all")
        params.set("visualStatus", visualStatusFilter);
      if (sourceFilter !== "all") params.set("sourceType", sourceFilter);
      if (stockSourceFilter !== "all")
        params.set("stockSource", stockSourceFilter);
      if (noImage) params.set("noImage", "true");
      if (noCategory) params.set("noCategory", "true");
      if (showRemovedIgnored) params.set("showRemovedIgnored", "true");

      const res = await fetch(`/api/catalog/ids?${params.toString()}`);
      if (!res.ok) throw new Error("Error al cargar IDs del filtro");
      const json = (await res.json()) as {
        ids: string[];
        total: number;
        truncated: boolean;
      };
      setSelectedIds(new Set(json.ids));
      setAllFilterSelected(true);
      if (json.truncated) {
        toast.warning(
          `Selección truncada a ${json.total} productos (tope del servidor). Refiná los filtros si necesitás más.`
        );
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoadingAllIds(false);
    }
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
        res.headers
          .get("content-disposition")
          ?.match(/filename="?([^";]+)"?/)?.[1] ?? "catalogo.xlsx";
      triggerBlobDownload(blob, filename);
      toast.success(
        `Excel descargado (${
          selectedIds.size > 0
            ? `${selectedIds.size} seleccionados`
            : `${data.total} productos`
        })`
      );
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setExporting(false);
    }
  }

  // Descarga imágenes: si selección ≤ 100, un POST; si más, batches de 100
  // y merge con JSZip en el cliente.
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
          res.headers
            .get("content-disposition")
            ?.match(/filename="?([^";]+)"?/)?.[1] ?? "catalog-images.zip";
        triggerBlobDownload(blob, filename);
        toast.success(`ZIP descargado (${ids.length} imágenes)`);
      } else {
        const JSZip = (await import("jszip")).default;
        const batches: string[][] = [];
        for (let i = 0; i < ids.length; i += BATCH)
          batches.push(ids.slice(i, i + BATCH));
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
            toast.error(
              `Lote ${i + 1}/${batches.length} falló: ${(err as Error).message}`
            );
          }
        }
        if (added === 0) throw new Error("Ningún lote pudo descargarse");
        const zipBlob = await merged.generateAsync({ type: "blob" });
        triggerBlobDownload(
          zipBlob,
          `catalog-images-${new Date().toISOString().slice(0, 10)}.zip`
        );
        if (failed > 0)
          toast.warning(`ZIP descargado (${added}). ${failed} lote(s) fallaron.`);
        else
          toast.success(
            `ZIP descargado (${added} imágenes en ${batches.length} lotes)`
          );
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setDownloading(false);
    }
  }

  async function handleStatusBulk(action: StatusBulkAction, ids?: string[]) {
    const targetIds = ids ?? Array.from(selectedIds);
    if (targetIds.length === 0) return;

    const labels: Record<StatusBulkAction, string> = {
      ignore: "ignorar",
      restore: "restaurar",
      prepare: "preparar para publicar",
      pause: "pausar",
    };
    const verb = labels[action];

    if (targetIds.length > 1) {
      if (
        !window.confirm(
          `¿${verb[0].toUpperCase() + verb.slice(1)} ${targetIds.length} productos?`
        )
      ) {
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
      if (!ids) deselectAll();
      refresh();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function handleDeleteOwnStock(id: string) {
    if (
      !window.confirm(
        "¿Eliminar este producto del stock propio? Esta acción no se puede deshacer."
      )
    ) {
      return;
    }
    try {
      const res = await fetch(`/api/catalog/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      toast.success("Producto eliminado del stock propio");
      refresh();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function handleCopyToOwnStock(ids: string[]) {
    if (ids.length === 0) return;
    if (
      ids.length > 1 &&
      !window.confirm(
        `¿Agregar ${ids.length} productos a stock propio? El producto pasa a stockSource=OWN y deja de depender de la baja del proveedor.`
      )
    ) {
      return;
    }
    try {
      const res = await fetch("/api/catalog/bulk-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productIds: ids, action: "copy_own_stock" }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const { updated } = (await res.json()) as { updated: number };
      toast.success(
        ids.length === 1
          ? "Agregado a stock propio"
          : `${updated} producto${updated !== 1 ? "s" : ""} en stock propio`
      );
      if (ids.length > 1) deselectAll();
      refresh();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function handlePublishToStore(ids: string[]) {
    if (ids.length === 0) return;
    if (
      ids.length > 1 &&
      !window.confirm(
        `¿Publicar ${ids.length} productos en tu tienda WooCommerce? El proceso puede tardar unos segundos por producto.`
      )
    ) {
      return;
    }
    try {
      const res = await fetch("/api/catalog/bulk-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productIds: ids, action: "publish" }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const { published, errors, total } = (await res.json()) as {
        published: number;
        errors: { id: string; error: string }[];
        total: number;
      };
      if (errors.length === 0) {
        toast.success(
          published === 1
            ? "Producto publicado en WooCommerce"
            : `${published} productos publicados en WooCommerce`
        );
      } else if (published > 0) {
        toast.warning(
          `${published}/${total} publicados — ${errors.length} con error (${errors[0]?.error?.slice(0, 80) ?? "ver detalles"})`
        );
      } else {
        toast.error(
          `Ninguno publicado — ${errors[0]?.error?.slice(0, 120) ?? "error desconocido"}`
        );
      }
      if (ids.length > 1) deselectAll();
      refresh();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function handleRemoveFromOwnStock(ids: string[]) {
    if (ids.length === 0) return;
    if (
      ids.length > 1 &&
      !window.confirm(
        `¿Quitar ${ids.length} productos del stock propio? Los publicados que el proveedor ya no tenga se auto-pausarán.`
      )
    ) {
      return;
    }
    try {
      const res = await fetch("/api/catalog/bulk-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productIds: ids, action: "remove_own_stock" }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const { updated, autoPaused } = (await res.json()) as {
        updated: number;
        autoPaused: number;
      };
      const pausedNote =
        autoPaused > 0
          ? ` · ${autoPaused} auto-pausado${autoPaused !== 1 ? "s" : ""}`
          : "";
      toast.success(
        ids.length === 1
          ? `Quitado de stock propio${pausedNote}`
          : `${updated} fuera de stock propio${pausedNote}`
      );
      if (ids.length > 1) deselectAll();
      refresh();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function handleClearPrice(ids: string[]) {
    if (ids.length === 0) return;
    if (
      ids.length > 1 &&
      !window.confirm(
        `¿Quitar precio final de ${ids.length} producto${ids.length > 1 ? "s" : ""}? Volverán a usar el precio calculado por la regla de pricing.`
      )
    ) {
      return;
    }
    try {
      const res = await fetch("/api/catalog/bulk-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productIds: ids, action: "clear_price" }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const { updated } = (await res.json()) as { updated: number };
      toast.success(
        ids.length === 1
          ? "Precio final quitado"
          : `Precio final quitado de ${updated} producto${updated !== 1 ? "s" : ""}`
      );
      if (ids.length > 1) deselectAll();
      refresh();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function handleMarkNoStock(ids: string[]) {
    if (ids.length === 0) return;
    if (
      ids.length > 1 &&
      !window.confirm(
        `¿Marcar sin stock ${ids.length} productos? Solo aplica a proveedores manuales / importados / stock propio. Los SCRAPER se saltean.`
      )
    ) {
      return;
    }
    try {
      const res = await fetch("/api/catalog/bulk-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productIds: ids, action: "mark_no_stock" }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const { updated, skipped, wooErrors } = (await res.json()) as {
        updated: number;
        skipped: number;
        wooErrors: number;
      };
      const skippedNote = skipped > 0 ? ` · ${skipped} salteado(s) (SCRAPER)` : "";
      const wooNote = wooErrors > 0 ? ` · ${wooErrors} error(es) en Woo` : "";
      if (updated === 0) {
        toast.warning("Sin productos elegibles (todos SCRAPER)");
      } else {
        toast.success(
          ids.length === 1
            ? `Marcado sin stock${wooNote}`
            : `${updated} sin stock${skippedNote}${wooNote}`
        );
      }
      if (ids.length > 1) deselectAll();
      refresh();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

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

  // ─── Bulk actions: descriptor + grupos para el dropdown ────────────────
  type BulkActionDef = {
    id: string;
    label: string;
    icon: typeof Tag;
    onClick: () => void;
    disabled?: boolean;
    hidden?: boolean;
    title?: string;
  };

  const idsArr = Array.from(selectedIds);

  const ACTION_DEFS: Record<string, BulkActionDef> = {
    apply_margin: {
      id: "apply_margin",
      label: "Aplicar margen",
      icon: Tag,
      onClick: () => setMarginModalOpen(true),
    },
    apply_cost: {
      id: "apply_cost",
      label: "Aplicar costo",
      icon: DollarSign,
      onClick: () => setCostModalOpen(true),
      hidden: !hasNonScraperInSelection,
      title: "Solo aplica a proveedores no-scraper",
    },
    clear_margin: {
      id: "clear_margin",
      label: "Quitar margen manual",
      icon: X,
      onClick: () => handleClearMargin(idsArr),
    },
    clear_price: {
      id: "clear_price",
      label: "Quitar precio final",
      icon: X,
      onClick: () => handleClearPrice(idsArr),
    },
    prepare: {
      id: "prepare",
      label: "Preparar",
      icon: PlayCircle,
      onClick: () => handleStatusBulk("prepare"),
    },
    publish: {
      id: "publish",
      label: "Publicar en tienda",
      icon: Globe,
      onClick: () => handlePublishToStore(idsArr),
    },
    pause: {
      id: "pause",
      label: "Pausar",
      icon: PauseCircle,
      onClick: () => handleStatusBulk("pause"),
    },
    ignore: {
      id: "ignore",
      label: "Ignorar",
      icon: Ban,
      onClick: () => handleStatusBulk("ignore"),
    },
    restore: {
      id: "restore",
      label: "Restaurar",
      icon: RotateCcw,
      onClick: () => handleStatusBulk("restore"),
      hidden: !hasIgnoredInSelection,
      title: "Solo aplica a productos IGNORED",
    },
    copy_own_stock: {
      id: "copy_own_stock",
      label: "Agregar a stock propio",
      icon: PackagePlus,
      onClick: () => handleCopyToOwnStock(idsArr),
    },
    remove_own_stock: {
      id: "remove_own_stock",
      label: "Quitar del stock propio",
      icon: PackageMinus,
      onClick: () => handleRemoveFromOwnStock(idsArr),
    },
    mark_no_stock: {
      id: "mark_no_stock",
      label: "Marcar sin stock",
      icon: PackageX,
      onClick: () => handleMarkNoStock(idsArr),
      hidden: !hasNonScraperInSelection,
      title:
        "Solo aplica a proveedores no-scraper. Marca el producto como sin stock y baja la publicación en la tienda.",
    },
    assign_category: {
      id: "assign_category",
      label: "Asignar categoría",
      icon: FolderPlus,
      onClick: () => setCategoryModalMode("assign"),
    },
    remove_category: {
      id: "remove_category",
      label: "Quitar categoría",
      icon: FolderMinus,
      onClick: () => setCategoryModalMode("remove"),
    },
  };

  const ACTION_GROUPS = [
    {
      label: "Comercial",
      ids: [
        "apply_margin",
        "apply_cost",
        "clear_margin",
        "clear_price",
        "assign_category",
        "remove_category",
      ],
    },
    { label: "Publicación", ids: ["prepare", "publish", "pause"] },
    {
      label: "Catálogo",
      ids: [
        "ignore",
        "restore",
        "copy_own_stock",
        "remove_own_stock",
        "mark_no_stock",
      ],
    },
  ];

  // Acciones pinneadas visibles en la barra (filtramos las hidden por contexto).
  const visiblePinned = pinned
    .map((id) => ACTION_DEFS[id])
    .filter((d): d is BulkActionDef => !!d && !d.hidden);

  // Sticky positions actualizadas — primeras 4 columnas son sticky.
  const sticky = {
    checkbox: { left: 0, width: 40 },
    image: { left: 40, width: 56 },
    sku: { left: 96, width: 130 },
    product: { left: 226, width: 220 },
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
            {exporting ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <FileSpreadsheet className="w-3.5 h-3.5" />
            )}
            Exportar
          </button>
          <a
            href="/catalog/import"
            className="flex items-center gap-1.5 text-xs border border-border bg-card px-3 py-2 rounded-lg hover:bg-muted/40 transition-colors"
            title="Importar Excel"
          >
            <Download className="w-3.5 h-3.5" /> Importar
          </a>
          <a
            href="/catalog/new"
            className="flex items-center gap-1.5 text-xs bg-primary text-primary-foreground border border-primary px-3 py-2 rounded-lg hover:bg-primary/90 transition-colors font-medium"
            title="Agregar producto manual"
          >
            <Plus className="w-3.5 h-3.5" /> Agregar
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
          onChange={(e) =>
            setSupplierStatus(e.target.value as SupplierStatus | "all")
          }
          className="text-xs bg-background border border-border rounded-md px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/60"
        >
          <option value="all">Estado prov.: Todos</option>
          <option value="ACTIVE">Activo</option>
          <option value="SUPPLIER_REMOVED">Removido por proveedor</option>
        </select>

        <div className="inline-flex items-center gap-1">
          <select
            value={visualStatusFilter}
            onChange={(e) =>
              setVisualStatusFilter(e.target.value as VisualStatus | "all")
            }
            className="text-xs bg-background border border-border rounded-md px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/60"
          >
            <option value="all">Estado: Todos</option>
            {VISUAL_STATUS_ORDER.map((s) => (
              <option key={s} value={s}>
                {visualStatusConfig[s].label}
              </option>
            ))}
          </select>
          <StatusHelpModal />
        </div>

        <select
          value={stockSourceFilter}
          onChange={(e) =>
            setStockSourceFilter(e.target.value as StockSource | "all")
          }
          className="text-xs bg-background border border-border rounded-md px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/60"
        >
          <option value="all">Stock: Todos</option>
          <option value="SUPPLIER">Proveedor</option>
          <option value="OWN">Stock propio</option>
          <option value="HYBRID">Híbrido</option>
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

        <select
          value={pageSize}
          onChange={(e) => {
            setPageSize(Number(e.target.value));
            setPage(1);
          }}
          className="text-xs bg-background border border-border rounded-md px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/60"
          title="Cantidad de productos por página"
        >
          <option value={50}>50 por página</option>
          <option value={100}>100 por página</option>
          <option value={250}>250 por página</option>
          <option value={500}>500 por página</option>
        </select>

        <div className="flex items-center gap-1.5 ml-auto">
          <button
            type="button"
            onClick={() => setNoImage((v) => !v)}
            className={`text-[11px] px-2.5 py-0.5 rounded-full border transition-colors ${
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
            className={`text-[11px] px-2.5 py-0.5 rounded-full border transition-colors ${
              noCategory
                ? "bg-primary/15 text-primary border-primary/40"
                : "border-border text-muted-foreground hover:text-foreground hover:bg-muted/40"
            }`}
          >
            Sin categoría
          </button>
          <button
            type="button"
            onClick={() => setShowRemovedIgnored((v) => !v)}
            className={`text-[11px] px-2.5 py-0.5 rounded-full border transition-colors ${
              showRemovedIgnored
                ? "bg-primary/15 text-primary border-primary/40"
                : "border-border text-muted-foreground hover:text-foreground hover:bg-muted/40"
            }`}
            title="Incluir/excluir productos removidos por proveedor e ignorados"
          >
            Removidos/ignorados
          </button>
        </div>
      </div>

      {/* Banner: seleccionar todo el filtro */}
      {!allFilterSelected &&
        selectedIds.size > 0 &&
        selectedIds.size === data.products.length &&
        data.total > data.products.length && (
          <div className="bg-primary/10 border border-primary/30 rounded-md px-4 py-2 text-xs flex items-center justify-between gap-3 flex-wrap">
            <span>
              {selectedIds.size} producto
              {selectedIds.size === 1 ? "" : "s"} seleccionado
              {selectedIds.size === 1 ? "" : "s"} en esta página.
            </span>
            <button
              type="button"
              onClick={handleSelectAllFilter}
              disabled={loadingAllIds}
              className="text-primary font-medium hover:underline disabled:opacity-60 flex items-center gap-1.5"
            >
              {loadingAllIds && <Loader2 className="w-3 h-3 animate-spin" />}
              Seleccionar los {data.total.toLocaleString("es-AR")} productos del filtro actual
            </button>
          </div>
        )}

      {allFilterSelected && (
        <div className="bg-primary/10 border border-primary/30 rounded-md px-4 py-2 text-xs flex items-center justify-between gap-3 flex-wrap">
          <span>
            Los {selectedIds.size.toLocaleString("es-AR")} producto
            {selectedIds.size === 1 ? "" : "s"} del filtro están seleccionados.
          </span>
          <button
            type="button"
            onClick={() => deselectAll()}
            className="text-muted-foreground hover:underline"
          >
            Cancelar selección
          </button>
        </div>
      )}

      {/* Tabla */}
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
                  style={{ left: sticky.sku.left, minWidth: sticky.sku.width }}
                  title="SKU comercial (publicationSku) — el que el cliente usa en su tienda"
                >
                  SKU Comercial
                </th>
                <th
                  className="sticky z-30 bg-muted/20 px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider"
                  style={{ left: sticky.product.left, minWidth: sticky.product.width }}
                >
                  Producto
                </th>
                <th
                  className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap"
                  style={{ minWidth: 110 }}
                >
                  Proveedor
                </th>
                <th
                  className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap"
                  style={{ minWidth: 100 }}
                  title="SKU original del proveedor"
                >
                  SKU Prov.
                </th>
                <th
                  className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap"
                  style={{ minWidth: 90 }}
                >
                  Costo
                </th>
                <th
                  className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap"
                  style={{ minWidth: 130 }}
                  title="Precio efectivo de venta + origen del margen"
                >
                  Precio de venta
                </th>
                <th
                  className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap"
                  style={{ minWidth: 80 }}
                >
                  Stock
                </th>
                <th
                  className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap"
                  style={{ minWidth: 140 }}
                >
                  Estado
                </th>
                <th
                  className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap"
                  style={{ minWidth: 60 }}
                >
                  Acc.
                </th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={11} className="px-4 py-8 text-center text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin inline-block mr-2" />
                    Cargando catálogo...
                  </td>
                </tr>
              )}
              {!loading && data.products.length === 0 && (
                <tr>
                  <td colSpan={11} className="px-4 py-12 text-center text-muted-foreground">
                    <Search className="w-6 h-6 mx-auto mb-2 opacity-30" />
                    Sin productos para los filtros aplicados
                  </td>
                </tr>
              )}
              {!loading &&
                data.products.map((p) => {
                  const anyDrift = p.publications.some(
                    (pub) =>
                      pub.pendingSync ||
                      (pub.syncStatus &&
                        pub.syncStatus !== "SYNCED" &&
                        pub.syncStatus !== "READY")
                  );
                  const visualStatus = deriveVisualStatus({
                    internalStatus: p.internalStatus,
                    supplierStatus: p.supplierStatus,
                    pendingSync: anyDrift,
                  });
                  const vBadge = visualStatusConfig[visualStatus];
                  const vDescription = visualStatusDescriptions[visualStatus];
                  const effPrice = p.pricing?.effectivePrice ?? null;
                  const origin: RuleOrigin = p.pricing?.ruleApplied ?? "none";
                  const enginePct = p.pricing?.marginPercent ?? null;
                  const displayName =
                    p.commercialTitle?.trim() || p.supplierName;
                  const skuComercial = p.publicationSku ?? p.sku ?? "—";
                  const rawImage = p.images[0]?.url ?? p.imageUrl ?? null;
                  const normalizedImage = normalizeImageUrl(rawImage);
                  const imageFailed = failedImages.has(p.id);
                  // Opacidad reducida basada en el estado visual derivado:
                  // SIN_STOCK (proveedor removió el item) e IGNORED (el usuario
                  // lo descartó). Los PAUSED manuales se ven normales — el
                  // badge alcanza para identificarlos.
                  const isInactive =
                    visualStatus === "SIN_STOCK" ||
                    visualStatus === "IGNORED";
                  // El "precio de venta" se destaca cuando el producto está
                  // PREPARED (listo para publicar) o ya PUBLISHED; en otros
                  // estados queda muted para no robar atención.
                  const priceTextCls =
                    p.internalStatus === "PREPARED" ||
                    p.internalStatus === "PUBLISHED"
                      ? "text-foreground"
                      : "text-muted-foreground";
                  return (
                    <tr
                      key={p.id}
                      className={`group border-b border-border transition-colors ${
                        isInactive
                          ? "opacity-40 bg-muted/5 hover:opacity-60"
                          : "hover:bg-muted/10"
                      }`}
                    >
                      <td
                        className="sticky z-20 bg-card group-hover:bg-muted/20 px-2 py-2"
                        style={{ left: sticky.checkbox.left, width: sticky.checkbox.width }}
                      >
                        <input
                          type="checkbox"
                          checked={selectedIds.has(p.id)}
                          onChange={() => toggleOne(p.id)}
                          className="cursor-pointer accent-primary"
                        />
                      </td>
                      <td
                        className="sticky z-20 bg-card group-hover:bg-muted/20 px-2 py-2"
                        style={{ left: sticky.image.left, width: sticky.image.width }}
                      >
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
                      <td
                        className="sticky z-20 bg-card group-hover:bg-muted/20 px-3 py-2"
                        style={{ left: sticky.sku.left, minWidth: sticky.sku.width }}
                      >
                        <span className="font-mono text-sm font-semibold">
                          {skuComercial}
                        </span>
                      </td>
                      <td
                        className="sticky z-20 bg-card group-hover:bg-muted/20 px-3 py-2"
                        style={{
                          left: sticky.product.left,
                          minWidth: sticky.product.width,
                          maxWidth: sticky.product.width,
                        }}
                      >
                        <div className="flex flex-col gap-0.5">
                          <span
                            className="text-sm font-medium truncate"
                            style={{ maxWidth: 200 }}
                            title={displayName}
                          >
                            {displayName}
                          </span>
                          {p.assignedCategory?.name && (
                            <span
                              className="text-[10px] text-muted-foreground truncate"
                              style={{ maxWidth: 200 }}
                            >
                              {p.assignedCategory.name}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span
                          title={p.provider.name}
                          className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${providerColorClass(p.provider.name)}`}
                        >
                          {p.provider.name.length > 10
                            ? p.provider.name.slice(0, 10) + "…"
                            : p.provider.name}
                        </span>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {p.sku ?? "—"}
                        </span>
                      </td>
                      <td className="px-3 py-2 font-mono text-muted-foreground whitespace-nowrap">
                        {formatPriceCompact(p.wholesalePrice)}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <div className="flex flex-col gap-0.5">
                          <span className={`font-mono text-sm font-semibold ${priceTextCls}`}>
                            {formatPriceCompact(effPrice)}
                          </span>
                          {origin !== "none" && (
                            <span className="text-[9px] uppercase tracking-wide text-muted-foreground/70">
                              {originLabel[origin]}
                              {enginePct != null && (
                                <> · {Math.round(enginePct)}%</>
                              )}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                        {p.stock ?? "—"}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span
                          title={vDescription}
                          className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${vBadge.className}`}
                        >
                          {vBadge.label}
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
                              if (contextMenuFor === p.id) {
                                setContextMenuFor(null);
                                return;
                              }
                              // Medimos espacio hacia abajo desde el botón.
                              // El menú renderiza ~9-11 ítems; estimamos 320px
                              // como tope. Si no entra abajo, abrimos arriba.
                              const rect = (
                                e.currentTarget as HTMLButtonElement
                              ).getBoundingClientRect();
                              const spaceBelow =
                                window.innerHeight - rect.bottom;
                              setContextMenuDir(spaceBelow < 320 ? "up" : "down");
                              setContextMenuFor(p.id);
                            }}
                            title="Más"
                            className="text-muted-foreground hover:text-foreground"
                          >
                            <MoreHorizontal className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        {contextMenuFor === p.id && (
                          <div
                            className={`absolute right-2 ${
                              contextMenuDir === "up"
                                ? "bottom-full mb-1"
                                : "top-full mt-1"
                            } z-40 bg-card border border-border rounded-lg shadow-2xl shadow-black/40 py-1 min-w-[200px] max-h-[60vh] overflow-y-auto`}
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
                                handleStatusBulk("prepare", [p.id]);
                                setContextMenuFor(null);
                              }}
                              className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted/40 flex items-center gap-2"
                            >
                              <PlayCircle className="w-3 h-3" /> Preparar para
                              publicar
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                handleStatusBulk("pause", [p.id]);
                                setContextMenuFor(null);
                              }}
                              className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted/40 flex items-center gap-2"
                            >
                              <PauseCircle className="w-3 h-3" /> Pausar
                            </button>
                            {p.provider.providerType !== "SCRAPER" &&
                              p.supplierStatus !== "SUPPLIER_REMOVED" && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    handleMarkNoStock([p.id]);
                                    setContextMenuFor(null);
                                  }}
                                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted/40 flex items-center gap-2"
                                >
                                  <PackageX className="w-3 h-3" /> Marcar sin
                                  stock
                                </button>
                              )}
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
                            {p.finalPrice != null && (
                              <button
                                type="button"
                                onClick={() => {
                                  setContextMenuFor(null);
                                  handleClearPrice([p.id]);
                                }}
                                className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted/40 flex items-center gap-2 text-muted-foreground"
                              >
                                <X className="w-3 h-3" /> Quitar precio final
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                setContextMenuFor(null);
                                handlePublishToStore([p.id]);
                              }}
                              className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted/40 flex items-center gap-2"
                            >
                              <Globe className="w-3 h-3" /> Publicar en tienda
                            </button>
                            {p.productUrl && (
                              <a
                                href={p.productUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted/40 flex items-center gap-2"
                                onClick={() => setContextMenuFor(null)}
                              >
                                <ExternalLink className="w-3 h-3" /> Ver en
                                proveedor
                              </a>
                            )}
                            <div className="border-t border-border my-1" />
                            {p.internalStatus !== "IGNORED" && (
                              <button
                                type="button"
                                onClick={() => {
                                  handleStatusBulk("ignore", [p.id]);
                                  setContextMenuFor(null);
                                }}
                                className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted/40 flex items-center gap-2 text-muted-foreground"
                              >
                                <Ban className="w-3 h-3" /> Marcar ignorado
                              </button>
                            )}
                            {p.internalStatus === "IGNORED" && (
                              <button
                                type="button"
                                onClick={() => {
                                  handleStatusBulk("restore", [p.id]);
                                  setContextMenuFor(null);
                                }}
                                className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted/40 flex items-center gap-2 text-muted-foreground"
                              >
                                <RotateCcw className="w-3 h-3" /> Restaurar
                              </button>
                            )}
                            {p.supplierStatus === "SUPPLIER_REMOVED" &&
                              p.stockSource !== "OWN" && (
                                <div className="px-3 py-1.5 text-[11px] text-muted-foreground/80 flex items-center gap-2">
                                  <Clock className="w-3 h-3" />
                                  Esperando reaparición del proveedor
                                </div>
                              )}
                            {p.stockSource !== "OWN" && (
                              <button
                                type="button"
                                onClick={() => {
                                  setContextMenuFor(null);
                                  handleCopyToOwnStock([p.id]);
                                }}
                                className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted/40 flex items-center gap-2 text-muted-foreground"
                              >
                                <PackagePlus className="w-3 h-3" /> Agregar a
                                stock propio
                              </button>
                            )}
                            {p.stockSource === "OWN" && (
                              <button
                                type="button"
                                onClick={() => {
                                  setContextMenuFor(null);
                                  handleRemoveFromOwnStock([p.id]);
                                }}
                                className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted/40 flex items-center gap-2 text-muted-foreground"
                              >
                                <PackageMinus className="w-3 h-3" /> Quitar del
                                stock propio
                              </button>
                            )}
                            {p.provider.providerType === "OWN_STOCK" && (
                              <>
                                <div className="border-t border-border my-1" />
                                <button
                                  type="button"
                                  onClick={() => {
                                    setContextMenuFor(null);
                                    handleDeleteOwnStock(p.id);
                                  }}
                                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-red-500/10 flex items-center gap-2 text-red-400"
                                >
                                  <Trash2 className="w-3 h-3" /> Eliminar del
                                  stock propio
                                </button>
                              </>
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

      {/* Barra masiva inferior */}
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
              {/* Imágenes — siempre visible (no pinneable) */}
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

              {/* Acciones pineadas */}
              {visiblePinned.map((def) => {
                const Icon = def.icon;
                return (
                  <button
                    key={def.id}
                    type="button"
                    onClick={def.onClick}
                    disabled={def.disabled}
                    title={def.title}
                    className="text-xs flex items-center gap-1.5 border border-border px-3 py-1.5 rounded-md hover:bg-muted/40 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Icon className="w-3.5 h-3.5" /> {def.label}
                  </button>
                );
              })}

              {/* Dropdown "Acciones ▼" — agrupado, con pin por acción */}
              <div className="relative" ref={actionsMenuRef}>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setActionsMenuOpen((v) => !v);
                  }}
                  className="text-xs flex items-center gap-1.5 border border-border px-3 py-1.5 rounded-md hover:bg-muted/40"
                >
                  Acciones <ChevronDown className="w-3.5 h-3.5" />
                </button>
                {actionsMenuOpen && (
                  <div
                    className="absolute right-0 bottom-full mb-1 z-40 bg-card border border-border rounded-lg shadow-2xl shadow-black/40 py-1 min-w-[260px] max-h-[60vh] overflow-y-auto"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {ACTION_GROUPS.map((group, gi) => (
                      <div key={group.label}>
                        {gi > 0 && <div className="border-t border-border my-1" />}
                        <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-muted-foreground/70">
                          {group.label}
                        </div>
                        {group.ids.map((id) => {
                          const def = ACTION_DEFS[id];
                          if (!def || def.hidden) return null;
                          const Icon = def.icon;
                          const isThisPinned = isPinned(id);
                          return (
                            <div
                              key={id}
                              className="flex items-center hover:bg-muted/40"
                            >
                              <button
                                type="button"
                                onClick={() => {
                                  if (def.disabled) return;
                                  setActionsMenuOpen(false);
                                  def.onClick();
                                }}
                                disabled={def.disabled}
                                title={def.title}
                                className="flex-1 text-left px-3 py-1.5 text-xs flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
                              >
                                <Icon className="w-3 h-3" /> {def.label}
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  togglePin(id);
                                }}
                                title={
                                  isThisPinned
                                    ? "Quitar de la barra masiva"
                                    : "Fijar a la barra masiva"
                                }
                                className="px-2 py-1.5 text-muted-foreground hover:text-foreground"
                              >
                                <Pin
                                  className={`w-3 h-3 ${
                                    isThisPinned
                                      ? "text-primary fill-primary"
                                      : ""
                                  }`}
                                />
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                )}
              </div>
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

      {categoryModalMode && (
        <CategoryBulkModal
          mode={categoryModalMode}
          selectedIds={Array.from(selectedIds)}
          onClose={() => setCategoryModalMode(null)}
          onDone={() => {
            setCategoryModalMode(null);
            refresh();
          }}
        />
      )}

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

      {costModalOpen && (
        <ApplyCostModal
          selectedIds={Array.from(selectedIds)}
          onClose={() => setCostModalOpen(false)}
          onApplied={() => {
            setCostModalOpen(false);
            deselectAll();
            refresh();
          }}
        />
      )}
    </div>
  );
}
