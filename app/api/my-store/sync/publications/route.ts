// POST /api/my-store/sync/publications — pushea a WooCommerce todas las
// publications con cambios locales pendientes.
//
// Universo a procesar:
//   - pendingSync = true  (flag legacy / drift detectado en el último import)
//   - syncStatus = PENDING_SYNC | ERROR (cola del sync engine y reintentos)
//   - status = PAUSED && externalStatus = "publish"  (cliente pausó en
//     PricEcom pero la tienda todavía lo tiene activo — reconciliación pull)
//
// Decisión por publication:
//   - PAUSED en PricEcom        → pauseProductInWoo
//   - cualquier otro estado     → publishProductToWoo (re-empuja datos)

import { NextResponse } from "next/server";
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

export async function POST() {
  const session = await requireSession();

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
    where: {
      storeId: store.id,
      OR: [
        { pendingSync: true },
        { syncStatus: "PENDING_SYNC" },
        { syncStatus: "ERROR" },
        // Drift: el usuario lo pausó en PricEcom pero sigue "publish" en Woo.
        { AND: [{ status: "PAUSED" }, { externalStatus: "publish" }] },
      ],
    },
    select: {
      id: true,
      catalogProductId: true,
      status: true,
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
    const result =
      t.status === "PAUSED"
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
