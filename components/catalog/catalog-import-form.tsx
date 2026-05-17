"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Loader2, Upload, FileSpreadsheet, BookOpen } from "lucide-react";

type ProviderType = "SCRAPER" | "MANUAL" | "IMPORTED";

interface ProviderOpt {
  id: string;
  name: string;
  providerType: ProviderType;
}

interface Props {
  providers: ProviderOpt[];
  initialProviderId: string | null;
}

interface ImportReport {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  categoriesCreated: number;
  imagesAdded: number;
  errors: { row: number; sku?: string; message: string }[];
  importBatchId: string;
}

export function CatalogImportForm({ providers, initialProviderId }: Props) {
  const router = useRouter();
  const [providerId, setProviderId] = useState(
    initialProviderId && providers.some((p) => p.id === initialProviderId)
      ? initialProviderId
      : providers[0]?.id ?? ""
  );
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!providerId) {
      toast.error("Seleccioná un proveedor");
      return;
    }
    if (!file) {
      toast.error("Subí un archivo");
      return;
    }
    setSubmitting(true);
    setReport(null);
    try {
      const fd = new FormData();
      fd.set("providerId", providerId);
      fd.set("file", file);
      const res = await fetch("/api/catalog/import", {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const r = (await res.json()) as ImportReport;
      setReport(r);
      toast.success(
        `Importación lista: ${r.created} nuevos, ${r.updated} actualizados`
      );
      router.refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const labelCls =
    "block text-[11px] font-medium text-muted-foreground mb-1 uppercase tracking-wider";

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div>
        <label className={labelCls}>Proveedor *</label>
        <select
          className="w-full border border-border rounded-md px-3 py-1.5 text-sm bg-background"
          value={providerId}
          onChange={(e) => setProviderId(e.target.value)}
          required
        >
          {providers.length === 0 && (
            <option value="">— sin proveedores activos —</option>
          )}
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.providerType.toLowerCase()})
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className={labelCls}>Archivo Excel o CSV *</label>
        <div className="relative border-2 border-dashed border-border rounded-lg px-4 py-6 text-center hover:border-primary/40 transition-colors">
          <input
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="absolute inset-0 opacity-0 cursor-pointer"
          />
          <FileSpreadsheet className="w-6 h-6 mx-auto text-muted-foreground/50 mb-2" />
          {file ? (
            <p className="text-sm font-medium">{file.name}</p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Click para elegir archivo (.xlsx / .csv)
            </p>
          )}
          {file && (
            <p className="text-[11px] text-muted-foreground mt-1">
              {(file.size / 1024).toFixed(1)} KB
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center justify-end gap-3 pt-2 border-t border-border">
        <button
          type="button"
          onClick={() => router.back()}
          className="text-sm px-4 py-2 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted/40"
          disabled={submitting}
        >
          Cancelar
        </button>
        <button
          type="submit"
          disabled={submitting || !file || !providerId}
          className="text-sm px-5 py-2 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60 flex items-center gap-1.5"
        >
          {submitting ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Upload className="w-3.5 h-3.5" />
          )}
          Importar
        </button>
      </div>

      {report && (
        <div className="mt-4 bg-muted/20 border border-border rounded-xl p-4 text-xs space-y-2">
          <p className="text-sm font-medium text-foreground">
            Resumen de importación
          </p>
          <div className="grid grid-cols-2 gap-2">
            <div>
              Total: <span className="font-mono">{report.total}</span>
            </div>
            <div>
              Creados:{" "}
              <span className="font-mono text-green-400">{report.created}</span>
            </div>
            <div>
              Actualizados:{" "}
              <span className="font-mono text-blue-400">{report.updated}</span>
            </div>
            <div>
              Saltados:{" "}
              <span className="font-mono text-muted-foreground">
                {report.skipped}
              </span>
            </div>
            <div>
              Categorías creadas:{" "}
              <span className="font-mono">{report.categoriesCreated}</span>
            </div>
            <div>
              Imágenes agregadas:{" "}
              <span className="font-mono">{report.imagesAdded}</span>
            </div>
          </div>
          <div className="text-[10px] text-muted-foreground/70 font-mono pt-1 border-t border-border">
            batch: {report.importBatchId}
          </div>
          {(report.created > 0 || report.updated > 0) && (
            <Link
              href={`/catalog?providerId=${providerId}&sourceType=IMPORTED`}
              className="inline-flex items-center gap-2 bg-accent text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-accent/90 transition-colors mt-2"
            >
              <BookOpen className="w-4 h-4" />
              Ver productos importados
            </Link>
          )}
          {report.errors.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-red-400">
                {report.errors.length} errores
              </summary>
              <ul className="mt-2 space-y-0.5 max-h-40 overflow-y-auto">
                {report.errors.slice(0, 50).map((e, i) => (
                  <li key={i} className="text-[11px]">
                    Fila {e.row}
                    {e.sku ? ` (SKU ${e.sku})` : ""}: {e.message}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </form>
  );
}
