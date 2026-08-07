// PURE verdict engine for the DifferentTouch (DT) diagnostic harness.
// No network, no DB, no browser, no I/O. Every field is derived from the input
// following the signed epistemic spec. Do NOT hardcode a verdict.

export interface DtHistorical {
  distribution: string;
  firstFailureApproxOrdinal: number | null;
  scaleAdequate: boolean;
}

export interface DtSampleMeta {
  size: number;
  effectiveFastScale: number;
  sha256: string;
}

export interface DtArmAgg {
  urlCount: number;
  navSuccessCount: number;
  initialZeroVariantCount: number;
  nonzeroVariantCount: number;
  variantTotal: number;
  validPriceVariantCount: number;
  urlsWithAnyValidPrice: number;
  sessionLossCount: number;
  http429Count: number;
  retryAfterCount: number;
  challengeCount: number;
  connectionResetCount: number;
  firstZeroOrdinal: number | null;
}

export interface DtZeroReplayAgg {
  executed: boolean;
  urlCount: number;
  recoveredWithoutReloadCount: number;
  neverRecoveredCount: number;
  maxRecoveryMs: number | null;
  recoveryDistribution: Record<string, number>; // keys "250","500","1000","2000","5000","NEVER"
}

export interface DtVerdictInput {
  historical: DtHistorical;
  sample: DtSampleMeta;
  fast: DtArmAgg; // always present
  paused: DtArmAgg | null; // null if not executed
  zeroReplay: DtZeroReplayAgg | null; // null if not executed
  pausedDelayMs: number | null;
  // Asociación histórica (Railway) latencia-end-to-end ↔ captura, establecida por el control de
  // causalidad inversa (R6-R1.1 §3). Es un hecho histórico de ENTRADA — NO se deriva de datos
  // locales. Default STRONGLY_SUPPORTED. NUNCA implica una causa (server/network/pacing) demostrada.
  historicalLatencyAssociation?: "STRONGLY_SUPPORTED" | "SUPPORTED" | "UNPROVEN";
}

// R6-R1.1: el harness local es VALIDACIÓN FUNCIONAL, no reproducción del régimen productivo.
// Estas constantes hacen imposible que el verdict local se lea como evidencia cross-environment.
export const LOCAL_HARNESS_ROLE = "FUNCTIONAL_VALIDATION_NOT_PRODUCTION_REGIME_REPRODUCTION" as const;
export const CROSS_ENVIRONMENT_CADENCE_COMPARABLE = false as const;

export interface DtVerdict {
  // --- R6-R1.1 · límites epistémicos explícitos (auto-documentan la NO-autoridad cross-environment) ---
  harnessRole: typeof LOCAL_HARNESS_ROLE;
  captureFailureReproducedLocally: boolean;
  captureRootCause: "UNPROVEN" | "TIMING_RACE" | "PACING" | "TIMING_AND_PACING";
  historicalProductionLatencyCaptureAssociation: "STRONGLY_SUPPORTED" | "SUPPORTED" | "UNPROVEN";
  crossEnvironmentCadenceComparable: typeof CROSS_ENVIRONMENT_CADENCE_COMPARABLE;
  historical: {
    distribution: string;
    firstFailureApproxOrdinal: number | null;
    scaleAdequate: boolean;
  };
  sample: {
    size: number;
    effectiveFastScale: number;
    sha256: string;
  };
  fast: {
    initialZeroVariantCount: number;
    firstZeroOrdinal: number | null;
    variantTotal: number;
    validPriceVariantCount: number;
    sessionLossCount: number;
  };
  paused: {
    executed: boolean;
    delayMs: number | null;
    initialZeroVariantCount: number | null;
    variantTotal: number | null;
    validPriceVariantCount: number | null;
    sessionLossCount: number | null;
  };
  zeroReplay: {
    executed: boolean;
    urlCount: number;
    recoveredWithoutReloadCount: number;
    neverRecoveredCount: number;
    maxRecoveryMs: number | null;
  };
  evidence: {
    reproductionAtAdequateScale: "SUCCESS" | "FAILED" | "UNPROVEN";
    timingRaceExists: "DEMONSTRATED" | "REFUTED" | "UNPROVEN";
    timingRaceExplainsProduction: "DEMONSTRATED" | "SUPPORTED" | "UNPROVEN" | "REFUTED";
    pacingEffect: "DEMONSTRATED" | "SUPPORTED" | "REFUTED" | "UNPROVEN";
    sessionLoss: "OBSERVED" | "NOT_OBSERVED" | "UNPROVEN";
    rateLimit: "DEMONSTRATED" | "NOT_DEMONSTRATED";
  };
  recommendedCaptureRemediation:
    | "CONDITIONAL_LS_WAIT"
    | "INTER_PRODUCT_PACING"
    | "WAIT_AND_PACING"
    | "OTHER"
    | "NONE"
    | "INSUFFICIENT_EVIDENCE";
}

