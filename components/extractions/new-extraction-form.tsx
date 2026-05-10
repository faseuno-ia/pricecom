"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Play,
  Loader2,
  CheckCircle,
  XCircle,
  ExternalLink,
  Download,
  Store,
} from "lucide-react";
import { ProgressBar } from "@/components/ui/progress-bar";

interface Provider {
  id: string;
  name: string;
  baseUrl: string;
}

interface Props {
  providers: Provider[];
  initialProviderId?: string;
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

const levelColor: Record<string, string> = {
  INFO: "text-muted-foreground",
  WARN: "text-amber-400",
  ERROR: "text-red-400",
  DEBUG: "text-muted-foreground/40",
};

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function NewExtractionForm({ providers, initialProviderId }: Props) {
  const router = useRouter();
  const [providerId, setProviderId] = useState(initialProviderId ?? "");
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

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [jobStatus?.logs]);

  return (
    <div className="space-y-6">
      {!jobId && (
        <form onSubmit={handleStart} className="space-y-6">
          {/* Provider cards */}
          <div>
            <label className="block text-[11px] font-medium text-muted-foreground mb-3 uppercase tracking-wider">
              Proveedor
            </label>
            {providers.length === 0 ? (
              <div className="bg-card border border-border rounded-xl p-6 text-center">
                <p className="text-sm text-muted-foreground">
                  No hay proveedores activos.{" "}
                  <a
                    href="/providers/new"
                    className="text-primary hover:underline"
                  >
                    Crear uno
                  </a>
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {providers.map((p) => {
                  const active = providerId === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => {
                        setProviderId(p.id);
                        setStartUrl("");
                      }}
                      className={`text-left bg-card border rounded-xl p-4 flex items-center gap-3 transition-all ${
                        active
                          ? "border-primary ring-2 ring-primary/30 bg-primary/5"
                          : "border-border hover:border-primary/40"
                      }`}
                    >
                      <div
                        className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${
                          active
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted/50 text-muted-foreground"
                        }`}
                      >
                        <Store className="w-5 h-5" />
                      </div>
                      <div className="min-w-0">
                        <p className="font-semibold text-sm truncate">{p.name}</p>
                        <p className="text-xs text-muted-foreground truncate">
                          {hostnameOf(p.baseUrl)}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {selectedProvider && (
            <>
              <div className="bg-muted/20 border border-border rounded-lg px-3 py-2 text-xs flex items-center gap-2">
                <ExternalLink className="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground" />
                <span className="text-muted-foreground">URL base:</span>
                <span className="font-mono text-foreground truncate">
                  {selectedProvider.baseUrl}
                </span>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-muted-foreground mb-1.5 uppercase tracking-wider">
                  URL inicial (opcional)
                </label>
                <input
                  className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                  type="url"
                  value={startUrl}
                  onChange={(e) => setStartUrl(e.target.value)}
                  placeholder={selectedProvider.baseUrl}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Si está vacío, se usa la URL base del proveedor
                </p>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="flex items-center gap-2 bg-primary text-primary-foreground px-6 py-2.5 rounded-lg text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-60 shadow-lg shadow-primary/20"
              >
                {loading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Play className="w-4 h-4" />
                )}
                {loading ? "Iniciando..." : "Iniciar extracción"}
              </button>
            </>
          )}
        </form>
      )}

      {jobId && jobStatus && (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-border flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              {jobStatus.status === "RUNNING" || jobStatus.status === "PENDING" ? (
                <Loader2 className="w-5 h-5 animate-spin text-primary" />
              ) : jobStatus.status === "COMPLETED" ? (
                <CheckCircle className="w-5 h-5 text-accent" />
              ) : (
                <XCircle className="w-5 h-5 text-red-400" />
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
                  className="flex items-center gap-1.5 bg-accent text-white text-xs px-3 py-1.5 rounded-lg hover:bg-accent/90 transition-colors font-medium"
                >
                  <Download className="w-3.5 h-3.5" /> Descargar Excel
                </a>
              )}
              {(jobStatus.status === "COMPLETED" ||
                jobStatus.status === "FAILED") && (
                <button
                  onClick={() => router.push(`/extractions/${jobId}`)}
                  className="text-xs text-primary border border-primary/30 px-3 py-1.5 rounded-lg hover:bg-primary hover:text-primary-foreground transition-colors"
                >
                  Ver detalle
                </button>
              )}
            </div>
          </div>

          {(jobStatus.status === "RUNNING" ||
            jobStatus.status === "PENDING") && (
            <div className="px-6 py-3 border-b border-border bg-muted/20">
              <ProgressBar
                value={jobStatus.status === "PENDING" ? 2 : jobStatus.progress}
                label={
                  jobStatus.status === "PENDING"
                    ? "Esperando al worker"
                    : "Progreso"
                }
              />
            </div>
          )}

          <div className="h-72 overflow-y-auto p-4 bg-[hsl(var(--surface-row))] font-mono text-xs space-y-0.5">
            {jobStatus.logs.map((log, i) => (
              <div key={i} className="flex gap-2">
                <span className="text-muted-foreground/40 select-none">
                  {new Date(log.createdAt).toLocaleTimeString("es-AR")}
                </span>
                <span
                  className={`font-medium w-12 flex-shrink-0 ${levelColor[log.level] ?? ""}`}
                >
                  [{log.level}]
                </span>
                <span className="text-foreground/90">{log.message}</span>
              </div>
            ))}
            {(jobStatus.status === "PENDING" ||
              jobStatus.status === "RUNNING") && (
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
