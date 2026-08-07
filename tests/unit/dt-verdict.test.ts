import { describe, it, expect } from "vitest";
import {
  computeVerdict,
  type DtArmAgg,
  type DtHistorical,
  type DtSampleMeta,
  type DtZeroReplayAgg,
  type DtVerdictInput,
} from "../../lib/diag/dt-verdict";

// ---- small synthetic builders (no disk, no I/O) ----

function arm(overrides: Partial<DtArmAgg> = {}): DtArmAgg {
  return {
    urlCount: 0,
    navSuccessCount: 0,
    initialZeroVariantCount: 0,
    nonzeroVariantCount: 0,
    variantTotal: 0,
    validPriceVariantCount: 0,
    urlsWithAnyValidPrice: 0,
    sessionLossCount: 0,
    http429Count: 0,
    retryAfterCount: 0,
    challengeCount: 0,
    connectionResetCount: 0,
    firstZeroOrdinal: null,
    ...overrides,
  };
}

function hist(overrides: Partial<DtHistorical> = {}): DtHistorical {
  return { distribution: "synthetic", firstFailureApproxOrdinal: null, scaleAdequate: true, ...overrides };
}

function sampleMeta(overrides: Partial<DtSampleMeta> = {}): DtSampleMeta {
  return { size: 100, effectiveFastScale: 100, sha256: "deadbeef", ...overrides };
}

function zeroReplay(overrides: Partial<DtZeroReplayAgg> = {}): DtZeroReplayAgg {
  return {
    executed: true,
    urlCount: 0,
    recoveredWithoutReloadCount: 0,
    neverRecoveredCount: 0,
    maxRecoveryMs: null,
    recoveryDistribution: { "250": 0, "500": 0, "1000": 0, "2000": 0, "5000": 0, NEVER: 0 },
    ...overrides,
  };
}

function input(overrides: Partial<DtVerdictInput> = {}): DtVerdictInput {
  return {
    historical: hist(),
    sample: sampleMeta(),
    fast: arm(),
    paused: null,
    zeroReplay: null,
    pausedDelayMs: null,
    ...overrides,
  };
}

// ---- R6-R1.1 · límites epistémicos: local no refuta ni atribuye causa ----

