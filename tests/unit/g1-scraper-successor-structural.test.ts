// G1-AMEND — guard estructural AUTÓNOMO (CI-safe): inmutables B4/B5 + sucesión firmada de
// scraper.service.ts. No importa NINGÚN módulo productivo ni pieza A41, no lee artifacts/,
// ni manifest de baseline, ni .env, ni DB, ni nada fuera del repo. Corre desde un checkout limpio.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const B4_PATH = resolve(process.cwd(), "lib/scraper/tiendanube-walker.ts");
const B5_PATH = resolve(process.cwd(), "lib/scraper/extracted-product-input.ts");
const SCRAPER_SERVICE_PATH = resolve(process.cwd(), "lib/scraper/scraper.service.ts");

// ─────────────────────────────────────────────────────────────────────────────
// BLOQUE 1 — B5 inmutable + B4 sucesión firmada
//
// B5 (extracted-product-input) permanece INMUTABLE firmado: un cambio de SHA es un
// DEFECTO hasta una decisión explícita de descongelamiento.
//
// B4 (tiendanube-walker) FUE descongelado por decisión explícita en 2G-R3
// (SITEMAP_DRIVEN_DISCOVERY). Delta autorizado y acotado:
//   + WalkerDeps.seedProductUrls?: string[]   (semilla sitemap-driven)
//   + collectProductUrlsFromSeed(...)          (canonicaliza/valida/deduplica el seed)
//   ~ runSkuFirstWalk: Fase A ramifica a seed cuando está presente; SIN seed = legacy.
//   = Fase B / captura / mapper / agrupación / cuarentena / completitud: SIN cambios.
// El ACCEPTED_WALK_SET (autoridad de completitud) sigue llenándose SOLO con capturas
// aceptadas en Fase B, nunca con el seed. Predecesor 1db776ad → sucesor abajo.
//
// RE-FREEZE (2G-R3): el descongelamiento fue PUNTUAL. Tras esta sucesión, B4 vuelve a
// régimen INMUTABLE en el nuevo SHA: cualquier cambio futuro es un DEFECTO hasta un nuevo
// descongelamiento explícito. No actualizar estos SHA como reacción automática a CI.
// ─────────────────────────────────────────────────────────────────────────────
const B5_SIGNED_SHA256 = "5091077200502b36f538d9b626ae2ea2f0e30e935cc685fb8b79a657aa1cb9b0";
const B4_G1_FROZEN_SHA256 = "1db776adb0d2e642ab815032073f113d07513e1bb1f79a8c395ef564bb719cb7";
const B4_2GR3_SUCCESSOR_SHA256 = "e8d53e3be901db0b8783ffae6576752e54a4a17bf451441915541e359804bf2e";
// 2G-R7: sucesión firmada de B4. Delta autorizado y acotado (observabilidad §7):
//   + WalkerDeps.nowMs? / onProductObserved?  (OPCIONALES, inertes si ausentes)
//   + WalkerProductObservation (tipo)
//   ~ Fase B: mide elapsedMs por ficha y llama onProductObserved (NO altera captureProductRows ni
//     la agrupación/completitud). Predecesor 2G-R3 e8d53e3b → sucesor R7 abajo.
const B4_R7_SUCCESSOR_SHA256 = "bff05f87d5691427cb73896586337d11b719d3be29b75bc8b1336035c380674d";
// 2G-R8-Q2: sucesión firmada de B4. Delta autorizado y acotado (HTTP 429 reactive recovery §11-§13 +
// modelo de outcome de ficha §3 + FICHA_TO_SKUS_MAP §9):
//   + import http-429-recovery; tipos FichaCaptureOutcome/FichaCaptureResult/NavigateResult/RateLimitEvent/
//     RateLimitWalkBudget/WalkOutcomeSummary; NavigateResult ahora expone status + Retry-After.
//   ~ captureProductRows: OWNER único de recuperación 429 (contador ficha-scoped, RATE_LIMITED terminal
//     devuelto nunca lanzado ⇒ RETRY_MULTIPLICATION_RISK=false); devuelve FichaCaptureResult (outcome
//     explícito, recovered/attempts/status/variantSetComplete). NUNCA VERIFIED_ABSENT (§5).
//   ~ runSkuFirstWalk: acumula outcomeSummary + FICHA_TO_SKUS_MAP + budget 429 de walk. Fase A/discovery/
//     mapper/agrupación/cuarentena/completitud (ACCEPTED_WALK_SET) SIN cambios de semántica.
//   La autoridad de completitud sigue llenándose SOLO con capturas VERIFIED_OK. Predecesor R7 bff05f87.
const B4_R8Q2_SUCCESSOR_SHA256 = "a478853a7345dd35a88e690241c64c9c91f26e4f486d09a75e70785644577cae";

