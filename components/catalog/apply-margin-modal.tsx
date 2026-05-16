"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Tag, Loader2, ArrowLeft, ArrowRight } from "lucide-react";

type Rounding = "NONE" | "NEAREST_100" | "NEAREST_500" | "ENDING_990";

interface PreviewExample {
  id: string;
  sku: string | null;
  name: string;
  cost: number;
  marginPercent: number;
  newPrice: number;
}

interface PreviewData {
  totalProducts: number;
  avgCost: number | null;
  avgCurrentPrice: number | null;
  avgNewPrice: number | null;
  examples: PreviewExample[];
}

interface Props {
  selectedIds: string[]; // si está vacío, no se permite "selected"
  filters: {
    providerId?: string;
    categoryId?: string;
  };
  onClose: () => void;
  onApplied: () => void;
}

function fmt(p: number | null | undefined): string {
  if (p == null) return "—";
  if (Math.abs(p % 1) < 0.005) return "$" + Math.round(p).toLocaleString("es-AR");
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 2,
  }).format(p);
}

export function ApplyMarginModal({ selectedIds, filters, onClose, onApplied }: Props) {
  type Step = "config" | "preview";
  type Scope = "selected" | "provider" | "all";

  const [step, setStep] = useState<Step>("config");
  const [scope, setScope] = useState<Scope>(
    selectedIds.length > 0 ? "selected" : filters.providerId ? "provider" : "all"
  );
  const [margin, setMargin] = useState<string>("30");
  const [rounding, setRounding] = useState<Rounding>("NONE");
  const [overwriteFinal, setOverwriteFinal] = useState(false);

  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [applying, setApplying] = useState(false);

  function buildBody() {
    const marginPercent = parseFloat(margin);
    if (!Number.isFinite(marginPercent)) return null;
    const base = { marginPercent, roundingMode: rounding };
    if (scope === "selected") return { ...base, productIds: selectedIds };
    if (scope === "provider" && filters.providerId)
      return { ...base, providerId: filters.providerId };
    if (scope === "all") return { ...base, applyAll: true };
    return null;
  }

  async function goPreview() {
    const body = buildBody();
    if (!body) {
      toast.error("Configurá el margen");
      return;
    }
    setLoadingPreview(true);
    try {
      const res = await fetch("/api/catalog/apply-margin/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Error al preview");
      }
      setPreview(await res.json());
      setStep("preview");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoadingPreview(false);
    }
  }

  async function applyMargin() {
    const body = buildBody();
    if (!body) return;
    setApplying(true);
    try {
      const res = await fetch("/api/catalog/apply-margin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, overwriteFinalPrice: overwriteFinal }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Error al aplicar");
      }
      const { updated } = (await res.json()) as { updated: number };
      toast.success(`Margen aplicado a ${updated} producto${updated === 1 ? "" : "s"}`);
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
        <div className="bg-card border border-border rounded-xl shadow-2xl shadow-black/40 w-full max-w-lg p-6 space-y-5 pointer-events-auto">
          <div className="flex items-center gap-2">
            <Tag className="w-4 h-4 text-primary" />
            <h3 className="font-semibold">Aplicar margen en bloque</h3>
          </div>

          {step === "config" && (
            <>
              <div>
                <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">
                  Alcance
                </p>
                <div className="space-y-1.5">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      checked={scope === "selected"}
                      onChange={() => setScope("selected")}
                      disabled={selectedIds.length === 0}
                      className="accent-primary"
                    />
                    Productos seleccionados ({selectedIds.length})
                  </label>
                  {filters.providerId && (
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="radio"
                        checked={scope === "provider"}
                        onChange={() => setScope("provider")}
                        className="accent-primary"
                      />
                      Proveedor actual (según filtro)
                    </label>
                  )}
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      checked={scope === "all"}
                      onChange={() => setScope("all")}
                      className="accent-primary"
                    />
                    Todos los productos del catálogo
                  </label>
                </div>
                <p className="text-[10px] text-muted-foreground mt-2">
                  No se incluyen productos con estado interno Ignorado o Archivado.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-muted-foreground mb-1">Margen %</label>
                  <input
                    type="number"
                    step="0.1"
                    value={margin}
                    onChange={(e) => setMargin(e.target.value)}
                    className="w-full text-sm bg-background border border-border rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/60"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-muted-foreground mb-1">Redondeo</label>
                  <select
                    value={rounding}
                    onChange={(e) => setRounding(e.target.value as Rounding)}
                    className="w-full text-sm bg-background border border-border rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/60"
                  >
                    <option value="NONE">Sin redondeo</option>
                    <option value="NEAREST_100">Múltiplo de 100</option>
                    <option value="NEAREST_500">Múltiplo de 500</option>
                    <option value="ENDING_990">Terminar en 990</option>
                  </select>
                </div>
              </div>

              <label className="flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={overwriteFinal}
                  onChange={(e) => setOverwriteFinal(e.target.checked)}
                  className="accent-primary mt-0.5"
                />
                <span>
                  Cristalizar precio final con el costo actual
                  <span className="block text-muted-foreground">
                    Si lo marcás, también se guarda <code>finalPrice</code> con el resultado del cálculo. Si no, sólo se guarda el margen y el precio se recalcula en runtime cuando cambia el costo.
                  </span>
                </span>
              </label>

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
                  onClick={goPreview}
                  disabled={loadingPreview}
                  className="text-xs flex items-center gap-1.5 bg-primary text-primary-foreground px-4 py-1.5 rounded-md hover:bg-primary/90 disabled:opacity-60"
                >
                  {loadingPreview ? <Loader2 className="w-3 h-3 animate-spin" /> : <ArrowRight className="w-3 h-3" />}
                  Ver preview
                </button>
              </div>
            </>
          )}

          {step === "preview" && preview && (
            <>
              <div className="bg-muted/20 border border-border rounded-lg p-4 space-y-2 text-sm">
                <div className="flex items-baseline justify-between">
                  <span className="text-muted-foreground">Productos afectados</span>
                  <span className="text-2xl font-semibold">
                    {preview.totalProducts.toLocaleString("es-AR")}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-2 pt-2 border-t border-border">
                  <div>
                    <p className="text-[10px] uppercase text-muted-foreground">Costo prom.</p>
                    <p className="font-mono">{fmt(preview.avgCost)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase text-muted-foreground">Pr. actual prom.</p>
                    <p className="font-mono text-muted-foreground">{fmt(preview.avgCurrentPrice)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase text-muted-foreground">Pr. nuevo prom.</p>
                    <p className="font-mono text-accent">{fmt(preview.avgNewPrice)}</p>
                  </div>
                </div>
              </div>

              {preview.examples.length > 0 && (
                <div>
                  <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">
                    Ejemplos
                  </p>
                  <div className="border border-border rounded-lg overflow-hidden text-xs">
                    <table className="w-full">
                      <thead className="bg-muted/20">
                        <tr>
                          <th className="text-left px-2 py-1.5 font-medium text-muted-foreground">SKU</th>
                          <th className="text-left px-2 py-1.5 font-medium text-muted-foreground">Nombre</th>
                          <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">Costo</th>
                          <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">Margen</th>
                          <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">Pr. nuevo</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.examples.map((ex) => (
                          <tr key={ex.id} className="border-t border-border">
                            <td className="px-2 py-1.5 font-mono">{ex.sku ?? "—"}</td>
                            <td className="px-2 py-1.5 truncate max-w-[200px]">{ex.name}</td>
                            <td className="px-2 py-1.5 font-mono text-right text-muted-foreground">{fmt(ex.cost)}</td>
                            <td className="px-2 py-1.5 font-mono text-right">+{ex.marginPercent}%</td>
                            <td className="px-2 py-1.5 font-mono text-right text-accent">{fmt(ex.newPrice)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between gap-2 pt-3 border-t border-border">
                <button
                  type="button"
                  onClick={() => setStep("config")}
                  className="text-xs flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted/40"
                >
                  <ArrowLeft className="w-3 h-3" /> Volver
                </button>
                <button
                  type="button"
                  onClick={applyMargin}
                  disabled={applying || preview.totalProducts === 0}
                  className="text-xs flex items-center gap-1.5 bg-primary text-primary-foreground px-4 py-1.5 rounded-md hover:bg-primary/90 disabled:opacity-60"
                >
                  {applying && <Loader2 className="w-3 h-3 animate-spin" />}
                  Confirmar aplicación
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
