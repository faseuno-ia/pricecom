"use client";

import { useState } from "react";
import { toast } from "sonner";
import { DollarSign, Loader2 } from "lucide-react";

interface Props {
  selectedIds: string[];
  onClose: () => void;
  onApplied: () => void;
}

// Aplica el mismo wholesalePrice (positivo) en bulk. El backend filtra los
// productos no elegibles (SCRAPER) y devuelve cuántos se saltaron.
export function ApplyCostModal({ selectedIds, onClose, onApplied }: Props) {
  const [cost, setCost] = useState<string>("");
  const [applying, setApplying] = useState(false);

  async function apply() {
    const value = parseFloat(cost);
    if (!Number.isFinite(value) || value <= 0) {
      toast.error("Ingresá un costo > 0");
      return;
    }
    setApplying(true);
    try {
      const res = await fetch("/api/catalog/bulk-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productIds: selectedIds,
          action: "set_cost",
          wholesalePrice: value,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const { updated, skipped } = (await res.json()) as {
        updated: number;
        skipped: number;
      };
      if (skipped > 0) {
        toast.warning(
          `Costo aplicado a ${updated} · ${skipped} salteados (proveedor SCRAPER)`
        );
      } else {
        toast.success(`Costo aplicado a ${updated} producto(s)`);
      }
      onApplied();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setApplying(false);
    }
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center px-4 pointer-events-none">
        <div className="bg-card border border-border rounded-xl shadow-2xl shadow-black/40 w-full max-w-md p-6 space-y-4 pointer-events-auto">
          <div className="flex items-center gap-2">
            <DollarSign className="w-4 h-4 text-primary" />
            <h3 className="font-semibold">Aplicar costo en bloque</h3>
          </div>
          <p className="text-xs text-muted-foreground">
            Setea el mismo precio mayorista a los {selectedIds.length}{" "}
            producto(s) seleccionados. Solo aplica a proveedores no-scraper —
            los productos scrapeados se saltean (el worker maneja su costo).
          </p>
          <div>
            <label className="block text-[11px] text-muted-foreground mb-1">
              Costo mayorista
            </label>
            <div className="flex items-center gap-1">
              <span className="font-mono text-muted-foreground">$</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={cost}
                onChange={(e) => setCost(e.target.value)}
                placeholder="0.00"
                autoFocus
                className="flex-1 font-mono text-sm bg-background border border-border rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/60"
              />
            </div>
            <p className="text-[10px] text-muted-foreground mt-1">
              El precio de venta sugerido se recalcula con la regla de pricing
              activa.
            </p>
          </div>
          <div className="flex items-center justify-end gap-2 pt-3 border-t border-border">
            <button
              type="button"
              onClick={onClose}
              className="text-xs px-3 py-1.5 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted/40"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={apply}
              disabled={applying}
              className="text-xs flex items-center gap-1.5 bg-primary text-primary-foreground px-4 py-1.5 rounded-md hover:bg-primary/90 disabled:opacity-60"
            >
              {applying && <Loader2 className="w-3 h-3 animate-spin" />}
              Aplicar
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
