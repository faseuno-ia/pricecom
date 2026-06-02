// Bug de producción: 62 productos B380- aparecen en "No vinculados" aunque
// ya tienen ProductPublication apuntando al wooId correcto. Causa raíz: el
// sync (sync/products/route.ts) matchea por cp.publicationSku o cp.sku raw,
// pero los lazy-SKU de Fase 3+ tienen el canónico en pp.sku — ninguna query
// del sync lo contempla. Defense-in-depth: la pestaña (unmatched/route.ts)
// solo filtra por resolved=false, no cruza con ProductPublication.externalProductId.
//
// Estos 4 tests deben FALLAR contra el código actual (antes del fix) y pasar
// después. Si pasa sin fix, el test no cubre el bug.

import "../setup/env";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock hoistea — esto debe quedar ANTES de los imports normales para que
// el route handler importe la versión mockeada de requireSession.
vi.mock("@/lib/auth", () => ({
  requireSession: vi.fn(async () => ({ user: { id: "stub" } })),
  getSession: vi.fn(async () => null),
}));

import { NextRequest } from "next/server";
import { testPrisma, truncateAll } from "../setup/db";
import { applyWooMock, mockWooFromIntegration } from "../helpers/woo-mock";
import {
  createTestCatalogProduct,
  createTestProvider,
  createTestPublication,
  createTestStore,
  createTestUser,
} from "../helpers/factories";
import { POST as syncProductsPost } from "@/app/api/my-store/sync/products/route";
import { GET as getUnmatched } from "@/app/api/my-store/unmatched/route";
import { requireSession } from "@/lib/auth";
import { buildActiveUnmatchedWhere } from "@/lib/store/unmatched-where";

const mockedRequireSession = vi.mocked(requireSession);

function mockWooProduct(opts: { id: number; sku: string; price?: string }) {
  return {
    id: opts.id,
    sku: opts.sku,
    name: `Mocked ${opts.id}`,
    status: "publish",
    regular_price: opts.price ?? "100.00",
    price: opts.price ?? "100.00",
    stock_quantity: null,
    manage_stock: false,
    stock_status: "instock",
    permalink: `https://shop.example.test/?p=${opts.id}`,
    images: [],
    categories: [],
    description: "",
  };
}

