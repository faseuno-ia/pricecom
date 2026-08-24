// NEON-GATE2A-EXEC-2 · CLASE: CHARACTERIZATION
//
// Conducta que NO debe cambiar al pasar el worker a event-driven. Pasa ANTES y DESPUÉS.
//
// Offline: sin DB y sin red. Los dos tests de semántica del claim se afirman sobre el TEXTO del
// SQL (la garantía real es de PostgreSQL: FOR UPDATE SKIP LOCKED y el filtro de source no se
// pueden ejercitar contra un fake). La prueba conductual vive en
// tests/integration/worker-directed-claim.test.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("@/lib/db/client", async () => {
  const { createFakePrisma } = await import("../helpers/fake-prisma");
  const client = createFakePrisma();
  return { prisma: client, default: client };
});

import { prisma as fakePrisma } from "@/lib/db/client";
import { loadFakeDb } from "../helpers/fake-prisma";
import { installWooFetchSpy, type FetchSpyHandle } from "../helpers/fetch-spy";
import {
  buildPublishFixture,
  CATALOG_PRODUCT_ID,
  PROVIDER_DT,
  PROVIDER_IMPOTEKNO,
  STORE_ID,
  STORE_URL,
} from "../helpers/first-publish-fixtures";
import { WooCommerceClient } from "@/lib/integrations/woocommerce/client";
import { publishProductToWoo } from "@/lib/integrations/woocommerce/publication-service";
import { JobLease } from "../../worker/src/job-lease";
import type { LeaseRenewResult } from "../../worker/src/queues/job-queue.interface";

const ROOT = process.cwd();
const claimSource = () =>
  readFileSync(resolve(ROOT, "worker/src/queues/db-polling-queue.ts"), "utf8");

/**
 * El JSDoc de cabecera del archivo transcribe la query de ejemplo, así que contar sobre el texto
 * crudo mezcla comentarios con código. Se cuenta sólo sobre líneas ejecutables.
 */
const claimCode = () =>
  claimSource()
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");

describe("NEON-GATE2A-EXEC-2 · CHARACTERIZATION", () => {
  it("claim_atomicity_prevents_double_execution", () => {
    const src = claimSource();

    // La conmutación PENDING→RUNNING es UN solo statement con la subselect bloqueante.
    // Si alguien la parte en read + write, dos ejecutores pueden ganar el mismo job.
    expect(src).toMatch(/UPDATE "ExtractionJob"/);
    expect(src).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(src).toMatch(/WHERE id = \(/);
    expect(src).toMatch(/RETURNING id, "providerId", "workerLockedAt"/);
    expect(src).toMatch(/status\s*=\s*'RUNNING'/);
    expect(src).toMatch(/status\s*=\s*'PENDING'/);

    // El fencing aguas abajo sigue siendo CAS sobre workerLockedAt.
    expect(src).toMatch(/expectedLeaseVersion/);
    expect(src).toMatch(/status: "RUNNING", workerLockedAt: expectedLeaseVersion/);
  });

  it("import_source_jobs_are_never_claimable", () => {
    const src = claimCode();
    // El filtro de source se conserva en TODA forma de claim que exista en el archivo.
    const claimBlocks = src.match(/FOR UPDATE SKIP LOCKED/g) ?? [];
    expect(claimBlocks.length).toBeGreaterThan(0);
    const sourceFilters = src.match(/"source" IS NULL OR "source" <> 'IMPORT'/g) ?? [];
    expect(
      sourceFilters.length,
      "cada claim debe conservar el filtro de source <> IMPORT",
    ).toBe(claimBlocks.length);
  });

  it("lease_heartbeat_only_during_job", async () => {
    const renewals: string[] = [];
    const renewer = {
      async renewLease(jobId: string): Promise<LeaseRenewResult> {
        renewals.push(jobId);
        return { kind: "OWNED", leaseVersion: new Date() };
      },
    };

    vi.useFakeTimers();
    try {
      const lease = new JobLease("job-1", new Date(), renewer, 1000);

      // Sin start(), el heartbeat NO existe: avanzar el reloj no renueva nada.
      await vi.advanceTimersByTimeAsync(5000);
      expect(renewals).toHaveLength(0);

      lease.start();
      await vi.advanceTimersByTimeAsync(3500);
      expect(renewals.length).toBeGreaterThan(0);

      const afterStop = renewals.length;
      await lease.stop("test");
      await vi.advanceTimersByTimeAsync(10000);
      // Detenido el job, el heartbeat no vuelve a latir.
      expect(renewals).toHaveLength(afterStop);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("first_publish_guardrail_is_unaffected", () => {
    let spy: FetchSpyHandle;
    beforeEach(() => {
      spy = installWooFetchSpy();
    });
    afterEach(() => {
      spy.restore();
    });

    it("par no elegible sigue bloqueado, sin HTTP", async () => {
      loadFakeDb(fakePrisma, buildPublishFixture({ providerId: PROVIDER_DT }));
      const r = await publishProductToWoo(
        fakePrisma,
        new WooCommerceClient(STORE_URL, "k", "s"),
        STORE_ID,
        CATALOG_PRODUCT_ID,
        [],
      );
      expect(r.success).toBe(false);
      expect(r.code).toBe("FIRST_PUBLISH_NOT_ELIGIBLE");
      expect(spy.count()).toBe(0);
    });

    it("par elegible sigue publicando", async () => {
      loadFakeDb(fakePrisma, buildPublishFixture({ providerId: PROVIDER_IMPOTEKNO }));
      const r = await publishProductToWoo(
        fakePrisma,
        new WooCommerceClient(STORE_URL, "k", "s"),
        STORE_ID,
        CATALOG_PRODUCT_ID,
        [],
      );
      expect(r.success).toBe(true);
      expect(spy.count("POST")).toBe(1);
    });
  });
});
