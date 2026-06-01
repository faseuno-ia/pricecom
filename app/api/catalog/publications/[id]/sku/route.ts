// PUT /api/catalog/publications/[id]/sku — edita el SKU comercial canónico
// (ProductPublication.sku) con guards bloqueantes.
//
// Body:
//   { sku: string, confirmPublishedChange?: boolean }
//
// Guards:
//   1. Formato: no vacío tras trim. ≤ 100 chars (consistente con el límite
//      del PATCH legacy).
//   2. Colisión (bloqueante): el nuevo sku no puede existir en otra
//      ProductPublication.sku NI en otro CatalogProduct.publicationSku
//      (legacy hasta Fase 5). Check doble igual que el de Fase 3
//      publishProductToWoo, pero acá BLOQUEA (no solo loguea warning) —
//      la edición manual no puede pisar identidades.
//   3. Push a Woo (si la publication tiene externalProductId): el cambio se
//      propaga a la tienda. Si la pub está en Woo y confirmPublishedChange
//      != true → 422 con flag requiresConfirmation. El front re-envía con
//      la flag true cuando el usuario confirma.
//
// Atomicidad (mismo patrón que Fase 3 publishProductToWoo): UPDATE pp.sku
// ANTES del push a Woo. Si Woo falla, el sku ya está en DB → log refleja
// realidad, retry no regenera. Si Woo respondiera 200 pero el commit fallara,
// peor escenario raro: Woo con el nuevo sku, DB con el viejo. Acepto el
// trade-off por simetría con Fase 3.
//
// Log USER_EDITED_PUBLICATION_SKU se emite SOLO si oldSku !== newSku (esto
// adelanta el fix de 4D — corta los logs fantasma del PATCH legacy).

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import { WooCommerceClient } from "@/lib/integrations/woocommerce/client";
import { logInfo } from "@/lib/events/event-log";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  sku: z.string().min(1, "El SKU no puede estar vacío").max(100),
  confirmPublishedChange: z.boolean().optional(),
});

export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await requireSession();

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Body inválido" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validación falló", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const newSku = parsed.data.sku.trim();
  if (!newSku) {
    return NextResponse.json({ error: "El SKU no puede ser vacío" }, { status: 400 });
  }

  // Cargar publication + chequear ownership.
  const pub = await prisma.productPublication.findUnique({
    where: { id: params.id },
    select: {
      id: true,
      sku: true,
      catalogProductId: true,
      storeId: true,
      externalProductId: true,
      catalogProduct: {
        select: { id: true, userId: true, supplierName: true },
      },
    },
  });
  if (!pub || pub.catalogProduct.userId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const oldSku = pub.sku ?? null;

  // ── Guard 1: colisión bloqueante ─────────────────────────────────────────
  // pp.sku igual en otra publication del mismo user
  const collisionPp = await prisma.productPublication.findFirst({
    where: {
      sku: newSku,
      id: { not: pub.id },
      catalogProduct: { is: { userId: session.user.id } },
    },
    select: {
      id: true,
      catalogProductId: true,
      catalogProduct: { select: { supplierName: true } },
    },
  });
  // cp.publicationSku igual en otro CatalogProduct (legacy hasta Fase 5)
  const collisionCp = !collisionPp
    ? await prisma.catalogProduct.findFirst({
        where: {
          publicationSku: newSku,
          id: { not: pub.catalogProductId },
          userId: session.user.id,
        },
        select: { id: true, supplierName: true },
      })
    : null;
  if (collisionPp || collisionCp) {
    const conflictName = collisionPp
      ? collisionPp.catalogProduct.supplierName
      : collisionCp!.supplierName;
    return NextResponse.json(
      {
        error: `El SKU "${newSku}" ya pertenece a otro producto (${conflictName.slice(0, 60)})`,
        conflictingCatalogProductId:
          collisionPp?.catalogProductId ?? collisionCp?.id ?? null,
        conflictingPublicationId: collisionPp?.id ?? null,
      },
      { status: 409 }
    );
  }

  // ── Guard 2: publicado en Woo → requiere confirmación ───────────────────
  const isInWoo = pub.externalProductId !== null;
  if (isInWoo && !parsed.data.confirmPublishedChange) {
    return NextResponse.json(
      {
        error: `Este producto está publicado en WooCommerce. Cambiar el SKU lo modificará en la tienda real.`,
        requiresConfirmation: true,
        previousSku: oldSku,
        newSku,
      },
      { status: 422 }
    );
  }

  // Si el sku no cambió, no hace nada y no loguea (delta-real, adelanto de 4D).
  if (oldSku === newSku) {
    return NextResponse.json({ unchanged: true, sku: oldSku });
  }

  // ── Persistir ANTES del push (atomicidad / retry-safety) ────────────────
  await prisma.productPublication.update({
    where: { id: pub.id },
    data: { sku: newSku },
  });

  // ── Push a Woo si la pub está en la tienda ──────────────────────────────
  let wooPushOk = true;
  let wooError: string | null = null;
  if (isInWoo) {
    const store = await prisma.store.findFirst({
      where: { id: pub.storeId, userId: session.user.id },
      include: { integrations: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    const integration = store?.integrations[0];
    if (!store || !integration) {
      wooPushOk = false;
      wooError = "Sin credenciales de WooCommerce";
    } else {
      try {
        const client = WooCommerceClient.fromIntegration({
          storeUrl: store.url,
          consumerKeyEncrypted: integration.consumerKeyEncrypted,
          consumerSecretEncrypted: integration.consumerSecretEncrypted,
        });
        await client.updateProduct(parseInt(pub.externalProductId!, 10), {
          sku: newSku,
        });
      } catch (err) {
        wooPushOk = false;
        wooError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  // ── Log USER_EDITED_PUBLICATION_SKU con delta real (4D adelantado) ──────
  await logInfo({
    source: "USER",
    type: "USER_EDITED_PUBLICATION_SKU",
    title: `SKU comercial editado: ${oldSku ?? "—"} → ${newSku}`,
    userId: session.user.id,
    productId: pub.catalogProductId,
    publicationId: pub.id,
    storeId: pub.storeId,
    metadata: {
      previousSku: oldSku,
      newSku,
      publicationId: pub.id,
      wasInWoo: isInWoo,
      wooPushOk,
      ...(wooError ? { wooError } : {}),
    },
  });

  return NextResponse.json({
    sku: newSku,
    previousSku: oldSku,
    wasInWoo: isInWoo,
    wooPushOk,
    ...(wooError ? { wooError } : {}),
  });
}
