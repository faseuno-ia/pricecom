// C2-MINI-A · Integration (Postgres real) — el espejo sobrevive al borrado del job.
//
// Es la prueba que JUSTIFICA la separación snapshot/espejo. ExtractedProduct muere por cascade con
// el ExtractionJob; CatalogProduct conserva la última observación válida conocida. Sin este test,
// "el espejo sobrevive" sería una afirmación de diseño sin capacidad detrás.
//
// También verifica contra Postgres real la semántica de frescura del UPDATE, que offline sólo se
// prueba contra un doble.
import "../setup/env";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { testPrisma, truncateAll } from "../setup/db";
import { createTestProvider, createTestUser } from "../helpers/factories";
import {
  persistSupplierTaxonomyObservation,
  buildMirrorUpdate,
} from "../../lib/catalog/supplier-taxonomy-observation";

const T1 = new Date("2026-08-24T10:00:00.000Z");
const T2 = new Date("2026-08-24T12:00:00.000Z");

async function fixture(opts: { sku?: string } = {}) {
  const sku = opts.sku ?? "SKU-1";
  const user = await createTestUser();
  const provider = await createTestProvider(user.id, {});
  const job = await testPrisma.extractionJob.create({
    data: { providerId: provider.id, userId: user.id, status: "COMPLETED" },
  });
  const cp = await testPrisma.catalogProduct.create({
    data: {
      userId: user.id,
      providerId: provider.id,
      sku,
      supplierName: "Producto uno",
      lastSeenAt: new Date(),
    },
  });
  return { user, provider, job, cp, sku };
}

async function snapshot(
  jobId: string,
  providerId: string,
  sku: string | null,
  path: string[],
  observedAt: Date | null,
  uncategorized: boolean | null,
) {
  return testPrisma.extractedProduct.create({
    data: {
      jobId,
      providerId,
      sku,
      name: "Producto uno",
      supplierTaxonomyPath: path,
      supplierTaxonomyObservedAt: observedAt,
      supplierTaxonomyUncategorized: uncategorized,
    },
  });
}

const mirrorOf = (id: string) =>
  testPrisma.catalogProduct.findUniqueOrThrow({
    where: { id },
    select: {
      supplierTaxonomyPath: true,
      supplierTaxonomyObservedAt: true,
      supplierTaxonomyUncategorized: true,
    },
  });

