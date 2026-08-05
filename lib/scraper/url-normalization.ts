// Primitiva PURA de normalización de URLs de catálogo, COMPARTIDA entre el recon
// (lib/ops/a41-recon-core) y el runtime de completitud SKU-first del scraper.
//
// Sin I/O, sin env, sin DB, sin browser, sin artifacts, sin imports de ops, sin
// side effects al importar. Extraída verbatim de `a41-recon-core.normalizeUrl` para
// tener UNA sola semántica de normalización (no duplicar).
//
// Semántica: si falta esquema se asume https; host en minúsculas; se remueven los
// slashes finales del pathname. Devuelve `null` para vacío/whitespace o URL inválida.
export function normalizeCatalogUrl(rawUrl: string): string | null {
  const s = (rawUrl ?? "").trim();
  if (s === "") return null;
  try {
    const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
    const u = new URL(withScheme);
    const host = u.host.toLowerCase();
    const path = u.pathname.replace(/\/+$/, "");
    return host + path;
  } catch {
    return null;
  }
}
