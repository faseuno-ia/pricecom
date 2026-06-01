"use client";

import { useState, useEffect, useMemo } from "react";
import { toast } from "sonner";
import {
  X,
  ExternalLink,
  ImageOff,
  Loader2,
  Plus,
  Power,
  Star,
  PackagePlus,
  PackageMinus,
} from "lucide-react";
import { formatPrice, normalizeImageUrl } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import { es } from "date-fns/locale";
import {
  deriveVisualStatus,
  visualStatusConfig,
  visualStatusDescriptions,
} from "@/lib/catalog/visual-status";
import { StatusHelpModal } from "@/components/ui/status-help-modal";

export interface CatalogProductDetail {
  id: string;
  sku: string | null;
  publicationSku: string | null;
  productUrl: string | null;
  supplierName: string;
  supplierDescription: string | null;
  wholesalePrice: number | null;
  stock: string | null;
  supplierCategory: string | null;
  imageUrl: string | null;
  lastSeenAt: string;
  supplierStatus: "ACTIVE" | "SUPPLIER_REMOVED";
  stockSource: "SUPPLIER" | "OWN" | "HYBRID";
  commercialTitle: string | null;
  commercialName: string | null;
  commercialDescription: string | null;
  finalPrice: number | null;
  manualMargin: number | null;
  manualPrice: number | null;
  notes: string | null;
  assignedCategoryId: string | null;
  provider: {
    id: string;
    name: string;
    baseUrl: string;
    providerType: "SCRAPER" | "MANUAL" | "IMPORTED" | "OWN_STOCK";
  };
  images: { id: string; url: string; isPrimary: boolean; source: string }[];
  assignedCategory: { id: string; name: string } | null;
  publications: {
    id: string;
    sku: string | null;
    status: string;
    storeId: string;
    externalProductId: string | null;
    pendingSync?: boolean;
    syncStatus?: string | null;
  }[];
  internalStatus?: string;
  pricing?: {
    calculatedPrice: number | null;
    effectivePrice: number | null;
    marginPercent: number | null;
    ruleApplied: "manual" | "category" | "provider" | "global" | "none";
    ruleName: string | null;
    ruleId: string | null;
    /// Si el proveedor tiene descuento sobre lista, estos campos permiten
    /// mostrar el desglose: precio lista → descuento → costo real → margen.
    listDiscountPercent?: number;
    effectiveCost?: number | null;
    wholesalePrice?: number | null;
  };
}

const stockSourceMeta: Record<
  "SUPPLIER" | "OWN" | "HYBRID",
  { label: string; cls: string; description: string }
> = {
  SUPPLIER: {
    label: "Stock del proveedor",
    cls: "bg-blue-500/15 text-blue-300 border-blue-500/30",
    description:
      "Dependemos del proveedor. Si lo remueven, la publicación se pausa.",
  },
  OWN: {
    label: "Stock propio",
    cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    description:
      "El cliente tiene este producto físicamente. Sobrevive a SUPPLIER_REMOVED.",
  },
  HYBRID: {
    label: "Stock híbrido",
    cls: "bg-amber-500/15 text-amber-300 border-amber-500/30",
    description: "Mix de stock propio y del proveedor. No se auto-pausa.",
  },
};

interface CategoryRaw {
  id: string;
  name: string;
  parentId: string | null;
}

interface CategoryNode extends CategoryRaw {
  depth: number;
}

// Aplana el árbol de categorías en orden jerárquico (preorden DFS).
// Cada nodo lleva su `depth` para indentar el dropdown.
function buildFlatTree(categories: CategoryRaw[]): CategoryNode[] {
  const byParent = new Map<string | null, CategoryRaw[]>();
  for (const c of categories) {
    const key = c.parentId ?? null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(c);
  }
  const result: CategoryNode[] = [];
  function walk(parentId: string | null, depth: number) {
    const children = (byParent.get(parentId) ?? []).slice().sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    for (const c of children) {
      result.push({ ...c, depth });
      walk(c.id, depth + 1);
    }
  }
  walk(null, 0);
  return result;
}

const ruleAppliedMeta: Record<
  "manual" | "category" | "provider" | "global" | "none",
  { label: string; cls: string }
> = {
  manual: {
    label: "Margen manual",
    cls: "bg-violet-500/15 text-violet-300 border-violet-500/30",
  },
  category: {
    label: "Regla por categoría",
    cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  },
  provider: {
    label: "Regla por proveedor",
    cls: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  },
  global: {
    label: "Regla global",
    cls: "bg-zinc-500/15 text-zinc-300 border-zinc-500/30",
  },
  none: {
    label: "Sin regla",
    cls: "bg-muted/40 text-muted-foreground border-border",
  },
};

