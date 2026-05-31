"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  ImageOff,
  ExternalLink,
  Link2,
  PlusCircle,
  Ban,
  Loader2,
  Search,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";

interface SuggestedMatch {
  catalogProductId: string;
  name: string;
  score: number;
  reason: string;
}

interface UnmatchedRow {
  id: string;
  externalProductId: string;
  externalSku: string | null;
  name: string;
  price: number | null;
  stockQuantity: number | null;
  imageUrl: string | null;
  categories: string[];
  permalink: string | null;
  resolved: boolean;
  suggestedMatch: SuggestedMatch | null;
}

interface CatalogSearchItem {
  id: string;
  sku: string | null;
  publicationSku: string | null;
  supplierName: string;
  commercialTitle: string | null;
  imageUrl: string | null;
}

function formatPrice(p: number | null): string {
  if (p == null) return "—";
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 0,
  }).format(p);
}

interface UnmatchedTableProps {
  // Callback opcional para notificar al padre del conteo actual de la tabla.
  // Útil para mantener sincronizado un badge externo (ej. en MyStoreTabs).
  onCountLoaded?: (count: number) => void;
}

export function UnmatchedTable({ onCountLoaded }: UnmatchedTableProps = {}) {
  const router = useRouter();
  const [items, setItems] = useState<UnmatchedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [includeDiscarded, setIncludeDiscarded] = useState(false);
  const [linkModalFor, setLinkModalFor] = useState<UnmatchedRow | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  // Preview modal del flujo "vincular al sugerido": el usuario confirma antes
  // de aceptar el match. Evita vinculaciones accidentales con score=60.
  const [previewFor, setPreviewFor] = useState<UnmatchedRow | null>(null);

  async function load() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (includeDiscarded) params.set("includeDiscarded", "true");
      const res = await fetch(`/api/my-store/unmatched?${params.toString()}`);
      if (!res.ok) throw new Error("Error al cargar");
      const json = (await res.json()) as { unmatched: UnmatchedRow[] };
      setItems(json.unmatched);
      onCountLoaded?.(json.unmatched.length);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeDiscarded]);

  async function linkTo(unmatchedId: string, catalogProductId: string) {
    setPendingId(unmatchedId);
    try {
      const res = await fetch(`/api/my-store/unmatched/${unmatchedId}/link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ catalogProductId }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error ?? `HTTP ${res.status}`);
      }
      toast.success("Producto vinculado");
      setLinkModalFor(null);
      router.refresh();
      load();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setPendingId(null);
    }
  }

  async function createInCatalog(unmatchedId: string) {
    if (
      !window.confirm(
        "¿Crear un nuevo producto en tu catálogo (Mi stock) copiando los datos de la tienda?"
      )
    )
      return;
    setPendingId(unmatchedId);
    try {
      const res = await fetch(
        `/api/my-store/unmatched/${unmatchedId}/create-catalog`,
        { method: "POST" }
      );
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error ?? `HTTP ${res.status}`);
      }
      toast.success("Producto creado en el catálogo y vinculado");
      router.refresh();
      load();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setPendingId(null);
    }
  }

  async function discard(unmatchedId: string) {
    setPendingId(unmatchedId);
    try {
      const res = await fetch(`/api/my-store/unmatched/${unmatchedId}/resolve`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success("Descartado");
      load();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground bg-muted/20 border border-border rounded-lg px-3 py-2">
        Estos productos existen en WooCommerce pero no están vinculados a
        ningún producto de tu catálogo en PricEcom. Vinculalos para poder
        gestionar su precio y estado desde PricEcom. Si elegís
        &ldquo;No vincular&rdquo;, se mueven al listado de descartados
        manualmente (accesible con el checkbox de abajo).
      </p>
      <div className="flex items-center gap-2 flex-wrap">
        <label className="text-xs flex items-center gap-2 text-muted-foreground">
          <input
            type="checkbox"
            checked={includeDiscarded}
            onChange={(e) => setIncludeDiscarded(e.target.checked)}
            className="accent-primary"
          />
          Ver descartados manualmente
        </label>
        <span className="text-xs text-muted-foreground ml-auto">
          {items.length}{" "}
          {includeDiscarded ? "descartado(s)" : "sin vincular"}
        </span>
      </div>

      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-muted/20">
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider w-[56px]">
                  Img
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider">
                  SKU tienda
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider">
                  Producto
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider">
                  Categoría
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider">
                  Precio
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider">
                  Stock
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider">
                  Match sugerido
                </th>
                <th className="px-3 py-2.5 text-right font-medium text-muted-foreground uppercase tracking-wider">
                  Acc.
                </th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin inline-block mr-2" />
                    Cargando…
                  </td>
                </tr>
              )}
              {!loading && items.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-muted-foreground">
                    {includeDiscarded
                      ? "Sin productos descartados"
                      : "No hay productos sin vincular 🎉"}
                  </td>
                </tr>
              )}
              {!loading &&
                items.map((it) => {
                  const isPending = pendingId === it.id;
                  return (
                    <tr
                      key={it.id}
                      className={`border-b border-border hover:bg-muted/10 transition-colors ${it.resolved ? "opacity-50" : ""}`}
                    >
                      <td className="px-3 py-2">
                        {it.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={it.imageUrl}
                            alt=""
                            loading="lazy"
                            className="w-9 h-9 rounded-md object-cover bg-muted/30 border border-border"
                          />
                        ) : (
                          <div className="w-9 h-9 rounded-md bg-muted/20 border border-border flex items-center justify-center text-muted-foreground/50">
                            <ImageOff className="w-3.5 h-3.5" />
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono text-sm font-semibold">
                        {it.externalSku ?? "—"}
                      </td>
                      <td className="px-3 py-2">
                        <p className="font-medium truncate" style={{ maxWidth: 240 }}>
                          {it.name}
                        </p>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground truncate" style={{ maxWidth: 140 }}>
                        {it.categories.join(", ") || "—"}
                      </td>
                      <td className="px-3 py-2 font-mono">{formatPrice(it.price)}</td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {it.stockQuantity ?? "—"}
                      </td>
                      <td className="px-3 py-2">
                        {it.suggestedMatch ? (
                          <div className="flex flex-col gap-0.5">
                            <span
                              className={`inline-flex items-center text-[10px] px-2 py-0.5 rounded-full border font-medium ${
                                it.suggestedMatch.score >= 90
                                  ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                                  : "bg-amber-500/15 text-amber-300 border-amber-500/30"
                              }`}
                              title={`${it.suggestedMatch.score}% — ${it.suggestedMatch.reason}`}
                            >
                              {it.suggestedMatch.score >= 90
                                ? "SKU exacto"
                                : "Nombre similar"}
                            </span>
                            <span
                              className="text-[10px] text-muted-foreground truncate"
                              style={{ maxWidth: 200 }}
                              title={it.suggestedMatch.name}
                            >
                              {it.suggestedMatch.name}
                            </span>
                          </div>
                        ) : (
                          <span className="text-muted-foreground/50 text-[10px]">
                            Sin coincidencia
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-end gap-1">
                          {it.permalink && (
                            <a
                              href={it.permalink}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="Ver en tienda"
                              className="text-muted-foreground hover:text-foreground p-1"
                            >
                              <ExternalLink className="w-3.5 h-3.5" />
                            </a>
                          )}
                          {it.suggestedMatch && (
                            <button
                              type="button"
                              onClick={() => setPreviewFor(it)}
                              disabled={isPending}
                              title={`Vincular al sugerido (${it.suggestedMatch.score}%)`}
                              className="text-xs flex items-center gap-1 border border-primary/30 bg-primary/10 text-primary px-2 py-1 rounded-md hover:bg-primary/20 disabled:opacity-60"
                            >
                              {isPending ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                <Link2 className="w-3 h-3" />
                              )}
                              Vincular al sugerido
                            </button>
                          )}
                          {!it.suggestedMatch && (
                            <button
                              type="button"
                              onClick={() => setLinkModalFor(it)}
                              className="text-xs flex items-center gap-1 border border-border px-2 py-1 rounded-md hover:bg-muted/40"
                            >
                              <Link2 className="w-3 h-3" /> Buscar en catálogo
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => createInCatalog(it.id)}
                            disabled={isPending}
                            title="Crear nuevo CatalogProduct desde este producto WooCommerce"
                            className="text-xs flex items-center gap-1 border border-border px-2 py-1 rounded-md hover:bg-muted/40 disabled:opacity-60"
                          >
                            <PlusCircle className="w-3 h-3" /> Crear en Mi stock
                          </button>
                          {!it.resolved && (
                            <button
                              type="button"
                              onClick={() => discard(it.id)}
                              disabled={isPending}
                              title="No vincular"
                              className="text-xs flex items-center gap-1 border border-border px-2 py-1 rounded-md hover:bg-muted/40 text-muted-foreground disabled:opacity-60"
                            >
                              <Ban className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      </div>

      {linkModalFor && (
        <LinkSearchModal
          unmatched={linkModalFor}
          onClose={() => setLinkModalFor(null)}
          onPick={(catalogProductId) =>
            linkTo(linkModalFor.id, catalogProductId)
          }
        />
      )}

      {previewFor && previewFor.suggestedMatch && (
        <LinkPreviewModal
          unmatched={previewFor}
          onClose={() => setPreviewFor(null)}
          onConfirm={() => {
            const target = previewFor;
            setPreviewFor(null);
            linkTo(target.id, target.suggestedMatch!.catalogProductId);
          }}
        />
      )}
    </div>
  );
}

function LinkPreviewModal({
  unmatched,
  onClose,
  onConfirm,
}: {
  unmatched: UnmatchedRow;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const m = unmatched.suggestedMatch!;
  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-md pointer-events-auto">
          <div className="flex items-center justify-between px-5 py-3 border-b border-border">
            <h3 className="text-sm font-semibold">Confirmar vinculación</h3>
            <button
              type="button"
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground p-1 rounded-md hover:bg-muted/40"
              aria-label="Cerrar"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="px-5 py-4 space-y-4 text-xs">
            <div className="space-y-1.5">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                Producto en WooCommerce
              </p>
              <div className="flex items-center gap-3">
                {unmatched.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={unmatched.imageUrl}
                    alt=""
                    className="w-12 h-12 rounded-md object-cover bg-muted/30 border border-border flex-shrink-0"
                  />
                ) : (
                  <div className="w-12 h-12 rounded-md bg-muted/20 border border-border flex items-center justify-center text-muted-foreground/50 flex-shrink-0">
                    <ImageOff className="w-4 h-4" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="font-medium truncate">{unmatched.name}</p>
                  <p className="text-[10px] text-muted-foreground font-mono">
                    {unmatched.externalSku ?? "(sin SKU)"} ·{" "}
                    {formatPrice(unmatched.price)}
                  </p>
                </div>
              </div>
            </div>

            <div className="flex justify-center text-muted-foreground">
              <Link2 className="w-4 h-4" />
            </div>

            <div className="space-y-1.5">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                Se vinculará con
              </p>
              <p className="font-medium">{m.name}</p>
              <span
                className={`inline-flex items-center text-[10px] px-2 py-0.5 rounded-full border font-medium ${
                  m.score >= 90
                    ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                    : "bg-amber-500/15 text-amber-300 border-amber-500/30"
                }`}
                title={`${m.score}%`}
              >
                {m.score >= 90 ? "SKU exacto" : "Nombre similar"} · {m.reason}
              </span>
            </div>
          </div>
          <div className="px-5 py-3 border-t border-border flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="text-xs px-3 py-1.5 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted/40"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className="text-xs flex items-center gap-1.5 bg-primary text-primary-foreground px-3 py-1.5 rounded-md hover:bg-primary/90"
            >
              <Link2 className="w-3 h-3" /> Confirmar vinculación
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function LinkSearchModal({
  unmatched,
  onClose,
  onPick,
}: {
  unmatched: UnmatchedRow;
  onClose: () => void;
  onPick: (catalogProductId: string) => void;
}) {
  const [q, setQ] = useState(unmatched.externalSku ?? unmatched.name.slice(0, 30));
  const [results, setResults] = useState<CatalogSearchItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!q.trim()) {
      setResults([]);
      return;
    }
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({
          search: q.trim(),
          pageSize: "20",
          showRemovedIgnored: "true",
        });
        const res = await fetch(`/api/catalog?${params.toString()}`);
        if (!res.ok) throw new Error("Error de búsqueda");
        const json = (await res.json()) as {
          products: CatalogSearchItem[];
        };
        if (!cancelled) setResults(json.products);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q]);

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-xl pointer-events-auto flex flex-col max-h-[80vh]">
          <div className="flex items-center justify-between px-5 py-4 border-b border-border">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold truncate">Vincular con un producto del catálogo</h3>
              <p className="text-xs text-muted-foreground truncate">
                {unmatched.externalSku ?? "—"} · {unmatched.name}
              </p>
            </div>
            <button onClick={onClose} className="p-1 hover:bg-muted/40 rounded">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="px-5 py-3 border-b border-border">
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Buscar por SKU, nombre…"
                className="w-full text-sm bg-background border border-border rounded-md pl-8 pr-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/60"
              />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {loading && (
              <div className="px-5 py-6 text-center text-xs text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin inline-block mr-2" />
                Buscando…
              </div>
            )}
            {!loading && results.length === 0 && (
              <div className="px-5 py-6 text-center text-xs text-muted-foreground">
                Sin resultados para “{q}”
              </div>
            )}
            <ul className="divide-y divide-border">
              {results.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => onPick(r.id)}
                    className="w-full text-left px-5 py-2.5 hover:bg-muted/30 transition-colors flex items-center gap-3"
                  >
                    {r.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={r.imageUrl}
                        alt=""
                        className="w-9 h-9 rounded-md object-cover bg-muted/30 border border-border flex-shrink-0"
                      />
                    ) : (
                      <div className="w-9 h-9 rounded-md bg-muted/20 border border-border flex items-center justify-center text-muted-foreground/50 flex-shrink-0">
                        <ImageOff className="w-3.5 h-3.5" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">
                        {r.commercialTitle ?? r.supplierName}
                      </p>
                      <p className="text-[10px] text-muted-foreground font-mono">
                        {r.publicationSku ?? "—"}
                      </p>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </>
  );
}
