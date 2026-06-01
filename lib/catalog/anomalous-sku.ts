// Detección de SKUs "anómalos" del proveedor: válidos (no son "0", "#N/A", ni
// vacíos — esos los filtra INVALID_SKU_RE en import-aliases), pero con un
// formato que sugiere que algo en el scraper o en el Excel pisó el SKU real
// con un fragmento de otro campo (número de orden, primer carácter del nombre,
// guión sobrante).
//
// Casos verificados contra los catálogos reales (Toys Palace 57, Impotekno 2,
// Gaby 1 — total 59 productos):
//
//   1. Empieza con "-" (54): "-877", "-680" → el SKU comercial sale con doble
//      guión ("TP--877") porque el prefijo ya inyecta uno.
//   2. Single-char (5): "3", "1", "8" → probable fragmento de nombre o
//      número de fila. SKU comercial sale demasiado corto ("TEK-3").
//   3. Termina con "-" (1): "Y-6-" → SKU comercial sale con guión colgando
//      ("TEK-Y-6-").
//
// Los SKUs anómalos se preservan literal (Fase 3 lazy) — no los reescribimos
// porque puede haber gemelos legítimos en distintos proveedores con ese
// formato. Pero en la UI los marcamos para que el usuario sepa antes de
// publicar.

export type AnomalousSkuReason =
  | "starts_with_dash"
  | "single_char"
  | "ends_with_dash";

export function isAnomalousSku(raw: string | null | undefined): boolean {
  return getAnomalousSkuReason(raw) !== null;
}

export function getAnomalousSkuReason(
  raw: string | null | undefined
): AnomalousSkuReason | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  if (s.startsWith("-")) return "starts_with_dash";
  if (s.length === 1) return "single_char";
  if (s.endsWith("-")) return "ends_with_dash";
  return null;
}

export const ANOMALOUS_SKU_TOOLTIP =
  "SKU del proveedor inusual — el SKU comercial puede quedar raro (doble guión, fragmento, guión final). Revisalo antes de publicar.";

export function getAnomalousSkuTooltip(
  reason: AnomalousSkuReason | null
): string {
  if (!reason) return "";
  switch (reason) {
    case "starts_with_dash":
      return "SKU del proveedor empieza con guión — el SKU comercial saldrá con doble guión. Revisalo antes de publicar.";
    case "single_char":
      return "SKU del proveedor es de un solo carácter — probablemente un fragmento. El SKU comercial saldrá demasiado corto. Revisalo antes de publicar.";
    case "ends_with_dash":
      return "SKU del proveedor termina con guión — el SKU comercial saldrá con guión colgando. Revisalo antes de publicar.";
  }
}
