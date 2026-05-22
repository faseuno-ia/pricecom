// POST /api/my-store/sync/publications — pushea a WooCommerce todas las
// publications con cambios locales pendientes (o un subset si el body
// incluye `catalogProductIds`).
//
// Body opcional:
//   { "catalogProductIds": ["..."] }  → sync solo de esos productos.
//   Sin body o body vacío             → sync de TODAS las publications
//                                       pendientes del usuario.
//
// Universo a procesar (cuando es global, sin catalogProductIds):
//   - pendingSync = true  (flag legacy / drift detectado en el último import)
//   - syncStatus = PENDING_SYNC | OUTDATED | ERROR  (cola del sync engine,
//     drift por edición local, y reintentos)
//   - status = PAUSED && externalStatus = "publish"  (cliente pausó en
//     PricEcom pero la tienda todavía lo tiene activo — reconciliación pull)
//
// Cuando viene catalogProductIds, NO aplicamos el filtro de pendientes:
// la acción individual fuerza el push aunque la publication ya esté SYNCED.
//
// Decisión por publication:
//   - PAUSED (en la publication o en el CatalogProduct.internalStatus) →
//     pauseProductInWoo. Mirar también internalStatus es clave para el
//     escenario de auto-pause: el worker pasa CatalogProduct a PAUSED y
//     marca pendingSync=true, pero ProductPublication.status sigue ACTIVE
//     hasta que confirmemos el push a Woo. Si solo mirásemos status nos
//     equivocaríamos y republicaríamos.
//   - cualquier otro estado     → publishProductToWoo (re-empuja datos)

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import { WooCommerceClient } from "@/lib/integrations/woocommerce/client";
import {
  publishProductToWoo,
  pauseProductInWoo,
} from "@/lib/integrations/woocommerce/publication-service";
import type { PricingRuleForCalc } from "@/lib/pricing/pricing-engine";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const bodySchema = z
  .object({
    catalogProductIds: z.array(z.string()).optional(),
  })
  .optional();

export async function POST(req: NextRequest) {
  const session = await requireSession();

  // Body opcional con filtro de ids. Si el body no es JSON válido lo
  // tratamos como ausente — el flujo histórico es sin body.
  let parsedIds: string[] | undefined;
  try {
    const raw = await req.json();
    const parsed = bodySchema.safeParse(raw);
    if (parsed.success && parsed.data?.catalogProductIds?.length) {
      parsedIds = parsed.data.catalogProductIds;
    }
  } catch {
    // sin body, sigue como sync global
  }

  const store = await prisma.store.findFirst({
    where: { userId: session.user.id },
    include: { integrations: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  if (!store) {
    return NextResponse.json({ error: "Sin tienda conectada" }, { status: 404 });
  }
  if (store.platform !== "WOOCOMMERCE") {
    return NextResponse.json(
      { error: "Solo WooCommerce soportado por ahora" },
      { status: 400 }
    );
  }
  const integration = store.integrations[0];
  if (!integration) {
    return NextResponse.json(
      { error: "Sin integración configurada" },
      { status: 400 }
    );
  }

  let client: WooCommerceClient;
  try {
    client = WooCommerceClient.fromIntegration({
      storeUrl: store.url,
      consumerKeyEncrypted: integration.consumerKeyEncrypted,
      consumerSecretEncrypted: integration.consumerSecretEncrypted,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error de credenciales" },
      { status: 400 }
    );
  }

  const targets = await prisma.productPublication.findMany({
    where: parsedIds
      ? {
          // Sync individual/selectivo: tomamos exactamente los productos
          // pedidos por el cliente, sin filtro de "pendientes". El usuario
          // está forzando el push.
          storeId: store.id,
          catalogProductId: { in: parsedIds },
        }
      : {
          // Sync global: solo publications con cambios pendientes o drift.
          storeId: store.id,
          OR: [
            { pendingSync: true },
            { syncStatus: "PENDING_SYNC" },
            { syncStatus: "OUTDATED" },
            { syncStatus: "ERROR" },
            // Drift: el usuario lo pausó en PricEcom pero sigue "publish" en Woo.
            { AND: [{ status: "PAUSED" }, { externalStatus: "publish" }] },
          ],
        },
    select: {
      id: true,
      catalogProductId: true,
      status: true,
      catalogProduct: { select: { internalStatus: true } },
    },
  });

  if (targets.length === 0) {
    return NextResponse.json({ synced: 0, errors: [] });
  }

  const rules = (await prisma.pricingRule.findMany({
    where: { userId: session.user.id, isActive: true },
    select: {
      id: true,
      name: true,
      scope: true,
      scopeId: true,
      marginPercent: true,
      roundingMode: true,
      isActive: true,
      priority: true,
    },
  })) as PricingRuleForCalc[];

  let synced = 0;
  const errors: { catalogProductId: string; error: string }[] = [];

  for (const t of targets) {
    const shouldPause =
      t.status === "PAUSED" ||
      t.catalogProduct.internalStatus === "PAUSED" ||
      t.catalogProduct.internalStatus === "IGNORED";
    const result = shouldPause
      ? await pauseProductInWoo(prisma, client, store.id, t.catalogProductId)
      : await publishProductToWoo(
          prisma,
          client,
          store.id,
          t.catalogProductId,
          rules
        );
    if (result.success) {
      synced++;
    } else {
      errors.push({
        catalogProductId: t.catalogProductId,
        error: result.error ?? "Error desconocido",
      });
    }
  }

  return NextResponse.json({ synced, errors, total: targets.length });
}