interface Props {
  productId: string | null;
  onClose: () => void;
  onSaved?: (updated: CatalogProductDetail) => void;
}

export function CatalogProductDrawer({ productId, onClose, onSaved }: Props) {
  const [product, setProduct] = useState<CatalogProductDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [togglingPub, setTogglingPub] = useState(false);
  const [mainImageFailed, setMainImageFailed] = useState(false);
  const [thumbImageFailed, setThumbImageFailed] = useState(false);

  // Editable fields (mirror of product, lifted while drawer is open)
  const [commercialTitle, setCommercialTitle] = useState("");
  const [commercialDescription, setCommercialDescription] = useState("");
  const [publicationSku, setPublicationSku] = useState("");
  const [finalPrice, setFinalPrice] = useState<string>("");
  const [manualMargin, setManualMargin] = useState<string>("");
  // Costo mayorista — solo editable para productos de proveedores no-SCRAPER.
  // En SCRAPER lo maneja el worker.
  const [wholesalePrice, setWholesalePrice] = useState<string>("");
  const [notes, setNotes] = useState("");

  // Categorías asignadas al producto (M2M). Fuente de verdad para el render
  // del bloque; el primary se identifica por isPrimary y se sincroniza server-side
  // con CatalogProduct.assignedCategoryId.
  interface AssignedCat {
    id: string;
    name: string;
    parentId: string | null;
    isPrimary: boolean;
  }
  const [productCategories, setProductCategories] = useState<AssignedCat[]>([]);
  const [pickerMode, setPickerMode] = useState<"closed" | "pick" | "create">(
    "closed"
  );
  const [pickValue, setPickValue] = useState<string>("");
  const [newCatName, setNewCatName] = useState("");
  const [newCatParent, setNewCatParent] = useState<string>("");
  const [savingCategory, setSavingCategory] = useState(false);

  async function reloadProductCategories(id: string) {
    try {
      const res = await fetch(`/api/catalog/${id}/categories`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { categories: AssignedCat[] };
      setProductCategories(json.categories);
    } catch {
      /* silencioso — el drawer ya muestra el resto del producto */
    }
  }

  async function addProductCategory(categoryId: string, makePrimary: boolean) {
    if (!product) return;
    setSavingCategory(true);
    try {
      const res = await fetch(`/api/catalog/${product.id}/categories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categoryId, isPrimary: makePrimary }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error ?? `HTTP ${res.status}`);
      }
      await reloadProductCategories(product.id);
      setPickerMode("closed");
      setPickValue("");
      toast.success(makePrimary ? "Categoría primaria asignada" : "Categoría agregada");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSavingCategory(false);
    }
  }

  async function removeProductCategory(categoryId: string) {
    if (!product) return;
    try {
      const res = await fetch(`/api/catalog/${product.id}/categories`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categoryId }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error ?? `HTTP ${res.status}`);
      }
      await reloadProductCategories(product.id);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function createAndAssignCategory() {
    if (!product || !newCatName.trim()) return;
    setSavingCategory(true);
    try {
      const res = await fetch("/api/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newCatName.trim(),
          parentId: newCatParent || null,
        }),
      });
      const json = (await res.json()) as {
        id?: string;
        name?: string;
        error?: string;
      };
      // 409 → duplicada: igual la asignamos al producto.
      let categoryId = json.id;
      if (!res.ok && res.status !== 409) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      if (!categoryId) throw new Error("La API no devolvió el id");

      // Refrescar la lista global de categorías para que aparezca en el
      // dropdown y en el flatTree.
      const catsRes = await fetch("/api/categories");
      if (catsRes.ok) setCategories(await catsRes.json());

      await addProductCategory(categoryId, productCategories.length === 0);
      setNewCatName("");
      setNewCatParent("");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSavingCategory(false);
    }
  }

  async function setAsPrimary(categoryId: string) {
    // Reusamos POST con isPrimary=true (upsert).
    await addProductCategory(categoryId, true);
  }

  // Catálogo global de categorías (compartido entre proveedores). Se carga una
  // sola vez por sesión de drawer abierta.
  const [categories, setCategories] = useState<CategoryRaw[]>([]);
  const flatTree = useMemo(() => buildFlatTree(categories), [categories]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/categories")
      .then((r) => r.json())
      .then((data: CategoryRaw[]) => {
        if (!cancelled) setCategories(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && productId) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [productId, onClose]);

  useEffect(() => {
    if (!productId) {
      setProduct(null);
      return;
    }
    // Reset image-failed flags al cambiar de producto
    setMainImageFailed(false);
    setThumbImageFailed(false);
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const res = await fetch(`/api/catalog/${productId}`);
        if (!res.ok) throw new Error("No se pudo cargar el producto");
        const data: CatalogProductDetail = await res.json();
        if (cancelled) return;
        setProduct(data);
        setCommercialTitle(data.commercialTitle ?? "");
        setCommercialDescription(data.commercialDescription ?? "");
        // SKU comercial post-Fase 4A/4B: leemos pp.sku (canónico) desde la
        // primera publication. El campo legacy data.publicationSku queda en
        // el response pero ya no se usa como fuente.
        setPublicationSku(data.publications[0]?.sku ?? "");
        setFinalPrice(data.finalPrice != null ? String(data.finalPrice) : "");
        setManualMargin(data.manualMargin != null ? String(data.manualMargin) : "");
        setWholesalePrice(
          data.wholesalePrice != null ? String(data.wholesalePrice) : ""
        );
        setNotes(data.notes ?? "");
        // Cargar categorías asignadas en paralelo (best-effort).
        // productId no puede ser null acá: el guard al inicio del efecto lo
        // garantiza, pero TS no lo sabe por el cierre.
        reloadProductCategories(productId as string);
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
  }, [productId]);

  // Fase 4B: el SKU comercial se edita por un endpoint separado con guard de
  // colisión bloqueante. Devuelve "ok"/"cancelled"/"error" para que handleSave
  // pueda decidir si abortar.
  async function saveSkuIfChanged(): Promise<"ok" | "cancelled" | "error" | "noop"> {
    if (!product) return "noop";
    const currentSku = product.publications[0]?.sku ?? null;
    const trimmed = publicationSku.trim();
    const newSku = trimmed || null;
    if (newSku === currentSku) return "noop";

    // Sin publication no hay endpoint que llamar. El SKU se asigna lazy al
    // publicar (Fase 3). Si el usuario quiso editarlo igual, lo avisamos.
    const pubId = product.publications[0]?.id;
    if (!pubId) {
      toast.error(
        "Este producto no tiene publicación todavía. El SKU se asigna al publicar en la tienda."
      );
      return "error";
    }
    if (!newSku) {
      toast.error("El SKU comercial no puede ser vacío.");
      return "error";
    }

    async function attempt(confirmPublishedChange: boolean): Promise<"ok" | "cancelled" | "error"> {
      const res = await fetch(`/api/catalog/publications/${pubId}/sku`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sku: newSku,
          ...(confirmPublishedChange ? { confirmPublishedChange: true } : {}),
        }),
      });
      if (res.ok) return "ok";
      const err = await res.json().catch(() => ({}));
      if (res.status === 422 && err.requiresConfirmation) {
        const ok = window.confirm(
          `Este producto está publicado en WooCommerce con SKU ${
            err.previousSku ?? "—"
          }.\n\nCambiarlo a "${
            err.newSku
          }" lo va a modificar en la tienda real.\n\n¿Confirmás?`
        );
        if (!ok) return "cancelled";
        return await attempt(true);
      }
      if (res.status === 409) {
        toast.error(err.error ?? "El SKU ya pertenece a otro producto");
        return "error";
      }
      toast.error(err.error ?? "Error al guardar el SKU");
      return "error";
    }
    return await attempt(false);
  }

  async function handleSave() {
    if (!product) return;
    setSaving(true);
    try {
      // ── 1. SKU comercial (endpoint separado con guard de colisión) ──
      const skuResult = await saveSkuIfChanged();
      if (skuResult === "cancelled" || skuResult === "error") {
        return; // no avanzar al PATCH del resto si el SKU falló o se canceló
      }

      // ── 2. PATCH del resto de campos comerciales ──
      // wholesalePrice solo se manda si el proveedor es no-SCRAPER y el usuario
      // ingresó un valor numérico > 0. El backend rechaza el campo en SCRAPER.
      const isScraper = product.provider.providerType === "SCRAPER";
      const wholesalePriceNum = !isScraper ? parseFloat(wholesalePrice) : NaN;
      const includeWholesale =
        !isScraper && Number.isFinite(wholesalePriceNum) && wholesalePriceNum > 0;

      const res = await fetch(`/api/catalog/${product.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commercialTitle: commercialTitle.trim() || null,
          commercialDescription: commercialDescription.trim() || null,
          // publicationSku NO se envía acá — Fase 4B redirigió a
          // PUT /api/catalog/publications/<id>/sku con guard de colisión.
          finalPrice: finalPrice ? parseFloat(finalPrice) : null,
          manualMargin: manualMargin ? parseFloat(manualMargin) : null,
          ...(includeWholesale ? { wholesalePrice: wholesalePriceNum } : {}),
          notes: notes.trim() || null,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Error al guardar");
      }
      const updated: CatalogProductDetail = await res.json();
      toast.success("Cambios guardados");
      setProduct(updated);
      onSaved?.(updated);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function toggleStockSource() {
    if (!product) return;
    const action =
      product.stockSource === "OWN" ? "remove_own_stock" : "copy_own_stock";
    setTogglingPub(true);
    try {
      const res = await fetch("/api/catalog/bulk-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productIds: [product.id], action }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Error al cambiar stock");
      }
      const { autoPaused } = (await res.json()) as { autoPaused?: number };
      toast.success(
        product.stockSource === "OWN"
          ? autoPaused
            ? "Quitado del stock propio · publicación auto-pausada"
            : "Quitado del stock propio"
          : "Agregado a stock propio"
      );
      const fresh = await fetch(`/api/catalog/${product.id}`);
      if (fresh.ok) {
        const updated: CatalogProductDetail = await fresh.json();
        setProduct(updated);
        onSaved?.(updated);
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setTogglingPub(false);
    }
  }

  async function togglePublication() {
    if (!product) return;
    const isActive = product.publications.some((p) => p.status === "ACTIVE");
    const next = isActive ? "PAUSED" : "ACTIVE";
    setTogglingPub(true);
    try {
      const res = await fetch(`/api/catalog/${product.id}/publication`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Error al cambiar publicación");
      }
      toast.success(`Publicación: ${next === "ACTIVE" ? "activada" : "pausada"}`);
      // Reload product
      const fresh = await fetch(`/api/catalog/${product.id}`);
      if (fresh.ok) setProduct(await fresh.json());
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setTogglingPub(false);
    }
  }

  if (!productId) return null;

  const isActive = product?.publications.some((p) => p.status === "ACTIVE") ?? false;
  const rawImage =
    product?.images.find((i) => i.isPrimary)?.url ??
    product?.images[0]?.url ??
    product?.imageUrl ??
    null;
  const displayImage = normalizeImageUrl(rawImage);

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} aria-hidden />
      <aside className="fixed right-0 top-0 h-full w-full max-w-[480px] bg-card border-l border-border z-50 flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h3 className="text-sm font-semibold">Detalle del producto</h3>
          <div className="flex items-center gap-2">
            {/* Toggle de publicación. Disabled si no hay store configurada
                (rama bloqueada por la API). */}
            <button
              type="button"
              onClick={togglePublication}
              disabled={togglingPub}
              title="Toggle publicación (requiere tienda configurada)"
              className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md border transition-colors disabled:opacity-60 ${
                isActive
                  ? "bg-accent/15 text-accent border-accent/30"
                  : "bg-muted/40 text-muted-foreground border-border hover:bg-muted/60"
              }`}
            >
              {togglingPub ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Power className="w-3 h-3" />
              )}
              {isActive ? "Activo" : "Pausado"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground p-1 rounded-md hover:bg-muted/40"
              aria-label="Cerrar"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {loading || !product ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-5 space-y-5">
            {/* Imagen */}
            <div className="w-full aspect-square rounded-xl overflow-hidden bg-muted/30 border border-border">
              {displayImage && !mainImageFailed ? (
                <img
                  src={displayImage}
                  alt=""
                  className="w-full h-full object-cover"
                  onError={() => setMainImageFailed(true)}
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <ImageOff className="w-12 h-12 text-muted-foreground/40" />
                </div>
              )}
            </div>

            {/* Estado del producto — visualStatus derivado */}
            {(() => {
              const activePub = product.publications.find(
                (p) => p.status === "ACTIVE"
              );
              const vStatus = deriveVisualStatus({
                internalStatus: product.internalStatus ?? "NOT_PUBLISHED",
                supplierStatus: product.supplierStatus,
                pendingSync: activePub?.pendingSync,
                syncStatus: activePub?.syncStatus,
              });
              const vCfg = visualStatusConfig[vStatus];
              const extra =
                vStatus === "SIN_STOCK"
                  ? "El proveedor dejó de tener este producto. Podés reactivarlo manualmente cuando vuelva a estar disponible."
                  : vStatus === "OUTDATED"
                    ? "Hay cambios pendientes de sincronizar con WooCommerce."
                    : null;
              return (
                <section className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                      Estado del producto
                    </p>
                    <StatusHelpModal triggerLabel="Guía de estados" />
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className={`inline-flex items-center text-xs px-2.5 py-1 rounded-full border font-medium ${vCfg.className}`}
                    >
                      {vCfg.label}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {visualStatusDescriptions[vStatus]}
                  </p>
                  {extra && (
                    <p className="text-xs text-muted-foreground/80 italic leading-relaxed">
                      {extra}
                    </p>
                  )}
                </section>
              );
            })()}

            {/* Datos del proveedor (readonly) */}
            <section className="space-y-2 border-t border-border pt-4">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                Datos del proveedor
              </p>
              {(() => {
                const ss = stockSourceMeta[product.stockSource];
                return (
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      title={ss.description}
                      className={`inline-flex items-center text-[10px] px-2 py-0.5 rounded-full border font-medium ${ss.cls}`}
                    >
                      {ss.label}
                    </span>
                    {product.supplierStatus === "SUPPLIER_REMOVED" && (
                      <span
                        title="Este producto ya no aparece en el proveedor. La publicación puede pausarse automáticamente según el origen del stock."
                        className="inline-flex items-center text-[10px] px-2 py-0.5 rounded-full border font-medium bg-red-500/15 text-red-300 border-red-500/30"
                      >
                        Removido por proveedor
                      </span>
                    )}
                  </div>
                );
              })()}
              <div className="space-y-1 text-xs">
                <p>
                  <span className="text-muted-foreground">Proveedor:</span>{" "}
                  <span className="font-medium">{product.provider.name}</span>
                </p>
                <p>
                  <span className="text-muted-foreground">SKU:</span>{" "}
                  <span className="font-mono">{product.sku ?? "—"}</span>
                </p>
                <p>
                  <span className="text-muted-foreground">Nombre:</span>{" "}
                  <span className="font-medium">{product.supplierName}</span>
                </p>
                {product.supplierDescription && (
                  <p>
                    <span className="text-muted-foreground">Descripción:</span>{" "}
                    <span>{product.supplierDescription}</span>
                  </p>
                )}
                <p>
                  <span className="text-muted-foreground">Precio mayorista:</span>{" "}
                  <span className="font-mono">
                    {product.wholesalePrice != null
                      ? formatPrice(product.wholesalePrice)
                      : "—"}
                  </span>
                </p>
                <p>
                  <span className="text-muted-foreground">Stock:</span>{" "}
                  <span>{product.stock ?? "—"}</span>
                </p>
                {product.supplierCategory && (
                  <p>
                    <span className="text-muted-foreground">Categoría proveedor:</span>{" "}
                    <span>{product.supplierCategory}</span>
                  </p>
                )}
                <p>
                  <span className="text-muted-foreground">Última vez visto:</span>{" "}
                  <span>
                    {formatDistanceToNow(new Date(product.lastSeenAt), {
                      locale: es,
                      addSuffix: true,
                    })}
                  </span>
                </p>
              </div>
              {product.productUrl && (
                <a
                  href={product.productUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
                >
                  Ver en proveedor <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </section>

            {/* Pricing — costo, precio sugerido por el motor y precio final
                efectivo (con override visible si aplica). */}
            <section className="space-y-2 border-t border-border pt-4">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                Pricing
              </p>
              {(() => {
                const calc = product.pricing?.calculatedPrice ?? null;
                const eff = product.pricing?.effectivePrice ?? null;
                const origin = product.pricing?.ruleApplied ?? "none";
                const originInfo = ruleAppliedMeta[origin];
                const enginePct = product.pricing?.marginPercent ?? null;
                const hasOverride =
                  product.finalPrice != null &&
                  calc != null &&
                  Math.abs(product.finalPrice - calc) > 0.005;
                const discount = product.pricing?.listDiscountPercent ?? 0;
                const effCost = product.pricing?.effectiveCost ?? null;
                const hasDiscount =
                  discount > 0 &&
                  product.wholesalePrice != null &&
                  effCost != null;
                const isScraperProvider =
                  product.provider.providerType === "SCRAPER";
                return (
                  <div className="bg-muted/20 border border-border rounded-lg p-3 space-y-2 text-xs">
                    {/* Costo — editable en proveedores no-SCRAPER, read-only en
                        SCRAPER (con desglose si tiene listDiscountPercent). */}
                    {!isScraperProvider ? (
                      <div className="space-y-1">
                        <label className="block text-muted-foreground">
                          Precio de costo (mayorista)
                        </label>
                        <div className="flex items-center gap-1">
                          <span className="font-mono text-muted-foreground">
                            $
                          </span>
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={wholesalePrice}
                            onChange={(e) => setWholesalePrice(e.target.value)}
                            placeholder="0.00"
                            className="flex-1 font-mono text-xs bg-background border border-border rounded-md px-2 py-1 focus:outline-none focus:ring-1 focus:ring-primary/60"
                          />
                        </div>
                        <p className="text-[10px] text-muted-foreground/80">
                          Al modificar el costo, el precio de venta sugerido se
                          recalcula automáticamente.
                        </p>
                      </div>
                    ) : hasDiscount ? (
                      <div className="space-y-1">
                        <div className="flex items-center justify-between">
                          <span className="text-muted-foreground">
                            Precio lista
                          </span>
                          <span className="font-mono">
                            {formatPrice(product.wholesalePrice as number)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-muted-foreground">
                            Desc. proveedor
                          </span>
                          <span className="font-mono text-amber-300">
                            −
                            {(discount % 1 === 0
                              ? discount.toFixed(0)
                              : discount.toFixed(1))}
                            % ({formatPrice(
                              (product.wholesalePrice as number) -
                                (effCost as number)
                            )}
                            )
                          </span>
                        </div>
                        <div className="flex items-center justify-between pt-1 border-t border-border/40">
                          <span className="text-muted-foreground font-medium">
                            Costo real
                          </span>
                          <span className="font-mono font-medium">
                            {formatPrice(effCost as number)}
                          </span>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Costo mayorista</span>
                        <span className="font-mono">
                          {product.wholesalePrice != null
                            ? formatPrice(product.wholesalePrice)
                            : "—"}
                        </span>
                      </div>
                    )}

                    {/* Precio sugerido (motor) */}
                    <div className="pt-2 border-t border-border space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">
                          Precio sugerido
                        </span>
                        <span className="font-mono">
                          {calc != null ? formatPrice(calc) : "—"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] text-muted-foreground/80">
                          Origen
                        </span>
                        <span
                          className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${originInfo.cls}`}
                        >
                          {originInfo.label}
                          {enginePct != null ? ` · ${enginePct}%` : ""}
                        </span>
                      </div>
                      {product.pricing?.ruleName &&
                        origin !== "manual" &&
                        origin !== "none" && (
                          <div className="flex items-center justify-between text-[10px] text-muted-foreground/70">
                            <span>Regla</span>
                            <span>{product.pricing.ruleName}</span>
                          </div>
                        )}
                    </div>

                    {/* Precio final efectivo (lo que el cliente paga) */}
                    <div className="pt-2 border-t border-border">
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">
                          Precio final
                        </span>
                        <div className="flex items-center gap-2">
                          {hasOverride && (
                            <span className="text-[9px] px-1.5 py-0.5 rounded border font-medium bg-violet-500/15 text-violet-300 border-violet-500/30 uppercase tracking-wide">
                              Override manual
                            </span>
                          )}
                          <span className="font-mono text-base font-semibold text-accent">
                            {eff != null ? formatPrice(eff) : "—"}
                          </span>
                        </div>
                      </div>
                      {hasOverride && (
                        <p className="text-[10px] text-muted-foreground/70 mt-1 text-right">
                          Difiere del sugerido (
                          {formatPrice(calc as number)}) por override del
                          usuario.
                        </p>
                      )}
                    </div>
                  </div>
                );
              })()}
            </section>

            {/* Datos comerciales (editables) */}
            <section className="space-y-3 border-t border-border pt-4">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                Datos comerciales
              </p>

              <div>
                <label className="block text-[11px] text-muted-foreground mb-1">
                  SKU comercial
                </label>
                <input
                  type="text"
                  value={publicationSku}
                  onChange={(e) => setPublicationSku(e.target.value)}
                  placeholder={
                    product.publications[0]
                      ? "SKU usado en la tienda (ej. TP-00658)"
                      : "Se asignará automáticamente al publicar"
                  }
                  className="w-full text-sm bg-background border border-border rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/60 font-mono"
                />
                <p className="text-[10px] text-muted-foreground mt-1">
                  SKU proveedor: {product.sku ?? "—"}
                  {!product.publications[0] && (
                    <span className="block mt-0.5">
                      Sin publicación todavía. El SKU comercial se genera
                      automáticamente al publicar usando el prefijo del
                      proveedor.
                    </span>
                  )}
                  {product.publications[0]?.externalProductId && (
                    <span className="block mt-0.5 text-amber-400">
                      Este producto está publicado en la tienda. Cambiar el
                      SKU lo modificará también en Woo.
                    </span>
                  )}
                </p>
              </div>

              <div>
                <label className="block text-[11px] text-muted-foreground mb-1">
                  Título comercial
                </label>
                <input
                  type="text"
                  value={commercialTitle}
                  onChange={(e) => setCommercialTitle(e.target.value)}
                  placeholder={product.supplierName}
                  className="w-full text-sm bg-background border border-border rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/60"
                />
              </div>

              <div>
                <label className="block text-[11px] text-muted-foreground mb-1">
                  Descripción comercial
                </label>
                <textarea
                  value={commercialDescription}
                  onChange={(e) => setCommercialDescription(e.target.value)}
                  rows={3}
                  className="w-full text-sm bg-background border border-border rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/60 resize-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-muted-foreground mb-1">
                    Precio final ($)
                  </label>
                  <input
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    value={finalPrice}
                    onChange={(e) => setFinalPrice(e.target.value)}
                    className="w-full text-sm bg-background border border-border rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/60"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-muted-foreground mb-1">
                    Margen manual (%)
                  </label>
                  <input
                    type="number"
                    inputMode="decimal"
                    step="0.1"
                    value={manualMargin}
                    onChange={(e) => setManualMargin(e.target.value)}
                    className="w-full text-sm bg-background border border-border rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/60"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-[11px] text-muted-foreground uppercase tracking-wider font-medium">
                    Categorías
                  </label>
                  {pickerMode === "closed" && (
                    <button
                      type="button"
                      onClick={() => setPickerMode("pick")}
                      className="text-[11px] text-primary hover:underline inline-flex items-center gap-1"
                    >
                      <Plus className="w-3 h-3" /> Agregar
                    </button>
                  )}
                </div>

                {productCategories.length === 0 ? (
                  <p className="text-xs text-muted-foreground/60">
                    Sin categorías asignadas
                  </p>
                ) : (
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {productCategories.map((c) => (
                      <span
                        key={c.id}
                        className={`inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border ${
                          c.isPrimary
                            ? "bg-primary/15 text-primary border-primary/40"
                            : "bg-muted/40 text-foreground border-border"
                        }`}
                      >
                        {c.isPrimary ? (
                          <Star className="w-2.5 h-2.5" aria-label="Primaria" />
                        ) : (
                          <button
                            type="button"
                            onClick={() => setAsPrimary(c.id)}
                            title="Marcar como primaria"
                            className="text-muted-foreground hover:text-primary"
                          >
                            <Star className="w-2.5 h-2.5" />
                          </button>
                        )}
                        <span>{c.name}</span>
                        <button
                          type="button"
                          onClick={() => removeProductCategory(c.id)}
                          title="Quitar"
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <X className="w-2.5 h-2.5" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}

                {pickerMode === "pick" && (
                  <div className="space-y-2 bg-muted/20 border border-border rounded-md p-2">
                    <select
                      autoFocus
                      value={pickValue}
                      onChange={(e) => setPickValue(e.target.value)}
                      className="w-full text-sm bg-background border border-border rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/60"
                    >
                      <option value="">— Elegir categoría —</option>
                      {flatTree
                        .filter(
                          (c) => !productCategories.some((p) => p.id === c.id)
                        )
                        .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.depth > 0
                        ? "  ".repeat(c.depth) + "└─ " + c.name
                        : c.name}
                    </option>
                  ))}
                    </select>
                    <div className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => setPickerMode("create")}
                        className="text-[11px] text-primary hover:underline"
                      >
                        + Nueva categoría
                      </button>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            setPickerMode("closed");
                            setPickValue("");
                          }}
                          className="text-[11px] text-muted-foreground hover:text-foreground px-2 py-1 rounded"
                        >
                          Cancelar
                        </button>
                        <button
                          type="button"
                          disabled={!pickValue || savingCategory}
                          onClick={() =>
                            addProductCategory(
                              pickValue,
                              productCategories.length === 0
                            )
                          }
                          className="text-[11px] bg-primary text-primary-foreground px-2.5 py-1 rounded-md hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-1"
                        >
                          {savingCategory && (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          )}
                          Agregar
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {pickerMode === "create" && (
                  <div className="space-y-2 bg-muted/20 border border-border rounded-md p-2">
                    <input
                      autoFocus
                      type="text"
                      value={newCatName}
                      onChange={(e) => setNewCatName(e.target.value)}
                      placeholder="Nombre de la nueva categoría"
                      className="w-full text-sm bg-background border border-border rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/60"
                    />
                    <select
                      value={newCatParent}
                      onChange={(e) => setNewCatParent(e.target.value)}
                      className="w-full text-sm bg-background border border-border rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/60"
                    >
                      <option value="">-- Sin categoria padre --</option>
                      {flatTree.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.depth > 0
                            ? "--".repeat(c.depth) + " " + c.name
                            : c.name}
                        </option>
                      ))}
                    </select>
                    <div className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => setPickerMode("pick")}
                        className="text-[11px] text-muted-foreground hover:text-foreground"
                      >
                        Volver
                      </button>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            setPickerMode("closed");
                            setNewCatName("");
                            setNewCatParent("");
                          }}
                          className="text-[11px] text-muted-foreground hover:text-foreground px-2 py-1 rounded"
                        >
                          Cancelar
                        </button>
                        <button
                          type="button"
                          disabled={!newCatName.trim() || savingCategory}
                          onClick={createAndAssignCategory}
                          className="text-[11px] bg-primary text-primary-foreground px-2.5 py-1 rounded-md hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-1"
                        >
                          {savingCategory && (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          )}
                          Crear y asignar
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {product.supplierCategory && (
                  <p className="text-[11px] text-muted-foreground pt-1">
                    Categoria proveedor:{" "}
                    <span className="text-foreground/80">
                      {product.supplierCategory}
                    </span>
                  </p>
                )}
              </div>

              <div>
                <label className="block text-[11px] text-muted-foreground mb-1">
                  Notas internas
                </label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  placeholder="No visible para clientes"
                  className="w-full text-sm bg-background border border-border rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/60 resize-none"
                />
              </div>
            </section>

            {/* Imágenes */}
            <section className="space-y-2 border-t border-border pt-4">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                Imágenes
              </p>
              <div className="flex gap-2 flex-wrap">
                {displayImage && !thumbImageFailed && (
                  <div className="w-16 h-16 rounded-md overflow-hidden bg-muted/30 border border-border">
                    <img
                      src={displayImage}
                      alt=""
                      className="w-full h-full object-cover"
                      onError={() => setThumbImageFailed(true)}
                    />
                  </div>
                )}
                <button
                  type="button"
                  disabled
                  title="Próximamente — subida de imágenes"
                  className="w-16 h-16 rounded-md border-2 border-dashed border-border flex items-center justify-center text-muted-foreground/50 cursor-not-allowed"
                >
                  <Plus className="w-5 h-5" />
                </button>
              </div>
            </section>
          </div>
        )}

        {/* Footer con acciones */}
        {product && !loading && (
          <div className="px-5 py-3 border-t border-border flex items-center justify-between gap-2 flex-wrap">
            <button
              type="button"
              onClick={toggleStockSource}
              disabled={togglingPub}
              className={`text-xs flex items-center gap-1.5 px-3 py-1.5 rounded-md border transition-colors disabled:opacity-60 ${
                product.stockSource === "OWN"
                  ? "border-amber-500/30 text-amber-300 hover:bg-amber-500/10"
                  : "border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/10"
              }`}
            >
              {togglingPub ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : product.stockSource === "OWN" ? (
                <PackageMinus className="w-3 h-3" />
              ) : (
                <PackagePlus className="w-3 h-3" />
              )}
              {product.stockSource === "OWN"
                ? "Quitar del stock propio"
                : "Agregar a stock propio"}
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="text-xs px-3 py-1.5 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="text-xs flex items-center gap-1.5 bg-primary text-primary-foreground px-4 py-1.5 rounded-md hover:bg-primary/90 transition-colors disabled:opacity-60"
              >
                {saving && <Loader2 className="w-3 h-3 animate-spin" />}
                Guardar cambios
              </button>
            </div>
          </div>
        )}
      </aside>
    </>
  );
}
