// C2-MINI-A · CLASE: DEFECT_RED · autoridad de espejo de taxonomía
//
// Contrato NUEVO. Deben fallar ANTES de implementar `persistSupplierTaxonomyObservation`.
//
// El módulo se importa DINÁMICAMENTE dentro de cada test: mientras no exista, falla sólo ese test
// en vez de tumbar la carga del archivo y ocultar el rojo real de los demás.
//
// 100% offline. El cliente es un doble que MODELA filas y REGISTRA los argumentos reales enviados
// a Prisma: el testigo fuerte de la autoridad es el `data:` que se ejecuta, no el texto del módulo.

import { describe, it, expect, vi } from "vitest";
import type { Prisma } from "@prisma/client";

/** Captura los eventos REALES que emite el writer (no se afirma sobre el texto del módulo). */
const emitted: { severity: string; type: string; metadata?: Record<string, unknown> }[] = [];
vi.mock("@/lib/events/event-log", () => ({
  logInfo: async (e: { type: string; metadata?: Record<string, unknown> }) => {
    emitted.push({ severity: "INFO", ...e });
  },
  logWarning: async (e: { type: string; metadata?: Record<string, unknown> }) => {
    emitted.push({ severity: "WARNING", ...e });
  },
  logError: async (e: { type: string; metadata?: Record<string, unknown> }) => {
    emitted.push({ severity: "ERROR", ...e });
  },
  logCritical: async () => {},
}));

const JOB = "job-1";
const USER = "user-A";
const PROV = "prov-A";
const T1 = new Date("2026-08-24T10:00:00.000Z");
const T2 = new Date("2026-08-24T12:00:00.000Z");

type SnapRow = {
  sku: string | null;
  supplierTaxonomyPath: string[];
  supplierTaxonomyObservedAt: Date | null;
  supplierTaxonomyUncategorized: boolean | null;
};
type CatRow = {
  id: string;
  userId: string;
  providerId: string;
  sku: string | null;
  supplierTaxonomyObservedAt: Date | null;
  supplierTaxonomyPath?: string[];
};

interface Calls {
  jobSelect: unknown[];
  snapshotSelect: unknown[];
  catalogSelect: unknown[];
  updates: Prisma.Sql[];
}

/** Parámetros por fila del UPDATE set-based: [userId, providerId, (sku, path, observedAt, unc)…]. */
function rowParams(sql: Prisma.Sql) {
  const v = sql.values as unknown[];
  const out: { sku: string; path: string[]; observedAt: Date; uncategorized: boolean | null }[] = [];
  for (let i = 2; i + 3 < v.length + 1; i += 4) {
    out.push({
      sku: v[i] as string,
      path: v[i + 1] as string[],
      observedAt: v[i + 2] as Date,
      uncategorized: v[i + 3] as boolean | null,
    });
  }
  return out;
}
const scopeOf = (sql: Prisma.Sql) => ({
  userId: (sql.values as unknown[])[0] as string,
  providerId: (sql.values as unknown[])[1] as string,
});

/**
 * Doble del cliente. `updateMany` aplica la condición de frescura sobre las filas modeladas, así
 * que la monotonicidad se prueba contra una semántica ejecutada, no contra una aserción de texto.
 */
