// GATE 2-T — Tests primero (TDD) del wrapper price-only `updatePriceOnlyInWoo`.
//
// ESTADO ESPERADO: ROJO. El módulo del wrapper todavía NO existe
// (`@/lib/integrations/woocommerce/price-only-service`) — la implementación es
// Gate 2-I. El import falla por módulo inexistente; es el estado correcto de 2-T.
//
// SEGURIDAD: `.env` apunta a PROD. Estos tests NO pueden tocar la DB viva ni
// pushear a Woo. Todo está mockeado:
//   - prisma: objeto fake con productPublication.findUnique/update/updateMany como
//     spies que capturan `data` y permiten simular throws. NO se instancia PrismaClient.
//   - Woo client: objeto fake con updateProductPrice/updateProduct/updateProductStatus
//     como spies. NO hay red real.
//   - EventLog: `@/lib/events/event-log` mockeado, porque logInfo/logError usan el
//     prisma REAL del módulo (lib/db/client) — sin este mock, emitir un evento
//     escribiría en PROD. Mockeado además sirve para asertar la emisión.
//
// Contrato codificado: docs/price-only-wrapper-design.md — "Contrato actualizado"
// + C.A / C.B / C.C / C.D.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { WooApiError } from "@/lib/integrations/woocommerce/woo-api-error";
// Import del wrapper por su path DEFINITIVO. Módulo aún inexistente (Gate 2-I) →
// este import falla y deja la suite roja. Es lo esperado en 2-T. NO crear stub.
import { updatePriceOnlyInWoo } from "@/lib/integrations/woocommerce/price-only-service";

// EventLog mockeado (evita el prisma real del módulo + permite asertar emisión).
vi.mock("@/lib/events/event-log", () => ({
  logInfo: vi.fn(async () => {}),
  logError: vi.fn(async () => {}),
  logWarning: vi.fn(async () => {}),
}));
import { logInfo, logError } from "@/lib/events/event-log";

// ── Helpers de mock ───────────────────────────────────────────────────────────

function wooProduct(id: number, regularPrice = "1000.00") {
  return {
    id,
    sku: "X-1",
    name: "m",
    status: "publish",
    regular_price: regularPrice,
    price: regularPrice,
    permalink: "https://shop.example.test/?p=" + id,
    images: [],
    categories: [],
    description: "",
  };
}

// Publication que devuelve findUnique. Defaults = fila publicable (gate OK):
// ACTIVE, externalProductId presente. priceInStore(950) != lastPushedPrice(1000)
// a propósito, para distinguir las dos lecturas de C.A.
function makePub(overrides: Record<string, unknown> = {}) {
  return {
    id: "pub-1",
    storeId: "store-1",
    catalogProductId: "cp-1",
    externalProductId: "5001",
    status: "ACTIVE",
    externalStatus: "publish",
    priceInStore: 950,
    lastPushedPrice: 1000,
    ...overrides,
  };
}

