"use client";

import { useState } from "react";
import {
  X,
  ImageOff,
  ExternalLink,
  Check,
  Ban,
  RotateCcw,
  Loader2,
  ArrowRight,
} from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { es } from "date-fns/locale";
import type { ChangeRow, ReviewStatus } from "./changes-table";

interface Props {
  change: ChangeRow | null;
  onClose: () => void;
  onReviewed: () => void;
}

const typeLabel: Record<ChangeRow["changeType"], string> = {
  NEW: "Nuevo producto",
  REMOVED: "Producto removido",
  PRICE_UP: "Subió el precio",
  PRICE_DOWN: "Bajó el precio",
  STOCK_CHANGED: "Cambio de stock",
};

function formatPriceLocal(p: number | null | undefined): string {
  if (p == null) return "—";
  if (Math.abs(p % 1) < 0.005) {
    return "$" + Math.round(p).toLocaleString("es-AR");
  }
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 2,
  }).format(p);
}

function severityFor(pct: number | null): {
  label: string;
  cls: string;
  dot: string;
} {
  if (pct == null)
    return { label: "—", cls: "text-muted-foreground", dot: "bg-muted-foreground/40" };
  const abs = Math.abs(pct);
  if (abs >= 20)
    return { label: "Crítica", cls: "text-red-400 font-semibold", dot: "bg-red-400" };
  if (abs >= 5)
    return { label: "Media", cls: "text-amber-400", dot: "bg-amber-400" };
  return { label: "Menor", cls: "text-muted-foreground", dot: "bg-muted-foreground/60" };
}

