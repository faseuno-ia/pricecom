// A4.1-R2 — test CONDUCTUAL de la autoridad de completitud (ejecuta la función real,
// no grep de fuente). Matriz de 5 outcomes + 3 invariantes fail-loud.
import { describe, it, expect } from "vitest";
import {
  resolveSitemapCompletenessOutcome,
  SitemapCompletenessInvariantError,
} from "@/lib/scraper/sitemap-completeness";

const POP = "POPULATED_REFERENCE" as const;
const EMPTY = "EXPLICITLY_EMPTY_REFERENCE" as const;

describe("resolveSitemapCompletenessOutcome — matriz", () => {
  it("1. walk != COMPLETE → WALK_INCOMPLETE (complete=false)", () => {
    const r = resolveSitemapCompletenessOutcome({ walkStatus: "PARTIAL", referenceKind: POP, normalizedReferenceCount: 877, exactSetMatch: true });
    expect(r).toEqual({ complete: false, outcome: "WALK_INCOMPLETE", reasonCode: "R2_WALK_INCOMPLETE" });
  });
  it("2. COMPLETE + EXPLICITLY_EMPTY → REFERENCE_EXPLICITLY_EMPTY (complete=false)", () => {
    const r = resolveSitemapCompletenessOutcome({ walkStatus: "COMPLETE", referenceKind: EMPTY, normalizedReferenceCount: 0, exactSetMatch: false });
    expect(r).toEqual({ complete: false, outcome: "REFERENCE_EXPLICITLY_EMPTY", reasonCode: "R2_SITEMAP_REFERENCE_EXPLICITLY_EMPTY" });
  });
  it("3. COMPLETE + POPULATED + count=0 → REFERENCE_NORMALIZED_TO_ZERO (complete=false)", () => {
    const r = resolveSitemapCompletenessOutcome({ walkStatus: "COMPLETE", referenceKind: POP, normalizedReferenceCount: 0, exactSetMatch: false });
    expect(r).toEqual({ complete: false, outcome: "REFERENCE_NORMALIZED_TO_ZERO", reasonCode: "R2_SITEMAP_REFERENCE_NORMALIZED_TO_ZERO" });
  });
  it("4. COMPLETE + POPULATED + count>0 + !exactMatch → SET_MISMATCH (complete=false)", () => {
    const r = resolveSitemapCompletenessOutcome({ walkStatus: "COMPLETE", referenceKind: POP, normalizedReferenceCount: 900, exactSetMatch: false });
    expect(r).toEqual({ complete: false, outcome: "SET_MISMATCH", reasonCode: "R2_SITEMAP_SET_MISMATCH" });
  });
  it("5. COMPLETE + POPULATED + count>0 + exactMatch → COMPLETE (complete=true EXCLUSIVO)", () => {
    const r = resolveSitemapCompletenessOutcome({ walkStatus: "COMPLETE", referenceKind: POP, normalizedReferenceCount: 877, exactSetMatch: true });
    expect(r).toEqual({ complete: true, outcome: "COMPLETE", reasonCode: null });
  });
  it("complete=true SOLO en el caso 5 (ningún otro input lo produce)", () => {
    const others = [
      { walkStatus: "PARTIAL", referenceKind: POP, normalizedReferenceCount: 877, exactSetMatch: true },
      { walkStatus: "COMPLETE", referenceKind: EMPTY, normalizedReferenceCount: 0, exactSetMatch: false },
      { walkStatus: "COMPLETE", referenceKind: POP, normalizedReferenceCount: 0, exactSetMatch: false },
      { walkStatus: "COMPLETE", referenceKind: POP, normalizedReferenceCount: 5, exactSetMatch: false },
    ];
    for (const i of others) expect(resolveSitemapCompletenessOutcome(i).complete).toBe(false);
  });
});

describe("resolveSitemapCompletenessOutcome — invariantes fail-loud", () => {
  it("EMPTY + count>0 → throw INVARIANT_EMPTY_REFERENCE_WITH_NONZERO_COUNT", () => {
    try { resolveSitemapCompletenessOutcome({ walkStatus: "COMPLETE", referenceKind: EMPTY, normalizedReferenceCount: 3, exactSetMatch: false }); expect.unreachable(); }
    catch (e) { expect(e).toBeInstanceOf(SitemapCompletenessInvariantError); expect((e as SitemapCompletenessInvariantError).invariant).toBe("INVARIANT_EMPTY_REFERENCE_WITH_NONZERO_COUNT"); }
  });
  it("exactMatch + count=0 → throw INVARIANT_EXACT_MATCH_WITH_ZERO_COUNT", () => {
    try { resolveSitemapCompletenessOutcome({ walkStatus: "COMPLETE", referenceKind: POP, normalizedReferenceCount: 0, exactSetMatch: true }); expect.unreachable(); }
    catch (e) { expect((e as SitemapCompletenessInvariantError).invariant).toBe("INVARIANT_EXACT_MATCH_WITH_ZERO_COUNT"); }
  });
  it("exactMatch + referenceKind != POPULATED → throw INVARIANT_EXACT_MATCH_WITHOUT_POPULATED_REFERENCE", () => {
    try { resolveSitemapCompletenessOutcome({ walkStatus: "COMPLETE", referenceKind: EMPTY, normalizedReferenceCount: 0, exactSetMatch: true }); expect.unreachable(); }
    catch (e) { expect((e as SitemapCompletenessInvariantError).invariant).toBe("INVARIANT_EXACT_MATCH_WITHOUT_POPULATED_REFERENCE"); }
  });
});
