"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2, PowerOff, Loader2 } from "lucide-react";

interface Props {
  providerId: string;
  isActive: boolean;
}

export function ProviderActions({ providerId, isActive }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [acting, setActing] = useState(false);

  async function handleDelete() {
    const ok = window.confirm(
      "¿Seguro que querés eliminar este proveedor? Esta acción eliminará también todas sus extracciones y productos."
    );
    if (!ok) return;

    setActing(true);
    try {
      const res = await fetch(`/api/providers/${providerId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Error eliminando proveedor");
      }
      toast.success("Proveedor eliminado");
      startTransition(() => router.refresh());
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setActing(false);
    }
  }

  async function handleDeactivate() {
    setActing(true);
    try {
      const res = await fetch(`/api/providers/${providerId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: false }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Error desactivando proveedor");
      }
      toast.success("Proveedor desactivado");
      startTransition(() => router.refresh());
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setActing(false);
    }
  }

  const busy = acting || pending;

  if (isActive) {
    return (
      <button
        type="button"
        onClick={handleDeactivate}
        disabled={busy}
        className="flex items-center justify-center text-muted-foreground hover:text-amber-300 hover:bg-amber-500/10 rounded-md p-1.5 transition-colors disabled:opacity-50"
        title="Desactivar proveedor"
      >
        {busy ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <PowerOff className="w-3.5 h-3.5" />
        )}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={handleDelete}
      disabled={busy}
      className="flex items-center justify-center text-muted-foreground hover:text-red-300 hover:bg-red-500/10 rounded-md p-1.5 transition-colors disabled:opacity-50"
      title="Eliminar proveedor"
    >
      {busy ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
      ) : (
        <Trash2 className="w-3.5 h-3.5" />
      )}
    </button>
  );
}
