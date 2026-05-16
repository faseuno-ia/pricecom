"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

type ProviderType = "SCRAPER" | "MANUAL" | "IMPORTED";

interface ProviderOpt {
  id: string;
  name: string;
  providerType: ProviderType;
  prefix: string | null;
}

interface CategoryOpt {
  id: string;
  name: string;
}

interface Props {
  providers: ProviderOpt[];
  categories: CategoryOpt[];
  initialProviderId: string | null;
}

export function ManualProductForm({
  providers,
  categories,
  initialProviderId,
}: Props) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  // Preferimos los proveedores MANUAL/IMPORTED arriba en la lista; los SCRAPER
  // también se permiten (no hay razón fuerte para vetarlos en el alta manual).
  const sortedProviders = useMemo(() => {
    const score: Record<ProviderType, number> = {
      MANUAL: 0,
      IMPORTED: 1,
      SCRAPER: 2,
    };
    return [...providers].sort(
      (a, b) =>
        score[a.providerType] - score[b.providerType] ||
        a.name.localeCompare(b.name)
    );
  }, [providers]);

  const [form, setForm] = useState({
    providerId:
      initialProviderId && providers.some((p) => p.id === initialProviderId)
        ? initialProviderId
        : sortedProviders[0]?.id ?? "",
    sku: "",
    publicationSku: "",
    publicationSkuTouched: false,
    name: "",
    description: "",
    wholesalePrice: "",
    stock: "",
    assignedCategoryId: "",
    manualMargin: "",
    finalPrice: "",
    notes: "",
    imageUrl: "",
  });

  const selectedProvider = providers.find((p) => p.id === form.providerId);
  const prefix = selectedProvider?.prefix ?? "";

  // publicationSku auto-derivado mientras el usuario no lo haya tocado.
  const autoPublicationSku = form.sku.trim() ? prefix + form.sku.trim() : "";
  const publicationSkuToShow = form.publicationSkuTouched
    ? form.publicationSku
    : autoPublicationSku;

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.providerId) {
      toast.error("Seleccioná un proveedor");
      return;
    }
    if (!form.sku.trim()) {
      toast.error("Cargá el SKU del proveedor");
      return;
    }
    if (!form.name.trim()) {
      toast.error("Cargá el nombre del producto");
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        providerId: form.providerId,
        sku: form.sku.trim(),
        publicationSku: form.publicationSkuTouched
          ? form.publicationSku.trim() || null
          : null, // null → el server deriva con buildPublicationSku
        name: form.name.trim(),
        description: form.description.trim() || null,
        wholesalePrice: form.wholesalePrice
          ? Number(form.wholesalePrice)
          : null,
        stock: form.stock.trim() || null,
        assignedCategoryId: form.assignedCategoryId || null,
        manualMargin: form.manualMargin ? Number(form.manualMargin) : null,
        finalPrice: form.finalPrice ? Number(form.finalPrice) : null,
        notes: form.notes.trim() || null,
        imageUrl: form.imageUrl.trim() || null,
      };

      const res = await fetch("/api/catalog/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      toast.success("Producto agregado al catálogo");
      router.push("/catalog");
      router.refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const inputCls =
    "w-full border border-border rounded-md px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/40";
  const labelCls =
    "block text-[11px] font-medium text-muted-foreground mb-1 uppercase tracking-wider";

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="md:col-span-2">
          <label className={labelCls}>Proveedor *</label>
          <select
            className={inputCls}
            value={form.providerId}
            onChange={(e) => set("providerId", e.target.value)}
            required
          >
            {sortedProviders.length === 0 && (
              <option value="">— sin proveedores activos —</option>
            )}
            {sortedProviders.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.providerType.toLowerCase()})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={labelCls}>SKU proveedor *</label>
          <input
            className={inputCls}
            value={form.sku}
            onChange={(e) => set("sku", e.target.value)}
            placeholder="Ej: 94028"
            required
          />
        </div>

        <div>
          <label className={labelCls}>
            SKU comercial{" "}
            <span className="text-muted-foreground/70 normal-case font-normal">
              (auto: {prefix || "sin prefijo"} + SKU)
            </span>
          </label>
          <input
            className={inputCls}
            value={publicationSkuToShow}
            onChange={(e) => {
              set("publicationSku", e.target.value);
              set("publicationSkuTouched", true);
            }}
            placeholder={`Ej: ${prefix || ""}94028`}
          />
        </div>

        <div className="md:col-span-2">
          <label className={labelCls}>Nombre del producto *</label>
          <input
            className={inputCls}
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="Nombre comercial del producto"
            required
          />
        </div>

        <div className="md:col-span-2">
          <label className={labelCls}>Descripción</label>
          <textarea
            className={`${inputCls} resize-none`}
            rows={3}
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
          />
        </div>

        <div>
          <label className={labelCls}>Costo mayorista</label>
          <input
            className={inputCls}
            type="number"
            inputMode="decimal"
            step="0.01"
            value={form.wholesalePrice}
            onChange={(e) => set("wholesalePrice", e.target.value)}
            placeholder="0.00"
          />
        </div>

        <div>
          <label className={labelCls}>Stock</label>
          <input
            className={inputCls}
            value={form.stock}
            onChange={(e) => set("stock", e.target.value)}
            placeholder="texto libre"
          />
        </div>

        <div>
          <label className={labelCls}>Categoría</label>
          <select
            className={inputCls}
            value={form.assignedCategoryId}
            onChange={(e) => set("assignedCategoryId", e.target.value)}
          >
            <option value="">— Sin categoría —</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={labelCls}>Imagen URL principal</label>
          <input
            className={inputCls}
            type="url"
            value={form.imageUrl}
            onChange={(e) => set("imageUrl", e.target.value)}
            placeholder="https://…"
          />
        </div>

        <div>
          <label className={labelCls}>Margen manual (%)</label>
          <input
            className={inputCls}
            type="number"
            inputMode="decimal"
            step="0.1"
            value={form.manualMargin}
            onChange={(e) => set("manualMargin", e.target.value)}
            placeholder="30"
          />
        </div>

        <div>
          <label className={labelCls}>Precio final (override)</label>
          <input
            className={inputCls}
            type="number"
            inputMode="decimal"
            step="0.01"
            value={form.finalPrice}
            onChange={(e) => set("finalPrice", e.target.value)}
            placeholder="0.00"
          />
        </div>

        <div className="md:col-span-2">
          <label className={labelCls}>Notas internas</label>
          <textarea
            className={`${inputCls} resize-none`}
            rows={2}
            value={form.notes}
            onChange={(e) => set("notes", e.target.value)}
          />
        </div>
      </div>

      <div className="flex items-center justify-end gap-3 pt-2 border-t border-border">
        <button
          type="button"
          onClick={() => router.back()}
          className="text-sm px-4 py-2 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted/40"
          disabled={submitting}
        >
          Cancelar
        </button>
        <button
          type="submit"
          disabled={submitting || sortedProviders.length === 0}
          className="text-sm px-5 py-2 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60 flex items-center gap-1.5"
        >
          {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          Guardar producto
        </button>
      </div>
    </form>
  );
}