// updateImpl permite simular el throw del update (test 200-then-DB-fail).
function makePrisma(
  pub: Record<string, unknown> | null,
  updateImpl?: (...args: unknown[]) => Promise<unknown>
) {
  return {
    productPublication: {
      findUnique: vi.fn(async () => pub),
      update: vi.fn(updateImpl ?? (async () => pub)),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
  };
}

// updatePriceImpl permite resolver un WooProduct o lanzar un WooApiError.
function makeClient(updatePriceImpl?: (...args: unknown[]) => Promise<unknown>) {
  return {
    updateProductPrice: vi.fn(
      updatePriceImpl ?? (async (id: number) => wooProduct(id))
    ),
    // Genéricos: el wrapper NO debe usarlos (podrían cargar status/sku). Spies
    // para asertar su AUSENCIA de uso (invariante "no republica").
    updateProduct: vi.fn(async (id: number) => wooProduct(id)),
    updateProductStatus: vi.fn(async (id: number) => wooProduct(id)),
  };
}

// Campos que el éxito NUNCA debe escribir (ejes operativo/identidad).
const FORBIDDEN_WRITE_KEYS = [
  "status",
  "externalStatus",
  "sku",
  "externalSku",
  "internalStatus",
  "commercialTitle",
  "commercialDescription",
  "name",
  "description",
];

beforeEach(() => {
  vi.clearAllMocks();
});

// ── 1. ÉXITO (Woo 200, DB ok) ─────────────────────────────────────────────────
// Contrato/Secuencia + C.A. Verifica el write completo del éxito y el Result.
describe("updatePriceOnlyInWoo — éxito (Woo 200, DB ok)", () => {
  it("pushea el precio y escribe el baseline; Result ok con shape de C.C", async () => {
    const pub = makePub({ priceInStore: 950, lastPushedPrice: 1000 });
    const prisma = makePrisma(pub);
    const client = makeClient();

    const res = await updatePriceOnlyInWoo(
      prisma as never,
      client as never,
      "pub-1",
      1000
    );

    // Llamó al primitivo price-only con (externalProductId numérico, newPrice).
    expect(client.updateProductPrice).toHaveBeenCalledTimes(1);
    expect(client.updateProductPrice).toHaveBeenCalledWith(5001, 1000);

    // Write de éxito: baseline + flags de sync.
    expect(prisma.productPublication.update).toHaveBeenCalledTimes(1);
    const data = (prisma.productPublication.update.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data.priceInStore).toBe(1000);
    expect(data.lastPushedPrice).toBe(1000);
    expect(data.syncStatus).toBe("SYNCED");
    expect(data.pendingSync).toBe(false);
    expect(data.syncError).toBeNull();
    expect(data.lastSyncedAt).toBeInstanceOf(Date);
    expect(data.lastSyncAt).toBeInstanceOf(Date);

    // Result enriquecido (C.C).
    expect(res).toMatchObject({
      ok: true,
      wooId: 5001,
      newPrice: 1000,
      previousPrice: 950, // = priceInStore previo (C.A)
      priceUnchanged: true, // lastPushedPrice previo (1000) == newPrice (1000)
    });
  });
});

// ── 2. INVARIANTE CLAVE: no republica (no status, no sku) ──────────────────────
// C.D invariantes. EL test del corazón del wrapper.
describe("updatePriceOnlyInWoo — invariante: NO republica (sin status/sku)", () => {
  it("usa SOLO el primitivo price-only; nunca el genérico que cargaría status/sku", async () => {
    const prisma = makePrisma(makePub());
    const client = makeClient();

    await updatePriceOnlyInWoo(prisma as never, client as never, "pub-1", 1234);

    // El único camino a Woo es updateProductPrice(id, price): por construcción
    // solo manda regular_price (no admite status/sku/name/description).
    expect(client.updateProductPrice).toHaveBeenCalledTimes(1);
    const args = client.updateProductPrice.mock.calls[0];
    expect(args).toEqual([5001, 1234]);
    expect(typeof args[1]).toBe("number"); // precio crudo, no un payload con extras

    // Ningún arg a Woo es un objeto que cargue campos prohibidos.
    for (const call of client.updateProductPrice.mock.calls) {
      for (const a of call) {
        if (a && typeof a === "object") {
          for (const k of FORBIDDEN_WRITE_KEYS) {
            expect(a as Record<string, unknown>).not.toHaveProperty(k);
          }
        }
      }
    }

    // El genérico updateProduct / updateProductStatus NO se usan (cargarían status).
    expect(client.updateProduct).not.toHaveBeenCalled();
    expect(client.updateProductStatus).not.toHaveBeenCalled();

    // El write de éxito tampoco toca eje operativo/identidad.
    const data = (prisma.productPublication.update.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    for (const k of FORBIDDEN_WRITE_KEYS) {
      expect(data).not.toHaveProperty(k);
    }
  });
});

// ── 3. C.A — cuarta vía: previousPrice (observación) vs priceUnchanged (autoridad) ─
describe("updatePriceOnlyInWoo — C.A: previousPrice=priceInStore previo; priceUnchanged=(lastPushedPrice previo==newPrice)", () => {
  it("previousPrice lee priceInStore previo; priceUnchanged deriva de lastPushedPrice (==) → true", async () => {
    // priceInStore=950 (observación), lastPushedPrice=1000 (autoridad), newPrice=1000.
    const prisma = makePrisma(makePub({ priceInStore: 950, lastPushedPrice: 1000 }));
    const client = makeClient();

    const res = await updatePriceOnlyInWoo(prisma as never, client as never, "pub-1", 1000);

    expect(res).toMatchObject({ ok: true, previousPrice: 950, priceUnchanged: true });

    expect(logInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "WOO_SYNC_SUCCESS",
        metadata: expect.objectContaining({
          wooId: 5001,
          previousPrice: 950, // priceInStore previo, NO lastPushedPrice
          newPrice: 1000,
          priceUnchanged: true, // 1000 == 1000
        }),
      })
    );
  });

  it("priceUnchanged=false cuando lastPushedPrice previo != newPrice", async () => {
    const prisma = makePrisma(makePub({ priceInStore: 950, lastPushedPrice: 900 }));
    const client = makeClient();

    const res = await updatePriceOnlyInWoo(prisma as never, client as never, "pub-1", 1000);

    expect(res).toMatchObject({ ok: true, previousPrice: 950, priceUnchanged: false });
    expect(logInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "WOO_SYNC_SUCCESS",
        metadata: expect.objectContaining({ previousPrice: 950, priceUnchanged: false }),
      })
    );
  });
});

