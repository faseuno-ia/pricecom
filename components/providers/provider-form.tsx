"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

type ProviderType = "SCRAPER" | "MANUAL" | "IMPORTED" | "OWN_STOCK" | "WOO_STORE_API";

interface ProviderFormProps {
  provider?: {
    id: string;
    name: string;
    providerType?: ProviderType;
    baseUrl: string;
    requiresLogin: boolean;
    username: string | null;
    isActive: boolean;
    notes: string | null;
    listDiscountPercent?: number;
    skuPrefix?: string;
  };
  /** SKU del primer producto del proveedor — usado para el preview en vivo
   *  del prefijo SKU comercial. null si no hay productos cargados aún. */
  sampleSupplierSku?: string | null;
}

const SKU_PREFIX_REGEX = /^[A-Z0-9-]{0,10}$/;
const SAMPLE_SKU_FALLBACK = "00123";

const TYPE_OPTIONS: { value: ProviderType; label: string; hint: string }[] = [
  {
    value: "SCRAPER",
    label: "Automático — Web scraping",
    hint: "El sistema extrae el catálogo navegando la web del proveedor.",
  },
  {
    value: "MANUAL",
    label: "Manual — Carga producto por producto",
    hint: "Los productos se cargan a mano desde el catálogo interno.",
  },
  {
    value: "IMPORTED",
    label: "Importado — Carga por Excel/CSV",
    hint: "Subís un archivo y el sistema hace upsert de productos.",
  },
  {
    value: "OWN_STOCK",
    label: "Stock propio — Productos del cliente",
    hint: "Productos propios sin proveedor externo. Se administran como MANUAL.",
  },
];

