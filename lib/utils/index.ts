import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatPrice(price: number | string | null | undefined): string {
  if (price === null || price === undefined) return "—";
  const num = typeof price === "string" ? parseFloat(price) : price;
  if (isNaN(num)) return "—";
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 2,
  }).format(num);
}

export function formatDate(date: Date | string | null | undefined): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(d);
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\w-]+/g, "")
    .replace(/--+/g, "-")
    .trim();
}

/**
 * Extract price from a raw string using common Argentine/Latin American formats.
 * Handles: $1.500, $1,500.00, ARS 1500, USD 10.50, 1.500,00
 */
export function parsePrice(raw: string): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^\d.,]/g, "").trim();
  if (!cleaned) return null;

  // Format: 1.500,00 (Argentine style)
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(cleaned)) {
    return parseFloat(cleaned.replace(/\./g, "").replace(",", "."));
  }
  // Format: 1,500.00 (US style)
  if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(cleaned)) {
    return parseFloat(cleaned.replace(/,/g, ""));
  }
  // Format: 1500,50
  if (/^\d+,\d{1,2}$/.test(cleaned)) {
    return parseFloat(cleaned.replace(",", "."));
  }
  // Plain number
  const num = parseFloat(cleaned.replace(",", "."));
  return isNaN(num) ? null : num;
}

export function truncate(str: string, length: number): string {
  if (str.length <= length) return str;
  return str.slice(0, length) + "…";
}

// Dominios que bloquean hotlinking — el browser no logra cargar la imagen
// porque el server remoto rechaza requests con Referer ajeno. Las pasamos
// por /api/image-proxy donde sí podemos setear el Referer correcto.
const HOTLINK_BLOCKED_DOMAINS = [
  "impotekno.net", // HTTP sin SSL válido — necesita proxy
  // toyspalace.com.ar — removido: Toys Palace bloquea requests desde la IP de
  // Railway. Cargar la imagen directa desde el browser del usuario logra
  // resultados mejores (al menos para una parte del catálogo).
];

/**
 * Normaliza una URL de imagen para que la UI la pueda mostrar siempre:
 * - https:// → tal cual, salvo que el host esté en HOTLINK_BLOCKED_DOMAINS.
 * - http://  → la enrutamos por /api/image-proxy (también evita mixed
 *              content cuando la app corre en HTTPS).
 * - //...    → asumimos https.
 * - cualquier otro caso → tal cual.
 */
export function normalizeImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;

  if (url.startsWith("//")) {
    url = "https:" + url;
  }

  const isHttp = url.startsWith("http://");
  const isBlocked = HOTLINK_BLOCKED_DOMAINS.some((d) => url.includes(d));

  if (isHttp || isBlocked) {
    return `/api/image-proxy?url=${encodeURIComponent(url)}`;
  }
  return url;
}

/**
 * Limpia un nombre/descripción extraído del scraper.
 * Cuando el selector matchea un contenedor en vez del título exacto, .text() de cheerio
 * concatena todo el texto interno (precio, descuento, "Comprar", etc.) separado por \n.
 * Nos quedamos con la primera línea no vacía y quitamos sufijos como "Codigo 34712"
 * o "Código.21774" que algunos sitios (Tienda Nube) agregan al final del título.
 */
export function cleanProductName(raw: string | null | undefined): string {
  if (!raw) return "";
  const firstLine = raw.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  let name = firstLine.replace(/\s*[Cc][oó]d(igo)?\.?\s*\d+\s*$/, "");
  // Código interno "(CODE) " al inicio (ej. OESTECH: "(BLT-078) CONTROL..."):
  // CODE en MAYÚSCULAS/dígitos/[-._], 2-20 chars, y CON al menos un dígito o
  // separador (-._). Esa guarda distingue un código de una palabra comercial:
  // "(Oferta)"/"(Combo x2)" tienen minúscula/espacio y "(OFERTA)" no tiene
  // dígito/guion → no se tocan. Solo se quita si queda texto real después.
  // \s* (no \s+): el código puede venir pegado al texto, "(RD-007)CAMIONETA".
  // El (\S.*) exige texto real después → "(RD-007)" o "(RD-007)   " no se tocan.
  const paren = name.match(/^\(([A-Z0-9._-]{2,20})\)\s*(\S.*)$/);
  if (paren && /[\d._-]/.test(paren[1])) name = paren[2];
  // Basura de guiones de relleno al final (ej. "NOMBRE - -  -  -"). Conservador:
  // solo el trailing; un guion interno (USB-C, "HDMI - VGA") se preserva.
  return name.replace(/(?:\s*-\s*)+$/, "").trim();
}
