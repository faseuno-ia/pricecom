// GATE 3BA — Contrato canónico de identidad de catálogo (módulo puro).
//
// Función central que construye la `sourceIdentityKey` determinística a partir de los
// datos crudos que entrega una fuente (scraper / extractor / import). NO hace IO, NO
// accede a Prisma, NO muta el input, NO depende de fecha/hora ni del orden de ejecución.
//
// El extractor entrega datos crudos (SKU, URL, nombre, externalProductId, externalVariantId)
// + una estrategia explícita; ESTE módulo decide la identidad. El extractor NO construye
// libremente la key.
//
// Formatos congelados:
//   sku:${sku.trim()}
//   urlsha256:${SHA256_HEX_64(productUrl.trim())}
//   namehash:${SHA256_HEX(name + providerId, lowercase+trim global).slice(0,16)}   ← 16 hex, histórico
//   tiendanube:variant:${externalVariantId normalizado}
//
// Asimetría deliberada: namehash conserva 16 hex para reproducir byte a byte el algoritmo
// histórico embebido en lib/catalog/upsert-catalog-products.ts (identityKey). urlsha256 usa
// SHA-256 completo (64 hex) porque es diseño nuevo. NO unificar las longitudes.

import { createHash } from "crypto";

export type CatalogIdentityStrategy =
  | { kind: "LEGACY_REPRODUCIBLE" }
  | { kind: "EXTERNAL_VARIANT_REQUIRED"; namespace: "tiendanube" };

export interface CatalogSourceIdentityInput {
  strategy: CatalogIdentityStrategy;
  providerId: string;
  sku?: string | null;
  productUrl?: string | null;
  name?: string | null;
  externalProductId?: string | number | bigint | null;
  externalVariantId?: string | number | bigint | null;
}

export type CatalogSourceIdentityResult =
  | {
      ok: true;
      sourceIdentityKey: string;
      basis: "EXTERNAL_VARIANT_ID" | "SKU" | "PRODUCT_URL" | "NAME_HASH";
      normalizedSku: string | null;
      externalProductId: string | null;
      externalVariantId: string | null;
    }
  | {
      ok: false;
      code:
        | "MISSING_EXTERNAL_VARIANT_ID"
        | "NO_REPRODUCIBLE_IDENTITY"
        | "INVALID_EXTERNAL_PRODUCT_ID"
        | "INVALID_EXTERNAL_VARIANT_ID";
      message: string;
    };

type NormResult = { ok: true; value: string | null } | { ok: false };

/**
 * Normaliza un ID externo a string decimal (o null si ausente).
 * - string: trim; vacío → null; sin lowercase/uppercase; sin agregar/quitar ceros.
 * - number: debe ser finite + integer + safe integer.
 * - bigint: representación decimal exacta.
 * - `strict` (namespace tiendanube): además debe ser entero decimal POSITIVO
 *   (sin cero, negativos, decimales, notación científica ni espacios internos).
 */
function normalizeExternalId(
  raw: string | number | bigint | null | undefined,
  strict: boolean
): NormResult {
  if (raw === null || raw === undefined) return { ok: true, value: null };

  if (typeof raw === "string") {
    const t = raw.trim();
    if (t === "") return { ok: true, value: null };
    if (strict) {
      // entero decimal positivo: solo dígitos y no todo ceros
      if (!/^[0-9]+$/.test(t) || /^0+$/.test(t)) return { ok: false };
      return { ok: true, value: t };
    }
    return { ok: true, value: t };
  }

  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || !Number.isInteger(raw) || !Number.isSafeInteger(raw)) {
      return { ok: false };
    }
    if (strict && raw <= 0) return { ok: false };
    return { ok: true, value: String(raw) };
  }

  if (typeof raw === "bigint") {
    if (strict && raw <= BigInt(0)) return { ok: false };
    return { ok: true, value: raw.toString() };
  }

  return { ok: false };
}

function effectiveTrimmed(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

export function buildCatalogSourceIdentity(
  input: CatalogSourceIdentityInput
): CatalogSourceIdentityResult {
  const strict = input.strategy.kind === "EXTERNAL_VARIANT_REQUIRED";

  // Normalización de IDs externos (se validan siempre; el productId primero para no
  // confundir su error con el del variantId).
  const epi = normalizeExternalId(input.externalProductId, strict);
  if (!epi.ok) {
    return { ok: false, code: "INVALID_EXTERNAL_PRODUCT_ID", message: "externalProductId inválido para la estrategia" };
  }
  const evi = normalizeExternalId(input.externalVariantId, strict);
  if (!evi.ok) {
    return { ok: false, code: "INVALID_EXTERNAL_VARIANT_ID", message: "externalVariantId inválido para la estrategia" };
  }

  const normalizedSku = effectiveTrimmed(input.sku);

  // --- Estrategia con externalVariantId obligatorio (TiendaNube / Different Touch) ---
  if (input.strategy.kind === "EXTERNAL_VARIANT_REQUIRED") {
    if (evi.value == null) {
      return { ok: false, code: "MISSING_EXTERNAL_VARIANT_ID", message: "la fuente exige externalVariantId y no llegó" };
    }
    return {
      ok: true,
      sourceIdentityKey: `${input.strategy.namespace}:variant:${evi.value}`,
      basis: "EXTERNAL_VARIANT_ID",
      normalizedSku,
      externalProductId: epi.value,
      externalVariantId: evi.value,
    };
  }

  // --- Estrategia legacy reproducible: SKU → URL → namehash ---
  const base = { normalizedSku, externalProductId: epi.value, externalVariantId: evi.value } as const;

  if (normalizedSku != null) {
    return { ok: true, sourceIdentityKey: `sku:${normalizedSku}`, basis: "SKU", ...base };
  }

  const url = effectiveTrimmed(input.productUrl);
  if (url != null) {
    const hex = createHash("sha256").update(url, "utf8").digest("hex"); // 64 hex, completo
    return { ok: true, sourceIdentityKey: `urlsha256:${hex}`, basis: "PRODUCT_URL", ...base };
  }

  // namehash: usa el name CRUDO (sin trim/uppercase individual). Reproduce el histórico.
  if (typeof input.name === "string" && input.name.trim() !== "") {
    const hex = createHash("sha256")
      .update((input.name + input.providerId).toLowerCase().trim())
      .digest("hex")
      .slice(0, 16); // 16 hex, asimetría deliberada vs urlsha256
    return { ok: true, sourceIdentityKey: `namehash:${hex}`, basis: "NAME_HASH", ...base };
  }

  return { ok: false, code: "NO_REPRODUCIBLE_IDENTITY", message: "sin SKU, URL ni nombre utilizable" };
}
