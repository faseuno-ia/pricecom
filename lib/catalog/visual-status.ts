// Estados visuales derivados para la UI del catálogo. No son un enum nuevo en
// la DB — siempre se calculan a partir de internalStatus + supplierStatus +
// el estado de sync de las publications. Centralizar acá garantiza que el
// badge, el filtro y el tooltip describan la misma cosa.

export type VisualStatus =
  | "NOT_PUBLISHED"
  | "PREPARED"
  | "PUBLISHED"
  | "OUTDATED"
  | "SIN_STOCK"
  | "PAUSED"
  | "IGNORED";

export interface VisualStatusInput {
  internalStatus: string;
  supplierStatus: string;
  pendingSync?: boolean;
  syncStatus?: string | null;
}

export function deriveVisualStatus(p: VisualStatusInput): VisualStatus {
  if (p.internalStatus === "IGNORED") return "IGNORED";
  if (p.internalStatus === "PAUSED") return "PAUSED";
  if (p.supplierStatus === "SUPPLIER_REMOVED") return "SIN_STOCK";
  if (p.internalStatus === "NOT_PUBLISHED") return "NOT_PUBLISHED";
  if (p.internalStatus === "PREPARED") return "PREPARED";
  // internalStatus = PUBLISHED a esta altura. Si la publication está
  // desincronizada (pendingSync o syncStatus != SYNCED/READY) marcamos
  // OUTDATED — el usuario ve drift sin tener que mirar el detalle.
  if (
    p.pendingSync ||
    (p.syncStatus && p.syncStatus !== "SYNCED" && p.syncStatus !== "READY")
  ) {
    return "OUTDATED";
  }
  return "PUBLISHED";
}

export const visualStatusConfig: Record<
  VisualStatus,
  { label: string; className: string }
> = {
  NOT_PUBLISHED: {
    label: "Sin publicar",
    className: "bg-muted/40 text-muted-foreground border-border",
  },
  PREPARED: {
    label: "Preparado",
    className: "bg-blue-500/15 text-blue-300 border-blue-500/30",
  },
  PUBLISHED: {
    label: "Publicado",
    className: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  },
  OUTDATED: {
    label: "Desactualizado",
    className: "bg-violet-500/15 text-violet-300 border-violet-500/30",
  },
  SIN_STOCK: {
    label: "Sin stock",
    className: "bg-orange-500/15 text-orange-300 border-orange-500/30",
  },
  PAUSED: {
    label: "Pausado",
    className: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  },
  IGNORED: {
    label: "Ignorado",
    className: "bg-muted/30 text-muted-foreground border-border",
  },
};

export const visualStatusDescriptions: Record<VisualStatus, string> = {
  NOT_PUBLISHED:
    "Producto cargado en PricEcom, pero todavía no preparado ni publicado.",
  PREPARED: "Producto listo para publicar, pendiente de envío a la tienda.",
  PUBLISHED: "Producto activo y sincronizado con WooCommerce.",
  OUTDATED:
    "PricEcom y WooCommerce no están alineados. Hay cambios pendientes o error de sync.",
  SIN_STOCK: "El proveedor dejó de tener el producto. Requiere revisión.",
  PAUSED: "El usuario decidió pausar manualmente este producto.",
  IGNORED:
    "Producto descartado por el usuario. No aparece en operaciones normales.",
};

// Orden canónico para listados del UI (filtro + tooltip explicativo).
export const VISUAL_STATUS_ORDER: VisualStatus[] = [
  "NOT_PUBLISHED",
  "PREPARED",
  "PUBLISHED",
  "OUTDATED",
  "SIN_STOCK",
  "PAUSED",
  "IGNORED",
];
