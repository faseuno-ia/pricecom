// Aliases tolerantes para los nombres de columna del Excel del cliente.
// Usado tanto por el endpoint POST /api/catalog/import como por el script CLI
// scripts/import-store-excel.ts. Mantener acá la fuente única.
//
// Reglas clave del Excel del cliente:
//   - SKU PROVEEDOR  → CatalogProduct.sku           (identidad técnica)
//   - SKU WEB        → CatalogProduct.publicationSku (identidad comercial)
//   - NOMBRE PROVEEDOR → supplierName
//   - NOMBRE WEB     → commercialTitle              (override comercial editable)

export const COL_ALIASES: Record<string, string[]> = {
  sku: [
    "SKU PROVEEDOR",
    "SKU",
    "sku",
    "Codigo",
    "CODIGO",
    "COD",
    "Cod",
  ],
  publicationSku: [
    "SKU WEB",
    "SKU COMERCIAL",
    "PUBLICATION SKU",
    "publicationSku",
  ],
  name: [
    "NOMBRE PROVEEDOR",
    "Nombre",
    "NOMBRE",
    "nombre",
    "DESCRIPCION",
    "Descripcion",
    "DESCRIPCIÓN",
    "Descripción",
    "name",
  ],
  commercialName: [
    "NOMBRE WEB",
    "Titulo comercial",
    "TITULO COMERCIAL",
    "Título comercial",
    "TÍTULO COMERCIAL",
  ],
  cost: [
    "COSTO PROVEEDOR",
    "Costo",
    "COSTO",
    "Precio mayorista",
    "PRECIO MAYORISTA",
    "PRECIO WEB (MAYORISTA)",
    "Costo mayorista",
    "costo",
  ],
  margin: [
    "MARGEN WEB %",
    "MARGEN WEB",
    "Margen %",
    "MARGEN %",
    "Margen",
    "MARGEN",
    "margen",
    "margin",
  ],
  // Precio de venta del Excel. NO se mapea a finalPrice (que congela el precio
  // y apaga el motor): el importador lo usa para DERIVAR manualMargin
  // recalculable (ver lib/catalog/import-price.ts). El freeze explícito por
  // columna ("PRECIO FIJO") queda para Gate 2B.
  // Cuidado: "PRECIO WEB (MAYORISTA)" es COSTO (arriba), no precio de venta.
  salePrice: [
    "PRECIO WEB",
    "Precio final",
    "PRECIO FINAL",
    "Precio venta",
    "PRECIO VENTA",
  ],
  stock: ["Stock", "STOCK", "stock", "Cantidad", "CANTIDAD"],
  category: ["Categoria", "CATEGORIA", "Categoría", "CATEGORÍA", "category"],
  imageUrl: [
    "IMÁGENES",
    "Imágenes",
    "IMAGENES",
    "Imagenes",
    "Imagen URL",
    "IMAGEN URL",
    "LINK FOTO",
    "Imagen",
    "IMAGEN",
    "imagen",
    "imageUrl",
    "foto",
    "FOTO",
  ],
};

export function pickField(
  row: Record<string, unknown>,
  field: keyof typeof COL_ALIASES
): string {
  for (const k of COL_ALIASES[field]) {
    const v = row[k];
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

export function parseImportNumber(s: string): number | null {
  if (!s) return null;
  const cleaned = s.replace(/[$\s]/g, "").replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function parseImportMargin(raw: unknown): number | null {
  if (raw == null || raw === "" || raw === "#N/A") return null;
  if (typeof raw === "number") {
    return raw <= 1 && raw > 0 ? raw * 100 : raw;
  }
  const cleaned = String(raw).replace("%", "").replace(",", ".").trim();
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return n <= 1 && n > 0 ? n * 100 : n;
}

// Regex compartido para SKUs inválidos: vacío, "0", "0.0", "#N/A".
export const INVALID_SKU_RE = /^(0+(\.0+)?|#N\/A)$/i;
