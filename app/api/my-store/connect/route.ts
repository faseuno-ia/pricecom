// POST /api/my-store/connect — crea o actualiza la tienda + integration del
// usuario, prueba la conexión real con la plataforma y guarda el resultado.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import { encrypt } from "@/lib/utils/crypto";
import { WooCommerceClient } from "@/lib/integrations/woocommerce/client";

const bodySchema = z.object({
  name: z.string().min(1).max(80),
  storeUrl: z.string().url(),
  platform: z.enum(["WOOCOMMERCE", "SHOPIFY", "TIENDANUBE"]),
  consumerKey: z.string().min(1),
  consumerSecret: z.string().min(1),
});

export async function POST(req: NextRequest) {
  const session = await requireSession();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body inválido" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validación falló", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const data = parsed.data;

  if (data.platform !== "WOOCOMMERCE") {
    return NextResponse.json(
      { error: "Solo WooCommerce está soportado por ahora" },
      { status: 400 }
    );
  }

  // Tienda del usuario (una por ahora — si en el futuro hay múltiples, el
  // form pedirá un selector).
  let store = await prisma.store.findFirst({
    where: { userId: session.user.id },
  });

  if (!store) {
    store = await prisma.store.create({
      data: {
        userId: session.user.id,
        name: data.name,
        platform: "WOOCOMMERCE",
        url: data.storeUrl,
      },
    });
  } else {
    store = await prisma.store.update({
      where: { id: store.id },
      data: {
        name: data.name,
        platform: data.platform,
        url: data.storeUrl,
      },
    });
  }

  // Probar credenciales contra la API real ANTES de cifrar/guardar.
  const client = new WooCommerceClient(
    data.storeUrl,
    data.consumerKey,
    data.consumerSecret
  );
  const probe = await client.testConnection();

  const integration = await prisma.storeIntegration.upsert({
    where: { id: (await getExistingIntegrationId(store.id)) ?? "__none__" },
    create: {
      storeId: store.id,
      consumerKeyEncrypted: encrypt(data.consumerKey),
      consumerSecretEncrypted: encrypt(data.consumerSecret),
      status: probe.ok ? "CONNECTED" : "ERROR",
      lastConnectionCheck: new Date(),
      lastError: probe.ok ? null : probe.error ?? "Error desconocido",
    },
    update: {
      consumerKeyEncrypted: encrypt(data.consumerKey),
      consumerSecretEncrypted: encrypt(data.consumerSecret),
      status: probe.ok ? "CONNECTED" : "ERROR",
      lastConnectionCheck: new Date(),
      lastError: probe.ok ? null : probe.error ?? "Error desconocido",
    },
  });

  return NextResponse.json({
    ok: probe.ok,
    storeId: store.id,
    integrationId: integration.id,
    error: probe.ok ? undefined : probe.error,
  });
}

async function getExistingIntegrationId(storeId: string): Promise<string | null> {
  const found = await prisma.storeIntegration.findFirst({
    where: { storeId },
    select: { id: true },
    orderBy: { createdAt: "desc" },
  });
  return found?.id ?? null;
}
