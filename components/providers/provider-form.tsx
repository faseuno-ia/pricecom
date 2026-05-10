"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

interface ProviderFormProps {
  provider?: {
    id: string;
    name: string;
    baseUrl: string;
    requiresLogin: boolean;
    username: string | null;
    isActive: boolean;
    notes: string | null;
  };
}

export function ProviderForm({ provider }: ProviderFormProps) {
  const router = useRouter();
  const isEdit = !!provider;

  const [form, setForm] = useState({
    name: provider?.name ?? "",
    baseUrl: provider?.baseUrl ?? "",
    requiresLogin: provider?.requiresLogin ?? false,
    username: provider?.username ?? "",
    password: "",
    isActive: provider?.isActive ?? true,
    notes: provider?.notes ?? "",
  });

  const [loading, setLoading] = useState(false);

  const set = (field: string, value: string | boolean) =>
    setForm((f) => ({ ...f, [field]: value }));

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
        throw new Error(err.error ?? "Error al guardar");
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

  const inputCls = "w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 bg-background";
  const labelCls = "block text-xs font-medium text-muted-foreground mb-1.5 uppercase tracking-wide";

  return (
    <form onSubmit={handleSubmit} className="space-y-6 max-w-xl">
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
        <label className={labelCls}>URL base *</label>
        <input
          className={inputCls}
          type="url"
          value={form.baseUrl}
          onChange={(e) => set("baseUrl", e.target.value)}
          placeholder="https://proveedor.com/productos"
          required
        />
      </div>

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
            <label className={labelCls}>Contraseña {isEdit ? "(dejar vacío para no cambiar)" : ""}</label>
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
        <label htmlFor="isActive" className="text-sm font-medium">Proveedor activo</label>
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
          disabled={loading}
        >
          {loading ? "Guardando..." : isEdit ? "Actualizar proveedor" : "Crear proveedor"}
        </button>
      </div>
    </form>
  );
}
