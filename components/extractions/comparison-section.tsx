"use client";

import { useState, useMemo } from "react";
import { formatPrice } from "@/lib/utils";
import {
  PlusCircle,
  MinusCircle,
  TrendingUp,
  TrendingDown,
  Package,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

type ChangeType = "NEW" | "REMOVED" | "PRICE_UP" | "PRICE_DOWN" | "STOCK_CHANGED";

interface ProductChange {
  id: string;
  sku: string | null;
  name: string;
  changeType: ChangeType;
  previousPrice: number | null;
  currentPrice: number | null;
  priceChangePercent: number | null;
  previousStock: string | null;
  currentStock: string | null;
}

export interface ComparisonData {
  previousJobId: string | null;
  newProducts: number;
  removedProducts: number;
  priceUp: number;
  priceDown: number;
  stockChanged: number;
  unchanged: number;
  previousJob: { createdAt: string } | null;
  changes: ProductChange[];
}

const cardConfig: Record<
  ChangeType | "UNCHANGED",
  { label: string; icon: typeof PlusCircle; classes: string }
> = {
  NEW: {
    label: "Nuevos",
    icon: PlusCircle,
    classes: "bg-emerald-500/10 border-emerald-500/30 text-emerald-300",
  },
  REMOVED: {
    label: "Removidos",
    icon: MinusCircle,
    classes: "bg-red-500/10 border-red-500/30 text-red-300",
  },
  PRICE_UP: {
    label: "Precio subió",
    icon: TrendingUp,
    classes: "bg-orange-500/10 border-orange-500/30 text-orange-300",
  },
  PRICE_DOWN: {
    label: "Precio bajó",
    icon: TrendingDown,
    classes: "bg-green-500/10 border-green-500/30 text-green-300",
  },
  STOCK_CHANGED: {
    label: "Stock cambió",
    icon: Package,
    classes: "bg-blue-500/10 border-blue-500/30 text-blue-300",
  },
  UNCHANGED: {
    label: "Sin cambios",
    icon: Package,
    classes: "bg-muted/30 border-border text-muted-foreground",
  },
};

const changeTypeLabel: Record<ChangeType, string> = {
  NEW: "Nuevo",
  REMOVED: "Removido",
  PRICE_UP: "Precio subió",
  PRICE_DOWN: "Precio bajó",
  STOCK_CHANGED: "Stock cambió",
};

function formatDate(d: string): string {
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(d));
}

