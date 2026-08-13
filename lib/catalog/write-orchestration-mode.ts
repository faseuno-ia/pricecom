// 2G-R10-PR19 · Autoridad de ORQUESTADOR por proveedor, config-driven y EXPLÍCITA. Resolver fail-loud,
// misma asimetría que resolveCatalogWriteMode/resolveExtractionMode. PURO: sin red/DB/IO.
//
//   catalogWriteMode        → QUÉ puede escribir (FULL | PRICE_ONLY)
//   extractionMode          → CÓMO obtiene los datos
//   writeOrchestrationMode  → QUÉ orquestador está autorizado a ejecutar (LEGACY | GUARDED_PRICE_ONLY)
//
// Default LEGACY (null/blank): NINGÚN proveedor cambia de conducta al desplegar; GUARDED_PRICE_ONLY es
// opt-in explícito por proveedor. NO reemplaza los otros dos modos: es una tercera dimensión ortogonal.

export type WriteOrchestrationMode = "LEGACY" | "GUARDED_PRICE_ONLY";

/** Fail-loud ante un writeOrchestrationMode inválido no vacío. Incluye field + rawValue, sin secretos. */
export class WriteOrchestrationModeError extends Error {
  readonly field = "writeOrchestrationMode";
  readonly rawValue: string;
  constructor(rawValue: string) {
    super(`Invalid writeOrchestrationMode: field=writeOrchestrationMode rawValue=${JSON.stringify(rawValue)} (valid: LEGACY, GUARDED_PRICE_ONLY)`);
    this.name = "WriteOrchestrationModeError";
    this.rawValue = rawValue;
  }
}

/**
 * Resuelve el modo de orquestación. Semántica EXACTA (paralela a resolveCatalogWriteMode):
 *   null | undefined | "" | whitespace-only → "LEGACY"
 *   "LEGACY" → "LEGACY"   ·   "GUARDED_PRICE_ONLY" → "GUARDED_PRICE_ONLY"
 *   otro string no vacío, o no-string no null/undefined → throw (nunca cae a un default en silencio).
 */
export function resolveWriteOrchestrationMode(raw: unknown): WriteOrchestrationMode {
  if (raw === null || raw === undefined) return "LEGACY";
  if (typeof raw !== "string") throw new WriteOrchestrationModeError(String(raw));
  const trimmed = raw.trim();
  if (trimmed === "") return "LEGACY";
  if (trimmed === "LEGACY") return "LEGACY";
  if (trimmed === "GUARDED_PRICE_ONLY") return "GUARDED_PRICE_ONLY";
  throw new WriteOrchestrationModeError(trimmed);
}