function makeClient(opts: {
  job?: { userId: string | null; providerId: string } | null;
  snapshot?: SnapRow[];
  catalog?: CatRow[];
  failOnUpdate?: boolean;
}) {
  const job = opts.job === undefined ? { userId: USER, providerId: PROV } : opts.job;
  const snapshot = opts.snapshot ?? [];
  const catalog = opts.catalog ?? [];
  const calls: Calls = { jobSelect: [], snapshotSelect: [], catalogSelect: [], updates: [] };

  const client = {
    extractionJob: {
      findUnique: async (a: unknown) => {
        calls.jobSelect.push(a);
        return job;
      },
    },
    extractedProduct: {
      findMany: async (a: unknown) => {
        calls.snapshotSelect.push(a);
        return snapshot.map((r) => ({ ...r }));
      },
    },
    catalogProduct: {
      findMany: async (a: {
        where?: { userId?: string; providerId?: string; sku?: { in?: string[] } };
      }) => {
        calls.catalogSelect.push(a);
        const skus = a?.where?.sku?.in ?? [];
        return catalog
          .filter(
            (c) =>
              c.userId === a?.where?.userId &&
              c.providerId === a?.where?.providerId &&
              typeof c.sku === "string" &&
              skus.includes(c.sku),
          )
          .map((c) => ({ id: c.id, sku: c.sku }));
      },
    },
    /**
     * Interpreta el statement REAL: lee `sql.values` (los parámetros) y aplica la semántica de
     * tenancy y frescura sobre las filas modeladas. No inspecciona el módulo: ejecuta su salida.
     */
    $queryRaw: async (sql: Prisma.Sql) => {
      calls.updates.push(sql);
      if (opts.failOnUpdate) throw new Error("__DB_DOWN__");
      const { userId, providerId } = scopeOf(sql);
      // El doble HONRA el statement en vez de hardcodear su semántica: aplica cada predicado sólo
      // si el SQL realmente lo contiene. Sin esto, un WHERE al que le falte una condición seguiría
      // pasando los tests —el doble la aplicaría igual— y el test no protegería nada.
      const filtraUser = sql.sql.includes('cp."userId"     = scope.user_id');
      const filtraProvider = sql.sql.includes('cp."providerId" = scope.provider_id');
      const filtraFrescura = sql.sql.includes('cp."supplierTaxonomyObservedAt" <= v.observed_at');
      const out: { sku: string }[] = [];
      for (const r of rowParams(sql)) {
        // Tenancy: los TRES componentes, como en el WHERE del UPDATE.
        const row = catalog.find(
          (c) =>
            (!filtraUser || c.userId === userId) &&
            (!filtraProvider || c.providerId === providerId) &&
            c.sku === r.sku,
        );
        if (!row) continue;
        const cur = row.supplierTaxonomyObservedAt;
        const fresh = cur === null || cur.getTime() <= r.observedAt.getTime();
        if (filtraFrescura && !fresh) continue;
        row.supplierTaxonomyObservedAt = r.observedAt;
        row.supplierTaxonomyPath = r.path;
        out.push({ sku: r.sku });
      }
      return out as never;
    },
  };
  return { client, calls, catalog };
}

const observed = (path: string[], at: Date, unc = false): SnapRow => ({
  sku: "SKU-1",
  supplierTaxonomyPath: path,
  supplierTaxonomyObservedAt: at,
  supplierTaxonomyUncategorized: unc,
});

const notObserved = (sku: string | null = "SKU-1"): SnapRow => ({
  sku,
  supplierTaxonomyPath: [],
  supplierTaxonomyObservedAt: null,
  supplierTaxonomyUncategorized: null,
});

const catRow = (over: Partial<CatRow> = {}): CatRow => ({
  id: "cp-1",
  userId: USER,
  providerId: PROV,
  sku: "SKU-1",
  supplierTaxonomyObservedAt: null,
  ...over,
});

async function run(client: unknown, jobId = JOB) {
  const { persistSupplierTaxonomyObservation } = await import(
    "@/lib/catalog/supplier-taxonomy-observation"
  );
  return persistSupplierTaxonomyObservation(client as never, { jobId });
}

