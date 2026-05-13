import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import JSZip from "jszip";
import { format } from "date-fns";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // segundos

const MAX_PRODUCT_IDS = 100;
const FETCH_TIMEOUT_MS = 10_000;

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/avif": "avif",
};

function sanitizeForFilename(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
}

function extFromUrl(url: string): string | null {
  try {
    const { pathname } = new URL(url);
    const m = pathname.match(/\.([a-zA-Z0-9]{2,5})$/);
    return m ? m[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

function detectExt(contentType: string | null, url: string): string {
  if (contentType) {
    const [mime] = contentType.split(";").map((s) => s.trim().toLowerCase());
    if (MIME_TO_EXT[mime]) return MIME_TO_EXT[mime];
  }
  const fromUrl = extFromUrl(url);
  if (fromUrl && /^(jpg|jpeg|png|webp|gif|bmp|avif)$/.test(fromUrl)) {
    return fromUrl === "jpeg" ? "jpg" : fromUrl;
  }
  return "jpg";
}

// Tienda Nube sirve la misma imagen en múltiples resoluciones. Si la URL pide una
// resolución que no está cacheada, devuelve 404. Intentamos las más comunes en orden
// descendente hasta encontrar una que exista.
const TIENDANUBE_RESOLUTIONS = [1024, 640, 480, 320, 240];
const RESOLUTION_PATTERN = /-(\d+)-(\d+)(\.[a-zA-Z]+)(\?|$)/;

async function fetchImageWithFallback(
  imageUrl: string,
  timeoutMs: number
): Promise<{ buffer: Buffer; contentType: string; finalUrl: string } | null> {
  const urlsToTry: string[] = [];

  if (RESOLUTION_PATTERN.test(imageUrl)) {
    for (const res of TIENDANUBE_RESOLUTIONS) {
      const candidate = imageUrl.replace(RESOLUTION_PATTERN, `-${res}-$2$3$4`);
      if (!urlsToTry.includes(candidate)) urlsToTry.push(candidate);
    }
    // Por si el patrón matcheó pero las candidatas no incluyen la original
    if (!urlsToTry.includes(imageUrl)) urlsToTry.push(imageUrl);
  } else {
    urlsToTry.push(imageUrl);
  }

  for (const url of urlsToTry) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) continue;
        const buffer = Buffer.from(await res.arrayBuffer());
        const contentType = res.headers.get("content-type") ?? "";
        return { buffer, contentType, finalUrl: url };
      } finally {
        clearTimeout(timer);
      }
    } catch {
      continue;
    }
  }
  return null;
}

export async function POST(req: NextRequest) {
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

  const products = await prisma.extractedProduct.findMany({
    where: { id: { in: productIds as string[] } },
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
