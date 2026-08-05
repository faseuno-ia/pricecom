// G1 — adapter de dos snapshots: cobertura + piso mínimo (§4.1/§4.2/§6.1/§6.2).
import { describe, it, expect } from "vitest";
import { resolveTwoSnapshotCompleteness } from "@/lib/scraper/sitemap-two-snapshot";
import type { SitemapSnapshot } from "@/lib/scraper/runtime-sitemap-reference";

const MIN = 700;
const gen = (n: number, prefix = "p"): string[] => Array.from({ length: n }, (_, i) => `differenttouch.com.ar/productos/${prefix}${i}`);
const pop = (urls: string[]): SitemapSnapshot => ({ kind: "POPULATED", urls, rawLocCount: urls.length, productLocCount: urls.length });
const empty = (): SitemapSnapshot => ({ kind: "EXPLICITLY_EMPTY", rawLocCount: 0, productLocCount: 0 });
const failed = (reason: any): SitemapSnapshot => ({ kind: "FETCH_FAILED", reason });
const run = (start: SitemapSnapshot, end: SitemapSnapshot, walkSet: string[], min = MIN) =>
  resolveTwoSnapshotCompleteness({ start, end, walkSet, minExpectedProducts: min });

describe("piso absoluto (§4.1)", () => {
  it("BLOCKING=40 < 700, walk cubre todo → R2_SITEMAP_REFERENCE_IMPLAUSIBLY_SMALL (nunca COMPLETE)", () => {
    const s = gen(40); const r = run(pop(s), pop(s), s);
    expect(r.complete).toBe(false);
    expect(r.reasonCode).toBe("R2_SITEMAP_REFERENCE_IMPLAUSIBLY_SMALL");
    if (!r.complete) expect(r.failedBeforeResolver).toBe(true);
    expect(r.diagnostics.blockingSetCount).toBe(40);
    expect(r.diagnostics.minExpectedProducts).toBe(700);
  });
  it("BLOCKING=699 < 700 → IMPLAUSIBLY_SMALL", () => {
    const s = gen(699); const r = run(pop(s), pop(s), s);
    expect(r.reasonCode).toBe("R2_SITEMAP_REFERENCE_IMPLAUSIBLY_SMALL");
  });
  it("BLOCKING=700, walk cubre todo → COMPLETE", () => {
    const s = gen(700); const r = run(pop(s), pop(s), s);
    expect(r.complete).toBe(true);
    expect(r.diagnostics.blockingSetCount).toBe(700);
  });
  it("BLOCKING=877, walk cubre todo → COMPLETE", () => {
    const s = gen(877); const r = run(pop(s), pop(s), s);
    expect(r.complete).toBe(true);
  });
});

describe("precedencia de estados vacío/intersección (§4.1)", () => {
  it("ambos poblados pero intersección vacía → R2_SITEMAP_STABLE_INTERSECTION_EMPTY (antes del piso)", () => {
    const r = run(pop(gen(800, "a")), pop(gen(800, "b")), []);
    expect(r.reasonCode).toBe("R2_SITEMAP_STABLE_INTERSECTION_EMPTY");
    expect(r.diagnostics.blockingSetCount).toBe(0);
  });
  it("start vacío → R2_SITEMAP_REFERENCE_EXPLICITLY_EMPTY (PARTIAL/exit23)", () => {
    const r = run(empty(), pop(gen(800)), gen(800));
    expect(r.reasonCode).toBe("R2_SITEMAP_REFERENCE_EXPLICITLY_EMPTY");
    if (!r.complete) expect(r.failedBeforeResolver).toBe(false);
  });
  it("end vacío → R2_SITEMAP_REFERENCE_EXPLICITLY_EMPTY", () => {
    const r = run(pop(gen(800)), empty(), gen(800));
    expect(r.reasonCode).toBe("R2_SITEMAP_REFERENCE_EXPLICITLY_EMPTY");
  });
  it("start fetch falla → fail-closed pre-resolver", () => {
    const r = run(failed("NETWORK_ERROR"), pop(gen(800)), gen(800));
    expect(r.reasonCode).toContain("R2_SITEMAP_START_FETCH_FAILED");
  });
  it("end fetch falla → fail-closed pre-resolver", () => {
    const r = run(pop(gen(800)), failed("HTTP_INVALID"), gen(800));
    expect(r.reasonCode).toContain("R2_SITEMAP_END_FETCH_FAILED");
  });
});

describe("cobertura (§4.2/§6.2)", () => {
  it("BLOCKING=700, walk omite una ficha estable → fail-closed (WALK_INCOMPLETE)", () => {
    const s = gen(700); const r = run(pop(s), pop(s), s.slice(0, 699));
    expect(r.complete).toBe(false);
    expect(r.reasonCode).toBe("R2_WALK_INCOMPLETE");
    expect(r.diagnostics.blockingMissingCount).toBe(1);
    expect(r.diagnostics.blockingMissingSetSha256).toBeTruthy();
  });
  it("churn removal (ficha solo en start) no bloquea si blocking≥700 cubierto → COMPLETE", () => {
    const stable = gen(800); const start = [...stable, "differenttouch.com.ar/productos/removed"];
    const r = run(pop(start), pop(stable), stable);
    expect(r.complete).toBe(true);
    expect(r.diagnostics.removedDuringRunCount).toBe(1);
  });
  it("churn addition (ficha solo en end) no bloquea → COMPLETE", () => {
    const stable = gen(800); const end = [...stable, "differenttouch.com.ar/productos/added"];
    const r = run(pop(stable), pop(end), stable);
    expect(r.complete).toBe(true);
    expect(r.diagnostics.addedDuringRunCount).toBe(1);
  });
  it("walk con extra fuera de start∪end pero cubre blocking → COMPLETE + anomalía", () => {
    const s = gen(800); const r = run(pop(s), pop(s), [...s, "differenttouch.com.ar/productos/extra"]);
    expect(r.complete).toBe(true);
    expect(r.diagnostics.walkOnlyOutsideStartEndCount).toBe(1);
  });
  it("faltantes con blocking≥700 (corte prematuro) → fail-closed", () => {
    const s = gen(750); const r = run(pop(s), pop(s), s.slice(0, 740));
    expect(r.complete).toBe(false);
    expect(r.diagnostics.blockingMissingCount).toBe(10);
  });
});
