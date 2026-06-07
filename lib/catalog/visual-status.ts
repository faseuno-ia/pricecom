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
  // Origen del stock (enum StockSource: "SUPPLIER" | "OWN" | "HYBRID").
  // REQUERIDO a propósito: SIN_STOCK solo aplica si el producto DEPENDE del
  // proveedor (stockSource="SUPPLIER"). Un OWN/HYBRID sobrevive a la baja del
  // proveedor, así que omitir este campo cambiaría la jerarquía silenciosamente.
  // Fallo seguro: si el call site no lo pasa, tsc lo marca.
  stockSource: string;
  pendingSync?: boolean;
  syncStatus?: string | null;
}

export function deriveVisualStatus(p: VisualStatusInput): VisualStatus {
  // 1. OUTDATED — máxima prioridad: si hay drift pendiente sobre una
  //    publicación viva, el usuario tiene que verlo aunque el proveedor
  //    haya removido el producto o el item esté pausado, porque hay
  //    cambios sin pushear.
  if (
    p.internalStatus === "PUBLISHED" &&
    (p.pendingSync ||
      (p.syncStatus && p.syncStatus !== "SYNCED" && p.syncStatus !== "READY"))
  ) {
    return "OUTDATED";
  }

  // 2. SIN_STOCK — gana sobre PAUSED. Si el proveedor removió el producto,
  //    "Sin stock" es la información comercialmente relevante, no la causa
  //    interna (pausa automática vs manual). PERO solo si el stock DEPENDE del
  //    proveedor: un producto OWN/HYBRID (contrato del enum StockSource —
  //    schema.prisma: "OWN para productos que el cliente tiene físicamente y
  //    vende aunque el proveedor desaparezca") sobrevive a SUPPLIER_REMOVED y
  //    debe mostrar su estado interno real (PUBLISHED/PAUSED/etc.), no "Sin stock".
  if (
    p.supplierStatus === "SUPPLIER_REMOVED" &&
    p.stockSource === "SUPPLIER"
  ) {
    return "SIN_STOCK";
  }

  // 3. PAUSED — pausa manual/intencional del usuario, con proveedor activo.
  if (p.internalStatus === "PAUSED") return "PAUSED";

  // 4. PUBLISHED — sincronizado y disponible.
  if (p.internalStatus === "PUBLISHED") return "PUBLISHED";

  // 5. PREPARED — listo para publicar, todavía no fue enviado a la tienda.
  if (p.internalStatus === "PREPARED") return "PREPARED";

  // 6. NOT_PUBLISHED — no se preparó ni se publicó.
  if (p.internalStatus === "NOT_PUBLISHED") return "NOT_PUBLISHED";

  // 7. IGNORED — fallback. SIN_STOCK gana solo si el producto dependía del
  //    proveedor (SUPPLIER), porque "olvidá esto" pierde sentido si el item ya
  //    no existe afuera. Un OWN/HYBRID removido por el proveedor NO cae acá:
  //    sobrevive en su estado interno (PUBLISHED/PAUSED/etc.) por el contrato
  //    de StockSource.
  return "IGNORED";
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
