// Servicio puro reutilizable: actualiza SOLO el precio de una publicación en
// WooCommerce, sin tocar status, SKU ni el resto de la publicación.
//
// Diseño cerrado en docs/price-only-wrapper-design.md (Gate 0 + Gate 1):
//   - C.D: push-first, gate status===ACTIVE, branch 200-then-DB-fail.
//   - C.C: PriceOnlyOutcome (clasificación enriquecida para el flujo masivo).
//   - C.B: always-push (sin early-exit con precio igual).
//   - C.A (cuarta vía): previousPrice = priceInStore previo (observación);
//     priceUnchanged = (lastPushedPrice previo == newPrice) (autoridad).
//
// Recibe prisma y client por INYECCIÓN. No instancia ninguno. No se cablea a
// UI/endpoints/drainer: es una primitiva "un producto, bien hecho".

import type { PrismaClient } from "@prisma/client";
import type { WooCommerceClient } from "./client";
import { logInfo, logError } from "@/lib/events/event-log";
// Reusa el MISMO helper de clasificación de errores Woo que usa el push/pause
// (B-Prep-1). No se reimplementa la taxonomía.
import { syncFieldsForWooError } from "./publication-service";

export type PriceOnlyOutcome =
  | {
      ok: true;
      wooId: number;
      newPrice: number;
      previousPrice: number | null;
      priceUnchanged: boolean;
    }
  | { ok: false; kind: "GUARDRAIL"; reason: string }
  | { ok: false; kind: "PENDING_SYNC"; error: string }
  | { ok: false; kind: "ERROR_TERMINAL"; error: string };

