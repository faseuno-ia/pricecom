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
  return firstLine.replace(/\s*[Cc][oó]d(igo)?\.?\s*\d+\s*$/, "").trim();
}
