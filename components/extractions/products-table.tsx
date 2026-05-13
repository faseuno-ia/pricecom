"use client";

import { useState, useMemo } from "react";
import { toast } from "sonner";
import { formatPrice } from "@/lib/utils";
import { ExternalLink, Search, Download, Loader2, ImageOff, CheckSquare, Square } from "lucide-react";
import type { ExtractedProduct } from "@prisma/client";

type Filter = "all" | "withPrice" | "withoutPrice" | "withoutSku";

const filters: { value: Filter; label: string }[] = [
  { value: "all", label: "Todos" },
  { value: "withPrice", label: "Con precio" },
  { value: "withoutPrice", label: "Sin precio" },
  { value: "withoutSku", label: "Sin SKU" },
];

const BATCH_SIZE = 100;

export function ProductsTable({ products }: { products: ExtractedProduct[] }) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [downloading, setDownloading] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number } | null>(null);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return products.filter((p) => {
      if (filter === "withPrice" && !p.wholesalePrice) return false;
      if (filter === "withoutPrice" && p.wholesalePrice) return false;
      if (filter === "withoutSku" && p.sku) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        (p.sku ?? "").toLowerCase().includes(q)
      );
    });
  }, [products, search, filter]);

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((p) => selectedIds.has(p.id));

  function toggleOne(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllFiltered() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        for (const p of filtered) next.delete(p.id);
      } else {
        for (const p of filtered) next.add(p.id);
      }
      return next;
    });
  }

  function selectAllInExtraction() {
    setSelectedIds(new Set(products.map((p) => p.id)));
  }

  function deselectAll() {
    setSelectedIds(new Set());
  }

  function triggerBlobDownload(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function downloadSingleBatch(ids: string[]) {
    const res = await fetch("/api/products/download-images", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productIds: ids }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error ?? `Error HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const filename =
      res.headers.get("content-disposition")?.match(/filename="?([^";]+)"?/)?.[1] ??
      `imagenes-${new Date().toISOString().slice(0, 10)}.zip`;
    triggerBlobDownload(blob, filename);
    toast.success(`ZIP descargado (${ids.length} imágenes)`);
  }

  async function downloadInBatches(ids: string[]) {
    // Import dinámico: solo paga el costo de jszip cuando hay >100 ids.
    const JSZip = (await import("jszip")).default;

    const batches: string[][] = [];
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      batches.push(ids.slice(i, i + BATCH_SIZE));
    }

    const mergedZip = new JSZip();
    let failedBatches = 0;
    let totalFilesAdded = 0;

    for (let bi = 0; bi < batches.length; bi++) {
      const batch = batches[bi];
      setBatchProgress({ current: bi + 1, total: batches.length });
      try {
        const res = await fetch("/api/products/download-images", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ productIds: batch }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error ?? `HTTP ${res.status}`);
        }
        const buf = await res.arrayBuffer();
        const batchZip = await JSZip.loadAsync(buf);
        for (const [filename, file] of Object.entries(batchZip.files)) {
          if (file.dir) continue;
          const content = await file.async("arraybuffer");
          const finalName = mergedZip.files[filename]
            ? filename.replace(/(\.[^.]+)$/, `-lote${bi + 1}$1`)
            : filename;
          mergedZip.file(finalName, content);
          totalFilesAdded++;
        }
      } catch (err) {
        failedBatches++;
        toast.error(`Lote ${bi + 1} de ${batches.length} falló: ${(err as Error).message}`);
      }
    }

    if (totalFilesAdded === 0) {
      throw new Error("Ningún lote pudo descargarse");
    }

    const zipBlob = await mergedZip.generateAsync({ type: "blob" });
    triggerBlobDownload(zipBlob, `imagenes-descarga-${new Date().toISOString().slice(0, 10)}.zip`);

    if (failedBatches > 0) {
      toast.warning(`ZIP descargado con ${totalFilesAdded} archivos (${failedBatches} lote${failedBatches > 1 ? "s" : ""} falló)`);
    } else {
      toast.success(`ZIP descargado (${totalFilesAdded} archivos en ${batches.length} lotes)`);
    }
  }

  async function handleDownload() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;

    setDownloading(true);
    setBatchProgress(null);
    try {
      if (ids.length <= BATCH_SIZE) {
        await downloadSingleBatch(ids);
      } else {
        await downloadInBatches(ids);
      }
    } catch (err) {
      toast.error((err as Error).message || "Error descargando imágenes");
    } finally {
      setDownloading(false);
      setBatchProgress(null);
    }
  }

  const downloadLabel = downloading
    ? batchProgress
      ? `Descargando lote ${batchProgress.current} de ${batchProgress.total}…`
      : "Descargando…"
    : `Descargar imágenes (${selectedIds.size})`;

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="px-5 py-3 border-b border-border flex flex-col md:flex-row md:items-center justify-between gap-3">
        <h2 className="font-semibold text-sm">
          Productos ({filtered.length}
          {filtered.length !== products.length ? ` de ${products.length}` : ""})
        </h2>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por nombre o SKU…"
              className="text-xs bg-background border border-border rounded-md pl-8 pr-3 py-1.5 w-64 focus:outline-none focus:ring-1 focus:ring-primary/60"
            />
          </div>
          <div className="flex bg-muted/30 rounded-md p-0.5 gap-0.5">
            {filters.map((f) => (
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
        </div>
      </div>

      <div className="px-5 py-2.5 border-b border-border bg-muted/10 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={selectAllInExtraction}
            disabled={downloading}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground border border-border bg-background hover:bg-muted/40 px-2.5 py-1 rounded-md transition-colors disabled:opacity-50"
            title="Seleccionar todos los productos de la extracción"
          >
            <CheckSquare className="w-3.5 h-3.5" />
            Seleccionar todos ({products.length})
          </button>
          <button
            type="button"
            onClick={deselectAll}
            disabled={downloading || selectedIds.size === 0}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground border border-border bg-background hover:bg-muted/40 px-2.5 py-1 rounded-md transition-colors disabled:opacity-50"
            title="Limpiar selección"
          >
            <Square className="w-3.5 h-3.5" />
            Deseleccionar todos
          </button>
          {selectedIds.size > 0 && (
            <span className="text-xs text-muted-foreground">
              {selectedIds.size} seleccionado{selectedIds.size === 1 ? "" : "s"}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={handleDownload}
          disabled={selectedIds.size === 0 || downloading}
          className="flex items-center gap-1.5 text-xs bg-accent text-white px-3 py-1.5 rounded-md hover:bg-accent/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed font-medium"
        >
          {downloading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Download className="w-3.5 h-3.5" />
          )}
          {downloadLabel}
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border bg-muted/20">
              <th className="px-3 py-2.5 w-8">
                <input
                  type="checkbox"
                  checked={allFilteredSelected}
                  onChange={toggleAllFiltered}
                  aria-label="Seleccionar todos visibles"
                  className="cursor-pointer accent-primary"
                />
              </th>
              {["Imagen", "SKU", "Nombre", "Precio", "Precio ant.", "Stock", "Categoría", "URL"].map((h) => (
                <th
                  key={h}
                  className="text-left px-4 py-2.5 font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((p, i) => (
              <tr
                key={p.id}
                className={
                  i % 2 === 1
                    ? "bg-[hsl(var(--surface-row))] hover:bg-muted/30"
                    : "hover:bg-muted/20"
                }
              >
                <td className="px-3 py-2 w-8">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(p.id)}
                    onChange={() => toggleOne(p.id)}
                    aria-label={`Seleccionar ${p.name}`}
                    className="cursor-pointer accent-primary"
                  />
                </td>
                <td className="px-4 py-2">
                  {p.imageUrl ? (
                    <a
                      href={p.imageUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block w-10 h-10 rounded overflow-hidden bg-muted/30 border border-border hover:border-primary/50 transition-colors"
                      title="Ver imagen original"
                    >
                      <img
                        src={p.imageUrl}
                        alt=""
                        loading="lazy"
                        className="w-full h-full object-cover"
                        onError={(e) => {
                          (e.currentTarget as HTMLImageElement).style.display = "none";
                        }}
                      />
                    </a>
                  ) : (
                    <div className="w-10 h-10 rounded bg-muted/30 border border-border flex items-center justify-center text-muted-foreground/50">
                      <ImageOff className="w-4 h-4" />
                    </div>
                  )}
                </td>
                <td className="px-4 py-2.5 font-mono text-muted-foreground">
                  {p.sku ?? "—"}
                </td>
                <td className="px-4 py-2.5 max-w-xs truncate font-medium">
                  {p.name}
                </td>
                <td className="px-4 py-2.5 font-mono text-accent">
                  {p.wholesalePrice ? formatPrice(Number(p.wholesalePrice)) : "—"}
                </td>
                <td className="px-4 py-2.5 font-mono text-muted-foreground line-through">
                  {p.oldPrice ? formatPrice(Number(p.oldPrice)) : ""}
                </td>
                <td className="px-4 py-2.5">{p.stock ?? "—"}</td>
                <td className="px-4 py-2.5 text-muted-foreground">
                  {p.category ?? "—"}
                </td>
                <td className="px-4 py-2.5">
                  {p.productUrl && (
                    <a
                      href={p.productUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline flex items-center gap-1"
                    >
                      Ver <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-muted-foreground">
                  Sin resultados
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
