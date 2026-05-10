"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Play, Loader2, CheckCircle, XCircle, ExternalLink, Download } from "lucide-react";

interface Provider {
  id: string;
  name: string;
  baseUrl: string;
}

interface Props {
  providers: Provider[];
}

interface JobStatus {
  status: string;
  progress: number;
  totalProducts: number;
  errorMessage: string | null;
  excelFilePath: string | null;
  excelFileUrl: string | null;
  logs: { level: string; message: string; createdAt: string }[];
}

export function NewExtractionForm({ providers }: Props) {
  const router = useRouter();
  const [providerId, setProviderId] = useState("");
  const [startUrl, setStartUrl] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);

  const selectedProvider = providers.find((p) => p.id === providerId);

  async function handleStart(e: React.FormEvent) {
    e.preventDefault();
    if (!providerId) return toast.error("Seleccioná un proveedor");
    setLoading(true);

    try {
      const res = await fetch("/api/extractions/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId, startUrl: startUrl || null }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Error al iniciar extracción");
      }
      const data = await res.json();
      setJobId(data.jobId);
      toast.success("Extracción iniciada — el worker la procesará en segundos");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // Polling
  useEffect(() => {
    if (!jobId) return;
    const interval = setInterval(async () => {
      const res = await fetch(`/api/extractions/${jobId}/status`);
      if (!res.ok) return;
      const data: JobStatus = await res.json();
      setJobStatus(data);
      if (data.status === "COMPLETED" || data.status === "FAILED") {
        clearInterval(interval);
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [jobId]);

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [jobStatus?.logs]);

  const levelColor: Record<string, string> = {
    INFO: "text-blue-700",
    WARN: "text-amber-600",
    ERROR: "text-red-600",
    DEBUG: "text-muted-foreground",
  };

  const inputCls = "w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 bg-background";

  return (
    <div className="space-y-5">
      {/* Form */}
      {!jobId && (
        <form onSubmit={handleStart} className="bg-card border rounded-xl p-6 space-y-5 max-w-xl">
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5 uppercase tracking-wide">
              Proveedor *
            </label>
            {providers.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No hay proveedores activos.{" "}
                <a href="/providers/new" className="text-primary hover:underline">Crear uno</a>
              </p>
            ) : (
              <select
                className={inputCls}
                value={providerId}
                onChange={(e) => {
                  setProviderId(e.target.value);
                  setStartUrl("");
                }}
                required
              >
                <option value="">Seleccioná un proveedor...</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            )}
          </div>

          {selectedProvider && (
            <div className="p-3 bg-muted/50 rounded-lg text-xs text-muted-foreground flex items-center gap-2">
              <ExternalLink className="w-3.5 h-3.5 flex-shrink-0" />
              URL base: <span className="font-mono text-foreground">{selectedProvider.baseUrl}</span>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5 uppercase tracking-wide">
              URL inicial (opcional)
            </label>
            <input
              className={inputCls}
              type="url"
              value={startUrl}
              onChange={(e) => setStartUrl(e.target.value)}
              placeholder={selectedProvider?.baseUrl ?? "https://..."}
            />
            <p className="text-xs text-muted-foreground mt-1">
              Si está vacío, se usa la URL base del proveedor
            </p>
          </div>

          <button
            type="submit"
            disabled={loading || providers.length === 0}
            className="flex items-center gap-2 bg-primary text-white px-5 py-2.5 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-60"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            {loading ? "Iniciando..." : "Iniciar extracción"}
          </button>
        </form>
      )}

      {/* Status + logs */}
      {jobId && jobStatus && (
        <div className="bg-card border rounded-xl overflow-hidden">
          {/* Header */}
          <div className="px-6 py-4 border-b flex items-center justify-between">
            <div className="flex items-center gap-3">
              {jobStatus.status === "RUNNING" || jobStatus.status === "PENDING" ? (
                <Loader2 className="w-5 h-5 animate-spin text-blue-600" />
              ) : jobStatus.status === "COMPLETED" ? (
                <CheckCircle className="w-5 h-5 text-emerald-600" />
              ) : (
                <XCircle className="w-5 h-5 text-red-500" />
              )}
              <div>
                <p className="font-semibold text-sm">
                  {jobStatus.status === "PENDING" && "Esperando al worker..."}
                  {jobStatus.status === "RUNNING" && "Extrayendo productos..."}
                  {jobStatus.status === "COMPLETED" && "Extracción completada"}
                  {jobStatus.status === "FAILED" && "Extracción fallida"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {jobStatus.totalProducts} productos encontrados
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              {jobStatus.excelFileUrl && (
                <a
                  href={jobStatus.excelFileUrl}
                  download
                  className="flex items-center gap-1.5 bg-emerald-600 text-white text-xs px-3 py-1.5 rounded-lg hover:bg-emerald-700 transition-colors"
                >
                  <Download className="w-3.5 h-3.5" />
                  Descargar Excel
                </a>
              )}
              {(jobStatus.status === "COMPLETED" || jobStatus.status === "FAILED") && (
                <button
                  onClick={() => router.push(`/extractions/${jobId}`)}
                  className="text-xs text-primary border border-primary/30 px-3 py-1.5 rounded-lg hover:bg-primary hover:text-white transition-colors"
                >
                  Ver detalle
                </button>
              )}
            </div>
          </div>

          {/* Progress bar */}
          {(jobStatus.status === "RUNNING" || jobStatus.status === "PENDING") && (
            <div className="px-6 py-2 border-b bg-muted/30">
              <div className="flex items-center justify-between text-xs text-muted-foreground mb-1.5">
                <span>Progreso</span>
                <span className="font-mono">{jobStatus.progress}%</span>
              </div>
              <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 rounded-full transition-all duration-500"
                  style={{ width: `${jobStatus.status === "PENDING" ? 2 : jobStatus.progress}%` }}
                />
              </div>
            </div>
          )}

          {/* Logs */}
          <div className="h-72 overflow-y-auto p-4 bg-[hsl(214,30%,97%)] font-mono text-xs space-y-0.5">
            {jobStatus.logs.map((log, i) => (
              <div key={i} className="flex gap-2">
                <span className="text-muted-foreground/50 select-none">
                  {new Date(log.createdAt).toLocaleTimeString("es-AR")}
                </span>
                <span className={`font-medium w-10 flex-shrink-0 ${levelColor[log.level] ?? ""}`}>
                  [{log.level}]
                </span>
                <span className="text-foreground/80">{log.message}</span>
              </div>
            ))}
            {(jobStatus.status === "PENDING" || jobStatus.status === "RUNNING") && (
              <div className="flex gap-2 text-muted-foreground animate-pulse">
                <span>—</span>
                <span>Procesando...</span>
              </div>
            )}
            <div ref={logsEndRef} />
          </div>
        </div>
      )}
    </div>
  );
}
