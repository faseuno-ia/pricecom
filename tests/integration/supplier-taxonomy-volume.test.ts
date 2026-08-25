// C2-MINI-A · R-2 · benchmark de volumen DT-like (1121 filas) contra Postgres real de test.
//
// El writer hace UN updateMany por producto. Este proyecto ya tiene evidencia de que ~1121
// operaciones secuenciales contra Neon remoto disparan latencias grandes y P1017
// (worker-job-lease.test.ts). No se asume que este writer sea distinto porque sus filas sean chicas:
// se mide.
//
// REGLA DE DECISIÓN PRE-REGISTRADA (no se ajusta después de ver el resultado):
//   < 15 s  y cero P1017  → PER_ROW_ACCEPTED
//   15–60 s               → PER_ROW_FRAGILE      ⇒ rediseño set-based antes del PR
//   > 60 s                → SET_BASED_REQUIRED
//   cualquier P1017       → SET_BASED_REQUIRED
//
// Interpretación: desde local el RTT contra ci-test es alto y producción tiene worker y Neon en la
// misma región. Un PASS local es evidencia FUERTE a favor del patrón; un FAIL mezclaría RTT con
// patrón. La regla gobierna igual.
import "../setup/env";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { testPrisma, truncateAll } from "../setup/db";
import { createTestProvider, createTestUser } from "../helpers/factories";
import { persistSupplierTaxonomyObservation } from "../../lib/catalog/supplier-taxonomy-observation";

// Parametrizable para calibrar ms/fila sin pagar el lote completo. Default = volumen DT real.
const ROWS = Number(process.env.TAXONOMY_VOLUME_ROWS ?? 1121);
const OBSERVED_AT = new Date("2026-08-24T10:00:00.000Z");
const sku = (i: number) => `DT-${String(i).padStart(5, "0")}`;

describe("C2-MINI-A · R-2 · volumen DT-like (1121 filas)", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  it(
    "mirror_write_volume_1121_rows",
    async () => {
      // ── Fixture (NO medido): createMany, para que el costo del setup no contamine la medición ──
      const user = await createTestUser();
      const provider = await createTestProvider(user.id, {});
      const job = await testPrisma.extractionJob.create({
        data: { providerId: provider.id, userId: user.id, status: "COMPLETED" },
      });

      await testPrisma.catalogProduct.createMany({
        data: Array.from({ length: ROWS }, (_, i) => ({
          userId: user.id,
          providerId: provider.id,
          sku: sku(i),
          supplierName: `Producto ${i}`,
          lastSeenAt: new Date(),
        })),
      });
      await testPrisma.extractedProduct.createMany({
        data: Array.from({ length: ROWS }, (_, i) => ({
          jobId: job.id,
          providerId: provider.id,
          sku: sku(i),
          name: `Producto ${i}`,
          supplierTaxonomyPath: ["Nivel A", `Nivel B ${i % 7}`, `Hoja ${i % 13}`],
          supplierTaxonomyObservedAt: OBSERVED_AT,
          supplierTaxonomyUncategorized: false,
        })),
      });

      // ── Medición ──────────────────────────────────────────────────────────
      // RTT de referencia: separa el costo de red del costo del patrón.
      const rttT0 = Date.now();
      for (let i = 0; i < 5; i++) await testPrisma.$queryRaw`SELECT 1`;
      const rttMs = (Date.now() - rttT0) / 5;

      const t0 = Date.now();
      const r = await persistSupplierTaxonomyObservation(testPrisma, { jobId: job.id });
      const durationMs = Date.now() - t0;

      // P1017 ("server has closed the connection") y timeouts se detectan por el testigo durable:
      // el writer nunca lanza, así que el error queda en EventLog con su reason.
      const failures = await testPrisma.eventLog.findMany({
        where: { jobId: job.id, type: "SUPPLIER_TAXONOMY_MIRROR_FAILED" },
        select: { description: true, metadata: true },
      });
      const blob = JSON.stringify(failures);
      const p1017 = (blob.match(/P1017/g) ?? []).length;
      const timeouts = (blob.match(/P2024|timed out|ETIMEDOUT/gi) ?? []).length;

      // ── Corrección: no basta con que termine ──────────────────────────────
      const correct = await testPrisma.catalogProduct.count({
        where: {
          providerId: provider.id,
          supplierTaxonomyObservedAt: OBSERVED_AT,
          supplierTaxonomyUncategorized: false,
        },
      });

      // eslint-disable-next-line no-console
      console.log(
        `[R-2] rows=${ROWS} durationMs=${durationMs} p1017=${p1017} timeouts=${timeouts} ` +
          `matched=${r.matched} written=${r.written} stale=${r.stale} failed=${r.failed} ` +
          `mirrorsCorrectos=${correct} msPorFila=${(durationMs / ROWS).toFixed(1)} ` +
          `rttMs=${rttMs.toFixed(1)} proyeccion1121=${Math.round((durationMs / ROWS) * 1121)}ms`,
      );

      expect(r.failed).toBe(false);
      expect(r.matched).toBe(ROWS);
      expect(r.written).toBe(ROWS);
      expect(r.stale).toBe(0);
      expect(correct).toBe(ROWS);
      expect(p1017).toBe(0);
      expect(timeouts).toBe(0);
    },
    300_000,
  );
});