describe("B5 inmutable + B4 sucesión firmada 2G-R8-Q2", () => {
  it("preserva B5 extracted-product-input como RUNTIME_REQUIRED_FROZEN_CONTENT", () => {
    expect(sha256File(B5_PATH)).toBe(B5_SIGNED_SHA256);
  });

  it("mantiene B4 tiendanube-walker en el sucesor firmado 2G-R8-Q2 (429 recovery)", () => {
    const actual = sha256File(B4_PATH);
    // Estados anteriores deliberadamente sucedidos (G1 frozen → 2G-R3 → 2G-R7 → 2G-R8-Q2).
    expect(actual).not.toBe(B4_G1_FROZEN_SHA256);
    expect(actual).not.toBe(B4_2GR3_SUCCESSOR_SHA256);
    expect(actual).not.toBe(B4_R7_SUCCESSOR_SHA256);
    expect(actual).toBe(B4_R8Q2_SUCCESSOR_SHA256);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BLOQUE 2 — SUCESIÓN FIRMADA DE scraper.service.ts
//
// scraper.service.ts NO es inmutable: es un target activo sujeto a sucesiones firmadas.
// I0 es el antecedente histórico (deliberadamente sucedido); el sucesor firmado vigente
// es G1-B6. I0 va inline (artifacts/ está gitignored y no existe en CI).
//
// PROCEDIMIENTO OBLIGATORIO PARA ACTUALIZAR EL SHA SUCESOR:
//   1. Clasificar el delta de scraper.service.ts.
//   2. Confirmar que todo el delta cae dentro de un alcance explícitamente autorizado.
//   3. Registrar el SHA predecesor y el nuevo sucesor en el reporte del gate.
//   4. Recién entonces actualizar SCRAPER_G1_B6_SUCCESSOR_SHA256.
//
// Está PROHIBIDO borrar, comentar o debilitar esta aserción para hacer pasar CI.
// scraper.service.ts es un target activo; cada cambio autorizado crea una NUEVA sucesión
// firmada, no una excepción al guard.
// ─────────────────────────────────────────────────────────────────────────────
// Sucesión: I0 (histórico) → G1-B6 → 2G-R3 (sitemap-driven wiring).
// Delta 2G-R3 en scraper.service.ts: runTiendaNubeSkuFirst reconstruye startSnapshot.urls
// como URLs absolutas y las pasa como deps.seedProductUrls (discovery sitemap-driven).
// Predecesor G1-B6 b2eae9c9 → sucesor 2G-R3 abajo.
const SCRAPER_I0_SHA256 = "0d3c8a54e5ed64737a1782ac160fa92dab85328d28930905f425ca1e08cbb0d0";
const SCRAPER_G1_B6_SHA256 = "b2eae9c9fc870c2a0d1aac5b85dc7774d79eb24fa361eb677531ade1b481eb4e";
const SCRAPER_2GR3_SUCCESSOR_SHA256 = "632448096364554e980973613e4c7e77289b9a5925978849865cec8a50bb8989";
// 2G-R7: sucesión firmada de scraper.service.ts. Delta autorizado (A login fail-closed §4-§5 +
// observabilidad de cadencia/zero-variant §7-§10): witness de sesión (probe ≤3 fichas) antes del
// walk que lanza SkuFirstLoginError; wiring de nowMs/onProductObserved + navSink; emisión de
// [SkuFirstCadence]/[SkuFirstZeroVariant]/[SkuFirstCaptureFailure]. NO toca D/upsert/Woo/stock/
// completeness. Predecesor 2G-R3 63244809 → sucesor R7 abajo.
const SCRAPER_R7_SUCCESSOR_SHA256 = "c0e20e99afd99b5be0a009c0fb36eee7f2aad807ff220d201ff305d8502aea3d";
// 2G-R8-Q2: sucesión firmada de scraper.service.ts. Delta autorizado (wiring de la recuperación 429 SÓLO
// en el path SKU-first §18): navigateToProduct expone status + Retry-After (sólo ese header); onRateLimit
// emite [SkuFirstRateLimit]/[SkuFirstRateLimitRecovered]/[SkuFirstRateLimitExhausted]/[SkuFirstRateLimit
// BudgetExhausted]; onProductObserved pasa a la taxonomía 4-outcome (SkuFirstDataIncomplete/RateLimitedFicha/
// ReadFailed); log de [SkuFirstOutcomeSummary]/[SkuFirstFichaMap]. NO toca D/upsert/Woo/stock/completeness ni
// el path legacy/FULL (goToNextPage intacto). Predecesor 2G-R7 c0e20e99 → sucesor R8-Q2 abajo.
const SCRAPER_R8Q2_SUCCESSOR_SHA256 = "664d66d91b62da84d7c226eb39ebd1e09df7b181f7f541ac3ef93bb7906ad1fc";

describe("G1/2G — sucesión firmada de scraper.service.ts", () => {
  it("mantiene scraper.service.ts en el sucesor firmado 2G-R8-Q2", () => {
    const actual = sha256File(SCRAPER_SERVICE_PATH);
    // Antecedentes deliberadamente sucedidos (I0 → G1-B6 → 2G-R3 → 2G-R7 → 2G-R8-Q2).
    expect(actual).not.toBe(SCRAPER_I0_SHA256);
    expect(actual).not.toBe(SCRAPER_G1_B6_SHA256);
    expect(actual).not.toBe(SCRAPER_2GR3_SUCCESSOR_SHA256);
    expect(actual).not.toBe(SCRAPER_R7_SUCCESSOR_SHA256);
    // Guard real del estado autorizado vigente.
    expect(actual).toBe(SCRAPER_R8Q2_SUCCESSOR_SHA256);
  });
});
