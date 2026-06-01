import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import { z } from "zod";
import {
  resolvePricing,
  type PricingRuleForCalc,
} from "@/lib/pricing/pricing-engine";
import { markPublicationsDrift } from "@/lib/catalog/mark-publications-drift";

export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireSession();

  const [product, rules] = await Promise.all([
    prisma.catalogProduct.findFirst({
      where: { id: params.id, userId: session.user.id },
      include: {
        provider: {
          select: {
            id: true,
            name: true,
            baseUrl: true,
            providerType: true,
            requiresLogin: true,
            listDiscountPercent: true,
          },
        },
        images: { orderBy: { position: "asc" } },
        assignedCategory: { select: { id: true, name: true } },
        publications: {
          include: { store: { select: { id: true, name: true, platform: true } } },
          // El sku de la publication (canónico post-Fase 3 lazy) lo usa el
          // drawer para el campo editable "SKU comercial". También venía
          // implícito en `include`, pero acá lo dejamos explícito por claridad.
        },
        latestExtractedProduct: {
          select: {
            id: true,
            jobId: true,
            extractedAt: true,
            productUrl: true,
            imageUrl: true,
          },
        },
      },
    }),
    prisma.pricingRule.findMany({
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
    }),
  ]);

  if (!product) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const pricing = resolvePricing(
    {
      wholesalePrice: product.wholesalePrice,
      manualMargin: product.manualMargin,
      finalPrice: product.finalPrice,
      assignedCategoryId: product.assignedCategoryId,
      providerId: product.providerId,
      listDiscountPercent: product.provider.listDiscountPercent
        ? Number(product.provider.listDiscountPercent)
        : 0,
    },
    rules as PricingRuleForCalc[]
  );

  return NextResponse.json({ ...product, pricing });
}