export function ComparisonSection({ comparison }: { comparison: ComparisonData }) {
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState<ChangeType | "all">("all");

  // Promedio de % para las cards de precio.
  const avgPriceUpPct = useMemo(() => {
    const ups = comparison.changes.filter(
      (c) => c.changeType === "PRICE_UP" && c.priceChangePercent != null
    );
    if (ups.length === 0) return null;
    const sum = ups.reduce((acc, c) => acc + (c.priceChangePercent ?? 0), 0);
    return sum / ups.length;
  }, [comparison.changes]);

  const avgPriceDownPct = useMemo(() => {
    const downs = comparison.changes.filter(
      (c) => c.changeType === "PRICE_DOWN" && c.priceChangePercent != null
    );
    if (downs.length === 0) return null;
    const sum = downs.reduce((acc, c) => acc + (c.priceChangePercent ?? 0), 0);
    return sum / downs.length;
  }, [comparison.changes]);

  const filtered = useMemo(() => {
    if (filter === "all") return comparison.changes;
    return comparison.changes.filter((c) => c.changeType === filter);
  }, [comparison.changes, filter]);

  const cards: {
    type: ChangeType | "UNCHANGED";
    value: number;
    sub?: string;
  }[] = [
    { type: "NEW", value: comparison.newProducts },
    { type: "REMOVED", value: comparison.removedProducts },
    {
      type: "PRICE_UP",
      value: comparison.priceUp,
      sub: avgPriceUpPct != null ? `prom. +${avgPriceUpPct.toFixed(1)}%` : undefined,
    },
    {
      type: "PRICE_DOWN",
      value: comparison.priceDown,
      sub: avgPriceDownPct != null ? `prom. ${avgPriceDownPct.toFixed(1)}%` : undefined,
    },
    { type: "STOCK_CHANGED", value: comparison.stockChanged },
    { type: "UNCHANGED", value: comparison.unchanged },
  ];

  const filterButtons: { value: ChangeType | "all"; label: string }[] = [
    { value: "all", label: "Todos" },
    { value: "NEW", label: "Nuevos" },
    { value: "REMOVED", label: "Removidos" },
    { value: "PRICE_UP", label: "Precio subió" },
    { value: "PRICE_DOWN", label: "Precio bajó" },
    { value: "STOCK_CHANGED", label: "Stock" },
  ];

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="px-5 py-3 border-b border-border">
        <h2 className="font-semibold text-sm">Cambios vs extracción anterior</h2>
        {comparison.previousJob && (
          <p className="text-xs text-muted-foreground mt-0.5">
            vs extracción del {formatDate(comparison.previousJob.createdAt)}
          </p>
        )}
      </div>

      {/* Cards resumen */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 p-5">
        {cards.map(({ type, value, sub }) => {
          const cfg = cardConfig[type];
          const Icon = cfg.icon;
          return (
            <div
              key={type}
              className={`border rounded-lg p-3 ${cfg.classes}`}
            >
              <div className="flex items-center gap-1.5">
                <Icon className="w-3.5 h-3.5" />
                <span className="text-[10px] uppercase tracking-wider font-medium">
                  {cfg.label}
                </span>
              </div>
              <p className="text-2xl font-semibold mt-1.5 text-foreground">
                {value}
              </p>
              {sub && <p className="text-[10px] mt-0.5">{sub}</p>}
            </div>
          );
        })}
      </div>

      {/* Tabla colapsable de detalle */}
      {comparison.changes.length > 0 && (
        <div className="border-t border-border">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="w-full flex items-center justify-between px-5 py-3 text-sm font-medium hover:bg-muted/20 transition-colors"
          >
            <span>
              Detalle de cambios ({comparison.changes.length})
            </span>
            {expanded ? (
              <ChevronUp className="w-4 h-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="w-4 h-4 text-muted-foreground" />
            )}
          </button>

          {expanded && (
            <div>
              <div className="px-5 pb-3 flex gap-0.5 bg-muted/10 pt-1 flex-wrap">
                {filterButtons.map((f) => (
                  <button
                    key={f.value}
                    type="button"
                    onClick={() => setFilter(f.value)}
                    className={`text-[11px] px-2.5 py-1 rounded transition-colors ${
                      filter === f.value
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-y border-border bg-muted/20">
                      {["Tipo", "Nombre", "SKU", "Precio ant.", "Precio actual", "Δ%", "Stock"].map(
                        (h) => (
                          <th
                            key={h}
                            className="text-left px-4 py-2.5 font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap"
                          >
                            {h}
                          </th>
                        )
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((c, i) => (
                      <tr
                        key={c.id}
                        className={
                          i % 2 === 1
                            ? "bg-[hsl(var(--surface-row))] hover:bg-muted/30"
                            : "hover:bg-muted/20"
                        }
                      >
                        <td className="px-4 py-2.5 whitespace-nowrap">
                          <span
                            className={`text-[10px] px-1.5 py-0.5 rounded font-medium border ${cardConfig[c.changeType].classes}`}
                          >
                            {changeTypeLabel[c.changeType]}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 max-w-xs truncate font-medium">
                          {c.name}
                        </td>
                        <td className="px-4 py-2.5 font-mono text-muted-foreground">
                          {c.sku ?? "—"}
                        </td>
                        <td className="px-4 py-2.5 font-mono text-muted-foreground">
                          {c.previousPrice != null
                            ? formatPrice(c.previousPrice)
                            : "—"}
                        </td>
                        <td className="px-4 py-2.5 font-mono">
                          {c.currentPrice != null
                            ? formatPrice(c.currentPrice)
                            : "—"}
                        </td>
                        <td
                          className={`px-4 py-2.5 font-mono ${
                            c.priceChangePercent == null
                              ? "text-muted-foreground"
                              : c.priceChangePercent > 0
                              ? "text-orange-300"
                              : "text-green-300"
                          }`}
                        >
                          {c.priceChangePercent != null
                            ? `${c.priceChangePercent > 0 ? "+" : ""}${c.priceChangePercent}%`
                            : "—"}
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground">
                          {c.changeType === "STOCK_CHANGED"
                            ? `${c.previousStock ?? "—"} → ${c.currentStock ?? "—"}`
                            : "—"}
                        </td>
                      </tr>
                    ))}
                    {filtered.length === 0 && (
                      <tr>
                        <td
                          colSpan={7}
                          className="px-4 py-8 text-center text-muted-foreground"
                        >
                          Sin cambios de este tipo
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
