// GATE 3BA — contrato canónico de identidad. Helper puro, sin DB, sin wiring.
// Caracterización histórica: el path namehash debe reproducir byte a byte el algoritmo
// embebido en lib/catalog/upsert-catalog-products.ts (identityKey), 16 hex.
import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import {
  buildCatalogSourceIdentity,
  type CatalogSourceIdentityInput,
} from "@/lib/catalog/source-identity";

const LEGACY = { kind: "LEGACY_REPRODUCIBLE" } as const;
const TN = { kind: "EXTERNAL_VARIANT_REQUIRED", namespace: "tiendanube" } as const;

function build(p: Partial<CatalogSourceIdentityInput>) {
  return buildCatalogSourceIdentity({
    strategy: LEGACY,
    providerId: "p",
    ...p,
  } as CatalogSourceIdentityInput);
}
function okKey(p: Partial<CatalogSourceIdentityInput>): string {
  const r = build(p);
  if (!r.ok) throw new Error("esperaba ok, vino " + r.code);
  return r.sourceIdentityKey;
}

// Implementación de REFERENCIA histórica (copia literal del upsert actual).
function historicNamehash(name: string, providerId: string): string {
  return createHash("sha256")
    .update((name + providerId).toLowerCase().trim())
    .digest("hex")
    .slice(0, 16);
}

describe("A. Caracterización histórica del namehash", () => {
  it("1-3. vectores literales hardcodeados", () => {
    expect(okKey({ name: "Producto X", providerId: "prov123" })).toBe("namehash:7babdaf5faae3201");
    expect(okKey({ name: "A", providerId: "B" })).toBe("namehash:fb8e20fc2e4c3f24");
    expect(okKey({ name: "MOÑO", providerId: "p1" })).toBe("namehash:9c60e75a39445122");
  });
  it("3. helper == referencia histórica byte a byte (varios inputs)", () => {
    for (const [n, pid] of [["Hola Mundo", "abc"], ["café", "X9"], ["  raro  ", "zz"], ["", "onlypid"]] as const) {
      const r = build({ name: n, productUrl: null, sku: null, providerId: pid });
      // "" name → NO_REPRODUCIBLE (guard nuevo); el resto reproduce el histórico
      if (n.trim() === "") {
        expect(r.ok).toBe(false);
      } else {
        expect(r.ok && r.sourceIdentityKey).toBe("namehash:" + historicNamehash(n, pid));
      }
    }
  });
  it("4. concatenación sin separador (name+providerId, no name|providerId)", () => {
    // "ab"+"c" y "a"+"bc" colisionan porque no hay separador — comportamiento histórico
    expect(okKey({ name: "ab", providerId: "c" })).toBe(okKey({ name: "a", providerId: "bc" }));
  });
  it("5-6. trim y lowercase se aplican DESPUÉS de concatenar, global", () => {
    // trailing/leading espacios de la cadena concatenada se trimean
    expect(okKey({ name: "  X", providerId: "Y  " })).toBe("namehash:" + historicNamehash("  X", "Y  "));
  });
  it("7. name crudo, sin toCatalogUpperCase", () => {
    // "Producto X" y "producto x" dan la MISMA key por el lowercase global, no por uppercase
    expect(okKey({ name: "Producto X", providerId: "prov123" })).toBe(okKey({ name: "producto x", providerId: "prov123" }));
  });
  it("8. cambio de name cambia la key", () => {
    expect(okKey({ name: "N1", providerId: "p" })).not.toBe(okKey({ name: "N2", providerId: "p" }));
  });
  it("9. cambio de providerId cambia la key", () => {
    expect(okKey({ name: "N", providerId: "p1" })).not.toBe(okKey({ name: "N", providerId: "p2" }));
  });
  it("10-11. exactamente 16 hex (NO SHA-256 completo de 64)", () => {
    const k = okKey({ name: "algo", providerId: "x" });
    const hex = k.replace("namehash:", "");
    expect(hex).toMatch(/^[0-9a-f]{16}$/);
    expect(hex.length).toBe(16);
    expect(hex.length).not.toBe(64);
  });
});

