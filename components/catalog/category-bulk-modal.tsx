"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, X } from "lucide-react";

interface CategoryRaw {
  id: string;
  name: string;
  parentId: string | null;
}

interface CategoryNode extends CategoryRaw {
  depth: number;
}

function buildFlatTree(categories: CategoryRaw[]): CategoryNode[] {
  const byParent = new Map<string | null, CategoryRaw[]>();
  for (const c of categories) {
    const key = c.parentId ?? null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(c);
  }
  const out: CategoryNode[] = [];
  function walk(parentId: string | null, depth: number) {
    const children = (byParent.get(parentId) ?? []).slice().sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    for (const c of children) {
      out.push({ ...c, depth });
      walk(c.id, depth + 1);
    }
  }
  walk(null, 0);
  return out;
}

interface Props {
  mode: "assign" | "remove";
  selectedIds: string[];
  onClose: () => void;
  onDone: () => void;
}

export function CategoryBulkModal({ mode, selectedIds, onClose, onDone }: Props) {
  const [categories, setCategories] = useState<CategoryRaw[]>([]);
  const [categoryId, setCategoryId] = useState("");
  const [isPrimary, setIsPrimary] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch("/api/categories")
      .then((r) => r.json())
      .then(setCategories)
      .catch(() => {});
  }, []);

  const flatTree = useMemo(() => buildFlatTree(categories), [categories]);

  async function submit() {
    if (!categoryId) {
      toast.error("Elegí una categoría");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/catalog/bulk-categories", {
        method: mode === "assign" ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          mode === "assign"
            ? { productIds: selectedIds, categoryId, isPrimary }
            : { productIds: selectedIds, categoryId }
        ),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error ?? `HTTP ${res.status}`);
      }
      const json = (await res.json()) as
        | { added: number; skipped: number; total: number }
        | { removed: number; total: number };
      if ("added" in json) {
        toast.success(
          `Asignada a ${json.added} producto${json.added === 1 ? "" : "s"}` +
            (json.skipped > 0 ? ` (${json.skipped} ya la tenian)` : "")
        );
      } else {
        toast.success(
          `Quitada de ${json.removed} producto${json.removed === 1 ? "" : "s"}`
        );
      }
      onDone();
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const title =
    mode === "assign" ? "Asignar categoria" : "Quitar categoria";
  const cta = mode === "assign" ? "Asignar" : "Quitar";

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-md pointer-events-auto">
          <div className="flex items-center justify-between px-5 py-4 border-b border-border">
            <div>
              <h3 className="text-sm font-semibold">{title}</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                {selectedIds.length} productos seleccionados
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground p-1 rounded-md hover:bg-muted/40"
              aria-label="Cerrar"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="p-5 space-y-4">
            <div>
              <label className="block text-[11px] text-muted-foreground mb-1 uppercase tracking-wider">
                Categoria
              </label>
              <select
                autoFocus
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                className="w-full text-sm bg-background border border-border rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/60"
              >
                <option value="">-- Elegir categoria --</option>
                {flatTree.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.depth > 0
                      ? "--".repeat(c.depth) + " " + c.name
                      : c.name}
                  </option>
                ))}
              </select>
            </div>

            {mode === "assign" && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={isPrimary}
                  onChange={(e) => setIsPrimary(e.target.checked)}
                  className="accent-primary"
                />
                Marcar como categoria primaria
              </label>
            )}
          </div>

          <div className="px-5 py-3 border-t border-border flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="text-xs text-muted-foreground hover:text-foreground px-3 py-1.5 rounded-md hover:bg-muted/40 disabled:opacity-60"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={submitting || !categoryId}
              className="text-xs bg-primary text-primary-foreground px-4 py-1.5 rounded-md hover:bg-primary/90 disabled:opacity-60 flex items-center gap-1.5"
            >
              {submitting && <Loader2 className="w-3 h-3 animate-spin" />}
              {cta}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