describe("C2-MINI-A · DEFECT_RED · autoridad de espejo", () => {
  // ── Los tres estados ─────────────────────────────────────────────────────────────

  it("taxonomy_state_observed_path", async () => {
    const { client, calls } = makeClient({
      snapshot: [observed(["A", "B", "C"], T1)],
      catalog: [catRow()],
    });
    const r = await run(client);

    expect(calls.updates).toHaveLength(1);
    expect(rowParams(calls.updates[0])[0]).toEqual({
      sku: "SKU-1",
      path: ["A", "B", "C"],
      observedAt: T1,
      uncategorized: false,
    });
    expect(r.written).toBe(1);
  });

  it("taxonomy_state_uncategorized", async () => {
    const { client, calls } = makeClient({
      snapshot: [observed([], T1, true)],
      catalog: [catRow()],
    });
    const r = await run(client);

    // Observación VÁLIDA sin categoría material: sí actualiza el espejo.
    expect(rowParams(calls.updates[0])[0]).toEqual({
      sku: "SKU-1",
      path: [],
      observedAt: T1,
      uncategorized: true,
    });
    expect(r.written).toBe(1);
  });

  it("taxonomy_state_not_observed", async () => {
    const { client, calls } = makeClient({
      snapshot: [notObserved()],
      catalog: [catRow()],
    });
    const r = await run(client);

    expect(calls.updates).toHaveLength(0);
    expect(r.written).toBe(0);
    expect(r.skippedNotObserved).toBe(1);
  });

  it("absence_does_not_overwrite_previous_observation", async () => {
    const { client, calls, catalog } = makeClient({
      snapshot: [notObserved()],
      catalog: [catRow({ supplierTaxonomyObservedAt: T1 })],
    });
    await run(client);

    // La observación previa sobrevive intacta: ausencia no da autoridad de borrado.
    expect(calls.updates).toHaveLength(0);
    expect(catalog[0].supplierTaxonomyObservedAt).toEqual(T1);
  });

  // ── SKU inválido · las tres clases, por separado ─────────────────────────────────

  it("invalid_sku_is_skipped", async () => {
    for (const bad of [null, "", "   "]) {
      const { client, calls } = makeClient({
        snapshot: [{ ...observed(["A"], T1), sku: bad }],
        catalog: [catRow()],
      });
      const r = await run(client);
      expect(calls.updates, "sku=" + JSON.stringify(bad)).toHaveLength(0);
      expect(r.skippedNoSku, "sku=" + JSON.stringify(bad)).toBe(1);
    }

    // CONTROL POSITIVO — sin esto, "cero updates" se cumple sola si el writer no escribe nunca.
    const ok = makeClient({ snapshot: [observed(["A"], T1)], catalog: [catRow()] });
    expect((await run(ok.client)).written).toBe(1);
  });

  // ── Duplicados ───────────────────────────────────────────────────────────────────

  it("duplicate_same_observation_collapses", async () => {
    const { client, calls } = makeClient({
      snapshot: [observed(["A", "B"], T1), observed(["A", "B"], T1)],
      catalog: [catRow()],
    });
    const r = await run(client);

    expect(calls.updates).toHaveLength(1); // una sola escritura
    expect(r.written).toBe(1);
    expect(r.conflicted).toBe(0);
  });

  it("duplicate_conflicting_observation_skips_with_witness", async () => {
    const { client, calls } = makeClient({
      snapshot: [observed(["A", "B"], T1), observed(["X", "Y"], T1)],
      catalog: [catRow()],
    });
    const r = await run(client);

    // No se elige una fila arbitraria: no se escribe nada para ese sku.
    expect(calls.updates).toHaveLength(0);
    expect(r.conflicted).toBe(1);
    expect(r.written).toBe(0);
    expect(r.conflictedSkus).toEqual(["SKU-1"]);
  });

  // ── Match al catálogo y tenancy ──────────────────────────────────────────────────

  it("missing_catalog_product_is_not_created", async () => {
    const { client, calls } = makeClient({ snapshot: [observed(["A"], T1)], catalog: [] });
    const r = await run(client);

    expect(calls.updates).toHaveLength(0);
    expect(r.matched).toBe(0);
    expect(r.notInCatalog).toBe(1);
  });

  it("taxonomy_authority_rejects_inconsistent_tenancy", async () => {
    // Mismo sku bajo OTRO tenant y OTRO proveedor. El job pertenece a (USER, PROV).
    const otro = catRow({ id: "cp-otro", userId: "user-B", providerId: "prov-B" });
    const { client, calls } = makeClient({ snapshot: [observed(["A"], T1)], catalog: [otro] });
    const r = await run(client);

    expect(calls.updates).toHaveLength(0);
    expect(r.written).toBe(0);
    // El where del catálogo se acota con lo DERIVADO del job, no con lo que pase un caller.
    const w = (calls.catalogSelect[0] as { where: { userId: string; providerId: string } }).where;
    expect(w.userId).toBe(USER);
    expect(w.providerId).toBe(PROV);
  });

  it("job_without_user_produces_no_writes", async () => {
    const { client, calls } = makeClient({
      job: { userId: null, providerId: PROV },
      snapshot: [observed(["A"], T1)],
      catalog: [catRow()],
    });
    const r = await run(client);
    expect(calls.updates).toHaveLength(0);
    expect(r.written).toBe(0);
  });

  // ── Monotonicidad ────────────────────────────────────────────────────────────────

  it("older_snapshot_cannot_overwrite_newer_mirror", async () => {
    const { client, calls, catalog } = makeClient({
      snapshot: [observed(["VIEJO"], T1)], // T1 = 10:00
      catalog: [catRow({ supplierTaxonomyObservedAt: T2 })], // espejo en T2 = 12:00
    });
    const r = await run(client);

    // El statement se emite, pero su WHERE de frescura no matchea ⇒ cero filas afectadas.
    expect(calls.updates).toHaveLength(1);
    expect(r.written).toBe(0);
    expect(r.stale).toBe(1);
    expect(catalog[0].supplierTaxonomyObservedAt).toEqual(T2);
  });

  it("same_timestamp_reexecution_is_idempotent", async () => {
    const { client, catalog } = makeClient({
      snapshot: [observed(["A", "B"], T1)],
      catalog: [catRow({ supplierTaxonomyObservedAt: T1 })],
    });
    const r = await run(client);

    // T1 == T1 debe poder reescribir: es lo que habilita reparar un espejo parcialmente dañado
    // sin romper el no-retroceso.
    expect(r.written).toBe(1);
    expect(catalog[0].supplierTaxonomyObservedAt).toEqual(T1);
  });

  it("freshness_condition_lives_in_the_where", async () => {
    const { client, calls } = makeClient({ snapshot: [observed(["A"], T1)], catalog: [catRow()] });
    await run(client);

    // La condición temporal es parte del statement EJECUTADO, no una comparación en JS entre un
    // SELECT y un UPDATE: eso último abriría una carrera entre lectura y escritura.
    const sql = calls.updates[0].sql;
    expect(sql).toContain('cp."supplierTaxonomyObservedAt" IS NULL');
    expect(sql).toContain('cp."supplierTaxonomyObservedAt" <= v.observed_at');
  });

  // ── Autoridad: allowlists ────────────────────────────────────────────────────────

  it("supplier_taxonomy_authority_writes_exactly_three_keys", async () => {
    const { client, calls } = makeClient({
      snapshot: [observed(["A"], T1)],
      catalog: [catRow()],
    });
    await run(client);

    // El SET del statement EJECUTADO asigna exactamente tres columnas, y ninguna es de precio.
    const sql = calls.updates[0].sql;
    const setClause = sql.slice(sql.indexOf("SET "), sql.indexOf("FROM (VALUES"));
    const assigned = [...setClause.matchAll(/"(\w+)"\s*=/g)].map((m) => m[1]).sort();
    expect(assigned).toEqual([
      "supplierTaxonomyObservedAt",
      "supplierTaxonomyPath",
      "supplierTaxonomyUncategorized",
    ]);
    for (const forbidden of ["wholesalePrice", "lastSeenAt", "latestExtractedProductId", "finalPrice"]) {
      expect(sql, "el UPDATE no puede nombrar " + forbidden).not.toContain(forbidden);
    }
  });

  it("supplier_taxonomy_authority_cannot_read_price_columns", async () => {
    const { client, calls } = makeClient({
      snapshot: [observed(["A"], T1)],
      catalog: [catRow()],
    });
    await run(client);

    const blob =
      JSON.stringify(calls.snapshotSelect) +
      JSON.stringify(calls.catalogSelect) +
      calls.updates.map((u) => u.sql).join(" ");
    for (const forbidden of [
      "wholesalePrice",
      "oldPrice",
      "finalPrice",
      "manualMargin",
      "lastSeenAt",
      "latestExtractedProductId",
    ]) {
      expect(blob, "no debe pedir " + forbidden).not.toContain(forbidden);
    }
    // Control positivo: sí pide lo que necesita.
    expect(blob).toContain("supplierTaxonomyObservedAt");
    expect(blob).toContain("sku");
  });

  // ── Gating por datos ─────────────────────────────────────────────────────────────

  it("legacy_providers_produce_no_taxonomy_writes", async () => {
    // Proveedor legacy: snapshot completo, ninguna observación.
    const legacy = makeClient({
      snapshot: [notObserved("L-1"), notObserved("L-2")],
      catalog: [catRow({ id: "cp-l1", sku: "L-1" }), catRow({ id: "cp-l2", sku: "L-2" })],
    });
    const r = await run(legacy.client);

    expect(legacy.calls.updates).toHaveLength(0);
    expect(r.written).toBe(0);
    // R-3 · el resumen SÍ se emite aunque no haya nada que materializar: es lo que distingue
    // "corrió y no escribió" de "nunca corrió".
    expect(r.emittedSummary).toBe(true);

    // CONTROL POSITIVO en el mismo camino: un job con observación SÍ produce el write.
    const dt = makeClient({ snapshot: [observed(["A"], T1)], catalog: [catRow()] });
    const rdt = await run(dt.client);
    expect(dt.calls.updates).toHaveLength(1);
    expect(rdt.written).toBe(1);
    expect(rdt.emittedSummary).toBe(true);
  });

  // ── Failure policy ───────────────────────────────────────────────────────────────

  it("taxonomy_write_failure_does_not_abort_extraction", async () => {
    const { client } = makeClient({
      snapshot: [observed(["A"], T1)],
      catalog: [catRow()],
      failOnUpdate: true,
    });

    // NUNCA lanza: un fallo del espejo no puede alterar el terminal del job ni los precios.
    const r = await run(client);
    expect(r.failed).toBe(true);
    expect(r.written).toBe(0);
  });

  // ── Reconstrucción ───────────────────────────────────────────────────────────────

  it("mirror_can_be_rebuilt_from_snapshot_alone", async () => {
    // El espejo fue borrado; el snapshot sigue durable. Re-ejecutar el MISMO jobId lo reconstruye,
    // y lo hace con el observedAt ORIGINAL, no con el instante de la reparación.
    const { client, catalog } = makeClient({
      snapshot: [observed(["A", "B", "C"], T1)],
      catalog: [catRow({ supplierTaxonomyObservedAt: null })],
    });
    const r = await run(client);

    expect(r.written).toBe(1);
    expect(catalog[0].supplierTaxonomyObservedAt).toEqual(T1);
  });

  // ── SET-BASED · propiedades de la forma nueva ────────────────────────────────────

  it("set_based_writer_preserves_exact_three_key_authority", async () => {
    const { client, calls } = makeClient({ snapshot: [observed(["A"], T1)], catalog: [catRow()] });
    await run(client);

    const sql = calls.updates[0].sql;
    // Los valores viajan como PARÁMETROS, no concatenados en el texto: el SKU no aparece literal.
    expect(sql).not.toContain("SKU-1");
    expect((calls.updates[0].values as unknown[])).toContain("SKU-1");
    // Y los casts son explícitos, uno por columna de `v`.
    expect(sql).toContain("::text[]");
    expect(sql).toContain("::timestamp(3)");
    expect(sql).toContain("::boolean");
  });

  it("same_sku_in_other_provider_is_not_touched", async () => {
    const ajeno = catRow({ id: "cp-otro", providerId: "prov-B", supplierTaxonomyObservedAt: null });
    const propio = catRow({ id: "cp-mio" });
    const { client, catalog } = makeClient({
      snapshot: [observed(["A"], T1)],
      catalog: [ajeno, propio],
    });
    const r = await run(client);

    // CONTROL POSITIVO: el del proveedor correcto SÍ se escribe…
    expect(r.written).toBe(1);
    expect(catalog.find((c) => c.id === "cp-mio")!.supplierTaxonomyObservedAt).toEqual(T1);
    // …y el del otro proveedor queda intacto pese a compartir SKU.
    expect(catalog.find((c) => c.id === "cp-otro")!.supplierTaxonomyObservedAt).toBeNull();
  });

  it("same_sku_in_other_user_is_not_touched", async () => {
    const ajeno = catRow({ id: "cp-otro", userId: "user-B", supplierTaxonomyObservedAt: null });
    const propio = catRow({ id: "cp-mio" });
    const { client, catalog } = makeClient({
      snapshot: [observed(["A"], T1)],
      catalog: [ajeno, propio],
    });
    const r = await run(client);

    expect(r.written).toBe(1);
    expect(catalog.find((c) => c.id === "cp-mio")!.supplierTaxonomyObservedAt).toEqual(T1);
    expect(catalog.find((c) => c.id === "cp-otro")!.supplierTaxonomyObservedAt).toBeNull();
  });

  // ── Contadores · el desglose no se degrada al pasar a set-based ──────────────────

  it("counter_written_is_preserved", async () => {
    const snap = [0, 1, 2].map((i) => ({ ...observed(["A"], T1), sku: `S-${i}` }));
    const cat = [0, 1, 2].map((i) => catRow({ id: `cp-${i}`, sku: `S-${i}` }));
    const { client } = makeClient({ snapshot: snap, catalog: cat });
    const r = await run(client);

    expect(r.written).toBe(3);
    expect(r.matched).toBe(3);
    expect(r.stale).toBe(0);
    expect(r.notInCatalog).toBe(0);
  });

  it("counter_stale_is_preserved", async () => {
    // Existe en catálogo, pero el espejo es MÁS NUEVO ⇒ no entra en RETURNING ⇒ stale.
    const snap = [
      { ...observed(["NUEVO"], T1), sku: "S-0" },
      { ...observed(["OK"], T1), sku: "S-1" },
    ];
    const cat = [
      catRow({ id: "cp-0", sku: "S-0", supplierTaxonomyObservedAt: T2 }),
      catRow({ id: "cp-1", sku: "S-1" }),
    ];
    const { client } = makeClient({ snapshot: snap, catalog: cat });
    const r = await run(client);

    expect(r.matched).toBe(2);
    expect(r.written).toBe(1); // sólo S-1
    expect(r.stale).toBe(1); // S-0: existe pero el espejo es más nuevo
    expect(r.notInCatalog).toBe(0);
  });

  it("counter_not_in_catalog_is_preserved", async () => {
    // `stale` y `notInCatalog` NO se colapsan: son causas operativamente distintas.
    const snap = [
      { ...observed(["A"], T1), sku: "S-0" }, // no existe en catálogo
      { ...observed(["B"], T1), sku: "S-1" }, // existe, espejo más nuevo
      { ...observed(["C"], T1), sku: "S-2" }, // existe y escribe
    ];
    const cat = [
      catRow({ id: "cp-1", sku: "S-1", supplierTaxonomyObservedAt: T2 }),
      catRow({ id: "cp-2", sku: "S-2" }),
    ];
    const { client } = makeClient({ snapshot: snap, catalog: cat });
    const r = await run(client);

    expect(r.notInCatalog).toBe(1); // S-0
    expect(r.stale).toBe(1); // S-1
    expect(r.written).toBe(1); // S-2
    expect(r.matched).toBe(2);
  });

  // ── Round-trips O(1) ─────────────────────────────────────────────────────────────

  it("set_based_writer_uses_constant_number_of_write_statements", async () => {
    const build = (n: number) => {
      const snap = Array.from({ length: n }, (_, i) => ({ ...observed(["A"], T1), sku: `S-${i}` }));
      const cat = Array.from({ length: n }, (_, i) => catRow({ id: `cp-${i}`, sku: `S-${i}` }));
      return makeClient({ snapshot: snap, catalog: cat });
    };
    const total = (c: Calls) =>
      c.jobSelect.length + c.snapshotSelect.length + c.catalogSelect.length + c.updates.length;

    const uno = build(1);
    const rUno = await run(uno.client);
    const mil = build(1121);
    const rMil = await run(mil.client);

    // Control positivo: ambos ESCRIBIERON. Sin esto, "mismo número de statements" se cumpliría
    // sola si el writer no hiciera nada.
    expect(rUno.written).toBe(1);
    expect(rMil.written).toBe(1121);

    // UN statement de escritura en ambos casos: los round-trips no dependen de N.
    expect(uno.calls.updates).toHaveLength(1);
    expect(mil.calls.updates).toHaveLength(1);
    expect(total(uno.calls)).toBe(total(mil.calls));
    expect(total(mil.calls)).toBe(4); // job + snapshot + catálogo + update
  });

  // ── R-3 · testigo durable incluso con cero writes ────────────────────────────────

  it("taxonomy_summary_emits_on_zero_writes", async () => {
    // CASO NEGATIVO · proveedor legacy: snapshot completo, ninguna observación.
    emitted.length = 0;
    const legacy = makeClient({
      snapshot: [notObserved("L-1"), notObserved("L-2"), notObserved("L-3")],
      catalog: [catRow({ id: "cp-l1", sku: "L-1" })],
    });
    const r = await run(legacy.client);

    expect(legacy.calls.updates).toHaveLength(0); // cero escrituras de taxonomía
    const summaries = emitted.filter((e) => e.type === "SUPPLIER_TAXONOMY_MIRROR_SUMMARY");
    expect(summaries).toHaveLength(1); // EXACTAMENTE uno
    expect(summaries[0].metadata).toMatchObject({
      written: 0,
      candidates: 0,
      totalSnapshots: 3,
      skippedNotObserved: 3,
    });
    expect(r.written).toBe(0);
    expect(r.emittedSummary).toBe(true);
    // MIRRORED ya no existe: `written` en el payload dice si hubo materialización.
    expect(emitted.filter((e) => e.type === "SUPPLIER_TAXONOMY_MIRRORED")).toHaveLength(0);
    expect(emitted.filter((e) => e.type === "SUPPLIER_TAXONOMY_MIRROR_FAILED")).toHaveLength(0);

    // CONTROL POSITIVO en el mismo camino · job DT con observación.
    emitted.length = 0;
    const dt = makeClient({ snapshot: [observed(["A", "B"], T1)], catalog: [catRow()] });
    const rdt = await run(dt.client);

    const dtSummaries = emitted.filter((e) => e.type === "SUPPLIER_TAXONOMY_MIRROR_SUMMARY");
    expect(dtSummaries).toHaveLength(1);
    expect(dtSummaries[0].metadata).toMatchObject({ written: 1, candidates: 1, totalSnapshots: 1 });
    expect(rdt.written).toBe(1);
  });

  it("mirror_failed_is_reserved_for_errors", async () => {
    emitted.length = 0;
    const { client } = makeClient({
      snapshot: [observed(["A"], T1)],
      catalog: [catRow()],
      failOnUpdate: true,
    });
    const r = await run(client);

    expect(r.failed).toBe(true);
    expect(emitted.filter((e) => e.type === "SUPPLIER_TAXONOMY_MIRROR_FAILED")).toHaveLength(1);
    // Un fallo NO emite resumen de terminación normal.
    expect(emitted.filter((e) => e.type === "SUPPLIER_TAXONOMY_MIRROR_SUMMARY")).toHaveLength(0);
    expect(r.emittedSummary).toBe(false);
  });
});
