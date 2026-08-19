// C2-DESIGN-1 · Autoridad TRANSITORIA de elegibilidad de storefront para PRIMERA publicación.
//
// Contrato:
//   FIRST_PUBLICATION_REQUIRES_EXPLICIT_STOREFRONT_ELIGIBILITY = true
//   DEFAULT = DENY
//
// La decisión depende EXCLUSIVAMENTE del par (providerId, storeId). Ningún otro dato del
// producto participa — en particular NO participa `stockSource`:
//
//   STOCK_SOURCE_DOES_NOT_GRANT_FIRST_PUBLISH_ELIGIBILITY = true
//
// `stockSource` (SUPPLIER | OWN | HYBRID) y la elegibilidad de storefront son ejes ortogonales:
// tener stock propio de un artículo no autoriza a crearlo en una tienda. El eje `stockSource`
// gobierna otra cosa (la supervivencia ante SUPPLIER_REMOVED, en
// lib/catalog/upsert-catalog-products.ts) y este módulo no lo mira ni lo recibe.
//
// POLARIDAD: es una ALLOWLIST, no una denylist. Un proveedor nuevo entra DENY por omisión, y
// la lista crece sólo con decisiones explícitas. Los identificadores aparecen acá como DATO de
// la autoridad, nunca como rama de lógica de negocio (ver
// tests/unit/first-publish-structural.test.ts).
//
// TRANSITORIA: C2-DESIGN-1 no define el boundary durable producto ↔ storefront. C2-DESIGN-2
// reemplaza el CUERPO de canFirstPublish() por una consulta al modelo durable; el punto y el
// momento del enforcement (lib/integrations/woocommerce/publication-service.ts, justo después
// de cargar existingPub) NO se mueven.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// Derived from:
//   GATE2-SEED-PRECHECK
//   2026-08-17
//
//   KNOWN_PUBLICATION_TOTAL = 2044
//   KNOWN_REMOTE_PUBLICATION_TOTAL = 2043
//   KNOWN_PUBLICATION_WITHOUT_REMOTE_ID_TOTAL = 1
//   KNOWN_NULL_REMOTE_PROVIDER = TOYS PALACE
//
// FIRST_GLOBAL_REMOTE_ID_MEASUREMENT = true — el desglose 2043/1 se midió por primera vez en
// este precheck; NO existía como baseline global previo. El total 2044 sí permanece sin cambios
// respecto del baseline anterior.
//
// Fuera del seed por decisión explícita (ambos resuelven E3 → DENY hasta que haya decisión):
//   · LACHIPELU - Vanesa · cmp8yrrxz0003v2l216axmacb · isActive=false · 85 publicaciones
//     remotas ya existentes (no se ven afectadas: tienen externalProductId ⇒ van por UPDATE).
//   · Mi stock · cmp9by4vt0001e7qryrqwnmvw · providerType=OWN_STOCK · 0 CatalogProduct
//     asociados ⇒ hoy no existe superficie real de first publish. No confundir este provider
//     lógico con `stockSource = OWN`: los 31 productos con stock propio pertenecen a IMPOTEKNO
//     y resuelven su elegibilidad como productos de IMPOTEKNO.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Código estable devuelto en PublishResult.code cuando el guard bloquea. */
export const FIRST_PUBLISH_NOT_ELIGIBLE = "FIRST_PUBLISH_NOT_ELIGIBLE" as const;

export type FirstPublishDecision = "ALLOW" | "DENY";

/**
 * ELIGIBLE      → par presente y autorizado (E1)
 * EXPLICIT      → par presente y explícitamente NO autorizado (E2)
 * ABSENT        → el par no figura: nadie decidió todavía (E3)
 * UNRESOLVABLE  → falta providerId o storeId: no hay par que evaluar (E4)
 * AUTHORITY_ERROR → la autoridad falló al resolver (E5)
 */
export type FirstPublishReason =
  | "ELIGIBLE"
  | "EXPLICIT"
  | "ABSENT"
  | "UNRESOLVABLE"
  | "AUTHORITY_ERROR";

export interface FirstPublishVerdict {
  decision: FirstPublishDecision;
  reason: FirstPublishReason;
}

export interface FirstPublishAuthorityEntry {
  /** Autoridad real. */
  providerId: string;
  /** Autoridad real. */
  storeId: string;
  /** Autoridad real. */
  decision: "ELIGIBLE" | "INELIGIBLE";
  /** Obligatorio en ambas decisiones: sin motivo escrito no hay decisión, hay olvido. */
  reason: string;
  /** Metadata humana — para que un typo de id se vea en review. NO es autoridad. */
  providerName: string;
  /** Metadata humana. NO es autoridad. */
  storeName: string;
  /** Metadata humana: publicaciones con externalProductId al momento de decidir. */
  baselineRemotePublications: number;
  /** Metadata humana: filas de catálogo al momento de decidir. */
  catalogProductsAtDecision: number;
}

const ELECTROFAYS = "cmpbws2z90001luzc2tsi5143";

