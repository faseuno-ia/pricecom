"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Info } from "lucide-react";

interface Config {
  productCardSelector: string | null;
  skuSelector: string | null;
  nameSelector: string | null;
  descriptionSelector: string | null;
  priceSelector: string | null;
  oldPriceSelector: string | null;
  stockSelector: string | null;
  categorySelector: string | null;
  imageSelector: string | null;
  productUrlSelector: string | null;
  nextPageSelector: string | null;
  waitForSelector: string | null;
  loginUsernameSelector: string | null;
  loginPasswordSelector: string | null;
  loginSubmitSelector: string | null;
  maxPages: number;
}

interface Props {
  providerId: string;
  config: Config | null;
}

const fields: { key: keyof Config; label: string; hint: string; isNumber?: boolean }[] = [
  { key: "productCardSelector", label: "Tarjeta de producto", hint: "Ej: .product-card, li.product, article" },
  { key: "nameSelector", label: "Nombre del producto", hint: "Ej: h2.product-title, .product-name" },
  { key: "skuSelector", label: "SKU / Código", hint: "Ej: .sku, [data-sku], .product-sku" },
  { key: "priceSelector", label: "Precio mayorista", hint: "Ej: .price, .woocommerce-Price-amount, ins" },
  { key: "oldPriceSelector", label: "Precio anterior", hint: "Ej: del, .old-price, .price-before" },
  { key: "descriptionSelector", label: "Descripción", hint: "Ej: .product-description, .desc" },
  { key: "stockSelector", label: "Stock", hint: "Ej: .stock, .availability, [data-stock]" },
  { key: "categorySelector", label: "Categoría", hint: "Ej: .product-category, .breadcrumb span:last" },
  { key: "imageSelector", label: "Imagen principal", hint: "Ej: img.product-image, .thumbnail img" },
  { key: "productUrlSelector", label: "Link al producto", hint: "Ej: a.product-link, h2 a, .product-title a" },
  { key: "nextPageSelector", label: "Botón siguiente página", hint: "Ej: a[rel=next], .next-page, .pagination-next" },
  { key: "waitForSelector", label: "Esperar selector (antes de extraer)", hint: "Selector que debe existir antes de leer el DOM" },
  { key: "loginUsernameSelector", label: "Campo usuario (login)", hint: "Ej: input[name=email], #username" },
  { key: "loginPasswordSelector", label: "Campo contraseña (login)", hint: "Ej: input[type=password], #password" },
  { key: "loginSubmitSelector", label: "Botón submit (login)", hint: "Ej: button[type=submit], .btn-login" },
  { key: "maxPages", label: "Máximo de páginas a recorrer", hint: "Entre 1 y 500. Por defecto: 10", isNumber: true },
];

export function ScraperConfigForm({ providerId, config }: Props) {
  const router = useRouter();
  const [form, setForm] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    fields.forEach(({ key }) => {
      const val = config?.[key];
      init[key] = val !== null && val !== undefined ? String(val) : "";
    });
    return init;
  });
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const payload: Record<string, string | number | null> = { providerId };
      fields.forEach(({ key, isNumber }) => {
        const val = form[key];
        if (isNumber) {
          payload[key] = val ? parseInt(val) : 10;
        } else {
          payload[key] = val.trim() || null;
        }
      });

      const res = await fetch(`/api/providers/${providerId}/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) throw new Error("Error al guardar configuración");
      toast.success("Configuración guardada");
      router.refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const inputCls = "w-full border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/40 bg-background placeholder:font-sans placeholder:text-muted-foreground";
  const labelCls = "block text-xs font-medium text-foreground mb-1";

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="flex gap-2 p-3 bg-blue-50 border border-blue-100 rounded-lg text-xs text-blue-800">
        <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
        <span>
          Los selectores son <strong>opcionales</strong>. Si no se configuran, el sistema intentará
          detección automática. Usá selectores CSS válidos (clases, IDs, atributos).
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
        {fields.map(({ key, label, hint, isNumber }) => (
          <div key={key}>
            <label className={labelCls}>{label}</label>
            <input
              className={inputCls}
              type={isNumber ? "number" : "text"}
              value={form[key]}
              onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
              placeholder={hint}
              min={isNumber ? 1 : undefined}
              max={isNumber ? 500 : undefined}
            />
          </div>
        ))}
      </div>

      <div className="flex gap-3 pt-2 border-t">
        <button
          type="button"
          onClick={() => router.back()}
          className="px-4 py-2 text-sm border rounded-lg hover:bg-muted transition-colors"
          disabled={loading}
        >
          Cancelar
        </button>
        <button
          type="submit"
          className="px-5 py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-60"
          disabled={loading}
        >
          {loading ? "Guardando..." : "Guardar selectores"}
        </button>
      </div>
    </form>
  );
}