describe("B. SKU legacy", () => {
  it("12. trim en extremos", () => { expect(okKey({ sku: " ABC-123 " })).toBe("sku:ABC-123"); });
  it("13. conserva case", () => { expect(okKey({ sku: "Abc" })).toBe("sku:Abc"); });
  it("14. no normaliza Unicode", () => { expect(okKey({ sku: "Ñoño" })).toBe("sku:Ñoño"); });
  it("15. conserva espacios internos", () => { expect(okKey({ sku: "A  B" })).toBe("sku:A  B"); });
  it("16. SKU vacío cae a URL", () => {
    expect(okKey({ sku: "", productUrl: "https://x.com/p" })).toMatch(/^urlsha256:/);
  });
  it("17. SKU solo espacios cae a URL", () => {
    expect(okKey({ sku: "   ", productUrl: "https://x.com/p" })).toMatch(/^urlsha256:/);
  });
  it("18. mismo SKU en providers distintos → misma key local (scope real es userId+providerId+key)", () => {
    expect(okKey({ sku: "S1", providerId: "pa" })).toBe(okKey({ sku: "S1", providerId: "pb" }));
  });
});

describe("C. Namespaces y SKU con dos puntos", () => {
  it('19. SKU "variant:643" → "sku:variant:643"', () => {
    expect(okKey({ sku: "variant:643" })).toBe("sku:variant:643");
  });
  it("20. no colisiona con tiendanube:variant:643", () => {
    const legacy = okKey({ sku: "variant:643" });
    const tnR = buildCatalogSourceIdentity({ strategy: TN, providerId: "p", externalVariantId: "643" });
    expect(tnR.ok && tnR.sourceIdentityKey).toBe("tiendanube:variant:643");
    expect(legacy).not.toBe(tnR.ok && tnR.sourceIdentityKey);
  });
  it('21-22. SKU "urlsha256:x" → "sku:urlsha256:x", no colisiona con key url real', () => {
    expect(okKey({ sku: "urlsha256:x" })).toBe("sku:urlsha256:x");
    expect(okKey({ sku: "urlsha256:x" })).not.toBe(okKey({ sku: "", productUrl: "https://x.com/p" }));
  });
  it("23. prefijos explícitos", () => {
    expect(okKey({ sku: "s" }).startsWith("sku:")).toBe(true);
    expect(okKey({ sku: "", productUrl: "https://x.com/p" }).startsWith("urlsha256:")).toBe(true);
    expect(okKey({ name: "n", providerId: "x" }).startsWith("namehash:")).toBe(true);
    const tn = buildCatalogSourceIdentity({ strategy: TN, providerId: "p", externalVariantId: "1" });
    expect(tn.ok && tn.sourceIdentityKey.startsWith("tiendanube:variant:")).toBe(true);
  });
});

describe("D. URL", () => {
  it("24-25. SHA-256 completo 64 hex + vector literal", () => {
    const k = okKey({ sku: null, productUrl: "https://ejemplo.com/producto" });
    expect(k).toBe("urlsha256:911bb95407f0b851251ae4d25312c5d9cc07fbfc62d569b41bfa52fa5cd74e8e");
    expect(k.replace("urlsha256:", "")).toMatch(/^[0-9a-f]{64}$/);
  });
  it("26. espacios externos no cambian la key", () => {
    expect(okKey({ productUrl: "  https://ejemplo.com/producto  " })).toBe(
      okKey({ productUrl: "https://ejemplo.com/producto" })
    );
  });
  it("27. barra final cambia la key", () => {
    expect(okKey({ productUrl: "https://ejemplo.com/producto" })).not.toBe(
      okKey({ productUrl: "https://ejemplo.com/producto/" })
    );
  });
  it("28. orden de query params cambia la key", () => {
    expect(okKey({ productUrl: "https://e.com/p?a=1&b=2" })).not.toBe(
      okKey({ productUrl: "https://e.com/p?b=2&a=1" })
    );
  });
  it("29. case del host cambia la key", () => {
    expect(okKey({ productUrl: "https://ejemplo.com/p" })).not.toBe(
      okKey({ productUrl: "https://EJEMPLO.com/p" })
    );
  });
  it("30. determinístico", () => {
    expect(okKey({ productUrl: "https://x.com/p" })).toBe(okKey({ productUrl: "https://x.com/p" }));
  });
  it("31. sin truncación en el path URL (64, no 16)", () => {
    expect(okKey({ productUrl: "https://x.com/p" }).replace("urlsha256:", "").length).toBe(64);
  });
  it("32. URL vacía cae a namehash si hay name", () => {
    expect(okKey({ productUrl: "", name: "nombre", providerId: "x" })).toMatch(/^namehash:/);
  });
  it("33. URL vacía sin name → NO_REPRODUCIBLE_IDENTITY", () => {
    const r = build({ sku: null, productUrl: "  ", name: "  " });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe("NO_REPRODUCIBLE_IDENTITY");
  });
});

