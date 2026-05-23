"use client";

// Modal/popover reutilizable: muestra la guía completa de estados visuales
// del catálogo. Centraliza la documentación on-screen para no duplicar el
// listado en cada pantalla.

import { useState } from "react";
import { Info, X } from "lucide-react";
import {
  VISUAL_STATUS_ORDER,
  visualStatusConfig,
  visualStatusDescriptions,
  type VisualStatus,
} from "@/lib/catalog/visual-status";

interface Props {
  // Subconjunto de estados a mostrar. Si se omite, muestra todos.
  // Útil para /my-store, donde solo aplican algunos.
  statuses?: VisualStatus[];
  // Trigger personalizado. Si se omite, usa un botón con icono Info.
  triggerLabel?: string;
}

export function StatusHelpModal({ statuses, triggerLabel }: Props) {
  const [open, setOpen] = useState(false);
  const list = statuses ?? VISUAL_STATUS_ORDER;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        aria-label="Ver guía de estados"
        title="Qué significa cada estado"
      >
        <Info className="w-3.5 h-3.5" />
        {triggerLabel && <span>{triggerLabel}</span>}
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0 bg-black/50 z-40"
            onClick={() => setOpen(false)}
          />
          <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-md bg-card border border-border rounded-xl shadow-2xl">
            <div className="flex items-center justify-between px-5 py-3 border-b border-border">
              <h3 className="text-sm font-semibold">Guía de estados</h3>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-muted-foreground hover:text-foreground p-1 rounded-md hover:bg-muted/40"
                aria-label="Cerrar"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-5 py-4 space-y-3 max-h-[70vh] overflow-y-auto">
              {list.map((s, idx) => (
                <div
                  key={s}
                  className={`space-y-1 ${idx > 0 ? "pt-3 border-t border-border" : ""}`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-block text-[10px] px-2 py-0.5 rounded-full border font-medium ${visualStatusConfig[s].className}`}
                    >
                      {visualStatusConfig[s].label}
                    </span>
                    <span className="text-xs font-semibold">
                      {visualStatusConfig[s].label}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {visualStatusDescriptions[s]}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </>
  );
}
