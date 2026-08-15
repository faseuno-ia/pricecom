// C1 · Observación de taxonomía de proveedor TiendaNube (Different Touch y equivalentes).
//
// PURA y aditiva: normaliza el breadcrumb crudo de una ficha a una ruta de categorías
// del proveedor SIN tocar ninguna semántica de extracción existente (precio, SKU,
// agrupación, imagen, `category` legacy). Es SÓLO observación; ningún writer la lee todavía.
//
// Reglas (N1/P0 congeladas):
//  1. Raíz constante "Inicio" se quita POR POSICIÓN (sólo si el primer nodo es la raíz).
//  2. El nodo final (producto actual) se quita POR POSICIÓN (nunca por coincidencia de texto).
//  3. Si la ruta restante es exactamente ["Productos"] (o queda vacía) → "sin categoría"
//     observada (uncategorized). "Productos" es el marcador genérico, no una categoría real.
//  4. Se preserva el orden jerárquico; no se aplana.
//
// Distinción explícita (NO_ABSENCE_FROM_FAILURE):
//   - `null`                         → NOT_OBSERVED (no había breadcrumb / malformado).
//   - `{ path: [], uncategorized:true }` → OBSERVED, sin categoría real ("Productos"/vacío).
//   - `{ path: [...], uncategorized:false }` → OBSERVED, ruta jerárquica real.

/** Raíz constante del storefront (probada 25/25 en DT). */
export const SUPPLIER_TAXONOMY_ROOT = "Inicio";
/** Marcador genérico de "sin categoría" del storefront. */
export const SUPPLIER_TAXONOMY_UNCATEGORIZED_MARKER = "Productos";

export interface SupplierTaxonomyObservation {
  /** Ruta de categorías del proveedor, de más general a más específica. Vacía si uncategorized. */
  path: string[];
  /** true cuando el proveedor NO asignó categoría real (bucket "Productos" o vacío tras normalizar). */
  uncategorized: boolean;
}

function cleanNode(n: unknown): string | null {
  if (typeof n !== "string") return null;
  // Normalización Unicode explícita = NFC (sólo composición canónica). Preserva la ortografía
  // VISIBLE (acentos, mayúsculas/minúsculas, puntuación significativa); NO hace lowercase, NO
  // elimina acentos, NO transliterar. Evita que "Cosmética" precompuesta (NFC) y la misma con
  // marcas combinantes (NFD) se conviertan en identidades de taxonomía distintas aguas abajo.
  const t = n.trim().normalize("NFC");
  if (t.length === 0 || t === ">" || t === "/") return null;
  return t;
}

/**
 * Normaliza los nodos crudos de un breadcrumb a una observación de taxonomía.
 * NO recibe el nombre del producto: el recorte del nodo-hoja es estrictamente POSICIONAL,
 * por lo que es imposible eliminar una categoría real cuyo texto coincida con el producto.
 *
 * @param rawNodes nodos del breadcrumb tal como se leyeron del DOM (incluida raíz y hoja de producto),
 *                 o `null`/`undefined` si no se observó breadcrumb.
 * @returns observación, o `null` si NOT_OBSERVED.
 */
export function normalizeSupplierTaxonomy(
  rawNodes: ReadonlyArray<string | null | undefined> | null | undefined,
): SupplierTaxonomyObservation | null {
  if (rawNodes === null || rawNodes === undefined) return null; // NOT_OBSERVED

  const cleaned = rawNodes.map(cleanNode).filter((n): n is string => n !== null);
  // Se necesitan al menos raíz + hoja de producto para recortar por posición de forma fiable.
  if (cleaned.length < 2) return null; // root-only / malformado → NOT_OBSERVED

  let nodes = cleaned.slice();
  // 1. Quitar raíz por posición SÓLO si el primer nodo es la raíz establecida.
  if (nodes[0] === SUPPLIER_TAXONOMY_ROOT) nodes = nodes.slice(1);
  // 2. Quitar el nodo-hoja (producto actual) por posición.
  nodes = nodes.slice(0, -1);

  // 3. Interpretar el resto.
  if (nodes.length === 0) return { path: [], uncategorized: true };
  if (nodes.length === 1 && nodes[0] === SUPPLIER_TAXONOMY_UNCATEGORIZED_MARKER) {
    return { path: [], uncategorized: true };
  }
  return { path: nodes, uncategorized: false };
}
