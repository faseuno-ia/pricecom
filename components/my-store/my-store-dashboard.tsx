"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Globe,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Download,
  FolderTree,
  RefreshCw,
  ExternalLink,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { es } from "date-fns/locale";
import { ConnectWizard } from "./connect-wizard";

interface Props {
  store: {
    id: string;
    name: string;
    platform: "WOOCOMMERCE" | "SHOPIFY" | "TIENDANUBE";
    url: string;
    publicationsCount: number;
    categoriesCount: number;
  };
  integration: {
    status: string | null;
    lastConnectionCheck: string | Date | null;
    lastError: string | null;
    hasCredentials: boolean;
  } | null;
  kpis: {
    active: number;
    draft: number;
    paused: number;
    error: number;
    pendingSync: number;
    unmatched: number;
  };
}

const platformLabel: Record<Props["store"]["platform"], string> = {
  WOOCOMMERCE: "WooCommerce",
  SHOPIFY: "Shopify",
  TIENDANUBE: "Tienda Nube",
};

export function MyStoreDashboard({ store, integration, kpis }: Props) {
  const router = useRouter();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [syncing, setSyncing] = useState<null | "categories" | "products">(null);

  const connected = integration?.status === "CONNECTED";

  async function syncCategories() {
    setSyncing("categories");
    try {
      const res = await fetch("/api/my-store/sync/categories", {
        method: "POST",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      toast.success(
        `Categorías: ${json.total} (${json.imported} nuevas, ${json.updated} actualizadas)`
      );
      router.refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSyncing(null);
    }
  }

  async function syncProducts() {
    setSyncing("products");
    try {
      const res = await fetch("/api/my-store/sync/products", {
        method: "POST",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      toast.success(
        `Productos: ${json.total} (${json.matched} matcheados, ${json.unmatchedCount} sin vincular)`
      );
      router.refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSyncing(null);
    }
  }

  const hostname = (() => {
    try {
      return new URL(store.url).hostname.replace(/^www\./, "");
    } catch {
      return store.url;
    }
  })();

  const kpiCards = [
    {
      label: "Publicados",
      value: kpis.active,
      cls: "bg-accent/10 text-accent border-accent/30",
    },
    {
      label: "Preparados",
      value: kpis.draft,
      cls: "bg-blue-500/10 text-blue-300 border-blue-500/30",
    },
    {
      label: "Pausados",
      value: kpis.paused,
      cls: "bg-amber-500/10 text-amber-300 border-amber-500/30",
    },
    {
      label: "Errores",
      value: kpis.error,
      cls: "bg-red-500/10 text-red-300 border-red-500/30",
    },
    {
      label: "Pend. sync",
      value: kpis.pendingSync,
      cls: "bg-orange-500/10 text-orange-300 border-orange-500/30",
    },
    {
      label: "Sin vincular",
      value: kpis.unmatched,
      cls: "bg-muted/30 text-muted-foreground border-border",
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header de la tienda */}
      <div className="bg-card border border-border rounded-xl p-5 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-4 min-w-0">
          <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
            <Globe className="w-6 h-6 text-primary" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="font-semibold text-base">{store.name}</p>
              <span
                className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${
                  connected
                    ? "bg-accent/10 text-accent border-accent/30"
                    : "bg-red-500/10 text-red-300 border-red-500/30"
                }`}
              >
                {connected ? (
                  <span className="inline-flex items-center gap-1">
                    <CheckCircle2 className="w-2.5 h-2.5" /> Conectado
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1">
                    <AlertCircle className="w-2.5 h-2.5" /> Sin conexión
                  </span>
                )}
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {platformLabel[store.platform]} ·{" "}
              <a
                href={store.url}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-primary inline-flex items-center gap-1"
              >
                {hostname} <ExternalLink className="w-3 h-3" />
              </a>
            </p>
            {integration?.lastConnectionCheck && (
              <p className="text-[10px] text-muted-foreground/70 mt-0.5">
                Última verificación{" "}
                {formatDistanceToNow(
                  new Date(integration.lastConnectionCheck),
                  { locale: es, addSuffix: true }
                )}
                {integration.lastError && (
                  <span className="text-red-400">
                    {" "}
                    · {integration.lastError}
                  </span>
                )}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => setWizardOpen(true)}
            className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-muted/40"
          >
            Editar conexión
          </button>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {kpiCards.map((k) => (
          <div
            key={k.label}
            className="bg-card border border-border rounded-xl p-4"
          >
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {k.label}
            </p>
            <p className={`text-2xl font-semibold mt-1`}>
              {k.value.toLocaleString("es-AR")}
            </p>
            <p
              className={`text-[10px] mt-1 px-1.5 py-0.5 rounded border inline-block ${k.cls}`}
            >
              {k.label}
            </p>
          </div>
        ))}
      </div>

      {/* Acciones */}
      <div className="bg-card border border-border rounded-xl p-5 flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={syncProducts}
          disabled={syncing !== null}
          className="text-sm flex items-center gap-1.5 bg-primary text-primary-foreground px-4 py-2 rounded-md hover:bg-primary/90 disabled:opacity-60"
        >
          {syncing === "products" ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Download className="w-3.5 h-3.5" />
          )}
          Importar productos
        </button>
        <button
          type="button"
          onClick={syncCategories}
          disabled={syncing !== null}
          className="text-sm flex items-center gap-1.5 border border-border px-4 py-2 rounded-md hover:bg-muted/40 disabled:opacity-60"
        >
          {syncing === "categories" ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <FolderTree className="w-3.5 h-3.5" />
          )}
          Importar categorías
        </button>
        <button
          type="button"
          disabled
          title="Próximamente: forzar push de cambios pendientes"
          className="text-sm flex items-center gap-1.5 border border-border px-4 py-2 rounded-md opacity-50 cursor-not-allowed"
        >
          <RefreshCw className="w-3.5 h-3.5" /> Forzar sync
        </button>
        <div className="ml-auto text-xs text-muted-foreground">
          {store.publicationsCount.toLocaleString("es-AR")} publicaciones ·{" "}
          {store.categoriesCount.toLocaleString("es-AR")} categorías
        </div>
      </div>

      {wizardOpen && (
        <ConnectWizard
          onClose={() => setWizardOpen(false)}
          initialName={store.name}
          initialUrl={store.url}
        />
      )}
    </div>
  );
}
