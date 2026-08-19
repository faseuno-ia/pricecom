// C2-DESIGN-1 · Gate 2 · CLASE: CHARACTERIZATION
//
// Estos tests describen conducta que NO debe cambiar: pasan ANTES y DESPUÉS de introducir el
// guardarraíl de primera publicación. Son la red que demuestra que el blast radius quedó
// acotado (W2 update, W3 pause, W4 SKU update, y el first publish de un par ELIGIBLE).
//
// 100% offline: fake de Prisma en memoria + spy de `fetch`. Cero conexiones a la DB.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// El módulo del cliente Prisma se reemplaza por el fake en memoria. La factory es async para
// poder importar el helper dentro del scope hoisted de vi.mock, y devuelve SIEMPRE la misma
// instancia: el test y el código bajo test comparten exactamente la misma "DB".
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
  loadFakeDb,
  type FakeDb,
  type FakePrismaHandle,
  type FakeRow,
} from "../helpers/fake-prisma";
import { installWooFetchSpy, type FetchSpyHandle } from "../helpers/fetch-spy";
import { mockWooFromIntegration } from "../helpers/woo-mock";
import {
  buildPublishFixture,
  CATALOG_PRODUCT_ID,
  PROVIDER_DT,
  PROVIDER_IMPOTEKNO,
  STORE_ID,
  STORE_URL,
} from "../helpers/first-publish-fixtures";
import { WooCommerceClient } from "@/lib/integrations/woocommerce/client";
import {
  publishProductToWoo,
  pauseProductInWoo,
} from "@/lib/integrations/woocommerce/publication-service";
import { POST as bulkUpdatePOST } from "@/app/api/catalog/bulk-update/route";
import { PUT as skuPUT } from "@/app/api/catalog/publications/[id]/sku/route";
import type { NextRequest } from "next/server";

const handle = fakePrisma as unknown as FakePrismaHandle;

function jsonRequest(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

function directClient(): WooCommerceClient {
  return new WooCommerceClient(STORE_URL, "key", "secret");
}

function load(db: FakeDb): void {
  loadFakeDb(fakePrisma, db);
}

function pubRow(): FakeRow | undefined {
  return (handle.__db.productPublication ?? [])[0];
}

function cpRow(): FakeRow | undefined {
  return (handle.__db.catalogProduct ?? [])[0];
}

describe("C2-DESIGN-1 · CHARACTERIZATION · conducta que no debe cambiar", () => {
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

  it("existing_publication_update_is_untouched_by_guard", async () => {
    // Par NO elegible (Different Touch) pero con externalProductId ⇒ es UPDATE, no first
    // publish. Mismo predicado que el branch de publication-service.ts:229.
    load(buildPublishFixture({ providerId: PROVIDER_DT, externalProductId: "555" }));

    const result = await publishProductToWoo(
      fakePrisma,
      directClient(),
      STORE_ID,
      CATALOG_PRODUCT_ID,
      [],
    );

    expect(result.success).toBe(true);
    // W2: publication-service.ts:293 → PUT /products/555
    expect(spy.count("PUT")).toBe(1);
    expect(spy.count("POST")).toBe(0);
    expect(spy.calls.some((c) => c.url.includes("/products/555"))).toBe(true);
    expect(pubRow()?.externalProductId).toBe("555");
  });

  it("pause_is_not_subject_to_first_publish_eligibility", async () => {
    // W3: pauseProductInWoo (publication-service.ts:473; HTTP en :512) sobre un par NO elegible.
    load(buildPublishFixture({ providerId: PROVIDER_DT, externalProductId: "555" }));

    const result = await pauseProductInWoo(
      fakePrisma,
      directClient(),
      STORE_ID,
      CATALOG_PRODUCT_ID,
    );

    expect(result.success).toBe(true);
    expect(spy.count("PUT")).toBe(1);
    expect(spy.count("POST")).toBe(0);
    expect(pubRow()?.status).toBe("PAUSED");
    expect(pubRow()?.externalStatus).toBe("draft");
  });

  it("sku_update_endpoint_behavior_is_unchanged", async () => {
    // W4: app/api/catalog/publications/[id]/sku/route.ts:203 → updateProduct({ sku }).
    load(buildPublishFixture({ providerId: PROVIDER_DT, externalProductId: "555" }));

    const res = await skuPUT(
      jsonRequest({ sku: "TEK-RENAMED", confirmPublishedChange: true }),
      { params: { id: "pp-under-test" } },
    );

    expect(res.status).toBe(200);
    expect(pubRow()?.sku).toBe("TEK-RENAMED");
    // Un GET (guard 3 = assertSkuNotInWoo) + un PUT (push del sku). Cero creaciones.
    expect(spy.count("POST")).toBe(0);
    expect(spy.count("PUT")).toBe(1);
    expect(
      spy.calls.some(
        (c) => c.method === "PUT" && (c.body as { sku?: string })?.sku === "TEK-RENAMED",
      ),
    ).toBe(true);
  });

  it("seeded_eligible_provider_can_still_first_publish", async () => {
    // Path REAL (no el helper): UI → POST /api/catalog/bulk-update { action: "publish" }
    // (route.ts:126 → :194). Proveedor ELIGIBLE del seed.
    load(buildPublishFixture({ providerId: PROVIDER_IMPOTEKNO }));

    const res = await bulkUpdatePOST(
      jsonRequest({ productIds: [CATALOG_PRODUCT_ID], action: "publish" }),
    );
    const body = (await res.json()) as { published: number; errors: unknown[] };

    expect(body.published).toBe(1);
    expect(body.errors).toEqual([]);
    // publication-service.ts:311 (GET del guard de SKU) + :329 (POST de creación)
    expect(spy.count("POST")).toBe(1);
    expect(pubRow()?.externalProductId).toBeTruthy();
    expect(cpRow()?.internalStatus).toBe("PUBLISHED");
  });

  it("own_stock_product_of_eligible_provider_can_first_publish", async () => {
    // stockSource=OWN sobre un proveedor ELIGIBLE ⇒ ALLOW. Caso real de referencia: los 31
    // productos con stockSource=OWN pertenecen todos a IMPOTEKNO, que es E1.
    load(buildPublishFixture({ providerId: PROVIDER_IMPOTEKNO, stockSource: "OWN" }));

    const result = await publishProductToWoo(
      fakePrisma,
      directClient(),
      STORE_ID,
      CATALOG_PRODUCT_ID,
      [],
    );

    expect(result.success).toBe(true);
    expect(spy.count("POST")).toBe(1);
    expect(pubRow()?.externalProductId).toBeTruthy();
  });

  it("hybrid_stock_product_of_eligible_provider_can_first_publish", async () => {
    load(buildPublishFixture({ providerId: PROVIDER_IMPOTEKNO, stockSource: "HYBRID" }));

    const result = await publishProductToWoo(
      fakePrisma,
      directClient(),
      STORE_ID,
      CATALOG_PRODUCT_ID,
      [],
    );

    expect(result.success).toBe(true);
    expect(spy.count("POST")).toBe(1);
  });
});
