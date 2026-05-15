import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import JSZip from "jszip";
import { format } from "date-fns";
import { requireSession } from "@/lib/auth";
import {
  fetchImageWithFallback,
  detectExt,
  sanitizeForFilename,
} from "@/lib/images/fetch-image";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // segundos

const MAX_PRODUCT_IDS = 100;
const FETCH_TIMEOUT_MS = 10_000;

export async function POST(req: NextRequest) {
  const session = await requireSession();
  let body: { productIds?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body inválido" }, { status: 400 });
  }

  const productIds = body.productIds;
  if (!Array.isArray(productIds) || productIds.length === 0) {
    return NextResponse.json({ error: "productIds requerido (array)" }, { status: 400 });
  }
  if (productIds.length > MAX_PRODUCT_IDS) {
    return NextResponse.json(
      { error: `Máximo ${MAX_PRODUCT_IDS} productos por descarga` },
      { status: 400 }
    );
  }
  if (!productIds.every((id) => typeof id === "string")) {
    return NextResponse.json({ error: "productIds deben ser strings" }, { status: 400 });
  }

  // Filtramos por jobs del usuario logueado: los productos heredan ownership de su job,
  // así no exponemos imágenes de otros tenants aunque alguien intuya productIds ajenos.
  const products = await prisma.extractedProduct.findMany({
    where: {
      id: { in: productIds as string[] },
      job: { userId: session.user.id },
    },
    include: {
      job: {
        include: {
          provider: {
            include: { scraperConfig: { select: { imageFilenamePrefix: true } } },
          },
        },
      },
    },
  });

  if (products.length === 0) {
    return NextResponse.json({ error: "No se encontraron productos" }, { status: 404 });
  }

  // Nombre del ZIP basado en el primer proveedor
  const firstProvider = products[0].job.provider;
  const zipName = `imagenes-${sanitizeForFilename(firstProvider.name)}-${format(new Date(), "yyyyMMdd")}.zip`;

  const zip = new JSZip();
  const errors: string[] = [];
  const usedNames = new Set<string>();

  for (const p of products) {
    if (!p.imageUrl) {
      errors.push(`${p.sku ?? p.id}: sin imageUrl`);
      continue;
    }

    const prefix = p.job.provider.scraperConfig?.imageFilenamePrefix ?? "";
    const baseId = p.sku ? sanitizeForFilename(p.sku) : `sin-sku-${p.id}`;
    const stem = `${prefix}${baseId}`;

    const result = await fetchImageWithFallback(p.imageUrl, FETCH_TIMEOUT_MS);
    if (!result) {
      errors.push(`${p.sku ?? p.id}: todas las resoluciones fallaron (${p.imageUrl})`);
      continue;
    }

    const { buffer, contentType, finalUrl } = result;
    const ext = detectExt(contentType, finalUrl);
    let filename = `${stem}.${ext}`;
    // Si hay colisión (mismo SKU dos veces) agregar contador
    let i = 2;
    while (usedNames.has(filename)) {
      filename = `${stem}-${i}.${ext}`;
      i++;
    }
    usedNames.add(filename);
    zip.file(filename, buffer);

    // Persistir metadata de la descarga. No bloquear el ZIP si falla.
    // imageFilePath queda null hasta que haya storage local/S3.
    try {
      await prisma.extractedProduct.update({
        where: { id: p.id },
        data: {
          imageFileName: filename,
          imageFilePath: null,
          imageDownloadedAt: new Date(),
        },
      });
    } catch (dbErr) {
      console.error(
        `[download-images] No se pudo actualizar producto ${p.id}:`,
        dbErr instanceof Error ? dbErr.message : dbErr
      );
    }
  }

  if (errors.length > 0) {
    zip.file("errores.txt", errors.join("\n") + "\n");
  }

  const zipBuffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  return new NextResponse(new Uint8Array(zipBuffer), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${zipName}"`,
      "Content-Length": String(zipBuffer.length),
    },
  });
}
