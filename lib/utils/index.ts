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

// Rango CP1252 0x80–0x9F: bytes que en Windows-1252 NO son latin1 sino puntuación
// tipográfica / letras extra. Mapa explícito Unicode → byte para poder revertir.
// (0x81, 0x8D, 0x8F, 0x90, 0x9D no están definidos en CP1252 → no aparecen acá.)
const CP1252_HIGH_TO_BYTE: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f,
};

/**
 * Revierte mojibake típico: texto UTF-8 que un origen interpretó como
 * Windows-1252 y luego re-codificó como UTF-8 (ej. OESTECH sirve el catálogo
 * UTF-8, pero el HTML crudo trae `DISEÃ‘O` en vez de `DISEÑO`, `180Â°` en vez
 * de `180°`).
 *
 * Estrategia: re-encodear cada carácter a su byte CP1252 y decodificar esos
 * bytes como UTF-8. NO usa `latin1` (falla con `‘` = U+2018) ni dependencias
 * externas; el rango alto 0x80–0x9F sale del mapa manual de arriba.
 *
 * Conservador por diseño — dos guardas para no romper texto ya correcto:
 *  1. Si algún carácter NO es representable en CP1252 → devuelve el original.
 *  2. Si el decode UTF-8 produce U+FFFD (secuencia inválida) → devuelve el
 *     original. Esta es crítica: un `Ñ`/`°` YA correcto encodea a un byte que
 *     no forma UTF-8 válido, así que la guarda lo deja intacto.
 *
 * NUNCA se aplica a SKU — solo a nombres/descripciones vía `cleanProductName`.
 */
export function fixMojibakeCp1252Utf8(input: string): string {
  if (!input) return input;

  const bytes: number[] = [];
  for (const ch of input) {
    const code = ch.codePointAt(0)!;
    if (code <= 0x7f || (code >= 0xa0 && code <= 0xff)) {
      // ASCII + rango alto donde CP1252 == latin1.
      bytes.push(code);
    } else if (code in CP1252_HIGH_TO_BYTE) {
      bytes.push(CP1252_HIGH_TO_BYTE[code]);
    } else {
      // Guarda 1: carácter fuera de CP1252 (emoji, CJK, C1 controls…).
      return input;
    }
  }

  // Guarda 2: decode no-fatal; si aparece U+FFFD, la secuencia no era UTF-8
  // válido → el texto ya estaba bien, devolver original.
  const decoded = new TextDecoder("utf-8").decode(Uint8Array.from(bytes));
  if (decoded.includes("�")) return input;
  return decoded;
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
  // Corregir mojibake CP1252→UTF-8 ANTES de quitar sufijos: así "Código" con
  // mojibake ("CÃ³digo") también se detecta. No toca SKU (otro flujo).
  let name = fixMojibakeCp1252Utf8(firstLine).replace(/\s*[Cc][oó]d(igo)?\.?\s*\d+\s*$/, "");
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
