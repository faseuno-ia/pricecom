// Helpers compartidos para descarga de imágenes de proveedores.
// Centralizado acá para que /api/products/download-images y /api/catalog/download-images
// usen exactamente la misma lógica.

export const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/avif": "avif",
};

export function sanitizeForFilename(s: string): string {
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

export function detectExt(contentType: string | null, url: string): string {
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

// Tienda Nube sirve la misma imagen en múltiples resoluciones. Si la URL pide
// una resolución que no está cacheada, devuelve 404. Intentamos las más comunes
// en orden descendente hasta encontrar una que exista.
const TIENDANUBE_RESOLUTIONS = [1024, 640, 480, 320, 240];
const RESOLUTION_PATTERN = /-(\d+)-(\d+)(\.[a-zA-Z]+)(\?|$)/;

export async function fetchImageWithFallback(
  imageUrl: string,
  timeoutMs: number
): Promise<{ buffer: Buffer; contentType: string; finalUrl: string } | null> {
  const urlsToTry: string[] = [];

  if (RESOLUTION_PATTERN.test(imageUrl)) {
    for (const res of TIENDANUBE_RESOLUTIONS) {
      const candidate = imageUrl.replace(RESOLUTION_PATTERN, `-${res}-$2$3$4`);
      if (!urlsToTry.includes(candidate)) urlsToTry.push(candidate);
    }
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