// Solo campos comerciales editables — el worker NUNCA toca estos campos
// cuando difieren del default del proveedor (regla user-first en
// upsert-catalog-products.ts), y la API tampoco permite editar campos
// supplier* por esta ruta.
const patchSchema = z
  .object({
    commercialTitle: z.string().nullable().optional(),
    commercialName: z.string().nullable().optional(),
    commercialDescription: z.string().nullable().optional(),
    publicationSku: z.string().min(1).max(100).nullable().optional(),
    finalPrice: z.number().nullable().optional(),
    manualMargin: z.number().nullable().optional(),
    manualPrice: z.number().nullable().optional(),
    /// Costo mayorista. Solo editable para productos de proveedores
    /// no-SCRAPER (MANUAL / IMPORTED / OWN_STOCK). En SCRAPER lo maneja el
    /// worker en cada extracción.
    wholesalePrice: z.number().positive().optional(),
    assignedCategoryId: z.string().nullable().optional(),
    pricingRuleId: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
  })
  .strict();

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireSession();

  const owned = await prisma.catalogProduct.findFirst({
    where: { id: params.id, userId: session.user.id },
    select: {
      id: true,
      // supplierName + commercialTitle: necesarios para resolver el delta real
      // del título comercial (4D-title). Sin esto, no podemos distinguir
      // "el usuario editó" de "guardó con el supplierName precargado intacto".
      supplierName: true,
      commercialTitle: true,
      provider: { select: { providerType: true } },
    },
  });
  if (!owned) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body inválido" }, { status: 400 });
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validación falló", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  // wholesalePrice solo es editable por el usuario en productos no-SCRAPER.
  // Bloqueamos a nivel API por si el cliente lo mete a mano (la UI ya oculta
  // el campo, pero defensa en profundidad).
  if (
    parsed.data.wholesalePrice !== undefined &&
    owned.provider.providerType === "SCRAPER"
  ) {
    return NextResponse.json(
      {
        error:
          "El precio de costo de productos scraper solo lo actualiza el worker",
      },
      { status: 400 }
    );
  }

  // publicationSku (legacy) ya NO se edita por este endpoint (Fase 4B).
  // El SKU comercial vive en ProductPublication.sku y se edita por
  // PUT /api/catalog/publications/[id]/sku, que tiene guard de colisión
  // bloqueante (lo que evita la contaminación que vimos con TP-00658).
  // Rechazamos 410 con redirección clara para tapar el agujero del campo
  // legacy hasta que Fase 5 lo elimine del schema.
  if (parsed.data.publicationSku !== undefined) {
    return NextResponse.json(
      {
        error:
          "publicationSku ya no se edita por este endpoint. Usar PUT /api/catalog/publications/<id>/sku.",
      },
      { status: 410 }
    );
  }

  // ── Resolver delta real del commercialTitle (4D-title) ──────────────────
  // El frontend ahora precarga el input con commercialTitle ?? supplierName
  // (en vez de "") y siempre lo manda en el PATCH. Sin esta lógica, el caller
  // que guarda "sin tocar" persistiría commercialTitle=supplierName y marcaría
  // pub.commercialTitleUserEdited=true, congelando el título: el scraper
  // seguiría actualizando supplierName, pero el display y Woo quedarían con el
  // viejo. La regla es "delta real": setear/marcar solo si el valor entrante
  // es realmente distinto del estado actual Y distinto del supplierName
  // precargado.
  //
  // Casos:
  //   incoming === prev          → no-op (no re-marcar, no tocar pub)
  //   incoming vacío/null        → volver a dinámico (cp.cT=null, userEdited=false)
  //   incoming === supplierName  → no editó (precargado intacto)  →   ídem ↑
  //   resto                       → edición real (cp.cT=incoming, userEdited=true)
  type TitleDecision =
    | { kind: "noop" }
    | { kind: "set"; value: string | null; userEdited: boolean };

  let titleDecision: TitleDecision = { kind: "noop" };
  if (parsed.data.commercialTitle !== undefined) {
    const incomingRaw = parsed.data.commercialTitle?.trim() ?? "";
    const incoming = incomingRaw === "" ? null : incomingRaw;
    const supplierTrimmed = owned.supplierName.trim();
    const prev = owned.commercialTitle?.trim() ?? null;

    if (incoming === prev) {
      titleDecision = { kind: "noop" };
    } else if (incoming === null) {
      titleDecision = { kind: "set", value: null, userEdited: false };
    } else if (incoming === supplierTrimmed) {
      titleDecision = { kind: "set", value: null, userEdited: false };
    } else {
      titleDecision = { kind: "set", value: incoming, userEdited: true };
    }
  }

  // commercialDescription: SIN delta real por ahora (decisión aparte, espera
  // a que se defina si la descripción también se precarga). Mantiene el
  // comportamiento legacy: "vino en el body → persistir + userEdited=true".

  const cpData = { ...parsed.data };
  if (titleDecision.kind === "noop") {
    // No tocar cp.commercialTitle: el campo ya está como debe.
    delete cpData.commercialTitle;
  } else {
    cpData.commercialTitle = titleDecision.value;
  }

  const updated = await prisma.catalogProduct.update({
    where: { id: params.id },
    data: cpData,
    include: {
      provider: { select: { id: true, name: true, baseUrl: true } },
      images: { orderBy: { position: "asc" } },
      assignedCategory: { select: { id: true, name: true } },
      publications: {
        select: {
          status: true,
          storeId: true,
          pendingSync: true,
          syncStatus: true,
        },
      },
    },
  });

  // Sincronizar el override per-publication SOLO si hubo decisión real. En el
  // caso noop, no tocamos nada para no marcar userEdited de balde.
  if (titleDecision.kind === "set") {
    await prisma.productPublication.updateMany({
      where: { catalogProductId: params.id, status: "ACTIVE" },
      data: {
        commercialTitle: titleDecision.value,
        commercialTitleUserEdited: titleDecision.userEdited,
      },
    });
  }
  if (parsed.data.commercialDescription !== undefined) {
    await prisma.productPublication.updateMany({
      where: { catalogProductId: params.id, status: "ACTIVE" },
      data: {
        commercialDescription: parsed.data.commercialDescription,
        commercialDescriptionUserEdited: true,
      },
    });
  }

  // Drift detection: el sync a WooCommerce empuja precio + estado siempre,
  // y nombre/descripción solo si el flag userEdited está activo en la
  // publication. Por eso cualquier cambio en estos campos dispara drift.
  // publicationSku, categorías y notes no llegan a Woo → no marcan drift.
  // Para commercialTitle, ahora usamos la decisión del delta real — si fue
  // noop, no marcamos drift (sería un ciclo de worker que no produce nada).
  const affectsWoo =
    parsed.data.finalPrice !== undefined ||
    parsed.data.manualMargin !== undefined ||
    parsed.data.manualPrice !== undefined ||
    parsed.data.wholesalePrice !== undefined ||
    parsed.data.pricingRuleId !== undefined ||
    titleDecision.kind === "set" ||
    parsed.data.commercialDescription !== undefined;

  if (affectsWoo) {
    await markPublicationsDrift(prisma, [params.id]);
  }

  // (El log USER_EDITED_PUBLICATION_SKU se removió de acá en Fase 4B.
  // Ahora vive en PUT /api/catalog/publications/[id]/sku y solo se emite
  // si oldSku !== newSku — sin más logs fantasma.)

  return NextResponse.json(updated);
}

// DELETE: solo permitido para productos del stock propio (providerType=OWN_STOCK).
// Los productos scrapeados/importados no se borran a mano — se gestionan con
// supplierStatus / internalStatus.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await requireSession();

  const product = await prisma.catalogProduct.findFirst({
    where: { id: params.id, userId: session.user.id },
    include: { provider: { select: { providerType: true } } },
  });

  if (!product) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (product.provider.providerType !== "OWN_STOCK") {
    return NextResponse.json(
      { error: "Solo se pueden eliminar productos del stock propio" },
      { status: 400 }
    );
  }

  // CatalogProductImage tiene onDelete: Cascade, pero somos explícitos para
  // que sea obvio si en el futuro alguien cambia esa relación.
  await prisma.catalogProductImage.deleteMany({
    where: { catalogProductId: params.id },
  });

  await prisma.catalogProduct.delete({ where: { id: params.id } });

  return NextResponse.json({ deleted: true });
}
