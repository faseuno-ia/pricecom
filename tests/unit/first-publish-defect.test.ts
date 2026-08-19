// C2-DESIGN-1 · Gate 2 · CLASE: DEFECT_RED
//
// Estos tests deben FALLAR contra el código actual: reproducen el agujero auditado en C2-PRE0
// (ACCIDENTAL_DT_PUBLICATION_IS_POSSIBLE_TODAY = true). Hoy los tres caminos que alcanzan
// `client.createProduct` (publication-service.ts:329) no consultan ninguna autoridad de
// storefront eligibility:
//
//   app/api/catalog/bulk-update/route.ts:194
//   app/api/my-store/sync/publications/route.ts:157
//   lib/catalog/upsert-catalog-products.ts:166
//
// 100% offline: fake de Prisma en memoria + spy de `fetch`. Cero conexiones a la DB.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/db/client", async () => {
  const { createFakePrisma } = await import("../helpers/fake-prisma");
  const client = createFakePrisma();
  return { prisma: client, default: client };
});

vi.mock("@/lib/auth", () => ({
  requireSession: async () => ({ user: { id: "cmp504wd40000t25nssc377rw" } }),
  getSession: async () => ({ user: { id: "cmp504wd40000t25nssc377rw" } }),
}));

import { prisma as fakePrisma } from "@/lib/db/client";
import {
  domainWrites,
  eventLogRows,
  loadFakeDb,
  type FakeDb,
  type FakePrismaHandle,
  type FakeRow,
} from "../helpers/fake-prisma";
import { installWooFetchSpy, type FetchSpyHandle } from "../helpers/fetch-spy";
import { mockWooFromIntegration } from "../helpers/woo-mock";
import {
  buildPublishFixture,
  buildWorkerReappearFixture,
  CATALOG_PRODUCT_ID,
  PROVIDER_DT,
  PROVIDER_IMPOTEKNO,
  PROVIDER_LACHIPELU,
  STORE_ID,
  STORE_URL,
  WORKER_CATALOG_PRODUCT_ID,
} from "../helpers/first-publish-fixtures";
import { WooCommerceClient } from "@/lib/integrations/woocommerce/client";
import { publishProductToWoo } from "@/lib/integrations/woocommerce/publication-service";
import { upsertCatalogProducts } from "@/lib/catalog/upsert-catalog-products";
import { POST as bulkUpdatePOST } from "@/app/api/catalog/bulk-update/route";
import { POST as syncPOST } from "@/app/api/my-store/sync/publications/route";
import type { NextRequest } from "next/server";

const handle = fakePrisma as unknown as FakePrismaHandle;

const DENY_CODE = "FIRST_PUBLISH_NOT_ELIGIBLE";

