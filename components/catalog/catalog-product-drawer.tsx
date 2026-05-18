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
} from "lucide-react";
import { formatPrice, normalizeImageUrl } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import { es } from "date-fns/locale";

export interface CatalogProductDetail {
  id: string;
  sku: string | null;
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
  provider: { id: string; name: string; baseUrl: string };
  images: { id: string; url: string; isPrimary: boolean; source: string }[];
  assignedCategory: { id: string; name: string } | null;
  publications: { status: string; storeId: string }[];
  pricing?: {
    calculatedPrice: number | null;
    effectivePrice: number | null;
    marginPercent: number | null;
    ruleApplied: "manual" | "category" | "provider" | "global" | "none";
    ruleName: string | null;
    ruleId: string | null;
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
  const [finalPrice, setFinalPrice] = useState<string>("");
  const [manualMargin, setManualMargin] = useState<string>("");
  const [assignedCategoryId, setAssignedCategoryId] = useState<string | null>(
    null
  );
  const [notes, setNotes] = useState("");

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
        setFinalPrice(data.finalPrice != null ? String(data.finalPrice) : "");
        setManualMargin(data.manualMargin != null ? String(data.manualMargin) : "");
        setAssignedCategoryId(data.assignedCategoryId ?? null);
        setNotes(data.notes ?? "");
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

  async function handleSave() {
    if (!product) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/catalog/${product.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commercialTitle: commercialTitle.trim() || null,
          commercialDescription: commercialDescription.trim() || null,
          finalPrice: finalPrice ? parseFloat(finalPrice) : null,
          manualMargin: manualMargin ? parseFloat(manualMargin) : null,
          assignedCategoryId: assignedCategoryId,
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

            {/* Datos del proveedor (readonly) */}
            <section className="space-y-2">
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
                return (
                  <div className="bg-muted/20 border border-border rounded-lg p-3 space-y-2 text-xs">
                    {/* Costo */}
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Costo mayorista</span>
                      <span className="font-mono">
                        {product.wholesalePrice != null
                          ? formatPrice(product.wholesalePrice)
                          : "—"}
                      </span>
                    </div>

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

              <div>
                <label className="block text-[11px] text-muted-foreground mb-1">
                  Categoría
                </label>
                <select
                  value={assignedCategoryId ?? ""}
                  onChange={(e) =>
                    setAssignedCategoryId(e.target.value || null)
                  }
                  className="w-full text-sm bg-background border border-border rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/60"
                >
                  <option value="">Sin categoría</option>
                  {flatTree.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.depth > 0
                        ? "  ".repeat(c.depth) + "└─ " + c.name
                        : c.name}
                    </option>
                  ))}
                </select>
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
          <div className="px-5 py-3 border-t border-border flex items-center justify-end gap-2">
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
        )}
      </aside>
    </>
  );
}