describe("R6-R1.1 epistemic guards", () => {
  it("harnessRole + crossEnvironmentCadenceComparable son constantes fijas (no derivadas de datos)", () => {
    const clean = computeVerdict(input({ fast: arm({ urlCount: 200, initialZeroVariantCount: 0, variantTotal: 285, validPriceVariantCount: 276 }) }));
    expect(clean.harnessRole).toBe("FUNCTIONAL_VALIDATION_NOT_PRODUCTION_REGIME_REPRODUCTION");
    expect(clean.crossEnvironmentCadenceComparable).toBe(false);
  });

  it("0 fallos locales → NO reproducido, causa UNPROVEN, timing UNPROVEN (no REFUTED), pacing UNPROVEN", () => {
    // FAST limpio, sin zero-replay ni paused (no hay zero-set): el motor NO puede refutar nada.
    const v = computeVerdict(input({ fast: arm({ urlCount: 200, initialZeroVariantCount: 0 }), historical: hist({ scaleAdequate: true }) }));
    expect(v.captureFailureReproducedLocally).toBe(false);
    expect(v.captureRootCause).toBe("UNPROVEN");
    expect(v.evidence.timingRaceExists).toBe("UNPROVEN"); // NUNCA REFUTED por 0 fallos locales
    expect(v.evidence.pacingEffect).toBe("UNPROVEN");
    expect(v.recommendedCaptureRemediation).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("la asociación histórica puede ser STRONGLY_SUPPORTED sin ninguna causa demostrada", () => {
    const v = computeVerdict(input({ fast: arm({ urlCount: 200, initialZeroVariantCount: 0 }), historicalLatencyAssociation: "STRONGLY_SUPPORTED" }));
    expect(v.historicalProductionLatencyCaptureAssociation).toBe("STRONGLY_SUPPORTED");
    expect(v.captureRootCause).toBe("UNPROVEN"); // asociación ≠ causa
  });

  it("R7 §12: default de asociación = UNPROVEN cuando no se pasa (no un claim fuerte)", () => {
    const v = computeVerdict(input({ fast: arm({ urlCount: 10, initialZeroVariantCount: 0 }) }));
    expect(v.historicalProductionLatencyCaptureAssociation).toBe("UNPROVEN");
  });

  it("captureRootCause sólo se atribuye con controles falsables ejecutados (timing+pacing)", () => {
    // reproducido + zero-replay demuestra timing + paused demuestra pacing → TIMING_AND_PACING
    const v = computeVerdict(input({
      fast: arm({ urlCount: 40, initialZeroVariantCount: 8 }),
      zeroReplay: zeroReplay({ urlCount: 8, recoveredWithoutReloadCount: 8, maxRecoveryMs: 1000 }),
      paused: arm({ urlCount: 40, initialZeroVariantCount: 0, sessionLossCount: 0 }),
      pausedDelayMs: 400,
    }));
    expect(v.captureFailureReproducedLocally).toBe(true);
    expect(v.captureRootCause).toBe("TIMING_AND_PACING");
  });

  it("reproducido pero sin controles → causa UNPROVEN (no se inventa)", () => {
    const v = computeVerdict(input({ fast: arm({ urlCount: 40, initialZeroVariantCount: 8 }) }));
    expect(v.captureFailureReproducedLocally).toBe(true);
    expect(v.captureRootCause).toBe("UNPROVEN");
  });
});

// ---- REPRODUCTION ----

describe("reproductionAtAdequateScale", () => {
  it("SUCCESS when fast has initial zero variants", () => {
    const v = computeVerdict(input({ fast: arm({ urlCount: 3, initialZeroVariantCount: 2 }) }));
    expect(v.evidence.reproductionAtAdequateScale).toBe("SUCCESS");
  });

  it("FAILED when no zeros but scale adequate", () => {
    const v = computeVerdict(input({ fast: arm({ urlCount: 3, initialZeroVariantCount: 0 }), historical: hist({ scaleAdequate: true }) }));
    expect(v.evidence.reproductionAtAdequateScale).toBe("FAILED");
  });

  it("UNPROVEN when no zeros and scale not adequate", () => {
    const v = computeVerdict(input({ fast: arm({ urlCount: 3, initialZeroVariantCount: 0 }), historical: hist({ scaleAdequate: false }) }));
    expect(v.evidence.reproductionAtAdequateScale).toBe("UNPROVEN");
  });
});

// ---- TIMING RACE ----

describe("timingRaceExists", () => {
  it("DEMONSTRATED when zero-replay recovers without reload", () => {
    const v = computeVerdict(input({ zeroReplay: zeroReplay({ urlCount: 4, recoveredWithoutReloadCount: 2, neverRecoveredCount: 2 }) }));
    expect(v.evidence.timingRaceExists).toBe("DEMONSTRATED");
  });

  it("REFUTED when nothing recovers under wait", () => {
    const v = computeVerdict(input({ zeroReplay: zeroReplay({ urlCount: 4, recoveredWithoutReloadCount: 0, neverRecoveredCount: 4 }) }));
    expect(v.evidence.timingRaceExists).toBe("REFUTED");
  });

  it("UNPROVEN when zero-replay not run", () => {
    const v = computeVerdict(input({ zeroReplay: null }));
    expect(v.evidence.timingRaceExists).toBe("UNPROVEN");
  });

  it("UNPROVEN when zero-replay inconclusive (executed but 0 urls)", () => {
    const v = computeVerdict(input({ zeroReplay: zeroReplay({ urlCount: 0 }) }));
    expect(v.evidence.timingRaceExists).toBe("UNPROVEN");
  });
});

// ---- TIMING RACE EXPLAINS PRODUCTION ----

describe("timingRaceExplainsProduction", () => {
  it("DEMONSTRATED when every FAST-zero URL recovered by waiting", () => {
    const v = computeVerdict(input({ zeroReplay: zeroReplay({ urlCount: 4, recoveredWithoutReloadCount: 4, neverRecoveredCount: 0 }) }));
    expect(v.evidence.timingRaceExplainsProduction).toBe("DEMONSTRATED");
  });

  it("SUPPORTED when at least half recovered (but not all)", () => {
    const v = computeVerdict(input({ zeroReplay: zeroReplay({ urlCount: 4, recoveredWithoutReloadCount: 2, neverRecoveredCount: 2 }) }));
    expect(v.evidence.timingRaceExplainsProduction).toBe("SUPPORTED");
  });

  it("REFUTED when timing race refuted", () => {
    const v = computeVerdict(input({ zeroReplay: zeroReplay({ urlCount: 4, recoveredWithoutReloadCount: 0, neverRecoveredCount: 4 }) }));
    expect(v.evidence.timingRaceExplainsProduction).toBe("REFUTED");
  });

  it("UNPROVEN when demonstrated but fewer than half recovered", () => {
    // 1 of 5 recovered → DEMONSTRATED exists, but 1 < ceil(5/2)=3
    const v = computeVerdict(input({ zeroReplay: zeroReplay({ urlCount: 5, recoveredWithoutReloadCount: 1, neverRecoveredCount: 4 }) }));
    expect(v.evidence.timingRaceExists).toBe("DEMONSTRATED");
    expect(v.evidence.timingRaceExplainsProduction).toBe("UNPROVEN");
  });

  it("UNPROVEN when zero-replay not run", () => {
    const v = computeVerdict(input({ zeroReplay: null }));
    expect(v.evidence.timingRaceExplainsProduction).toBe("UNPROVEN");
  });
});

// ---- PACING EFFECT ----

describe("pacingEffect", () => {
  it("DEMONSTRATED when pacing eliminates the failure with valid session", () => {
    const v = computeVerdict(input({
      fast: arm({ urlCount: 3, initialZeroVariantCount: 3 }),
      paused: arm({ urlCount: 3, initialZeroVariantCount: 0, sessionLossCount: 0 }),
      pausedDelayMs: 800,
    }));
    expect(v.evidence.pacingEffect).toBe("DEMONSTRATED");
  });

  it("SUPPORTED when pacing reduces but does not eliminate", () => {
    const v = computeVerdict(input({
      fast: arm({ urlCount: 4, initialZeroVariantCount: 4 }),
      paused: arm({ urlCount: 4, initialZeroVariantCount: 1, sessionLossCount: 0 }),
      pausedDelayMs: 800,
    }));
    expect(v.evidence.pacingEffect).toBe("SUPPORTED");
  });

  it("REFUTED when pacing does not help", () => {
    const v = computeVerdict(input({
      fast: arm({ urlCount: 4, initialZeroVariantCount: 3 }),
      paused: arm({ urlCount: 4, initialZeroVariantCount: 3, sessionLossCount: 0 }),
      pausedDelayMs: 800,
    }));
    expect(v.evidence.pacingEffect).toBe("REFUTED");
  });

  it("UNPROVEN when paused not executed", () => {
    const v = computeVerdict(input({ fast: arm({ urlCount: 3, initialZeroVariantCount: 3 }), paused: null }));
    expect(v.evidence.pacingEffect).toBe("UNPROVEN");
  });

  it("UNPROVEN when paused reduces zeros but session was lost", () => {
    const v = computeVerdict(input({
      fast: arm({ urlCount: 4, initialZeroVariantCount: 2 }),
      paused: arm({ urlCount: 4, initialZeroVariantCount: 1, sessionLossCount: 1 }),
      pausedDelayMs: 800,
    }));
    expect(v.evidence.pacingEffect).toBe("UNPROVEN");
  });
});

// ---- SESSION LOSS ----

describe("sessionLoss", () => {
  it("OBSERVED when fast arm loses session", () => {
    const v = computeVerdict(input({ fast: arm({ urlCount: 3, sessionLossCount: 1 }) }));
    expect(v.evidence.sessionLoss).toBe("OBSERVED");
  });

  it("OBSERVED when paused arm loses session", () => {
    const v = computeVerdict(input({ fast: arm({ urlCount: 3 }), paused: arm({ urlCount: 3, sessionLossCount: 2 }) }));
    expect(v.evidence.sessionLoss).toBe("OBSERVED");
  });

  it("NOT_OBSERVED when fast ran and no session loss anywhere", () => {
    const v = computeVerdict(input({ fast: arm({ urlCount: 3, sessionLossCount: 0 }) }));
    expect(v.evidence.sessionLoss).toBe("NOT_OBSERVED");
  });

  it("UNPROVEN when fast arm did not run", () => {
    const v = computeVerdict(input({ fast: arm({ urlCount: 0 }) }));
    expect(v.evidence.sessionLoss).toBe("UNPROVEN");
  });
});

// ---- RATE LIMIT ----

describe("rateLimit", () => {
  it("DEMONSTRATED via http 429", () => {
    const v = computeVerdict(input({ fast: arm({ urlCount: 3, http429Count: 1 }) }));
    expect(v.evidence.rateLimit).toBe("DEMONSTRATED");
  });

  it("DEMONSTRATED via retry-after", () => {
    const v = computeVerdict(input({ fast: arm({ urlCount: 3, retryAfterCount: 1 }) }));
    expect(v.evidence.rateLimit).toBe("DEMONSTRATED");
  });

  it("DEMONSTRATED via challenge", () => {
    const v = computeVerdict(input({ fast: arm({ urlCount: 3, challengeCount: 1 }) }));
    expect(v.evidence.rateLimit).toBe("DEMONSTRATED");
  });

  it("DEMONSTRATED via witness on paused arm", () => {
    const v = computeVerdict(input({ fast: arm({ urlCount: 3 }), paused: arm({ urlCount: 3, http429Count: 1 }) }));
    expect(v.evidence.rateLimit).toBe("DEMONSTRATED");
  });

  it("NOT_DEMONSTRATED with connection reset only", () => {
    const v = computeVerdict(input({ fast: arm({ urlCount: 3, connectionResetCount: 5 }) }));
    expect(v.evidence.rateLimit).toBe("NOT_DEMONSTRATED");
  });
});

// ---- RECOMMENDED CAPTURE REMEDIATION ----

describe("recommendedCaptureRemediation", () => {
  it("INSUFFICIENT_EVIDENCE when not reproduced (clean at adequate scale)", () => {
    const v = computeVerdict(input({ fast: arm({ urlCount: 3, initialZeroVariantCount: 0 }), historical: hist({ scaleAdequate: true }) }));
    expect(v.recommendedCaptureRemediation).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("INSUFFICIENT_EVIDENCE when not reproduced (scale not adequate)", () => {
    const v = computeVerdict(input({ fast: arm({ urlCount: 3, initialZeroVariantCount: 0 }), historical: hist({ scaleAdequate: false }) }));
    expect(v.recommendedCaptureRemediation).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("Case D: OTHER when reproduced but session loss observed", () => {
    const v = computeVerdict(input({
      fast: arm({ urlCount: 3, initialZeroVariantCount: 3, sessionLossCount: 1 }),
      zeroReplay: zeroReplay({ urlCount: 3, recoveredWithoutReloadCount: 3 }),
    }));
    expect(v.recommendedCaptureRemediation).toBe("OTHER");
  });

  it("Case A: CONDITIONAL_LS_WAIT when timing demonstrated and pacing refuted", () => {
    const v = computeVerdict(input({
      fast: arm({ urlCount: 3, initialZeroVariantCount: 3, sessionLossCount: 0 }),
      zeroReplay: zeroReplay({ urlCount: 3, recoveredWithoutReloadCount: 2, neverRecoveredCount: 1 }),
      paused: arm({ urlCount: 3, initialZeroVariantCount: 3, sessionLossCount: 0 }),
    }));
    expect(v.evidence.timingRaceExists).toBe("DEMONSTRATED");
    expect(v.evidence.pacingEffect).toBe("REFUTED");
    expect(v.recommendedCaptureRemediation).toBe("CONDITIONAL_LS_WAIT");
  });

  it("Case A: CONDITIONAL_LS_WAIT when timing demonstrated and pacing unproven (no paused)", () => {
    const v = computeVerdict(input({
      fast: arm({ urlCount: 3, initialZeroVariantCount: 3, sessionLossCount: 0 }),
      zeroReplay: zeroReplay({ urlCount: 3, recoveredWithoutReloadCount: 2, neverRecoveredCount: 1 }),
      paused: null,
    }));
    expect(v.evidence.pacingEffect).toBe("UNPROVEN");
    expect(v.recommendedCaptureRemediation).toBe("CONDITIONAL_LS_WAIT");
  });

  it("Case B: INTER_PRODUCT_PACING when pacing demonstrated and timing unproven", () => {
    const v = computeVerdict(input({
      fast: arm({ urlCount: 3, initialZeroVariantCount: 3, sessionLossCount: 0 }),
      paused: arm({ urlCount: 3, initialZeroVariantCount: 0, sessionLossCount: 0 }),
      zeroReplay: null,
    }));
    expect(v.evidence.pacingEffect).toBe("DEMONSTRATED");
    expect(v.evidence.timingRaceExists).toBe("UNPROVEN");
    expect(v.recommendedCaptureRemediation).toBe("INTER_PRODUCT_PACING");
  });

  it("Case C: WAIT_AND_PACING when both timing and pacing demonstrated", () => {
    const v = computeVerdict(input({
      fast: arm({ urlCount: 3, initialZeroVariantCount: 3, sessionLossCount: 0 }),
      zeroReplay: zeroReplay({ urlCount: 3, recoveredWithoutReloadCount: 3 }),
      paused: arm({ urlCount: 3, initialZeroVariantCount: 0, sessionLossCount: 0 }),
    }));
    expect(v.evidence.timingRaceExists).toBe("DEMONSTRATED");
    expect(v.evidence.pacingEffect).toBe("DEMONSTRATED");
    expect(v.recommendedCaptureRemediation).toBe("WAIT_AND_PACING");
  });

  it("Case C: WAIT_AND_PACING when timing demonstrated and pacing supported", () => {
    const v = computeVerdict(input({
      fast: arm({ urlCount: 4, initialZeroVariantCount: 4, sessionLossCount: 0 }),
      zeroReplay: zeroReplay({ urlCount: 4, recoveredWithoutReloadCount: 4 }),
      paused: arm({ urlCount: 4, initialZeroVariantCount: 1, sessionLossCount: 0 }),
    }));
    expect(v.evidence.pacingEffect).toBe("SUPPORTED");
    expect(v.recommendedCaptureRemediation).toBe("WAIT_AND_PACING");
  });

  it("Case G: OTHER when reproduced but neither timing nor pacing explains it", () => {
    const v = computeVerdict(input({
      fast: arm({ urlCount: 3, initialZeroVariantCount: 3, sessionLossCount: 0 }),
      zeroReplay: null,
      paused: null,
    }));
    expect(v.evidence.timingRaceExists).toBe("UNPROVEN");
    expect(v.evidence.pacingEffect).toBe("UNPROVEN");
    expect(v.recommendedCaptureRemediation).toBe("OTHER");
  });

  it("NONE is a declared value that the current rules never emit (fallback is OTHER)", () => {
    // Exercise the fallback branch: reproduced, no session loss, pacing REFUTED,
    // timing REFUTED -> not A/B/C, and pacing is REFUTED so Case G's guard
    // (pacing not DEMONSTRATED/SUPPORTED) holds -> OTHER, never NONE.
    const v = computeVerdict(input({
      fast: arm({ urlCount: 3, initialZeroVariantCount: 3, sessionLossCount: 0 }),
      zeroReplay: zeroReplay({ urlCount: 3, recoveredWithoutReloadCount: 0, neverRecoveredCount: 3 }),
      paused: arm({ urlCount: 3, initialZeroVariantCount: 3, sessionLossCount: 0 }),
    }));
    expect(v.evidence.timingRaceExists).toBe("REFUTED");
    expect(v.evidence.pacingEffect).toBe("REFUTED");
    expect(v.recommendedCaptureRemediation).not.toBe("NONE");
    expect(v.recommendedCaptureRemediation).toBe("OTHER");
  });
});

// ---- PROJECTION BLOCKS ----

describe("projection of input blocks", () => {
  it("projects paused=null as executed:false with null numerics", () => {
    const v = computeVerdict(input({ fast: arm({ urlCount: 3, initialZeroVariantCount: 1 }), paused: null, pausedDelayMs: 500 }));
    expect(v.paused.executed).toBe(false);
    expect(v.paused.delayMs).toBeNull();
    expect(v.paused.initialZeroVariantCount).toBeNull();
    expect(v.paused.variantTotal).toBeNull();
    expect(v.paused.validPriceVariantCount).toBeNull();
    expect(v.paused.sessionLossCount).toBeNull();
  });

  it("projects paused present with delayMs and numerics", () => {
    const v = computeVerdict(input({
      fast: arm({ urlCount: 3, initialZeroVariantCount: 3 }),
      paused: arm({ urlCount: 3, initialZeroVariantCount: 0, variantTotal: 30, validPriceVariantCount: 30, sessionLossCount: 0 }),
      pausedDelayMs: 800,
    }));
    expect(v.paused.executed).toBe(true);
    expect(v.paused.delayMs).toBe(800);
    expect(v.paused.initialZeroVariantCount).toBe(0);
    expect(v.paused.variantTotal).toBe(30);
    expect(v.paused.validPriceVariantCount).toBe(30);
    expect(v.paused.sessionLossCount).toBe(0);
  });

  it("projects zeroReplay=null as executed:false with defaults", () => {
    const v = computeVerdict(input({ zeroReplay: null }));
    expect(v.zeroReplay.executed).toBe(false);
    expect(v.zeroReplay.urlCount).toBe(0);
    expect(v.zeroReplay.recoveredWithoutReloadCount).toBe(0);
    expect(v.zeroReplay.neverRecoveredCount).toBe(0);
    expect(v.zeroReplay.maxRecoveryMs).toBeNull();
  });

  it("projects zeroReplay present", () => {
    const v = computeVerdict(input({ zeroReplay: zeroReplay({ urlCount: 4, recoveredWithoutReloadCount: 3, neverRecoveredCount: 1, maxRecoveryMs: 2000 }) }));
    expect(v.zeroReplay.executed).toBe(true);
    expect(v.zeroReplay.urlCount).toBe(4);
    expect(v.zeroReplay.recoveredWithoutReloadCount).toBe(3);
    expect(v.zeroReplay.neverRecoveredCount).toBe(1);
    expect(v.zeroReplay.maxRecoveryMs).toBe(2000);
  });

  it("projects historical, sample and fast blocks", () => {
    const v = computeVerdict(input({
      historical: hist({ distribution: "clustered", firstFailureApproxOrdinal: 41, scaleAdequate: true }),
      sample: sampleMeta({ size: 200, effectiveFastScale: 150, sha256: "abc123" }),
      fast: arm({ urlCount: 5, initialZeroVariantCount: 2, firstZeroOrdinal: 41, variantTotal: 50, validPriceVariantCount: 48, sessionLossCount: 0 }),
    }));
    expect(v.historical).toEqual({ distribution: "clustered", firstFailureApproxOrdinal: 41, scaleAdequate: true });
    expect(v.sample).toEqual({ size: 200, effectiveFastScale: 150, sha256: "abc123" });
    expect(v.fast).toEqual({ initialZeroVariantCount: 2, firstZeroOrdinal: 41, variantTotal: 50, validPriceVariantCount: 48, sessionLossCount: 0 });
  });
});
