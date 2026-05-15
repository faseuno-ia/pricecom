import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import JSZip from "jszip";
import { format } from "date-fns";
import {
  fetchImageWithFallback,
  detectExt,
  sanitizeForFilename,
} from "@/lib/images/fetch-image";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_PRODUCT_IDS = 100;
const FETCH_TIMEOUT_MS = 10_000;

export async function POST(req: NextRequest) {
  const session = await requireSession();

  let body: { catalogProductIds?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body inválido" }, { status: 400 });
  }
  const ids = body.catalogProductIds;
  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json(
      { error: "catalogProductIds requerido (array)" },
      { status: 400 }
    );
  }
  if (ids.length > MAX_PRODUCT_IDS) {
    return NextResponse.json(
      { error: `Máximo ${MAX_PRODUCT_IDS} productos por descarga` },
      { status: 400 }
    );
  }
  if (!ids.every((id) => typeof id === "string")) {
    return NextResponse.json({ error: "IDs deben ser strings" }, { status: 400 });
  }

  const products = await prisma.catalogProduct.findMany({
    where: { id: { in: ids as string[] }, userId: session.user.id },
    include: {
      provider: {
        select: {
          id: true,
          name: true,
          scraperConfig: { select: { imageFilenamePrefix: true } },
        },
      },
      // Solo la imagen primaria (o la primera por position) — la que muestra la UI.
      images: {
        orderBy: [{ isPrimary: "desc" }, { position: "asc" }],
        take: 1,
        select: { url: true },
      },
    },
  });

  if (products.length === 0) {
    return NextResponse.json(
      { error: "No se encontraron productos" },
      { status: 404 }
    );
  }

  const zip = new JSZip();
  const errors: string[] = [];
  const usedNames = new Set<string>();

  for (const p of products) {
    // Prioridad: imagen propia del catálogo > imageUrl del proveedor.
    const imageUrl = p.images[0]?.url ?? p.imageUrl;
    if (!imageUrl) {
      errors.push(`${p.sku ?? p.id}: sin imagen disponible`);
      continue;
    }

    const prefix =
      p.provider.scraperConfig?.imageFilenamePrefix ??
      `${p.provider.id.slice(0, 6)}-`;
    const baseId = p.sku ? sanitizeForFilename(p.sku) : `sin-sku-${p.id}`;
    const stem = `${prefix}${baseId}`;

    const result = await fetchImageWithFallback(imageUrl, FETCH_TIMEOUT_MS);
    if (!result) {
      errors.push(`${p.sku ?? p.id}: todas las resoluciones fallaron (${imageUrl})`);
      continue;
    }

    const ext = detectExt(result.contentType, result.finalUrl);
    let filename = `${stem}.${ext}`;
    let i = 2;
    while (usedNames.has(filename)) {
      filename = `${stem}-${i}.${ext}`;
      i++;
    }
    usedNames.add(filename);
    zip.file(filename, result.buffer);
  }

  if (errors.length > 0) {
    zip.file("errores.txt", errors.join("\n") + "\n");
  }

  const zipBuffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  const filename = `catalog-images-${format(new Date(), "yyyyMMdd")}.zip`;
  return new NextResponse(new Uint8Array(zipBuffer), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(zipBuffer.length),
    },
  });
}
