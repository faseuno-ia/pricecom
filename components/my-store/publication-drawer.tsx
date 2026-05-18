"use client";

import {
  X,
  ExternalLink,
  RefreshCw,
  Loader2,
  ImageOff,
  AlertTriangle,
  CheckCircle2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { es } from "date-fns/locale";

type PubStatus = "DRAFT" | "ACTIVE" | "PAUSED" | "REMOVED" | "ERROR";
type SyncStatus =
  | "READY"
  | "PENDING_SYNC"
  | "SYNCED"
  | "OUTDATED"
  | "ERROR"
  | "PAUSED";

export interface PubDetail {
  id: string;
  status: PubStatus;
  syncStatus: SyncStatus;
  externalProductId: string | null;
  externalSku: string | null;
  externalStatus: string | null;
  externalUrl: string | null;
  priceInStore: number | null;
  stockInStore: number | null;
  categoryInStore: string | null;
  lastSyncedAt: string | null;
  pendingSync: boolean;
  syncError: string | null;
  catalogProduct: {
    id: string;
    publicationSku: string | null;
    commercialTitle: string | null;
    supplierName: string;
    imageUrl: string | null;
    finalPrice: number | null;
    stock: string | null;
    stockSource: "SUPPLIER" | "OWN" | "HYBRID";
    pricing?: {
      effectivePrice: number | null;
    };
  };
}

interface Props {
  publication: PubDetail | null;
  onClose: () => void;
  onChanged: () => void;
}

function formatPrice(p: number | null | undefined): string {
  if (p == null) return "—";
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 0,
  }).format(p);
}

const stockSourceLabel: Record<
  "SUPPLIER" | "OWN" | "HYBRID",
  { label: string; cls: string }
> = {
  SUPPLIER: {
    label: "Stock proveedor",
    cls: "bg-blue-500/15 text-blue-300 border-blue-500/30",
  },
  OWN: {
    label: "Stock propio",
    cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  },
  HYBRID: {
    label: "Stock híbrido",
    cls: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  },
};

export function PublicationDrawer({ publication, onClose, onChanged }: Props) {
  const [pending, setPending] = useState<string | null>(null);

  if (!publication) return null;

  const p = publication;
  const effectivePrice =
    p.catalogProduct.finalPrice ??
    p.catalogProduct.pricing?.effectivePrice ??
    null;
  const internalStockNum = parseStockNum(p.catalogProduct.stock);

  const priceDrift =
    effectivePrice != null &&
    p.priceInStore != null &&
    Math.abs(effectivePrice - p.priceInStore) > 1;
  const stockDrift =
    internalStockNum != null &&
    p.stockInStore != null &&
    internalStockNum !== p.stockInStore;

  async function forceSync() {
    setPending("forceSync");
    try {
      const res = await fetch("/api/my-store/sync/publications", {
        method: "POST",
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error ?? `HTTP ${res.status}`);
      }
      const { synced } = (await res.json()) as { synced: number };
      toast.success(`${synced} publicaciones sincronizadas`);
      onChanged();
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setPending(null);
    }
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />
      <aside className="fixed right-0 top-0 h-full w-full max-w-[640px] bg-card border-l border-border z-50 flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h3 className="text-sm font-semibold">Detalle de publicación</h3>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground p-1 rounded-md hover:bg-muted/40"
            aria-label="Cerrar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 grid grid-cols-1 md:grid-cols-2 gap-5">
          {/* Columna izquierda: identidad del producto */}
          <div className="space-y-3">
            <div className="aspect-square rounded-xl overflow-hidden bg-muted/30 border border-border">
              {p.catalogProduct.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={p.catalogProduct.imageUrl}
                  alt=""
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <ImageOff className="w-10 h-10 text-muted-foreground/40" />
                </div>
              )}
            </div>
            <div>
              <p className="font-medium text-sm">
                {p.catalogProduct.commercialTitle ??
                  p.catalogProduct.supplierName}
              </p>
              <p className="text-[11px] text-muted-foreground font-mono mt-0.5">
                SKU tienda: {p.externalSku ?? "—"}
              </p>
              <p className="text-[11px] text-muted-foreground font-mono">
                SKU comercial: {p.catalogProduct.publicationSku ?? "—"}
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span
                title={stockSourceLabel[p.catalogProduct.stockSource].label}
                className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${stockSourceLabel[p.catalogProduct.stockSource].cls}`}
              >
                {stockSourceLabel[p.catalogProduct.stockSource].label}
              </span>
              {p.categoryInStore && (
                <span className="text-[10px] px-2 py-0.5 rounded-full border bg-muted/40 text-muted-foreground border-border">
                  {p.categoryInStore}
                </span>
              )}
            </div>
            {p.externalUrl && (
              <a
                href={p.externalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
              >
                Ver en tienda <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </div>

          {/* Columna derecha: estados, comparación y acciones */}
          <div className="space-y-3 text-xs">
            <div className="bg-muted/20 border border-border rounded-lg p-3 space-y-2">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                Estados
              </p>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Pub. interna</span>
                <span className="font-mono">{p.status}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Estado en tienda</span>
                <span className="font-mono">{p.externalStatus ?? "—"}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Sync</span>
                <span className="font-mono">{p.syncStatus}</span>
              </div>
            </div>

            <div className="bg-muted/20 border border-border rounded-lg p-3 space-y-2">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                Precio
              </p>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">PricEcom</span>
                <span className="font-mono font-semibold">
                  {formatPrice(effectivePrice)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Tienda</span>
                <span className="font-mono">{formatPrice(p.priceInStore)}</span>
              </div>
              {priceDrift && (
                <p className="text-[11px] text-amber-300 inline-flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" />
                  Drift de precio detectado
                </p>
              )}
              {!priceDrift && effectivePrice != null && p.priceInStore != null && (
                <p className="text-[11px] text-emerald-300/80 inline-flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3" /> En sintonía
                </p>
              )}
            </div>

            <div className="bg-muted/20 border border-border rounded-lg p-3 space-y-2">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                Stock
              </p>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">PricEcom</span>
                <span className="font-mono font-semibold">
                  {p.catalogProduct.stock ?? "—"}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Tienda</span>
                <span className="font-mono">{p.stockInStore ?? "—"}</span>
              </div>
              {stockDrift && (
                <p className="text-[11px] text-amber-300 inline-flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" />
                  Drift de stock detectado
                </p>
              )}
            </div>

            <div className="bg-muted/20 border border-border rounded-lg p-3 space-y-1.5 text-[11px]">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Último sync</span>
                <span>
                  {p.lastSyncedAt
                    ? formatDistanceToNow(new Date(p.lastSyncedAt), {
                        locale: es,
                        addSuffix: true,
                      })
                    : "—"}
                </span>
              </div>
              {p.syncError && (
                <p className="text-red-300 mt-1 break-words">
                  ⚠ {p.syncError}
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="px-5 py-3 border-t border-border flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={forceSync}
            disabled={pending !== null}
            className="text-xs flex items-center gap-1.5 bg-primary text-primary-foreground px-3 py-1.5 rounded-md hover:bg-primary/90 disabled:opacity-60"
          >
            {pending === "forceSync" ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
            Forzar sync
          </button>
        </div>
      </aside>
    </>
  );
}

function parseStockNum(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const m = String(raw).match(/-?\d+/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}
