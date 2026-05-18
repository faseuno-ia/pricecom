"use client";

import { useState } from "react";
import { ShoppingBag, Check, Lock } from "lucide-react";
import { ConnectWizard } from "./connect-wizard";

export function Onboarding() {
  const [wizardOpen, setWizardOpen] = useState(false);

  const perks = [
    "productos",
    "precios",
    "categorías",
    "stock",
    "publicaciones",
  ];

  return (
    <>
      <div className="max-w-xl mx-auto bg-card border border-border rounded-2xl p-10 text-center space-y-6">
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-primary to-accent flex items-center justify-center mx-auto shadow-lg shadow-primary/20">
          <ShoppingBag className="w-8 h-8 text-white" />
        </div>
        <div>
          <h2 className="text-xl font-semibold tracking-tight">
            Conectá tu tienda
          </h2>
          <p className="text-sm text-muted-foreground mt-2">
            Sincronizá tu catálogo con tu ecommerce existente — productos,
            precios, categorías y stock.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2 text-sm">
          {perks.map((p) => (
            <div
              key={p}
              className="flex items-center gap-2 bg-muted/20 border border-border rounded-md px-3 py-2"
            >
              <Check className="w-3.5 h-3.5 text-accent flex-shrink-0" />
              <span>{p}</span>
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={() => setWizardOpen(true)}
          className="bg-primary text-primary-foreground px-6 py-2.5 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors w-full"
        >
          Conectar WooCommerce
        </button>

        <p className="text-[11px] text-muted-foreground/70 inline-flex items-center gap-1.5 justify-center">
          <Lock className="w-3 h-3" />
          Próximamente: Shopify · Tienda Nube
        </p>
      </div>

      {wizardOpen && <ConnectWizard onClose={() => setWizardOpen(false)} />}
    </>
  );
}