describe("C2-MINI-A · espejo de taxonomía (Postgres real)", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  it("mirror_survives_job_deletion", async () => {
    const { job, provider, cp, sku } = await fixture();
    await snapshot(job.id, provider.id, sku, ["Niños", "Autos a Batería"], T1, false);

    const r = await persistSupplierTaxonomyObservation(testPrisma, { jobId: job.id });
    expect(r.written).toBe(1);

    const antes = await mirrorOf(cp.id);
    expect(antes.supplierTaxonomyPath).toEqual(["Niños", "Autos a Batería"]);
    expect(antes.supplierTaxonomyObservedAt?.getTime()).toBe(T1.getTime());
    expect(antes.supplierTaxonomyUncategorized).toBe(false);

    // El writer dejó su testigo en EventLog, y `EventLog.job` es onDelete: NoAction — la FK BLOQUEA
    // el borrado del job. Es propiedad preexistente del schema, no algo que introduzca el espejo:
    // cualquier borrado real de un ExtractionJob tiene que limpiar antes su audit trail.
    await testPrisma.eventLog.deleteMany({ where: { jobId: job.id } });

    // Ahora sí: borrar el job elimina el snapshot por cascade (ExtractedProduct.job = onDelete: Cascade)…
    await testPrisma.extractionJob.delete({ where: { id: job.id } });
    expect(await testPrisma.extractedProduct.count({ where: { jobId: job.id } })).toBe(0);

    // …y el espejo sigue intacto. Ésa es la razón de que sean dos modelos.
    const despues = await mirrorOf(cp.id);
    expect(despues.supplierTaxonomyPath).toEqual(["Niños", "Autos a Batería"]);
    expect(despues.supplierTaxonomyObservedAt?.getTime()).toBe(T1.getTime());
    expect(despues.supplierTaxonomyUncategorized).toBe(false);
  });

  it("mirror_can_be_rebuilt_from_snapshot_alone_on_real_postgres", async () => {
    const { job, provider, cp, sku } = await fixture();
    await snapshot(job.id, provider.id, sku, ["A", "B", "C"], T1, false);
    await persistSupplierTaxonomyObservation(testPrisma, { jobId: job.id });

    // Se borra el espejo a mano (simula un fallo de materialización); el snapshot sigue durable.
    await testPrisma.catalogProduct.update({
      where: { id: cp.id },
      data: {
        supplierTaxonomyPath: [],
        supplierTaxonomyObservedAt: null,
        supplierTaxonomyUncategorized: null,
      },
    });

    const r = await persistSupplierTaxonomyObservation(testPrisma, { jobId: job.id });

    expect(r.written).toBe(1);
    const m = await mirrorOf(cp.id);
    expect(m.supplierTaxonomyPath).toEqual(["A", "B", "C"]);
    // El observedAt es el ORIGINAL de la observación, no el instante de la reparación.
    expect(m.supplierTaxonomyObservedAt?.getTime()).toBe(T1.getTime());
  });

  it("older_snapshot_cannot_overwrite_newer_mirror_on_real_postgres", async () => {
    const { user, provider, cp, sku } = await fixture();

    // Job NUEVO (T2) materializa primero.
    const nuevo = await testPrisma.extractionJob.create({
      data: { providerId: provider.id, userId: user.id, status: "COMPLETED" },
    });
    await snapshot(nuevo.id, provider.id, sku, ["NUEVO"], T2, false);
    await persistSupplierTaxonomyObservation(testPrisma, { jobId: nuevo.id });

    // Job VIEJO (T1) se re-ejecuta como reparación tardía.
    const viejo = await testPrisma.extractionJob.create({
      data: { providerId: provider.id, userId: user.id, status: "COMPLETED" },
    });
    await snapshot(viejo.id, provider.id, sku, ["VIEJO"], T1, false);
    const r = await persistSupplierTaxonomyObservation(testPrisma, { jobId: viejo.id });

    // La condición de frescura vive en el WHERE: el UPDATE afecta 0 filas.
    expect(r.written).toBe(0);
    expect(r.stale).toBe(1);
    const m = await mirrorOf(cp.id);
    expect(m.supplierTaxonomyPath).toEqual(["NUEVO"]);
    expect(m.supplierTaxonomyObservedAt?.getTime()).toBe(T2.getTime());
  });

  it("absence_does_not_overwrite_previous_observation_on_real_postgres", async () => {
    const { user, provider, cp, sku } = await fixture();

    const conObs = await testPrisma.extractionJob.create({
      data: { providerId: provider.id, userId: user.id, status: "COMPLETED" },
    });
    await snapshot(conObs.id, provider.id, sku, ["A"], T1, false);
    await persistSupplierTaxonomyObservation(testPrisma, { jobId: conObs.id });

    // Attempt posterior cuyo breadcrumb NO se pudo leer.
    const sinObs = await testPrisma.extractionJob.create({
      data: { providerId: provider.id, userId: user.id, status: "COMPLETED" },
    });
    await snapshot(sinObs.id, provider.id, sku, [], null, null);
    const r = await persistSupplierTaxonomyObservation(testPrisma, { jobId: sinObs.id });

    expect(r.written).toBe(0);
    expect(r.skippedNotObserved).toBe(1);
    const m = await mirrorOf(cp.id);
    expect(m.supplierTaxonomyPath).toEqual(["A"]); // la observación válida previa sobrevive
    expect(m.supplierTaxonomyObservedAt?.getTime()).toBe(T1.getTime());
  });

  it("set_based_values_columns_have_the_expected_postgres_types", async () => {
    // §4 · DEMOSTRACIÓN de tipos. No se infiere: se le pregunta a Postgres qué recibió cada columna
    // de `v`. Sin los casts explícitos esta consulta ni siquiera planifica ("could not determine
    // data type of column"), que es el modo de fallo que el proyecto ya conoce entre Prisma y PG.
    const rows = await testPrisma.$queryRaw<
      { sku: string; path: string; observed_at: string; uncategorized: string }[]
    >`
      SELECT pg_typeof(v.sku)::text           AS sku,
             pg_typeof(v.path)::text          AS path,
             pg_typeof(v.observed_at)::text   AS observed_at,
             pg_typeof(v.uncategorized)::text AS uncategorized
      FROM (VALUES (
        ${"SKU-1"}::text,
        ${["Niños", "Autos a Batería"]}::text[],
        ${T1}::timestamp(3),
        ${false}::boolean
      )) AS v(sku, path, observed_at, uncategorized)
    `;

    expect(rows[0]).toEqual({
      sku: "text",
      path: "text[]",
      observed_at: "timestamp without time zone",
      uncategorized: "boolean",
    });
  });

  it("set_based_update_preserves_path_fidelity_and_is_parameterized", async () => {
    const { job, provider, cp } = await fixture({ sku: "SKU-ÑÁ-1" });
    // Acentos, espacios, comillas y un separador que rompería cualquier concatenación ingenua.
    const path = ["Niños", "Autos a Batería 12V", 'Marca "X" > Y', "Ñandú's"];
    await snapshot(job.id, provider.id, "SKU-ÑÁ-1", path, T1, false);

    const sql = buildMirrorUpdate("u", "p", [
      { sku: "SKU-ÑÁ-1", path, observedAt: T1, uncategorized: false },
    ]);
    // El texto del statement NO contiene los valores: viajan como parámetros.
    expect(sql.sql).not.toContain("Ñandú");
    expect(sql.sql).not.toContain("SKU-ÑÁ-1");
    expect(sql.values).toContainEqual(path);

    const r = await persistSupplierTaxonomyObservation(testPrisma, { jobId: job.id });
    expect(r.written).toBe(1);
    const m = await mirrorOf(cp.id);
    expect(m.supplierTaxonomyPath).toEqual(path); // orden, acentos y case intactos
  });
});
