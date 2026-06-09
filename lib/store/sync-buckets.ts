// Predicados compartidos de los buckets de estado de SYNC (eje PricEcom ↔ Woo).
// UNA sola fuente de verdad para que KPI, API, chip/filtro y dashboard cuenten
// EXACTAMENTE lo mismo y no vuelvan a divergir (1A.2-kpi).

import type { Prisma } from "@prisma/client";

// Bucket "Errores": fallos TERMINALES del contrato honesto (1A.2-ab).
//   syncStatus IN (ERROR, ERROR_SKU_CONFLICT)
// NO incluye PENDING_SYNC: los pendientes (recoverable/ambiguous, incluido el
// caso sin-credenciales) tienen su propio bucket visible ("Pend. sync").
export const SYNC_ERRORS_WHERE = {
  syncStatus: { in: ["ERROR", "ERROR_SKU_CONFLICT"] },
} satisfies Prisma.ProductPublicationWhereInput;
