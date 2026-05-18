"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Link2, X, Loader2, Search } from "lucide-react";

interface StoreCatRow {
  id: string;
  externalCategoryId: string;
  name: string;
  slug: string | null;
  parent: { id: string; name: string } | null;
  linkedCategory: { id: string; name: string } | null;
  productsCount: number;
  suggestion: { categoryId: string; name: string; score: number } | null;
}

interface CategoryOpt {
  id: string;
  name: string;
}

export function CategoriesTable({ categories }: { categories: CategoryOpt[] }) {
  const [rows, setRows] = useState<StoreCatRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [linkModalFor, setLinkModalFor] = useState<StoreCatRow | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/my-store/categories");
      if (!res.ok) throw new Error("Error al cargar");
      const json = (await res.json()) as { categories: StoreCatRow[] };
      setRows(json.categories);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function link(id: string, categoryId: string | null) {
    setPendingId(id);
    try {
      const res = await fetch(`/api/my-store/categories/${id}/link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categoryId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success(categoryId ? "Categoría vinculada" : "Vínculo removido");
      setLinkModalFor(null);
      load();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setPendingId(null);
    }
  }

  // Render con jerarquía: agrupamos por parent. Raíces primero, hijos
  // indentados debajo del padre con `└─`.
  const ordered = useMemo(() => {
    const roots = rows.filter((r) => !r.parent);
    const childrenByParent = new Map<string, StoreCatRow[]>();
    for (const r of rows) {
      if (r.parent) {
        const list = childrenByParent.get(r.parent.id) ?? [];
        list.push(r);
        childrenByParent.set(r.parent.id, list);
      }
    }
    const out: Array<StoreCatRow & { depth: number }> = [];
    for (const root of roots) {
      out.push({ ...root, depth: 0 });
      for (const child of childrenByParent.get(root.id) ?? []) {
        out.push({ ...child, depth: 1 });
      }
    }
    // Categorías huérfanas (parent no presente en la lista, raro pero por las
    // dudas) al final.
    const visited = new Set(out.map((r) => r.id));
    for (const r of rows) {
      if (!visited.has(r.id)) out.push({ ...r, depth: 0 });
    }
    return out;
  }, [rows]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-muted-foreground ml-auto">
          {rows.length} categorías ·{" "}
          {rows.filter((r) => r.linkedCategory).length} vinculadas
        </span>
      </div>

      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-muted/20">
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider">
                  Categoría tienda
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider">
                  Productos
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider">
                  Match sugerido
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground uppercase tracking-wider">
                  Estado
                </th>
                <th className="px-3 py-2.5 text-right font-medium text-muted-foreground uppercase tracking-wider">
                  Acc.
                </th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin inline-block mr-2" />
                    Cargando…
                  </td>
                </tr>
              )}
              {!loading && ordered.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                    No hay categorías sincronizadas todavía. Corré "Importar
                    categorías" desde el dashboard.
                  </td>
                </tr>
              )}
              {!loading &&
                ordered.map((r) => {
                  const isPending = pendingId === r.id;
                  return (
                    <tr
                      key={r.id}
                      className="border-b border-border hover:bg-muted/10 transition-colors"
                    >
                      <td className="px-3 py-2">
                        <div
                          className="flex items-center gap-2"
                          style={{ paddingLeft: r.depth * 18 }}
                        >
                          {r.depth > 0 && (
                            <span className="text-muted-foreground/60 font-mono">
                              └─
                            </span>
                          )}
                          <span className="font-medium">{r.name}</span>
                          <span className="text-[10px] text-muted-foreground font-mono">
                            #{r.externalCategoryId}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {r.productsCount}
                      </td>
                      <td className="px-3 py-2">
                        {r.suggestion ? (
                          <span
                            className={`inline-flex items-center text-[10px] px-2 py-0.5 rounded-full border font-medium ${
                              r.suggestion.score >= 90
                                ? "bg-accent/10 text-accent border-accent/30"
                                : "bg-amber-500/10 text-amber-300 border-amber-500/30"
                            }`}
                          >
                            {r.suggestion.score}% · {r.suggestion.name}
                          </span>
                        ) : (
                          <span className="text-muted-foreground/50 text-[10px]">
                            sin sugerencia
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {r.linkedCategory ? (
                          <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border font-medium bg-accent/10 text-accent border-accent/30">
                            <Link2 className="w-2.5 h-2.5" /> {r.linkedCategory.name}
                          </span>
                        ) : (
                          <span className="text-[10px] text-muted-foreground">
                            Sin vincular
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-end gap-1">
                          {!r.linkedCategory && r.suggestion && (
                            <button
                              type="button"
                              onClick={() => link(r.id, r.suggestion!.categoryId)}
                              disabled={isPending}
                              className="text-xs flex items-center gap-1 border border-primary/30 bg-primary/10 text-primary px-2 py-1 rounded-md hover:bg-primary/20 disabled:opacity-60"
                            >
                              {isPending ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                <Link2 className="w-3 h-3" />
                              )}
                              Aceptar
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => setLinkModalFor(r)}
                            className="text-xs flex items-center gap-1 border border-border px-2 py-1 rounded-md hover:bg-muted/40"
                          >
                            <Search className="w-3 h-3" />
                            {r.linkedCategory ? "Cambiar" : "Vincular…"}
                          </button>
                          {r.linkedCategory && (
                            <button
                              type="button"
                              onClick={() => link(r.id, null)}
                              disabled={isPending}
                              title="Desvincular"
                              className="text-xs flex items-center gap-1 border border-border px-2 py-1 rounded-md hover:bg-muted/40 text-muted-foreground disabled:opacity-60"
                            >
                              <X className="w-3 h-3" />
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
        <CategoryPickerModal
          storeCat={linkModalFor}
          categories={categories}
          onClose={() => setLinkModalFor(null)}
          onPick={(catId) => link(linkModalFor.id, catId)}
        />
      )}
    </div>
  );
}

function CategoryPickerModal({
  storeCat,
  categories,
  onClose,
  onPick,
}: {
  storeCat: StoreCatRow;
  categories: CategoryOpt[];
  onClose: () => void;
  onPick: (catId: string) => void;
}) {
  const [q, setQ] = useState(storeCat.name.slice(0, 30));
  const filtered = useMemo(() => {
    const lc = q.trim().toLowerCase();
    if (!lc) return categories.slice(0, 50);
    return categories
      .filter((c) => c.name.toLowerCase().includes(lc))
      .slice(0, 50);
  }, [q, categories]);

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-md pointer-events-auto flex flex-col max-h-[80vh]">
          <div className="flex items-center justify-between px-5 py-4 border-b border-border">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold truncate">
                Vincular categoría
              </h3>
              <p className="text-xs text-muted-foreground truncate">
                Tienda: {storeCat.name}
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
                placeholder="Filtrar categorías…"
                className="w-full text-sm bg-background border border-border rounded-md pl-8 pr-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/60"
              />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {filtered.length === 0 && (
              <div className="px-5 py-6 text-center text-xs text-muted-foreground">
                Sin resultados
              </div>
            )}
            <ul className="divide-y divide-border">
              {filtered.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => onPick(c.id)}
                    className="w-full text-left px-5 py-2.5 text-sm hover:bg-muted/30 transition-colors"
                  >
                    {c.name}
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