export function computeVerdict(input: DtVerdictInput): DtVerdict {
  const { historical, sample, fast, paused, zeroReplay } = input;

  // --- REPRODUCTION ---
  let reproductionAtAdequateScale: DtVerdict["evidence"]["reproductionAtAdequateScale"];
  if (fast.initialZeroVariantCount > 0) {
    reproductionAtAdequateScale = "SUCCESS";
  } else if (historical.scaleAdequate === true) {
    reproductionAtAdequateScale = "FAILED";
  } else {
    reproductionAtAdequateScale = "UNPROVEN";
  }

  // --- TIMING RACE (needs zero-replay control) ---
  let timingRaceExists: DtVerdict["evidence"]["timingRaceExists"];
  if (zeroReplay && zeroReplay.executed && zeroReplay.recoveredWithoutReloadCount > 0) {
    timingRaceExists = "DEMONSTRATED";
  } else if (
    zeroReplay &&
    zeroReplay.executed &&
    zeroReplay.urlCount > 0 &&
    zeroReplay.recoveredWithoutReloadCount === 0 &&
    zeroReplay.neverRecoveredCount === zeroReplay.urlCount
  ) {
    timingRaceExists = "REFUTED";
  } else {
    timingRaceExists = "UNPROVEN";
  }

  // --- TIMING RACE EXPLAINS PRODUCTION ---
  let timingRaceExplainsProduction: DtVerdict["evidence"]["timingRaceExplainsProduction"];
  if (
    timingRaceExists === "DEMONSTRATED" &&
    zeroReplay !== null &&
    zeroReplay.urlCount > 0 &&
    zeroReplay.recoveredWithoutReloadCount === zeroReplay.urlCount
  ) {
    timingRaceExplainsProduction = "DEMONSTRATED";
  } else if (
    timingRaceExists === "DEMONSTRATED" &&
    zeroReplay !== null &&
    zeroReplay.recoveredWithoutReloadCount >= Math.ceil(zeroReplay.urlCount / 2)
  ) {
    timingRaceExplainsProduction = "SUPPORTED";
  } else if (timingRaceExists === "REFUTED") {
    timingRaceExplainsProduction = "REFUTED";
  } else {
    timingRaceExplainsProduction = "UNPROVEN";
  }

  // --- PACING EFFECT (paired FAST vs PAUSED, needs paused) ---
  let pacingEffect: DtVerdict["evidence"]["pacingEffect"];
  // paused has no "executed" flag on DtArmAgg; presence (non-null) means executed.
  if (paused !== null) {
    const pacingSignal = fast.initialZeroVariantCount - paused.initialZeroVariantCount;
    if (
      fast.initialZeroVariantCount > 0 &&
      paused.initialZeroVariantCount === 0 &&
      paused.sessionLossCount === 0
    ) {
      pacingEffect = "DEMONSTRATED";
    } else if (
      pacingSignal > 0 &&
      paused.initialZeroVariantCount < fast.initialZeroVariantCount &&
      paused.sessionLossCount === 0
    ) {
      pacingEffect = "SUPPORTED";
    } else if (paused.initialZeroVariantCount >= fast.initialZeroVariantCount) {
      pacingEffect = "REFUTED";
    } else {
      pacingEffect = "UNPROVEN";
    }
  } else {
    pacingEffect = "UNPROVEN";
  }

  // --- SESSION LOSS ---
  let sessionLoss: DtVerdict["evidence"]["sessionLoss"];
  if (fast.sessionLossCount > 0 || (paused !== null && paused.sessionLossCount > 0)) {
    sessionLoss = "OBSERVED";
  } else if (fast.urlCount > 0) {
    sessionLoss = "NOT_OBSERVED";
  } else {
    sessionLoss = "UNPROVEN";
  }

  // --- RATE LIMIT (needs explicit witness) ---
  const rateLimitWitness = (a: DtArmAgg): boolean =>
    a.http429Count > 0 || a.retryAfterCount > 0 || a.challengeCount > 0;
  let rateLimit: DtVerdict["evidence"]["rateLimit"];
  if (rateLimitWitness(fast) || (paused !== null && rateLimitWitness(paused))) {
    rateLimit = "DEMONSTRATED";
  } else {
    rateLimit = "NOT_DEMONSTRATED";
  }

  // --- RECOMMENDED CAPTURE REMEDIATION (gate §17) ---
  let recommendedCaptureRemediation: DtVerdict["recommendedCaptureRemediation"];
  if (reproductionAtAdequateScale !== "SUCCESS") {
    // Not reproduced: either clean at adequate scale, or scale must be escalated first.
    // From a verdict standpoint both are INSUFFICIENT_EVIDENCE.
    recommendedCaptureRemediation = "INSUFFICIENT_EVIDENCE";
  } else if (sessionLoss === "OBSERVED") {
    // Case D first: session problem must be separated; do not mask with waits/pacing.
    recommendedCaptureRemediation = "OTHER";
  } else if (
    // Case A
    timingRaceExists === "DEMONSTRATED" &&
    (pacingEffect === "REFUTED" || pacingEffect === "UNPROVEN")
  ) {
    recommendedCaptureRemediation = "CONDITIONAL_LS_WAIT";
  } else if (
    // Case B
    pacingEffect === "DEMONSTRATED" &&
    (timingRaceExists === "REFUTED" || timingRaceExists === "UNPROVEN")
  ) {
    recommendedCaptureRemediation = "INTER_PRODUCT_PACING";
  } else if (
    // Case C
    timingRaceExists === "DEMONSTRATED" &&
    (pacingEffect === "DEMONSTRATED" || pacingEffect === "SUPPORTED")
  ) {
    recommendedCaptureRemediation = "WAIT_AND_PACING";
  } else if (
    // Case G: reproduced but neither timing nor pacing explains it.
    timingRaceExists !== "DEMONSTRATED" &&
    pacingEffect !== "DEMONSTRATED" &&
    pacingEffect !== "SUPPORTED"
  ) {
    recommendedCaptureRemediation = "OTHER";
  } else {
    // Fallback
    recommendedCaptureRemediation = "OTHER";
  }

  // --- R6-R1.1 · campos epistémicos explícitos ---
  // captureRootCause SÓLO puede atribuir timing/pacing con sus controles falsables ejecutados;
  // NUNCA server/network, y NUNCA se vuelve conocido por 0 fallos locales o por cadencia local.
  const captureFailureReproducedLocally = fast.initialZeroVariantCount > 0;
  let captureRootCause: DtVerdict["captureRootCause"] = "UNPROVEN";
  if (captureFailureReproducedLocally) {
    const timingKnown = timingRaceExists === "DEMONSTRATED";
    const pacingKnown = pacingEffect === "DEMONSTRATED" || pacingEffect === "SUPPORTED";
    if (timingKnown && pacingKnown) captureRootCause = "TIMING_AND_PACING";
    else if (timingKnown) captureRootCause = "TIMING_RACE";
    else if (pacingEffect === "DEMONSTRATED") captureRootCause = "PACING";
    else captureRootCause = "UNPROVEN";
  }

  return {
    harnessRole: LOCAL_HARNESS_ROLE,
    captureFailureReproducedLocally,
    captureRootCause,
    // R7 §12: el DEFAULT es UNPROVEN (no un claim fuerte). El caller DT pasa STRONGLY_SUPPORTED
    // explícitamente porque ese dato histórico sí está establecido para ESTE caso.
    historicalProductionLatencyCaptureAssociation: input.historicalLatencyAssociation ?? "UNPROVEN",
    crossEnvironmentCadenceComparable: CROSS_ENVIRONMENT_CADENCE_COMPARABLE,
    historical: {
      distribution: historical.distribution,
      firstFailureApproxOrdinal: historical.firstFailureApproxOrdinal,
      scaleAdequate: historical.scaleAdequate,
    },
    sample: {
      size: sample.size,
      effectiveFastScale: sample.effectiveFastScale,
      sha256: sample.sha256,
    },
    fast: {
      initialZeroVariantCount: fast.initialZeroVariantCount,
      firstZeroOrdinal: fast.firstZeroOrdinal,
      variantTotal: fast.variantTotal,
      validPriceVariantCount: fast.validPriceVariantCount,
      sessionLossCount: fast.sessionLossCount,
    },
    paused: {
      executed: paused !== null,
      delayMs: paused !== null ? input.pausedDelayMs : null,
      initialZeroVariantCount: paused !== null ? paused.initialZeroVariantCount : null,
      variantTotal: paused !== null ? paused.variantTotal : null,
      validPriceVariantCount: paused !== null ? paused.validPriceVariantCount : null,
      sessionLossCount: paused !== null ? paused.sessionLossCount : null,
    },
    zeroReplay: {
      executed: zeroReplay !== null ? zeroReplay.executed : false,
      urlCount: zeroReplay !== null ? zeroReplay.urlCount : 0,
      recoveredWithoutReloadCount:
        zeroReplay !== null ? zeroReplay.recoveredWithoutReloadCount : 0,
      neverRecoveredCount: zeroReplay !== null ? zeroReplay.neverRecoveredCount : 0,
      maxRecoveryMs: zeroReplay !== null ? zeroReplay.maxRecoveryMs : null,
    },
    evidence: {
      reproductionAtAdequateScale,
      timingRaceExists,
      timingRaceExplainsProduction,
      pacingEffect,
      sessionLoss,
      rateLimit,
    },
    recommendedCaptureRemediation,
  };
}