// ── 4. C.B — always-push: sin early-exit aunque newPrice == precio actual ───────
describe("updatePriceOnlyInWoo — C.B: always-push (sin early-exit)", () => {
  it("con newPrice == priceInStore actual igual llama a Woo y emite EventLog", async () => {
    // Mismo precio en todos lados: un wrapper con early-exit NO llamaría a Woo.
    const prisma = makePrisma(makePub({ priceInStore: 1000, lastPushedPrice: 1000 }));
    const client = makeClient();

    const res = await updatePriceOnlyInWoo(prisma as never, client as never, "pub-1", 1000);

    expect(client.updateProductPrice).toHaveBeenCalledTimes(1); // ← ocurrió pese a precio igual
    expect(logInfo).toHaveBeenCalledWith(
      expect.objectContaining({ type: "WOO_SYNC_SUCCESS" })
    );
    expect(res).toMatchObject({ ok: true, priceUnchanged: true });
  });
});

// ── 5. C.D — error terminal (400/422) → ERROR_TERMINAL + pSync=false ───────────
describe("updatePriceOnlyInWoo — C.D: error terminal", () => {
  it("WooApiError terminal (400) → ERROR_TERMINAL, pendingSync=false; baseline intacto", async () => {
    const prisma = makePrisma(makePub());
    const client = makeClient(async () => {
      throw new WooApiError({ message: "bad", kind: "http", status: 400, op: "update" });
    });

    const res = await updatePriceOnlyInWoo(prisma as never, client as never, "pub-1", 1000);

    expect(res).toMatchObject({ ok: false, kind: "ERROR_TERMINAL" });
    expect((res as { error: string }).error).toBeTruthy();

    // Write de error: solo eje sync; NO toca priceInStore/lastPushedPrice.
    expect(prisma.productPublication.update).toHaveBeenCalledTimes(1);
    const data = (prisma.productPublication.update.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data.syncStatus).toBe("ERROR_TERMINAL");
    expect(data.pendingSync).toBe(false);
    expect(data).not.toHaveProperty("priceInStore");
    expect(data).not.toHaveProperty("lastPushedPrice");

    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ type: "WOO_SYNC_ERROR" })
    );
  });
});

// ── 6. C.D — error transitorio (503/timeout) → PENDING_SYNC + pSync=true ───────
describe("updatePriceOnlyInWoo — C.D: error transitorio", () => {
  it("WooApiError recoverable (503) → PENDING_SYNC, pendingSync=true", async () => {
    const prisma = makePrisma(makePub());
    const client = makeClient(async () => {
      throw new WooApiError({ message: "down", kind: "http", status: 503, op: "update" });
    });

    const res = await updatePriceOnlyInWoo(prisma as never, client as never, "pub-1", 1000);

    expect(res).toMatchObject({ ok: false, kind: "PENDING_SYNC" });
    const data = (prisma.productPublication.update.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data.syncStatus).toBe("PENDING_SYNC");
    expect(data.pendingSync).toBe(true);
  });
});

// ── 7. C.D — 200-then-DB-fail: Woo OK, falla el write → PENDING_SYNC best-effort ─
// Verifica la PROPIEDAD del contrato, no el mecanismo. C.D dice "write mínimo
// best-effort" sin fijar forma ni dónde (detalle de 2-I). Por eso NO se asserta el
// conteo de updates ni que el recovery sea obligatoriamente un segundo .update.
describe("updatePriceOnlyInWoo — C.D: 200-then-DB-fail (branch deliberado)", () => {
  it("Woo 200 y el write de éxito tira (Error de DB, no WooApiError) → Result PENDING_SYNC, NO ERROR_TERMINAL", async () => {
    const pub = makePub();
    const dbError = new Error("db down"); // Error plano de Prisma, NO WooApiError.
    // El write de ÉXITO falla; cualquier write posterior (recovery best-effort, SI
    // la implementación lo hace) resuelve. No fijamos cuántos ni su forma.
    const update = vi.fn().mockRejectedValueOnce(dbError).mockResolvedValue(pub);
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const prisma = {
      productPublication: {
        findUnique: vi.fn(async () => pub),
        update,
        updateMany,
      },
    };
    // El client confirma que Woo resolvió 200 ANTES de que falle la DB.
    let wooResolvedOk = false;
    const client = makeClient(async (id: number) => {
      const p = wooProduct(id);
      wooResolvedOk = true;
      return p;
    });

    const res = await updatePriceOnlyInWoo(prisma as never, client as never, "pub-1", 1000);

    // Propiedad 1: Woo recibió el push y resolvió OK (200) antes del fallo de DB.
    expect(client.updateProductPrice).toHaveBeenCalledTimes(1);
    expect(wooResolvedOk).toBe(true);

    // Propiedad 2: el error simulado del write de éxito es un Error plano, no WooApiError.
    expect(WooApiError.is(dbError)).toBe(false);

    // Propiedad 3: Result transitorio, explícitamente NO terminal.
    expect(res).toMatchObject({ ok: false, kind: "PENDING_SYNC" });
    expect((res as { kind: string }).kind).not.toBe("ERROR_TERMINAL");

    // Propiedad 4: SI el mock registró algún write de recuperación (write de eje-sync
    // que NO es el write de baseline fallido — setea syncStatus sin tocar priceInStore),
    // ese write deja PENDING_SYNC + pendingSync=true. No se exige que exista ni su forma.
    const writeDatas = [
      ...update.mock.calls.map((c) => (c[0] as { data?: Record<string, unknown> })?.data),
      ...updateMany.mock.calls.map((c) => (c[0] as { data?: Record<string, unknown> })?.data),
    ].filter(Boolean) as Record<string, unknown>[];
    const recoveryWrites = writeDatas.filter(
      (d) => "syncStatus" in d && !("priceInStore" in d)
    );
    for (const w of recoveryWrites) {
      expect(w.syncStatus).toBe("PENDING_SYNC");
      expect(w.pendingSync).toBe(true);
    }
  });
});