describe("Sync de tienda + pestaña No vinculados", () => {
  beforeEach(async () => {
    await truncateAll();
    mockedRequireSession.mockReset();
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  it("1. Sync matchea cp por pp.sku canónico (Fase 3+ lazy SKU)", async () => {
    const user = await createTestUser();
    const provider = await createTestProvider(user.id, { skuPrefix: "T-" });
    const { store } = await createTestStore(user.id);
    // Patrón Fase 3+ lazy: cp.publicationSku=null, cp.sku raw del proveedor,
    // pp.sku tiene el canónico compuesto. Es exactamente el patrón de los
    // 62 stale B380- en prod.
    const cp = await createTestCatalogProduct(user.id, provider.id, {
      sku: "123",
      publicationSku: null,
      finalPrice: 100,
    });
    await createTestPublication(cp.id, store.id, {
      sku: "T-123",
      externalSku: "T-123",
      externalProductId: "900",
      status: "ACTIVE",
      syncStatus: "SYNCED",
    });

    mockedRequireSession.mockResolvedValue({ user: { id: user.id } });

    const restoreProto = applyWooMock({
      getAllProducts: async () => [mockWooProduct({ id: 900, sku: "T-123" })],
    });
    const restoreStatic = mockWooFromIntegration();

    try {
      const res = await syncProductsPost();
      const body = await res.json();
      expect(body.matched).toBe(1);
      expect(body.unmatchedCount).toBe(0);
    } finally {
      restoreProto();
      restoreStatic();
    }

    // pp se actualizó con datos del sync.
    const pubAfter = await testPrisma.productPublication.findUnique({
      where: {
        catalogProductId_storeId: { catalogProductId: cp.id, storeId: store.id },
      },
    });
    expect(pubAfter?.priceInStore).toBe(100);

    // No se creó UnmatchedStoreProduct para wooId=900.
    const unmatchedRow = await testPrisma.unmatchedStoreProduct.findUnique({
      where: {
        storeId_externalProductId: { storeId: store.id, externalProductId: "900" },
      },
    });
    expect(unmatchedRow).toBeNull();
  });

  it("2. Sync scopea por userId — no matchea pubs de OTRO usuario con mismo pp.sku", async () => {
    // user1 corre el sync. user2 tiene una pub cuyo pp.sku coincide con un
    // producto Woo de user1 — no debe matchear (es de otro user). Esto
    // verifica que la query nueva tiene `userId: session.user.id` en el
    // where exterior (sin esa restricción, Fix 1 cruzaría usuarios).
    const user1 = await createTestUser();
    const provider1 = await createTestProvider(user1.id, { skuPrefix: "T-" });
    const { store: store1 } = await createTestStore(user1.id);
    // user1 NO tiene cp con sku=456 ni pub con sku=T-456.

    const user2 = await createTestUser();
    const provider2 = await createTestProvider(user2.id, { skuPrefix: "T-" });
    const { store: store2 } = await createTestStore(user2.id);
    const cpOther = await createTestCatalogProduct(user2.id, provider2.id, {
      sku: "456",
      publicationSku: null,
      finalPrice: 100,
    });
    await createTestPublication(cpOther.id, store2.id, {
      sku: "T-456",
      externalSku: "T-456",
      externalProductId: "800",
      status: "ACTIVE",
    });

    mockedRequireSession.mockResolvedValue({ user: { id: user1.id } });

    const restoreProto = applyWooMock({
      // Woo de user1 trae un producto con el mismo sku que la pub de user2.
      getAllProducts: async () => [mockWooProduct({ id: 700, sku: "T-456" })],
    });
    const restoreStatic = mockWooFromIntegration();

    try {
      const res = await syncProductsPost();
      const body = await res.json();
      // user1 no tiene cp/pp con ese sku → no debe matchear → unmatched.
      expect(body.matched).toBe(0);
      expect(body.unmatchedCount).toBe(1);
    } finally {
      restoreProto();
      restoreStatic();
    }

    // Verificación adicional: el cp de user2 NO debe haber sido tocado.
    const cpOtherAfter = await testPrisma.catalogProduct.findUnique({
      where: { id: cpOther.id },
    });
    expect(cpOtherAfter?.commercialTitle).toBeNull(); // no se le seteó nada
    const pubOtherAfter = await testPrisma.productPublication.findFirst({
      where: { catalogProductId: cpOther.id },
    });
    expect(pubOtherAfter?.externalProductId).toBe("800"); // sin cambios
  });

  it("3. Pestaña default OCULTA stale (unmatched con resolved=false pero pp existe)", async () => {
    const user = await createTestUser();
    const provider = await createTestProvider(user.id, { skuPrefix: "T-" });
    const { store } = await createTestStore(user.id);
    const cp = await createTestCatalogProduct(user.id, provider.id, {
      sku: "STALE-1",
      finalPrice: 100,
    });
    // pub vinculada con externalProductId="500".
    await createTestPublication(cp.id, store.id, {
      sku: "T-STALE-1",
      externalSku: "T-STALE-1",
      externalProductId: "500",
      status: "ACTIVE",
    });
    // unmatched fantasma para el MISMO externalProductId.
    await testPrisma.unmatchedStoreProduct.create({
      data: {
        storeId: store.id,
        externalProductId: "500",
        externalSku: "T-STALE-1",
        name: "Producto stale",
        externalStatus: "publish",
        resolved: false,
      },
    });

    mockedRequireSession.mockResolvedValue({ user: { id: user.id } });

    const req = new NextRequest("http://localhost/api/my-store/unmatched");
    const res = await getUnmatched(req);
    const body = await res.json();

    const externalIds = body.unmatched.map(
      (u: { externalProductId: string }) => u.externalProductId
    );
    expect(externalIds).not.toContain("500");
  });

  it("4. Pestaña default MUESTRA genuino (unmatched sin pp asociada)", async () => {
    const user = await createTestUser();
    const { store } = await createTestStore(user.id);
    // unmatched genuino: NO hay pub con externalProductId="700".
    await testPrisma.unmatchedStoreProduct.create({
      data: {
        storeId: store.id,
        externalProductId: "700",
        externalSku: "UNRELATED-700",
        name: "Producto que el usuario aún no vinculó",
        externalStatus: "publish",
        resolved: false,
      },
    });

    mockedRequireSession.mockResolvedValue({ user: { id: user.id } });

    const req = new NextRequest("http://localhost/api/my-store/unmatched");
    const res = await getUnmatched(req);
    const body = await res.json();

    const externalIds = body.unmatched.map(
      (u: { externalProductId: string }) => u.externalProductId
    );
    expect(externalIds).toContain("700");
  });

  it("5. Helper centralizado: count del dashboard excluye stale (no duplicar lógica)", async () => {
    // Origen del test: el Fix 2 corrigió el endpoint de la lista pero el
    // count del dashboard tenía su propia copia (count crudo por resolved=false)
    // → quedaron desincronizados (lista en 1, contador en 63). El fix
    // estructural fue extraer la lógica a un helper que ambos consumen.
    //
    // Este test cubre el helper directo. Con setup de 2 stale + 1 genuino,
    // el count helper-based devuelve 1; el count crudo (que page.tsx tenía
    // antes del fix) devuelve 3. Sin el helper, la lógica no es testeable
    // ni compartible — el archivo `lib/store/unmatched-where.ts` ES el
    // contrato.
    const user = await createTestUser();
    const provider = await createTestProvider(user.id, { skuPrefix: "T-" });
    const { store } = await createTestStore(user.id);

    // Stale 1: cp + pp con externalProductId="2001", UMSP fantasma con mismo id.
    const cp1 = await createTestCatalogProduct(user.id, provider.id, {
      sku: "S1",
      finalPrice: 10,
    });
    await createTestPublication(cp1.id, store.id, {
      sku: "T-S1",
      externalProductId: "2001",
      status: "ACTIVE",
    });
    await testPrisma.unmatchedStoreProduct.create({
      data: {
        storeId: store.id,
        externalProductId: "2001",
        externalSku: "T-S1",
        name: "Stale 1",
        externalStatus: "publish",
        resolved: false,
      },
    });

    // Stale 2: cp + pp con externalProductId="2002", UMSP fantasma con mismo id.
    const cp2 = await createTestCatalogProduct(user.id, provider.id, {
      sku: "S2",
      finalPrice: 10,
    });
    await createTestPublication(cp2.id, store.id, {
      sku: "T-S2",
      externalProductId: "2002",
      status: "ACTIVE",
    });
    await testPrisma.unmatchedStoreProduct.create({
      data: {
        storeId: store.id,
        externalProductId: "2002",
        externalSku: "T-S2",
        name: "Stale 2",
        externalStatus: "publish",
        resolved: false,
      },
    });

    // Genuino: UMSP con externalProductId="2003" sin pp asociada.
    await testPrisma.unmatchedStoreProduct.create({
      data: {
        storeId: store.id,
        externalProductId: "2003",
        externalSku: "GENUINE-2003",
        name: "Genuine",
        externalStatus: "publish",
        resolved: false,
      },
    });

    // Helper-based count: el que page.tsx debe usar.
    const where = await buildActiveUnmatchedWhere(testPrisma, store.id);
    const helperCount = await testPrisma.unmatchedStoreProduct.count({ where });
    expect(helperCount).toBe(1);

    // Contrafactual: el count crudo (lo que page.tsx tenía pre-fix). Si
    // alguien vuelve a duplicar la lógica sin pasar por el helper, ese
    // count seguiría dando 3 — esa es la diferencia que el helper resuelve.
    const crudoCount = await testPrisma.unmatchedStoreProduct.count({
      where: { storeId: store.id, resolved: false },
    });
    expect(crudoCount).toBe(3);
    expect(helperCount).toBeLessThan(crudoCount);
  });
});
