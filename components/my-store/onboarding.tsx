"use client";

import { useState } from "react";
import {
  Store,
  CheckCircle2,
  Lock,
  ArrowRight,
  ChevronRight,
} from "lucide-react";
import { ConnectWizard } from "./connect-wizard";

const SYNC_TARGETS = [
  "Productos publicados",
  "Categorías y subcategorías",
  "Precios",
  "Stock",
  "Publicaciones existentes",
];

const AFTER_CONNECT = [
  "Vincular productos existentes con tu catálogo PricEcom",
  "Detectar diferencias de precio y stock",
  "Pausar o activar publicaciones",
  "Sincronizar cambios pendientes",
  "Resolver productos no vinculados",
  "Mantener categorías y subcategorías ordenadas",
];

const FLOW_STEPS = [
  "WooCommerce",
  "Importar catálogo",
  "Vincular productos",
  "Revisar diferencias",
  "Sincronizar",
];

export function Onboarding() {
  const [wizardOpen, setWizardOpen] = useState(false);

  return (
    <>
      {/* Status bar — estado actual sin tienda */}
      <div className="flex items-center gap-3 text-xs text-muted-foreground bg-muted/20 border border-border rounded-lg px-4 py-2 mb-6 flex-wrap">
        <span className="w-2 h-2 rounded-full bg-muted-foreground/40 flex-shrink-0" />
        <span>WooCommerce: No conectado</span>
        <span className="text-border">·</span>
        <span>Última sync: —</span>
        <span className="text-border">·</span>
        <span>Productos importados: —</span>
      </div>

      <div className="max-w-lg mx-auto">
        {/* Card principal de conexión */}
        <div className="bg-card border border-border rounded-2xl p-8 space-y-6">
          <div className="w-14 h-14 rounded-2xl bg-primary/15 flex items-center justify-center mx-auto">
            <Store className="w-7 h-7 text-primary" />
          </div>

          <div className="text-center space-y-2">
            <h2 className="text-xl font-semibold">
              Conectá tu tienda WooCommerce
            </h2>
            <p className="text-sm text-muted-foreground">
              Importá tus productos, categorías, precios, stock y publicaciones
              existentes para administrarlos desde PricEcom sin duplicar
              productos.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2">
            {SYNC_TARGETS.map((item) => (
              <div key={item} className="flex items-center gap-2 text-sm">
                <CheckCircle2 className="w-4 h-4 text-green-400 flex-shrink-0" />
                <span>{item}</span>
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setWizardOpen(true)}
            className="w-full bg-primary text-primary-foreground py-2.5 rounded-lg font-medium hover:bg-primary/90 transition-colors"
          >
            Conectar tienda WooCommerce
          </button>

          <p className="text-center text-xs text-muted-foreground inline-flex items-center gap-1.5 justify-center w-full">
            <Lock className="w-3 h-3" />
            Próximamente: Shopify · Tienda Nube
          </p>
        </div>

        {/* Después de conectar */}
        <div className="mt-8 space-y-4">
          <h3 className="text-sm font-medium text-muted-foreground text-center">
            Después de conectar podrás:
          </h3>
          <div className="grid grid-cols-1 gap-2">
            {AFTER_CONNECT.map((item) => (
              <div
                key={item}
                className="flex items-center gap-3 text-sm text-muted-foreground"
              >
                <ArrowRight className="w-3.5 h-3.5 text-primary/60 flex-shrink-0" />
                <span>{item}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Flujo visual */}
        <div className="mt-8 bg-muted/10 border border-border rounded-xl p-4">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60 mb-3 font-medium">
            Cómo funciona
          </p>
          <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
            {FLOW_STEPS.map((step, i) => (
              <div key={step} className="flex items-center gap-2">
                <span className="bg-muted px-2 py-0.5 rounded text-foreground/80">
                  {step}
                </span>
                {i < FLOW_STEPS.length - 1 && (
                  <ChevronRight className="w-3 h-3 text-muted-foreground/40" />
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {wizardOpen && <ConnectWizard onClose={() => setWizardOpen(false)} />}
    </>
  );
}
