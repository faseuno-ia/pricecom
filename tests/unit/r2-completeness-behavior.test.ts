// G1 (2A-R1) — aserción CONDUCTUAL pura de la autoridad de completitud R2, preservada de
// r2-completeness-authority-inventory.test.ts (que era A41-inventory y se removió del set G1).
// No lee filesystem; ejercita el contrato productivo resolveSitemapCompletenessOutcome.
import { describe, it, expect } from "vitest";
import { resolveSitemapCompletenessOutcome } from "@/lib/scraper/sitemap-completeness";

describe("autoridad de completitud R2 — caso conductual (autoridad compartida)", () => {
  it("walk COMPLETE + reference EXPLICITLY_EMPTY → complete=false / reason EXPLICITLY_EMPTY", () => {
    const r = resolveSitemapCompletenessOutcome({
      walkStatus: "COMPLETE",
      referenceKind: "EXPLICITLY_EMPTY_REFERENCE",
      normalizedReferenceCount: 0,
      exactSetMatch: false,
    });
    expect(r.complete).toBe(false);
    expect(r.reasonCode).toBe("R2_SITEMAP_REFERENCE_EXPLICITLY_EMPTY");
  });
});
