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
// BLOQUE 1 — INMUTABLES B4/B5 (RUNTIME_REQUIRED_FROZEN_CONTENT)
//
// B4 y B5 son inmutables firmados. Un cambio de SHA es un DEFECTO hasta que exista
// una decisión explícita que descongele el archivo. No actualizar estas constantes
// como reacción automática a un fallo de CI.
// ─────────────────────────────────────────────────────────────────────────────
const B4_SIGNED_SHA256 = "1db776adb0d2e642ab815032073f113d07513e1bb1f79a8c395ef564bb719cb7";
const B5_SIGNED_SHA256 = "5091077200502b36f538d9b626ae2ea2f0e30e935cc685fb8b79a657aa1cb9b0";

describe("G1 — inmutables B4/B5 (RUNTIME_REQUIRED_FROZEN_CONTENT)", () => {
  it("preserva B4 tiendanube-walker como RUNTIME_REQUIRED_FROZEN_CONTENT", () => {
    expect(sha256File(B4_PATH)).toBe(B4_SIGNED_SHA256);
  });

  it("preserva B5 extracted-product-input como RUNTIME_REQUIRED_FROZEN_CONTENT", () => {
    expect(sha256File(B5_PATH)).toBe(B5_SIGNED_SHA256);
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
const SCRAPER_I0_SHA256 = "0d3c8a54e5ed64737a1782ac160fa92dab85328d28930905f425ca1e08cbb0d0";
const SCRAPER_G1_B6_SUCCESSOR_SHA256 = "b2eae9c9fc870c2a0d1aac5b85dc7774d79eb24fa361eb677531ade1b481eb4e";

describe("G1 — sucesión firmada de scraper.service.ts", () => {
  it("mantiene scraper.service.ts en el sucesor firmado G1-B6", () => {
    const actual = sha256File(SCRAPER_SERVICE_PATH);
    // I0 fue sucedido deliberadamente: el estado actual NO es el antecedente histórico.
    expect(actual).not.toBe(SCRAPER_I0_SHA256);
    // Guard real del estado autorizado vigente.
    expect(actual).toBe(SCRAPER_G1_B6_SUCCESSOR_SHA256);
  });
});