export async function updatePriceOnlyInWoo(
  prisma: PrismaClient,
  client: WooCommerceClient,
  publicationId: string,
  newPrice: number
): Promise<PriceOnlyOutcome> {
  // ── Guardrail 1: precio válido (fail-closed). NO pushear null/0/negativo:
  // re-vaciaría Woo (lección del incidente). Se chequea antes de tocar nada.
  if (typeof newPrice !== "number" || !Number.isFinite(newPrice) || newPrice <= 0) {
    return {
      ok: false,
      kind: "GUARDRAIL",
      reason: `newPrice inválido (${newPrice}): debe ser un número finito > 0`,
    };
  }

  const pub = await prisma.productPublication.findUnique({
    where: { id: publicationId },
    select: {
      id: true,
      storeId: true,
      catalogProductId: true,
      externalProductId: true,
      status: true,
      sku: true,
      priceInStore: true,
      lastPushedPrice: true,
    },
  });

  // ── Guardrail 2: la publicación existe.
  if (!pub) {
    return { ok: false, kind: "GUARDRAIL", reason: `Publicación ${publicationId} no encontrada` };
  }

  // ── Guardrail 3: tiene presencia en Woo (el wrapper ACTUALIZA, nunca crea).
  if (!pub.externalProductId) {
    return {
      ok: false,
      kind: "GUARDRAIL",
      reason: "La publicación no tiene externalProductId (no está en Woo)",
    };
  }

  // ── Guardrail 4: status === "ACTIVE" ESTRICTO (corrección C.D). El combo
  // PAUSED + externalStatus="publish" NO pasa: un retry transitorio lo toma el
  // drainer vía publishProductToWoo, que sobre una fila PAUSED PAUSARÍA en Woo
  // en vez de republicar — revirtiendo el push de precio. Exigir ACTIVE hace que
  // ese retry sea inocuo (republica algo ya publish).
  if (pub.status !== "ACTIVE") {
    return {
      ok: false,
      kind: "GUARDRAIL",
      reason: `status=${pub.status} (se requiere ACTIVE para price-only)`,
    };
  }

  const wooId = Number(pub.externalProductId);
  // C.A — cuarta vía: dos lecturas ANTES del write.
  const previousPrice = pub.priceInStore ?? null; // observación (lo logueado)
  const priceUnchanged = pub.lastPushedPrice === newPrice; // autoridad (señal derivada)

  // ── Push-first: SOLO el primitivo price-only. updateProductPrice manda
  // únicamente { regular_price } — no status, no sku → no republica.
  // C.B: always-push, sin early-exit aunque newPrice == priceInStore.
  try {
    await client.updateProductPrice(wooId, newPrice);
  } catch (err) {
    // Fallo de Woo (no hubo 200). Clasificar con el helper compartido (B-Prep-1):
    // terminal/unknown → ERROR_TERMINAL + pendingSync=false; recoverable/ambiguous
    // → PENDING_SYNC + pendingSync=true. Solo eje sync; NO toca priceInStore/lastPushedPrice.
    const message = err instanceof Error ? err.message : String(err);
    const { syncStatus, pendingSync } = syncFieldsForWooError(err);
    // best-effort: si el write del eje sync ADEMÁS falla, no explotar — el
    // outcome clasificado se devuelve igual (abajo) y el backstop reconcilia.
    try {
      await prisma.productPublication.update({
        where: { id: pub.id },
        data: { syncStatus, syncError: message, pendingSync },
      });
    } catch {
      // absorber: no relanzar.
    }
    await logError({
      source: "WOOCOMMERCE",
      type: "WOO_SYNC_ERROR",
      title: `Error al sincronizar precio — SKU ${pub.sku}`,
      description: message,
      productId: pub.catalogProductId,
      publicationId: pub.id,
      storeId: pub.storeId,
      metadata: { error: message },
    });
    return {
      ok: false,
      kind: syncStatus === "ERROR_TERMINAL" ? "ERROR_TERMINAL" : "PENDING_SYNC",
      error: message,
    };
  }

  // ── Woo 200. Write de éxito: baseline (C.A) + eje sync. NO toca status,
  // externalStatus, sku, externalSku, internalStatus, títulos ni imágenes.
  try {
    await prisma.productPublication.update({
      where: { id: pub.id },
      data: {
        priceInStore: newPrice,
        lastPushedPrice: newPrice,
        syncStatus: "SYNCED",
        pendingSync: false,
        syncError: null,
        lastSyncAt: new Date(),
        lastSyncedAt: new Date(),
      },
    });
  } catch (dbErr) {
    // ── Branch deliberado C.D — 200-then-DB-fail: Woo aplicó el precio pero el
    // write local falló. El error es de Prisma, NO un WooApiError → clasificarlo
    // con syncFieldsForWooError daría unknown→ERROR_TERMINAL, que es INCORRECTO:
    // es reintentable. Forzar PENDING_SYNC. Write mínimo best-effort; si hasta
    // ese falla, el backstop (markPublicationsDrift periódico) converge porque
    // priceInStore quedó viejo → drift → OUTDATED → drainer.
    const message = dbErr instanceof Error ? dbErr.message : String(dbErr);
    try {
      await prisma.productPublication.update({
        where: { id: pub.id },
        data: { syncStatus: "PENDING_SYNC", pendingSync: true, syncError: message },
      });
    } catch {
      // best-effort: backstop converge igual.
    }
    await logError({
      source: "WOOCOMMERCE",
      type: "WOO_SYNC_ERROR",
      title: `Precio aplicado en Woo pero falló el write local — SKU ${pub.sku}`,
      description: message,
      productId: pub.catalogProductId,
      publicationId: pub.id,
      storeId: pub.storeId,
      metadata: { error: message, wooApplied: true },
    });
    return { ok: false, kind: "PENDING_SYNC", error: message };
  }

  // ── EventLog de éxito (espeja la llamada de publishProductToWoo, agregando
  // priceUnchanged). previousPrice = priceInStore previo (C.A — observación).
  await logInfo({
    source: "SYNC",
    type: "WOO_SYNC_SUCCESS",
    title: `Precio sincronizado — SKU ${pub.sku}`,
    productId: pub.catalogProductId,
    publicationId: pub.id,
    storeId: pub.storeId,
    metadata: { wooId, sku: pub.sku, previousPrice, newPrice, priceUnchanged },
  });

  return { ok: true, wooId, newPrice, previousPrice, priceUnchanged };
}