describe("E. External variant (tiendanube)", () => {
  const tn = (p: Partial<CatalogSourceIdentityInput>) =>
    buildCatalogSourceIdentity({ strategy: TN, providerId: "p", ...p } as CatalogSourceIdentityInput);
  it("34. válido → tiendanube:variant:<id>", () => {
    const r = tn({ externalVariantId: "643792286", sku: "3048-9" });
    expect(r.ok && r.sourceIdentityKey).toBe("tiendanube:variant:643792286");
    expect(r.ok && r.basis).toBe("EXTERNAL_VARIANT_ID");
  });
  it("35. string con espacios externos se trimea", () => {
    const r = tn({ externalVariantId: "  643792286  " });
    expect(r.ok && r.sourceIdentityKey).toBe("tiendanube:variant:643792286");
  });
  it("36. number safe integer", () => {
    const r = tn({ externalVariantId: 643792286 });
    expect(r.ok && r.sourceIdentityKey).toBe("tiendanube:variant:643792286");
  });
  it("37. bigint", () => {
    const r = tn({ externalVariantId: BigInt("643792286") });
    expect(r.ok && r.sourceIdentityKey).toBe("tiendanube:variant:643792286");
  });
  it("38. mismo SKU + variantIds distintos → keys distintas", () => {
    const a = tn({ sku: "3048-9", externalVariantId: "643792286" });
    const b = tn({ sku: "3048-9", externalVariantId: "643792287" });
    expect(a.ok && a.sourceIdentityKey).not.toBe(b.ok && b.sourceIdentityKey);
  });
  it("39. mismo variantId + SKUs distintos → misma key", () => {
    const a = tn({ sku: "3048-9", externalVariantId: "643792286" });
    const b = tn({ sku: "OTRO", externalVariantId: "643792286" });
    expect(a.ok && a.sourceIdentityKey).toBe(b.ok && b.sourceIdentityKey);
  });
  it("40-43. falta variantId → MISSING, sin fallback a SKU/URL/namehash", () => {
    const r = tn({ sku: "3048-9", productUrl: "https://x.com/p", name: "N" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe("MISSING_EXTERNAL_VARIANT_ID");
  });
  it("44-45. externalProductId se normaliza pero no participa; cambiarlo con mismo variantId conserva key", () => {
    const a = tn({ externalVariantId: "643792286", externalProductId: "170002697" });
    const b = tn({ externalVariantId: "643792286", externalProductId: "999999999" });
    expect(a.ok && a.externalProductId).toBe("170002697");
    expect(a.ok && a.sourceIdentityKey).toBe(b.ok && b.sourceIdentityKey);
  });
  it("46. ID cero → inválido", () => {
    expect(tn({ externalVariantId: 0 }).ok).toBe(false);
    expect(tn({ externalVariantId: "0" }).ok).toBe(false);
  });
  it("47. ID negativo → inválido", () => {
    expect(tn({ externalVariantId: -5 }).ok).toBe(false);
    expect(tn({ externalVariantId: BigInt(-5) }).ok).toBe(false);
  });
  it("48. ID decimal → inválido", () => { expect(tn({ externalVariantId: 1.5 }).ok).toBe(false); });
  it("49. NaN → inválido", () => { expect(tn({ externalVariantId: NaN }).ok).toBe(false); });
  it("50. Infinity → inválido", () => {
    expect(tn({ externalVariantId: Infinity }).ok).toBe(false);
    expect(tn({ externalVariantId: -Infinity }).ok).toBe(false);
  });
  it("51. unsafe integer → inválido", () => {
    expect(tn({ externalVariantId: Number.MAX_SAFE_INTEGER + 1 }).ok).toBe(false);
  });
  it("52. string vacío → ausente → MISSING", () => {
    const r = tn({ externalVariantId: "   " });
    expect(!r.ok && r.code).toBe("MISSING_EXTERNAL_VARIANT_ID");
  });
  it("53. string no numérico → inválido para TiendaNube", () => {
    const r = tn({ externalVariantId: "abc" });
    expect(!r.ok && r.code).toBe("INVALID_EXTERNAL_VARIANT_ID");
  });
  it("54. input no mutado", () => {
    const input = { strategy: TN, providerId: "p", externalVariantId: "  643  ", sku: " s " } as CatalogSourceIdentityInput;
    const snap = JSON.stringify(input);
    buildCatalogSourceIdentity(input);
    expect(JSON.stringify(input)).toBe(snap);
  });
});

describe("F. Errores y tipado", () => {
  it("55. legacy sin SKU/URL/name → NO_REPRODUCIBLE_IDENTITY", () => {
    const r = build({ sku: null, productUrl: null, name: null });
    expect(!r.ok && r.code).toBe("NO_REPRODUCIBLE_IDENTITY");
  });
  it("57. error de externalProductId no se confunde con externalVariantId", () => {
    const r = buildCatalogSourceIdentity({ strategy: TN, providerId: "p", externalProductId: "abc", externalVariantId: "643" });
    expect(!r.ok && r.code).toBe("INVALID_EXTERNAL_PRODUCT_ID");
  });
  it("58. ningún mensaje contiene secretos obvios", () => {
    const r = build({ sku: null, productUrl: null, name: null });
    if (!r.ok) expect(r.message).not.toMatch(/password|token|secret|cookie/i);
  });
  it("60. resultado discriminado por ok", () => {
    const good = build({ sku: "s" });
    const bad = build({ sku: null, productUrl: null, name: null });
    expect(good.ok).toBe(true);
    expect(bad.ok).toBe(false);
    if (good.ok) expect(good.basis).toBe("SKU");
  });
  it("56. namespace no permitido → prevenido por tipos (compile-time)", () => {
    const r = buildCatalogSourceIdentity({
      // @ts-expect-error namespace "shopify" no es asignable a "tiendanube"
      strategy: { kind: "EXTERNAL_VARIANT_REQUIRED", namespace: "shopify" },
      providerId: "p",
      externalVariantId: "1",
    });
    // Si se forzara en runtime igual respondería, pero el tipo lo bloquea en compilación.
    expect(r.ok).toBe(true);
  });
  it("59. exhaustiva respecto a las estrategias (ambos kinds producen resultado)", () => {
    const legacy = buildCatalogSourceIdentity({ strategy: { kind: "LEGACY_REPRODUCIBLE" }, providerId: "p", sku: "s" });
    const tn = buildCatalogSourceIdentity({ strategy: { kind: "EXTERNAL_VARIANT_REQUIRED", namespace: "tiendanube" }, providerId: "p", externalVariantId: "1" });
    expect(legacy.ok).toBe(true);
    expect(tn.ok).toBe(true);
  });
});

describe("G. externalProductId inválido (tiendanube) — código distinto a variantId", () => {
  const tnP = (extProd: string | number | bigint | null) =>
    buildCatalogSourceIdentity({ strategy: TN, providerId: "p", externalVariantId: "1", externalProductId: extProd });
  const code = (r: ReturnType<typeof buildCatalogSourceIdentity>) => (r.ok ? "OK" : r.code);
  it("cero → INVALID_EXTERNAL_PRODUCT_ID", () => { expect(code(tnP(0))).toBe("INVALID_EXTERNAL_PRODUCT_ID"); expect(code(tnP("0"))).toBe("INVALID_EXTERNAL_PRODUCT_ID"); });
  it("negativo → INVALID_EXTERNAL_PRODUCT_ID", () => { expect(code(tnP(-3))).toBe("INVALID_EXTERNAL_PRODUCT_ID"); expect(code(tnP(BigInt(-3)))).toBe("INVALID_EXTERNAL_PRODUCT_ID"); });
  it("decimal → INVALID_EXTERNAL_PRODUCT_ID", () => { expect(code(tnP(1.5))).toBe("INVALID_EXTERNAL_PRODUCT_ID"); });
  it("no numérico → INVALID_EXTERNAL_PRODUCT_ID", () => { expect(code(tnP("abc"))).toBe("INVALID_EXTERNAL_PRODUCT_ID"); });
  it("vacío → ausente (válido, externalProductId=null, no participa de la key)", () => {
    const r = tnP("   ");
    expect(r.ok && r.externalProductId).toBe(null);
    expect(r.ok && r.sourceIdentityKey).toBe("tiendanube:variant:1");
  });
  it("productId inválido se reporta ANTES que un variantId también inválido", () => {
    const r = buildCatalogSourceIdentity({ strategy: TN, providerId: "p", externalProductId: "abc", externalVariantId: "def" });
    expect(code(r)).toBe("INVALID_EXTERNAL_PRODUCT_ID");
  });
});