// ── 8. C.D — GUARDRAILS (Woo NUNCA llamado, Result kind=GUARDRAIL) ─────────────
describe("updatePriceOnlyInWoo — C.D: guardrails (fail-closed, Woo intacto)", () => {
  it("newPrice <= 0 → GUARDRAIL, Woo no llamado", async () => {
    const prisma = makePrisma(makePub());
    const client = makeClient();

    for (const bad of [0, -5]) {
      const res = await updatePriceOnlyInWoo(prisma as never, client as never, "pub-1", bad);
      expect(res).toMatchObject({ ok: false, kind: "GUARDRAIL" });
    }
    expect(client.updateProductPrice).not.toHaveBeenCalled();
    expect(prisma.productPublication.update).not.toHaveBeenCalled();
  });

  it("externalProductId ausente → GUARDRAIL, Woo no llamado", async () => {
    const prisma = makePrisma(makePub({ externalProductId: null }));
    const client = makeClient();

    const res = await updatePriceOnlyInWoo(prisma as never, client as never, "pub-1", 1000);

    expect(res).toMatchObject({ ok: false, kind: "GUARDRAIL" });
    expect(client.updateProductPrice).not.toHaveBeenCalled();
    expect(prisma.productPublication.update).not.toHaveBeenCalled();
  });

  it("status != ACTIVE → GUARDRAIL — INCLUYE el combo PAUSED + externalStatus=publish (bug C.D)", async () => {
    // Combo exacto corregido en C.D: PAUSED+publish pasaría un gate por OR, pero
    // el retry del drainer lo PAUSARÍA en vez de republicar. Debe dar GUARDRAIL.
    const prisma = makePrisma(makePub({ status: "PAUSED", externalStatus: "publish" }));
    const client = makeClient();

    const res = await updatePriceOnlyInWoo(prisma as never, client as never, "pub-1", 1000);

    expect(res).toMatchObject({ ok: false, kind: "GUARDRAIL" });
    expect(client.updateProductPrice).not.toHaveBeenCalled();
    expect(prisma.productPublication.update).not.toHaveBeenCalled();
  });

  it("status PREPARED → GUARDRAIL, Woo no llamado", async () => {
    const prisma = makePrisma(makePub({ status: "PREPARED" }));
    const client = makeClient();

    const res = await updatePriceOnlyInWoo(prisma as never, client as never, "pub-1", 1000);

    expect(res).toMatchObject({ ok: false, kind: "GUARDRAIL" });
    expect(client.updateProductPrice).not.toHaveBeenCalled();
  });
});

// ── 9. C.D — NO marca drift / NO encola ────────────────────────────────────────
describe("updatePriceOnlyInWoo — C.D: no marca drift, no encola", () => {
  it("éxito: no usa updateMany (markPublicationsDrift) ni emite PRODUCT_MARKED_OUTDATED; pendingSync=false", async () => {
    const prisma = makePrisma(makePub());
    const client = makeClient();

    await updatePriceOnlyInWoo(prisma as never, client as never, "pub-1", 1000);

    // markPublicationsDrift escribe vía updateMany → no debe invocarse.
    expect(prisma.productPublication.updateMany).not.toHaveBeenCalled();
    // No se emite el evento de drift.
    const loggedTypes = (logInfo as unknown as { mock: { calls: { 0: { type: string } }[] } }).mock.calls.map(
      (c) => c[0].type
    );
    expect(loggedTypes).not.toContain("PRODUCT_MARKED_OUTDATED");
    // Éxito deja pendingSync=false → fuera del drainer.
    const data = (prisma.productPublication.update.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data.pendingSync).toBe(false);
  });
});
