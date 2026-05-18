import { NextRequest, NextResponse } from "next/server";

// Lista blanca de hosts permitidos para evitar que el proxy se use como
// pasarela genérica. Sólo dominios de proveedores conocidos.
const ALLOWED_HOSTS = [
  "impotekno.net",
  "dcdn-us.mitiendanube.com",
  "bazar380.com.ar",
  "toyspalace.com.ar",
];

// Nota de auth: las rutas de la app están protegidas por middleware.ts
// (matcher excluye sólo /login y /api/auth). El browser manda la cookie de
// NextAuth automáticamente al cargar imágenes via <img src="/api/image-proxy?...">,
// así que el acceso al proxy está limitado a usuarios logueados sin código extra.

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) return new NextResponse("Missing url", { status: 400 });

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return new NextResponse("Invalid url", { status: 400 });
  }

  if (!ALLOWED_HOSTS.some((h) => parsed.hostname.endsWith(h))) {
    return new NextResponse("Host not allowed", { status: 403 });
  }

  try {
    // Algunos sitios (Toys Palace) bloquean hotlinking — devuelven una imagen
    // de "image was hotlinked" cuando el Referer no matchea su dominio. Para
    // que el proxy obtenga la imagen real, forjamos un Referer del mismo
    // origen que la imagen.
    const referer = `${parsed.protocol}//${parsed.hostname}/`;
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        Referer: referer,
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
    });

    if (!response.ok) {
      return new NextResponse("Image fetch failed", { status: 502 });
    }

    const contentType = response.headers.get("content-type") ?? "image/jpeg";
    const buffer = await response.arrayBuffer();

    return new NextResponse(buffer, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400", // cache 24h
      },
    });
  } catch {
    return new NextResponse("Error fetching image", { status: 500 });
  }
}
