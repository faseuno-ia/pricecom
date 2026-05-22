"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Globe,
  Loader2,
  Download,
  FolderTree,
  RefreshCw,
  ExternalLink,
  Settings,
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
  const [syncing, setSyncing] = useState<
    null | "categories" | "products" | "publications"
  >(null);

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

  async function syncPending() {
    setSyncing("publications");
    try {
      const res = await fetch("/api/my-store/sync/publications", {
        method: "POST",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      const n = json.synced ?? 0;
      toast.success(
        n === 0
          ? "No había cambios pendientes"
          : `${n} publicaciones sincronizadas`
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

  // Estado para el status bar superior
  const statusInfo = (() => {
    switch (integration?.status) {
      case "CONNECTED":
        return {
          dot: "bg-green-400",
          text: `${platformLabel[store.platform]} conectado`,
        };
      case "ERROR":
        return { dot: "bg-red-400", text: "Error de conexión" };
      default:
        return { dot: "bg-amber-400", text: "Sin verificar" };
    }
  })();

  const kpiCards = [
    { label: "Publicados", value: kpis.active, cls: "bg-accent/10 text-accent border-accent/30" },
    { label: "Borradores", value: kpis.draft, cls: "bg-blue-500/10 text-blue-300 border-blue-500/30" },
    { label: "Pausados", value: kpis.paused, cls: "bg-amber-500/10 text-amber-300 border-amber-500/30" },
    { label: "Pendientes sync", value: kpis.pendingSync, cls: "bg-orange-500/10 text-orange-300 border-orange-500/30" },
    { label: "Errores", value: kpis.error, cls: "bg-red-500/10 text-red-300 border-red-500/30" },
    { label: "No vinculados", value: kpis.unmatched, cls: "bg-muted/30 text-muted-foreground border-border" },
  ];

  return (
    <div className="space-y-5">
      {/* Status bar: estado de la conexión + última verificación + error */}
      <div className="flex items-center gap-4 bg-muted/20 border border-border rounded-lg px-4 py-2.5 text-xs flex-wrap">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusInfo.dot}`} />
          <span className="font-medium">{statusInfo.text}</span>
        </div>
        <span className="text-border">·</span>
        <span className="text-muted-foreground">
          <a
            href={store.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 hover:text-foreground"
          >
            {hostname} <ExternalLink className="w-2.5 h-2.5" />
          </a>
        </span>
        {integration?.lastConnectionCheck && (
          <>
            <span className="text-border">·</span>
            <span className="text-muted-foreground">
              Verificado{" "}
              {formatDistanceToNow(new Date(integration.lastConnectionCheck), {
                locale: es,
                addSuffix: true,
              })}
            </span>
          </>
        )}
        {integration?.lastError && (
          <>
            <span className="text-border">·</span>
            <span className="text-red-400 truncate" title={integration.lastError}>
              {integration.lastError.slice(0, 60)}
              {integration.lastError.length > 60 ? "…" : ""}
            </span>
          </>
        )}
        <button
          type="button"
          onClick={() => setWizardOpen(true)}
          className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <Settings className="w-3 h-3" /> Editar conexión
        </button>
      </div>

      {/* Identidad de la tienda — bloque compacto */}
      <div className="bg-card border border-border rounded-xl p-4 flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
          <Globe className="w-5 h-5 text-primary" />
        </div>
        <div className="min-w-0">
          <p className="font-semibold text-sm truncate">{store.name}</p>
          <p className="text-[11px] text-muted-foreground">
            {store.publicationsCount.toLocaleString("es-AR")} publicaciones ·{" "}
            {store.categoriesCount.toLocaleString("es-AR")} categorías
          </p>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {kpiCards.map((k) => (
          <div key={k.label} className="bg-card border border-border rounded-xl p-4">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {k.label}
            </p>
            <p className="text-2xl font-semibold mt-1">
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
          onClick={syncPending}
          disabled={syncing !== null}
          className="text-sm flex items-center gap-1.5 border border-border px-4 py-2 rounded-md hover:bg-muted/40 disabled:opacity-60"
          title="Empuja a la tienda los cambios pendientes (precio, stock, estado)"
        >
          {syncing === "publications" ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RefreshCw className="w-3.5 h-3.5" />
          )}
          Sincronizar pendientes
          {kpis.pendingSync > 0 && (
            <span className="ml-1 text-[10px] font-mono bg-orange-500/15 text-orange-300 px-1.5 py-0.5 rounded">
              {kpis.pendingSync}
            </span>
          )}
        </button>
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
