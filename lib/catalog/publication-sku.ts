// SKU comercial / publicable = imageFilenamePrefix del proveedor + SKU original.
// Es el identificador que el cliente usa en su tienda online, en sus exports
// comerciales y en los nombres de archivo de las imágenes descargadas. NUNCA
// sobrescribe el `sku` original del proveedor; vive en un campo aparte
// (CatalogProduct.publicationSku) y se deriva siempre.

export function buildPublicationSku(
  prefix: string | null | undefined,
  sku: string | null | undefined
): string | null {
  const cleanSku = sku?.trim();
  if (!cleanSku) return null;
  const cleanPrefix = (prefix ?? "").trim();
  return cleanPrefix + cleanSku;
}
