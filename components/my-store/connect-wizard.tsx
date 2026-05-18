"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Loader2,
  CheckCircle2,
  XCircle,
  ArrowRight,
  ArrowLeft,
  X,
} from "lucide-react";

type Platform = "WOOCOMMERCE" | "SHOPIFY" | "TIENDANUBE";

interface Props {
  onClose: () => void;
  initialName?: string;
  initialUrl?: string;
}

export function ConnectWizard({ onClose, initialName, initialUrl }: Props) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [name, setName] = useState(initialName ?? "Mi tienda");
  const [storeUrl, setStoreUrl] = useState(initialUrl ?? "");
  const [consumerKey, setConsumerKey] = useState("");
  const [consumerSecret, setConsumerSecret] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    error?: string;
  } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [importCategories, setImportCategories] = useState(true);
  const [importProducts, setImportProducts] = useState(true);
  const [platform] = useState<Platform>("WOOCOMMERCE");

  function validateUrl(u: string): boolean {
    try {
      const parsed = new URL(u);
      return parsed.protocol === "https:" || parsed.protocol === "http:";
    } catch {
      return false;
    }
  }

  async function testAndSave() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/my-store/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          storeUrl,
          platform,
          consumerKey,
          consumerSecret,
        }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setTestResult({ ok: false, error: json.error ?? `HTTP ${res.status}` });
      } else {
        setTestResult({ ok: true });
      }
    } catch (err) {
      setTestResult({
        ok: false,
        error: err instanceof Error ? err.message : "Error de red",
      });
    } finally {
      setTesting(false);
    }
  }

  async function startSync() {
    setSyncing(true);
    try {
      if (importCategories) {
        const res = await fetch("/api/my-store/sync/categories", {
          method: "POST",
        });
        if (!res.ok) {
          const e = await res.json().catch(() => ({}));
          throw new Error(`Categorías: ${e.error ?? res.status}`);
        }
        const r = (await res.json()) as {
          imported: number;
          updated: number;
          total: number;
        };
        toast.success(
          `Categorías: ${r.total} (${r.imported} nuevas, ${r.updated} actualizadas)`
        );
      }
      if (importProducts) {
        const res = await fetch("/api/my-store/sync/products", {
          method: "POST",
        });
        if (!res.ok) {
          const e = await res.json().catch(() => ({}));
          throw new Error(`Productos: ${e.error ?? res.status}`);
        }
        const r = (await res.json()) as {
          matched: number;
          created: number;
          updated: number;
          unmatchedCount: number;
          total: number;
        };
        toast.success(
          `Productos: ${r.total} (${r.matched} matcheados, ${r.unmatchedCount} sin vincular)`
        );
      }
      onClose();
      router.refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  const labelCls =
    "block text-[11px] font-medium text-muted-foreground mb-1 uppercase tracking-wider";
  const inputCls =
    "w-full border border-border rounded-md px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/40";

  return (
    <>
      <div
        className="fixed inset-0 bg-black/50 z-40"
        onClick={onClose}
        aria-hidden
      />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-lg pointer-events-auto">
          <div className="flex items-center justify-between px-5 py-4 border-b border-border">
            <h2 className="text-sm font-semibold">Conectar tienda — Paso {step} de 4</h2>
            <button
              type="button"
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-muted/40"
              aria-label="Cerrar"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="p-6 space-y-5">
            {/* Paso 1: URL */}
            {step === 1 && (
              <>
                <p className="text-xs text-muted-foreground">
                  Plataforma:{" "}
                  <span className="font-mono text-foreground">WooCommerce</span>{" "}
                  (Shopify y Tienda Nube próximamente)
                </p>
                <div>
                  <label className={labelCls}>Nombre interno</label>
                  <input
                    className={inputCls}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Mi tienda"
                  />
                </div>
                <div>
                  <label className={labelCls}>URL de la tienda *</label>
                  <input
                    className={inputCls}
                    type="url"
                    value={storeUrl}
                    onChange={(e) => setStoreUrl(e.target.value)}
                    placeholder="https://mitienda.com"
                    required
                  />
                  {storeUrl && !validateUrl(storeUrl) && (
                    <p className="text-[11px] text-red-400 mt-1">
                      URL inválida — debe incluir http:// o https://
                    </p>
                  )}
                </div>
              </>
            )}

            {/* Paso 2: Credenciales */}
            {step === 2 && (
              <>
                <div className="bg-amber-500/10 border border-amber-500/30 rounded-md p-3 text-xs text-amber-200">
                  Generá las credenciales en WooCommerce →{" "}
                  <span className="font-mono">
                    Ajustes › Avanzado › REST API
                  </span>
                  . Necesitamos permisos de lectura como mínimo (escritura para
                  publicar/actualizar productos).
                </div>
                <div>
                  <label className={labelCls}>Consumer Key *</label>
                  <input
                    className={inputCls}
                    type="password"
                    value={consumerKey}
                    onChange={(e) => setConsumerKey(e.target.value)}
                    placeholder="ck_…"
                  />
                </div>
                <div>
                  <label className={labelCls}>Consumer Secret *</label>
                  <input
                    className={inputCls}
                    type="password"
                    value={consumerSecret}
                    onChange={(e) => setConsumerSecret(e.target.value)}
                    placeholder="cs_…"
                  />
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Las credenciales se guardan cifradas con AES-256.
                </p>
              </>
            )}

            {/* Paso 3: Test */}
            {step === 3 && (
              <>
                <p className="text-xs text-muted-foreground">
                  Vamos a probar las credenciales contra{" "}
                  <span className="font-mono text-foreground">{storeUrl}</span>{" "}
                  llamando a <span className="font-mono">/wp-json/wc/v3</span>.
                </p>
                <div className="flex items-center justify-center py-4">
                  <button
                    type="button"
                    onClick={testAndSave}
                    disabled={testing}
                    className="bg-primary text-primary-foreground px-5 py-2 rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-60 flex items-center gap-2"
                  >
                    {testing && <Loader2 className="w-4 h-4 animate-spin" />}
                    {testResult?.ok ? "Volver a probar" : "Probar conexión"}
                  </button>
                </div>
                {testResult && (
                  <div
                    className={`rounded-md p-3 text-sm flex items-start gap-2 ${
                      testResult.ok
                        ? "bg-accent/10 border border-accent/30 text-accent"
                        : "bg-red-500/10 border border-red-500/30 text-red-300"
                    }`}
                  >
                    {testResult.ok ? (
                      <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />
                    ) : (
                      <XCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                    )}
                    <div>
                      <p className="font-medium">
                        {testResult.ok
                          ? "Conexión exitosa, credenciales guardadas"
                          : "No pudimos conectar"}
                      </p>
                      {!testResult.ok && testResult.error && (
                        <p className="text-xs mt-1 opacity-80">
                          {testResult.error}
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}

            {/* Paso 4: Sync */}
            {step === 4 && (
              <>
                <p className="text-xs text-muted-foreground">
                  ¿Qué querés importar ahora? Podés volver a correrlo después
                  desde el dashboard.
                </p>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={importCategories}
                    onChange={(e) => setImportCategories(e.target.checked)}
                    className="accent-primary"
                  />
                  Categorías de la tienda
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={importProducts}
                    onChange={(e) => setImportProducts(e.target.checked)}
                    className="accent-primary"
                  />
                  Productos publicados (matchea por SKU contra tu catálogo)
                </label>
              </>
            )}
          </div>

          <div className="px-5 py-4 border-t border-border flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setStep((s) => Math.max(1, s - 1))}
              disabled={step === 1 || testing || syncing}
              className="text-xs text-muted-foreground hover:text-foreground px-3 py-1.5 rounded-md hover:bg-muted/40 disabled:opacity-40 flex items-center gap-1"
            >
              <ArrowLeft className="w-3 h-3" /> Volver
            </button>

            {step < 3 && (
              <button
                type="button"
                onClick={() => setStep((s) => s + 1)}
                disabled={
                  (step === 1 && (!storeUrl || !validateUrl(storeUrl))) ||
                  (step === 2 && (!consumerKey || !consumerSecret))
                }
                className="bg-primary text-primary-foreground px-4 py-1.5 rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-60 flex items-center gap-1"
              >
                Siguiente <ArrowRight className="w-3 h-3" />
              </button>
            )}

            {step === 3 && (
              <button
                type="button"
                onClick={() => setStep(4)}
                disabled={!testResult?.ok}
                className="bg-primary text-primary-foreground px-4 py-1.5 rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-60 flex items-center gap-1"
              >
                Continuar <ArrowRight className="w-3 h-3" />
              </button>
            )}

            {step === 4 && (
              <button
                type="button"
                onClick={startSync}
                disabled={syncing || (!importCategories && !importProducts)}
                className="bg-primary text-primary-foreground px-5 py-1.5 rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-60 flex items-center gap-2"
              >
                {syncing && <Loader2 className="w-4 h-4 animate-spin" />}
                {syncing ? "Sincronizando…" : "Iniciar sincronización"}
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