export const FIRST_PUBLISH_AUTHORITY: readonly FirstPublishAuthorityEntry[] = [
  {
    providerId: "cmp3hop7700003mhu29jk9kxd",
    providerName: "IMPOTEKNO",
    storeId: ELECTROFAYS,
    storeName: "ELECTROFAYS",
    decision: "ELIGIBLE",
    reason:
      "Publicador histórico con relación de storefront ya establecida (1152 publicaciones remotas).",
    baselineRemotePublications: 1152,
    catalogProductsAtDecision: 1233,
  },
  {
    providerId: "cmowdhjgv00078te4whvfo0iv",
    providerName: "TOYS PALACE",
    storeId: ELECTROFAYS,
    storeName: "ELECTROFAYS",
    decision: "ELIGIBLE",
    reason:
      "Publicador histórico (446 publicaciones remotas). Tiene además 1 ProductPublication sin externalProductId: su first publish automático vía worker queda autorizado a propósito.",
    baselineRemotePublications: 446,
    catalogProductsAtDecision: 3645,
  },
  {
    providerId: "cmp01ejq00000uuyfdmcwrnpi",
    providerName: "BAZAR 380",
    storeId: ELECTROFAYS,
    storeName: "ELECTROFAYS",
    decision: "ELIGIBLE",
    reason: "Publicador histórico (240 publicaciones remotas).",
    baselineRemotePublications: 240,
    catalogProductsAtDecision: 1010,
  },
  {
    providerId: "cmqesu14f0001nrww0fxmm02n",
    providerName: "JUGUETES ELY",
    storeId: ELECTROFAYS,
    storeName: "ELECTROFAYS",
    decision: "ELIGIBLE",
    reason: "Publicador histórico (109 publicaciones remotas).",
    baselineRemotePublications: 109,
    catalogProductsAtDecision: 1622,
  },
  {
    providerId: "cmp8yqtgs0001v2l2iqer7a00",
    providerName: "GABY",
    storeId: ELECTROFAYS,
    storeName: "ELECTROFAYS",
    decision: "ELIGIBLE",
    reason: "Publicador histórico (11 publicaciones remotas).",
    baselineRemotePublications: 11,
    catalogProductsAtDecision: 20,
  },
  {
    providerId: "cmqyh2cqq0002fgq5olah8ua6",
    providerName: "OESTECH",
    storeId: ELECTROFAYS,
    storeName: "ELECTROFAYS",
    decision: "ELIGIBLE",
    reason:
      "Autorizado explícitamente para publicar en ELECTROFAYS (todavía sin publicaciones remotas).",
    baselineRemotePublications: 0,
    catalogProductsAtDecision: 632,
  },
  {
    providerId: "cmqesu14g0003nrwwos9h9ona",
    providerName: "LEDMOMENTS",
    storeId: ELECTROFAYS,
    storeName: "ELECTROFAYS",
    decision: "ELIGIBLE",
    reason:
      "Autorizado explícitamente para publicar en ELECTROFAYS (todavía sin publicaciones remotas).",
    baselineRemotePublications: 0,
    catalogProductsAtDecision: 561,
  },
  {
    providerId: "cms8554bw0002cxz7qm3buvwm",
    providerName: "Different Touch",
    storeId: ELECTROFAYS,
    storeName: "ELECTROFAYS",
    decision: "INELIGIBLE",
    reason:
      "Decisión explícita: DT no se publica en ELECTROFAYS. Su catálogo se observa (precios) pero no se crea en la tienda. Registrado como decisión tomada, no como ausencia de decisión.",
    baselineRemotePublications: 0,
    catalogProductsAtDecision: 1121,
  },
];

/** Resuelve la entrada del par, o undefined si no figura. */
export type FirstPublishLookup = (
  providerId: string,
  storeId: string,
) => FirstPublishAuthorityEntry | undefined;

const defaultLookup: FirstPublishLookup = (providerId, storeId) =>
  FIRST_PUBLISH_AUTHORITY.find(
    (e) => e.providerId === providerId && e.storeId === storeId,
  );

/**
 * ¿Está autorizada la PRIMERA publicación de un producto de `providerId` en `storeId`?
 *
 * Función TOTAL: nunca lanza. Cualquier fallo interno se resuelve como DENY/AUTHORITY_ERROR
 * (fail-closed) — una autoridad rota no puede convertirse en una publicación remota.
 *
 * `lookup` existe para poder inyectar fallos en tests sin mockear módulos; producción usa el
 * default.
 */
export function canFirstPublish(
  providerId: string | null | undefined,
  storeId: string | null | undefined,
  lookup: FirstPublishLookup = defaultLookup,
): FirstPublishVerdict {
  try {
    const provider = typeof providerId === "string" ? providerId.trim() : "";
    const store = typeof storeId === "string" ? storeId.trim() : "";
    if (!provider || !store) {
      return { decision: "DENY", reason: "UNRESOLVABLE" };
    }
    const entry = lookup(provider, store);
    if (!entry) return { decision: "DENY", reason: "ABSENT" };
    if (entry.decision === "ELIGIBLE") {
      return { decision: "ALLOW", reason: "ELIGIBLE" };
    }
    return { decision: "DENY", reason: "EXPLICIT" };
  } catch {
    return { decision: "DENY", reason: "AUTHORITY_ERROR" };
  }
}

/**
 * Mensaje para el operador. Tiene que decir tres cosas, porque las tres cambian qué hace el
 * humano después: quién bloqueó, que fue la PRIMERA publicación (los updates no están
 * bloqueados), y que no hubo ninguna llamada a la tienda.
 */
export function firstPublishDenyMessage(reason: FirstPublishReason): string {
  const detail: Record<FirstPublishReason, string> = {
    ELIGIBLE: "autorizado",
    EXPLICIT: "el proveedor está marcado como NO habilitado para esta tienda",
    ABSENT: "el proveedor no está habilitado para esta tienda todavía",
    UNRESOLVABLE:
      "no se pudo determinar el par proveedor/tienda de este producto",
    AUTHORITY_ERROR:
      "falló la verificación de habilitación (se bloquea por precaución)",
  };
  return (
    `Bloqueado por PricEcom: este producto no está autorizado para su PRIMERA publicación ` +
    `en esta tienda (${detail[reason]}). No se hizo ninguna llamada a WooCommerce.`
  );
}