function jsonRequest(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

function directClient(): WooCommerceClient {
  return new WooCommerceClient(STORE_URL, "key", "secret");
}

function load(db: FakeDb): void {
  loadFakeDb(fakePrisma, db);
}

function pubRows(): FakeRow[] {
  return handle.__db.productPublication ?? [];
}

function denyEvents(): FakeRow[] {
  return eventLogRows(fakePrisma).filter((r) => r.type === "FIRST_PUBLISH_DENIED");
}

describe("C2-DESIGN-1 · DEFECT_RED · primera publicación sin autorización", () => {
  let spy: FetchSpyHandle;
  let restoreFromIntegration: () => void;

  beforeEach(() => {
    spy = installWooFetchSpy();
    restoreFromIntegration = mockWooFromIntegration();
  });

  afterEach(() => {
    spy.restore();
    restoreFromIntegration();
  });

  // ── Un test por cada camino a W1 (D-6.1) ─────────────────────────────────────────────

  it("first_publish_denied_via_manual_bulk_update", async () => {
    load(buildPublishFixture({ providerId: PROVIDER_DT }));

    const res = await bulkUpdatePOST(
      jsonRequest({ productIds: [CATALOG_PRODUCT_ID], action: "publish" }),
    );
    const body = (await res.json()) as {
      published: number;
      errors: { id: string; error: string }[];
    };

    expect(body.published).toBe(0);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].error).toContain("PricEcom");
    expect(spy.count("POST")).toBe(0);
    expect(pubRows()).toHaveLength(0);
  });

  it("first_publish_denied_via_my_store_sync", async () => {
    // Publication existente SIN externalProductId ⇒ el branch de :229 entra en CREATE.
    load(
      buildPublishFixture({
        providerId: PROVIDER_DT,
        publicationWithoutRemoteId: true,
      }),
    );

    const res = await syncPOST(
      jsonRequest({ catalogProductIds: [CATALOG_PRODUCT_ID] }),
    );
    const body = (await res.json()) as {
      synced: number;
      errors: { catalogProductId: string; error: string }[];
    };

    expect(body.synced).toBe(0);
    expect(body.errors).toHaveLength(1);
    expect(spy.count("POST")).toBe(0);
    // La fila NO se modifica en un DENY (D-4.2: PRODUCTPUBLICATION_ON_DENY = no).
    expect(pubRows()[0].externalProductId).toBeNull();
    expect(pubRows()[0].syncStatus).toBe("SYNCED");
  });

  it("first_publish_denied_via_worker_handle_reappeared", async () => {
    load(buildWorkerReappearFixture(PROVIDER_DT));

    await upsertCatalogProducts("job-1", fakePrisma);

    expect(spy.count("POST")).toBe(0);
    expect(pubRows()[0].externalProductId).toBeNull();
  });

  // ── DT / no elegible: cero interacción con Woo y cero writes (D-6.2) ─────────────────

  it("ineligible_first_publish_performs_zero_woo_http", async () => {
    load(buildPublishFixture({ providerId: PROVIDER_DT }));

    const result = await publishProductToWoo(
      fakePrisma,
      directClient(),
      STORE_ID,
      CATALOG_PRODUCT_ID,
      [],
    );

    expect(result.success).toBe(false);
    expect(result.code).toBe(DENY_CODE);
    // Incluye el GET de assertSkuNotInWoo (publication-service.ts:311), no sólo el POST.
    expect(spy.byMethod()).toEqual({ GET: 0, POST: 0, PUT: 0, DELETE: 0 });
    expect(spy.count()).toBe(0);
  });

  it("ineligible_first_publish_performs_zero_db_writes", async () => {
    load(buildPublishFixture({ providerId: PROVIDER_DT }));

    await publishProductToWoo(
      fakePrisma,
      directClient(),
      STORE_ID,
      CATALOG_PRODUCT_ID,
      [],
    );

    // Cero writes de DOMINIO. El único write admitido es el audit trail (eventLog).
    expect(domainWrites(fakePrisma)).toEqual([]);
    expect(pubRows()).toHaveLength(0);
    expect((handle.__db.catalogProduct ?? [])[0].internalStatus).toBe("PREPARED");
  });

  // ── Matriz fail-closed (D-6.7) ───────────────────────────────────────────────────────

  it("authority_absent_denies_first_publish", async () => {
    // LACHIPELU - Vanesa: fuera del seed por decisión explícita (isActive=false) ⇒ E3.
    load(buildPublishFixture({ providerId: PROVIDER_LACHIPELU }));

    const result = await publishProductToWoo(
      fakePrisma,
      directClient(),
      STORE_ID,
      CATALOG_PRODUCT_ID,
      [],
    );

    expect(result.success).toBe(false);
    expect(result.code).toBe(DENY_CODE);
    expect(spy.count()).toBe(0);
    expect(denyEvents()).toHaveLength(1);
    expect((denyEvents()[0].metadata as { reason?: string })?.reason).toBe("ABSENT");
  });

  it("authority_explicitly_ineligible_denies", async () => {
    load(buildPublishFixture({ providerId: PROVIDER_DT }));

    const result = await publishProductToWoo(
      fakePrisma,
      directClient(),
      STORE_ID,
      CATALOG_PRODUCT_ID,
      [],
    );

    expect(result.success).toBe(false);
    expect(denyEvents()).toHaveLength(1);
    expect((denyEvents()[0].metadata as { reason?: string })?.reason).toBe("EXPLICIT");
  });

  it("authority_null_input_denies", async () => {
    // storeId vacío ⇒ el par no se puede resolver. Proveedor ELIGIBLE a propósito: lo que
    // falta es el otro eje de la clave, y sin par no hay autorización posible.
    load(buildPublishFixture({ providerId: PROVIDER_IMPOTEKNO }));

    const result = await publishProductToWoo(
      fakePrisma,
      directClient(),
      "",
      CATALOG_PRODUCT_ID,
      [],
    );

    expect(result.success).toBe(false);
    expect(result.code).toBe(DENY_CODE);
    expect(spy.count()).toBe(0);
    expect((denyEvents()[0]?.metadata as { reason?: string })?.reason).toBe(
      "UNRESOLVABLE",
    );
  });

  it("authority_resolution_error_denies", async () => {
    // Fail-closed ante fallo de la propia autoridad (E5). Se inyecta un lookup que lanza:
    // no hace falta mockear módulos, y prueba que canFirstPublish es TOTAL (nunca propaga).
    const { canFirstPublish } = await import("@/lib/publishing/first-publish-authority");

    const verdict = canFirstPublish(PROVIDER_IMPOTEKNO, STORE_ID, () => {
      throw new Error("autoridad corrupta");
    });

    expect(verdict.decision).toBe("DENY");
    expect(verdict.reason).toBe("AUTHORITY_ERROR");
  });

  // ── Observabilidad del caller worker que ignora el resultado (D-6.9) ─────────────────

  it("worker_deny_is_observable_even_though_caller_ignores_result", async () => {
    // upsert-catalog-products.ts:166 descarta el retorno de publishProductToWoo: la única
    // forma de que el DENY no desaparezca es que el gateway lo registre él mismo.
    load(buildWorkerReappearFixture(PROVIDER_DT));

    await upsertCatalogProducts("job-1", fakePrisma);

    const events = denyEvents();
    expect(events).toHaveLength(1);
    expect(events[0].productId).toBe(WORKER_CATALOG_PRODUCT_ID);
    expect(events[0].providerId).toBe(PROVIDER_DT);
    expect(events[0].storeId).toBe(STORE_ID);
    expect((events[0].metadata as { reason?: string })?.reason).toBe("EXPLICIT");
  });

  it("deny_does_not_abort_extraction_in_worker_path", async () => {
    load(buildWorkerReappearFixture(PROVIDER_DT));

    // No lanza…
    await expect(upsertCatalogProducts("job-1", fakePrisma)).resolves.toBeUndefined();

    const cp = (handle.__db.catalogProduct ?? [])[0];
    // …y el resto del upsert sí ocurrió: el producto volvió a ACTIVE y se reactivó localmente.
    expect(cp.supplierStatus).toBe("ACTIVE");
    expect(cp.internalStatus).toBe("PUBLISHED");
    expect(cp.pausedBySystem).toBe(false);
    // El DENY quedó registrado y no hubo publicación remota.
    expect(denyEvents()).toHaveLength(1);
    expect(spy.count("POST")).toBe(0);
    expect(
      eventLogRows(fakePrisma).some((r) => r.type === "PRODUCT_REACTIVATED"),
    ).toBe(true);
  });

  // ── stockSource no otorga elegibilidad ───────────────────────────────────────────────

  it("own_stock_does_not_bypass_ineligible_provider", async () => {
    // RECLASIFICADO: el prompt lo ubica en CHARACTERIZATION (§6.2.1), pero hoy no puede
    // pasar — sin guard, un producto de un proveedor INELIGIBLE con stock propio SE PUBLICA.
    // Es un test de defecto, no de caracterización. Ver el reporte.
    load(buildPublishFixture({ providerId: PROVIDER_DT, stockSource: "OWN" }));

    const result = await publishProductToWoo(
      fakePrisma,
      directClient(),
      STORE_ID,
      CATALOG_PRODUCT_ID,
      [],
    );

    expect(result.success).toBe(false);
    expect(result.code).toBe(DENY_CODE);
    expect((denyEvents()[0]?.metadata as { reason?: string })?.reason).toBe("EXPLICIT");
    expect(spy.count()).toBe(0);
  });
});
