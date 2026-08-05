// A4.1-R2 / A3 — AUTORIDAD DE DOMINIO de completitud R2 (walk vs referencia sitemap).
//
// PURA: sin I/O, sin browser, sin red, sin exit codes, sin status del CLI, sin side
// effects al importar. Decide COMPLETITUD como concepto de dominio, reutilizable por
// el recon (adaptador a exit/status) y por el futuro worker A3 (misma autoridad).
//
// Invariantes fail-loud PRIMERO: representan wiring inconsistente entre el walk, el
// loader de referencia y el diff — deben abortar, nunca degradar en silencio.

export type SitemapReferenceKind = "POPULATED_REFERENCE" | "EXPLICITLY_EMPTY_REFERENCE";

export type SitemapCompletenessOutcome =
  | "COMPLETE"
  | "WALK_INCOMPLETE"
  | "REFERENCE_EXPLICITLY_EMPTY"
  | "REFERENCE_NORMALIZED_TO_ZERO"
  | "SET_MISMATCH";

export type SitemapCompletenessInvariant =
  | "INVARIANT_EMPTY_REFERENCE_WITH_NONZERO_COUNT"
  | "INVARIANT_EXACT_MATCH_WITH_ZERO_COUNT"
  | "INVARIANT_EXACT_MATCH_WITHOUT_POPULATED_REFERENCE";

export class SitemapCompletenessInvariantError extends Error {
  readonly invariant: SitemapCompletenessInvariant;
  constructor(invariant: SitemapCompletenessInvariant) {
    super(`SITEMAP_COMPLETENESS_INVARIANT_VIOLATED: ${invariant}`);
    this.name = "SitemapCompletenessInvariantError";
    this.invariant = invariant;
  }
}

export interface SitemapCompletenessInput {
  /** Estado del walk (classifyWalkState): "COMPLETE" habilita la evaluación del resto. */
  walkStatus: string;
  referenceKind: SitemapReferenceKind;
  /** URLs de referencia tras normalizar+deduplicar (0 si vacía o si todo normalizó a null). */
  normalizedReferenceCount: number;
  /** Identidad de conjuntos walker == referencia. */
  exactSetMatch: boolean;
}

export interface SitemapCompletenessResult {
  complete: boolean;
  outcome: SitemapCompletenessOutcome;
  reasonCode: string | null;
}

/**
 * Resuelve el outcome de completitud. `complete=true` SOLO cuando el walk cerró,
 * la referencia está poblada con >0 URLs normalizadas y hay identidad exacta de sets.
 */
export function resolveSitemapCompletenessOutcome(input: SitemapCompletenessInput): SitemapCompletenessResult {
  const { walkStatus, referenceKind, normalizedReferenceCount, exactSetMatch } = input;

  // ── Invariantes fail-loud (wiring inconsistente) — PRIMERO ──
  // Orden elegido para que cada invariante sea alcanzable de forma independiente
  // (con solo dos referenceKind, chequear kind!==POPULATED antes que count===0).
  if (referenceKind === "EXPLICITLY_EMPTY_REFERENCE" && normalizedReferenceCount > 0) {
    throw new SitemapCompletenessInvariantError("INVARIANT_EMPTY_REFERENCE_WITH_NONZERO_COUNT");
  }
  if (exactSetMatch === true && referenceKind !== "POPULATED_REFERENCE") {
    throw new SitemapCompletenessInvariantError("INVARIANT_EXACT_MATCH_WITHOUT_POPULATED_REFERENCE");
  }
  if (exactSetMatch === true && normalizedReferenceCount === 0) {
    throw new SitemapCompletenessInvariantError("INVARIANT_EXACT_MATCH_WITH_ZERO_COUNT");
  }

  // ── Precedencia de outcome ──
  if (walkStatus !== "COMPLETE") {
    return { complete: false, outcome: "WALK_INCOMPLETE", reasonCode: "R2_WALK_INCOMPLETE" };
  }
  if (referenceKind === "EXPLICITLY_EMPTY_REFERENCE") {
    return { complete: false, outcome: "REFERENCE_EXPLICITLY_EMPTY", reasonCode: "R2_SITEMAP_REFERENCE_EXPLICITLY_EMPTY" };
  }
  if (normalizedReferenceCount === 0) {
    return { complete: false, outcome: "REFERENCE_NORMALIZED_TO_ZERO", reasonCode: "R2_SITEMAP_REFERENCE_NORMALIZED_TO_ZERO" };
  }
  if (exactSetMatch === false) {
    return { complete: false, outcome: "SET_MISMATCH", reasonCode: "R2_SITEMAP_SET_MISMATCH" };
  }
  return { complete: true, outcome: "COMPLETE", reasonCode: null };
}