export function ProviderForm({ provider, sampleSupplierSku }: ProviderFormProps) {
  const router = useRouter();
  const isEdit = !!provider;

  const [form, setForm] = useState({
    name: provider?.name ?? "",
    providerType: (provider?.providerType ?? "SCRAPER") as ProviderType,
    baseUrl: provider?.baseUrl ?? "",
    requiresLogin: provider?.requiresLogin ?? false,
    username: provider?.username ?? "",
    password: "",
    isActive: provider?.isActive ?? true,
    notes: provider?.notes ?? "",
    listDiscountPercent: provider?.listDiscountPercent ?? 0,
    skuPrefix: provider?.skuPrefix ?? "",
  });

  // El input se forza a mayúsculas al escribir, pero validamos también el
  // patrón completo para mostrar el error en el cliente y bloquear el submit.
  const skuPrefixValid = SKU_PREFIX_REGEX.test(form.skuPrefix);
  const skuSampleBase = sampleSupplierSku?.trim() || SAMPLE_SKU_FALLBACK;
  const skuPreview = `${form.skuPrefix}${skuSampleBase}`;

  const [loading, setLoading] = useState(false);

  const set = <K extends keyof typeof form>(field: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [field]: value }));

  const isScraper = form.providerType === "SCRAPER";
  const typeHint = TYPE_OPTIONS.find((o) => o.value === form.providerType)?.hint;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);

    const url = isEdit ? `/api/providers/${provider.id}` : "/api/providers";
    const method = isEdit ? "PUT" : "POST";

    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(
          typeof err.error === "string"
            ? err.error
            : JSON.stringify(err.error) ?? "Error al guardar"
        );
      }

      toast.success(isEdit ? "Proveedor actualizado" : "Proveedor creado");
      router.push("/providers");
      router.refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const inputCls =
    "w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 bg-background";
  const labelCls =
    "block text-xs font-medium text-muted-foreground mb-1.5 uppercase tracking-wide";

  return (
    <form onSubmit={handleSubmit} className="space-y-6 max-w-xl">
      <div>
        <label className={labelCls}>Tipo de proveedor *</label>
        <select
          className={inputCls}
          value={form.providerType}
          onChange={(e) => set("providerType", e.target.value as ProviderType)}
          disabled={isEdit}
          title={isEdit ? "El tipo no se cambia tras la creación" : undefined}
        >
          {TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {typeHint && (
          <p className="text-[11px] text-muted-foreground mt-1.5">{typeHint}</p>
        )}
      </div>

      <div>
        <label className={labelCls}>Nombre del proveedor *</label>
        <input
          className={inputCls}
          value={form.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="Ej: Distribuidora García"
          required
        />
      </div>

      <div>
        <label className={labelCls}>
          URL base {isScraper ? "*" : "(opcional)"}
        </label>
        <input
          className={inputCls}
          type="url"
          value={form.baseUrl}
          onChange={(e) => set("baseUrl", e.target.value)}
          placeholder={
            isScraper
              ? "https://proveedor.com/productos"
              : "https://… (opcional, referencia)"
          }
          required={isScraper}
        />
      </div>

      {isScraper && (
        <>
          <div className="flex items-center gap-3">
            <input
              id="requiresLogin"
              type="checkbox"
              className="w-4 h-4 accent-primary"
              checked={form.requiresLogin}
              onChange={(e) => set("requiresLogin", e.target.checked)}
            />
            <label htmlFor="requiresLogin" className="text-sm font-medium">
              Requiere inicio de sesión
            </label>
          </div>

          {form.requiresLogin && (
            <div className="space-y-4 p-4 bg-amber-50 border border-amber-100 rounded-xl">
              <p className="text-xs text-amber-700 font-medium">
                Las credenciales se almacenan cifradas con AES-256
              </p>
              <div>
                <label className={labelCls}>Usuario / Email</label>
                <input
                  className={inputCls}
                  value={form.username}
                  onChange={(e) => set("username", e.target.value)}
                  placeholder="usuario@proveedor.com"
                />
              </div>
              <div>
                <label className={labelCls}>
                  Contraseña {isEdit ? "(dejar vacío para no cambiar)" : ""}
                </label>
                <input
                  className={inputCls}
                  type="password"
                  value={form.password}
                  onChange={(e) => set("password", e.target.value)}
                  placeholder="••••••••"
                />
              </div>
            </div>
          )}
        </>
      )}

      {/* Condiciones comerciales */}
      <div className="space-y-4 p-4 bg-muted/20 border border-border rounded-xl">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Condiciones comerciales
        </p>
        <div>
          <label className={labelCls}>Descuento sobre lista (%)</label>
          <input
            className={`${inputCls} max-w-[160px]`}
            type="number"
            min={0}
            max={100}
            step={0.1}
            value={form.listDiscountPercent}
            onChange={(e) =>
              set("listDiscountPercent", Number(e.target.value) || 0)
            }
            placeholder="0"
          />
          <p className="text-[11px] text-muted-foreground mt-1.5">
            Se aplica al precio extraído antes de calcular el precio de venta.
            No modifica el precio original de la lista.
          </p>
        </div>

        <div>
          <label className={labelCls}>Prefijo SKU comercial</label>
          <input
            className={`${inputCls} max-w-[200px] font-mono uppercase ${
              !skuPrefixValid ? "border-red-500 focus:ring-red-500/40" : ""
            }`}
            type="text"
            maxLength={10}
            value={form.skuPrefix}
            onChange={(e) => set("skuPrefix", e.target.value.toUpperCase())}
            placeholder="TEK-"
          />
          {!skuPrefixValid ? (
            <p className="text-[11px] text-red-600 mt-1.5">
              Solo mayúsculas, números y guiones (máximo 10 caracteres).
            </p>
          ) : (
            <p className="text-[11px] text-muted-foreground mt-1.5">
              Se concatena al SKU del proveedor al asignar el SKU comercial.
              {" "}
              <span className="text-foreground/80">
                Ej: <span className="font-mono">{skuPreview || "—"}</span>
              </span>
              {sampleSupplierSku
                ? ""
                : " (sin productos cargados aún — usando ejemplo)"}
            </p>
          )}
        </div>
      </div>

      <div>
        <label className={labelCls}>Notas internas</label>
        <textarea
          className={`${inputCls} resize-none`}
          rows={3}
          value={form.notes}
          onChange={(e) => set("notes", e.target.value)}
          placeholder="Observaciones, condiciones de pago, contacto..."
        />
      </div>

      <div className="flex items-center gap-3">
        <input
          id="isActive"
          type="checkbox"
          className="w-4 h-4 accent-primary"
          checked={form.isActive}
          onChange={(e) => set("isActive", e.target.checked)}
        />
        <label htmlFor="isActive" className="text-sm font-medium">
          Proveedor activo
        </label>
      </div>

      <div className="flex gap-3 pt-2">
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
          disabled={loading || !skuPrefixValid}
        >
          {loading
            ? "Guardando..."
            : isEdit
              ? "Actualizar proveedor"
              : "Crear proveedor"}
        </button>
      </div>
    </form>
  );
}