export function ProductDrawer({ change, onClose, onReviewed }: Props) {
  const [pending, setPending] = useState<null | ReviewStatus>(null);

  if (!change) return null;

  const sev = severityFor(change.priceChangePercent);
  const deltaText =
    change.priceChangePercent == null
      ? "—"
      : `${change.priceChangePercent >= 0 ? "+" : ""}${
          Math.round(change.priceChangePercent * 10) / 10
        }%`;

  async function markReview(status: ReviewStatus) {
    if (!change) return;
    setPending(status);
    try {
      const res = await fetch(`/api/changes/${change.id}/review`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error ?? `HTTP ${res.status}`);
      }
      toast.success(
        status === "REVIEWED"
          ? "Marcado como revisado"
          : status === "IGNORED"
            ? "Ignorado"
            : "Reabierto"
      );
      onReviewed();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setPending(null);
    }
  }

  const image = change.product?.imageUrl ?? null;
  const isPriceChange =
    change.changeType === "PRICE_UP" || change.changeType === "PRICE_DOWN";

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />
      <aside className="fixed right-0 top-0 h-full w-full max-w-[440px] bg-card border-l border-border z-50 flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h3 className="text-sm font-semibold">Detalle del cambio</h3>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground p-1 rounded-md hover:bg-muted/40"
            aria-label="Cerrar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* Imagen + identidad */}
          <div className="space-y-3">
            <div className="w-full aspect-square max-w-[280px] mx-auto rounded-xl overflow-hidden bg-muted/30 border border-border">
              {image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={image} alt="" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <ImageOff className="w-12 h-12 text-muted-foreground/40" />
                </div>
              )}
            </div>
            <div>
              <p className="font-semibold text-base">{change.name}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                <span className="font-mono">{change.sku ?? "—"}</span>
                <span className="text-border mx-1.5">·</span>
                {change.providerName}
              </p>
            </div>
          </div>

          {/* Datos del cambio */}
          <section className="bg-muted/20 border border-border rounded-lg p-4 space-y-2 text-sm">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
              {typeLabel[change.changeType]}
            </p>

            {isPriceChange && (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Precio anterior</span>
                  <span className="font-mono">
                    {formatPriceLocal(change.previousPrice)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Precio nuevo</span>
                  <span className="font-mono font-semibold">
                    {formatPriceLocal(change.currentPrice)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Variación</span>
                  <span className={`font-mono ${sev.cls}`}>
                    {deltaText}
                    {change.priceChangePercent != null &&
                      (change.priceChangePercent >= 0 ? " ↑" : " ↓")}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Severidad</span>
                  <span className={`inline-flex items-center gap-1.5 ${sev.cls}`}>
                    <span className={`w-2 h-2 rounded-full ${sev.dot}`} />
                    {sev.label}
                  </span>
                </div>
              </>
            )}

            {change.changeType === "STOCK_CHANGED" && (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Stock anterior</span>
                  <span className="font-mono">
                    {change.previousStock ?? "—"}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Stock nuevo</span>
                  <span className="font-mono font-semibold">
                    {change.currentStock ?? "—"}
                  </span>
                </div>
              </>
            )}

            {change.changeType === "NEW" && change.currentPrice != null && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Precio</span>
                <span className="font-mono">
                  {formatPriceLocal(change.currentPrice)}
                </span>
              </div>
            )}

            {change.changeType === "REMOVED" && change.previousPrice != null && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Último precio visto</span>
                <span className="font-mono">
                  {formatPriceLocal(change.previousPrice)}
                </span>
              </div>
            )}
          </section>

          {/* Meta */}
          <section className="text-xs text-muted-foreground space-y-1">
            {change.jobFinishedAt && (
              <p>
                Fecha:{" "}
                {formatDistanceToNow(new Date(change.jobFinishedAt), {
                  locale: es,
                  addSuffix: true,
                })}
              </p>
            )}
            <p>
              Comparación: job{" "}
              <span className="font-mono">{change.jobId.slice(-6)}</span>
              {change.previousJobId && (
                <>
                  {" vs "}
                  <span className="font-mono">
                    {change.previousJobId.slice(-6)}
                  </span>
                </>
              )}
            </p>
            {change.product?.productUrl && (
              <p>
                <a
                  href={change.product.productUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  Ver en proveedor <ExternalLink className="w-3 h-3" />
                </a>
              </p>
            )}
          </section>

          {/* CTA al catálogo */}
          {change.sku && (
            <Link
              href={`/catalog?search=${encodeURIComponent(change.sku)}`}
              className="w-full bg-primary/10 text-primary border border-primary/30 rounded-md px-4 py-2 text-sm font-medium hover:bg-primary/20 transition-colors inline-flex items-center justify-between"
            >
              <span>Ver en catálogo</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          )}
        </div>

        {/* Acciones de revisión */}
        <div className="px-5 py-3 border-t border-border flex items-center justify-between gap-2">
          {change.reviewStatus === "PENDING" ? (
            <>
              <button
                type="button"
                onClick={() => markReview("IGNORED")}
                disabled={pending !== null}
                className="text-xs flex items-center gap-1.5 border border-border px-3 py-1.5 rounded-md hover:bg-muted/40 disabled:opacity-60"
              >
                {pending === "IGNORED" ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Ban className="w-3.5 h-3.5" />
                )}
                Ignorar
              </button>
              <button
                type="button"
                onClick={() => markReview("REVIEWED")}
                disabled={pending !== null}
                className="text-xs flex items-center gap-1.5 bg-primary text-primary-foreground px-4 py-1.5 rounded-md hover:bg-primary/90 disabled:opacity-60"
              >
                {pending === "REVIEWED" ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Check className="w-3.5 h-3.5" />
                )}
                Marcar revisado
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => markReview("PENDING")}
              disabled={pending !== null}
              className="text-xs flex items-center gap-1.5 border border-border px-3 py-1.5 rounded-md hover:bg-muted/40 disabled:opacity-60 ml-auto"
            >
              {pending === "PENDING" ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RotateCcw className="w-3.5 h-3.5" />
              )}
              Reabrir
            </button>
          )}
        </div>
      </aside>
    </>
  );
}
