"use client";

import { useEffect } from "react";
import Link from "next/link";
import { X, ExternalLink, TrendingUp, TrendingDown, ImageOff, AlertCircle } from "lucide-react";
import { formatPrice, formatDate } from "@/lib/utils";
import type { ChangeRow } from "./changes-table";

const changeTypeBadge: Record<string, { label: string; className: string }> = {
  NEW: { label: "Nuevo", className: "bg-green-500/15 text-green-300 border-green-500/30" },
  REMOVED: { label: "Removido", className: "bg-red-500/15 text-red-300 border-red-500/30" },
  PRICE_UP: { label: "Precio ↑", className: "bg-orange-500/15 text-orange-300 border-orange-500/30" },
  PRICE_DOWN: { label: "Precio ↓", className: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" },
  STOCK_CHANGED: { label: "Stock", className: "bg-blue-500/15 text-blue-300 border-blue-500/30" },
};

export function ProductDrawer({
  change,
  onClose,
}: {
  change: ChangeRow | null;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && change) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [change, onClose]);

  if (!change) return null;

  const isRemoved = change.changeType === "REMOVED";
  const badge = changeTypeBadge[change.changeType];
  const pct = change.priceChangePercent;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 z-40"
        onClick={onClose}
        aria-hidden
      />
      {/* Panel lateral */}
      <aside className="fixed right-0 top-0 h-full w-full max-w-md bg-card border-l border-border z-50 flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h3 className="text-sm font-semibold">Detalle del cambio</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground p-1 rounded-md hover:bg-muted/40 transition-colors"
            aria-label="Cerrar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* Imagen */}
          {!isRemoved && change.product?.imageUrl ? (
            <div className="w-full aspect-square rounded-xl overflow-hidden bg-muted/30 border border-border">
              <img
                src={change.product.imageUrl}
                alt={change.name}
                className="w-full h-full object-cover"
              />
            </div>
          ) : (
            <div className="w-full aspect-square rounded-xl bg-muted/20 border border-border flex items-center justify-center">
              <ImageOff className="w-12 h-12 text-muted-foreground/40" />
            </div>
          )}

          {/* Identidad */}
          <div className="space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className={`text-[11px] px-2 py-0.5 rounded-full font-medium border ${badge.className}`}
              >
                {badge.label}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {formatDate(change.createdAt)}
              </span>
            </div>
            <h4 className="text-base font-semibold">{change.name}</h4>
            <div className="text-xs text-muted-foreground space-y-0.5">
              <p>
                <span className="font-medium text-foreground/80">SKU:</span>{" "}
                <span className="font-mono">{change.sku ?? "—"}</span>
              </p>
              <p>
                <span className="font-medium text-foreground/80">Proveedor:</span>{" "}
                {change.providerName}
              </p>
              {change.product?.category && (
                <p>
                  <span className="font-medium text-foreground/80">
                    Categoría:
                  </span>{" "}
                  {change.product.category}
                </p>
              )}
            </div>
          </div>

          {/* Mensaje de removido */}
          {isRemoved && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 flex items-start gap-2 text-xs text-red-300">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <p>Este producto fue removido del catálogo del proveedor.</p>
            </div>
          )}

          {/* Precios */}
          {(change.previousPrice != null || change.currentPrice != null) && (
            <div className="bg-muted/20 border border-border rounded-lg p-4 space-y-2">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Precio
              </p>
              <div className="flex items-baseline justify-between gap-3">
                <div>
                  <p className="text-xs text-muted-foreground">Actual</p>
                  <p className="text-xl font-semibold">
                    {change.currentPrice != null
                      ? formatPrice(change.currentPrice)
                      : "—"}
                  </p>
                </div>
                {change.previousPrice != null && (
                  <div className="text-right">
                    <p className="text-xs text-muted-foreground">Anterior</p>
                    <p className="text-sm text-muted-foreground line-through">
                      {formatPrice(change.previousPrice)}
                    </p>
                  </div>
                )}
              </div>
              {pct != null && (
                <div
                  className={`flex items-center gap-1 text-sm font-medium ${
                    pct > 0 ? "text-orange-400" : "text-emerald-400"
                  }`}
                >
                  {pct > 0 ? (
                    <TrendingUp className="w-3.5 h-3.5" />
                  ) : (
                    <TrendingDown className="w-3.5 h-3.5" />
                  )}
                  {pct > 0 ? "+" : ""}
                  {pct}%
                </div>
              )}
            </div>
          )}

          {/* Stock */}
          {change.changeType === "STOCK_CHANGED" && (
            <div className="bg-muted/20 border border-border rounded-lg p-4 space-y-2">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Stock
              </p>
              <p className="text-sm">
                <span className="text-muted-foreground line-through">
                  {change.previousStock ?? "—"}
                </span>{" "}
                <span className="mx-1 text-muted-foreground">→</span>{" "}
                <span className="font-medium">{change.currentStock ?? "—"}</span>
              </p>
            </div>
          )}

          {/* Acciones */}
          <div className="space-y-2 pt-2">
            {change.product?.productUrl && (
              <a
                href={change.product.productUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 w-full bg-primary/10 text-primary border border-primary/30 px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary hover:text-primary-foreground transition-colors"
              >
                Ver en proveedor <ExternalLink className="w-3.5 h-3.5" />
              </a>
            )}
            <Link
              href={`/extractions/${change.jobId}`}
              onClick={onClose}
              className="flex items-center justify-center w-full border border-border px-4 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
            >
              Ver extracción
            </Link>
          </div>
        </div>
      </aside>
    </>
  );
}
