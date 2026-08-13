import { describe, it, expect, vi } from "vitest";
import {
  decideExecutionPath,
  selectAndGuardPath,
  buildPathDecisionWitness,
  CanaryPreconditionError,
  CanaryWitnessPersistError,
  CANARY_MARKER,
  CANARY_PRECONDITION_ERROR_CODE,
  PATH_DECISION_SCHEMA_VERSION,
  type PathDecisionInput,
} from "../../worker/src/execution-path";
import { readWorkerIdentity } from "../../worker/src/worker-boot";

const PRICE_ONLY = "PRICE_ONLY";
const SKU_FIRST = "TIENDANUBE_LS_VARIANTS_SKU_FIRST";
// 8 combinaciones de (C1,C2,C3) en orden binario.
const COMBOS: Array<[boolean, boolean, boolean]> = [
  [false, false, false], [false, false, true], [false, true, false], [false, true, true],
  [true, false, false], [true, false, true], [true, true, false], [true, true, true],
];
const inputFor = (isCanary: boolean, [c1, c2, c3]: [boolean, boolean, boolean]): PathDecisionInput => ({
  isCanary,
  partialFlagEnabled: c1,
  catalogWriteMode: c2 ? PRICE_ONLY : "FULL",
  extractionMode: c3 ? SKU_FIRST : "SOMETHING_ELSE",
});
const expectedFailed = ([c1, c2, c3]: [boolean, boolean, boolean]) =>
  [!c1 && "C1", !c2 && "C2", !c3 && "C3"].filter(Boolean);

describe("2G-R9-PR2 · decideExecutionPath · tabla de verdad NO-CANARY (4.a)", () => {
  it("8/8: PARTIAL sólo con C1∧C2∧C3, HISTORICAL en el resto", () => {
    for (const combo of COMBOS) {
      const d = decideExecutionPath(inputFor(false, combo));
      const allMet = combo.every(Boolean);
      expect(d.selectedPath, `combo ${combo}`).toBe(allMet ? "PARTIAL" : "HISTORICAL");
    }
  });
});

describe("2G-R9-PR2 · decideExecutionPath · tabla de verdad CANARY (4.b)", () => {
  it("8/8: PARTIAL con los tres; CANARY_FAIL_CLOSED en los otros 7, con failedConjuncts completos y ordenados", () => {
    for (const combo of COMBOS) {
      const d = decideExecutionPath(inputFor(true, combo));
      if (combo.every(Boolean)) {
        expect(d.selectedPath).toBe("PARTIAL");
        expect(d.failedConjuncts).toEqual([]);
      } else {
        expect(d.selectedPath, `combo ${combo}`).toBe("CANARY_FAIL_CLOSED");
        expect(d.failedConjuncts, `combo ${combo}`).toEqual(expectedFailed(combo)); // F) todos los falsos, orden C1,C2,C3
      }
    }
  });
});

describe("2G-R9-PR2 · selectAndGuardPath · efectos (4.c)", () => {
  const witnessLine = (d: any) => `[PathDecision] ${JSON.stringify({ selectedPath: d.selectedPath })}`;

  it("E) 7 casos CANARY_FAIL_CLOSED → lanza CanaryPreconditionError ANTES del scraper (spy 0 llamadas)", async () => {
    for (const combo of COMBOS.filter((c) => !c.every(Boolean))) {
      const emit = vi.fn(async () => {});
      const scraperSpy = vi.fn();
      await expect((async () => {
        await selectAndGuardPath({ inputs: inputFor(true, combo), emitWitness: emit, buildWitnessLine: witnessLine });
        scraperSpy(); // inalcanzable: selectAndGuardPath lanza
      })()).rejects.toBeInstanceOf(CanaryPreconditionError);
      expect(scraperSpy, `combo ${combo}`).not.toHaveBeenCalled();
      expect(emit).toHaveBeenCalledTimes(1); // I) witness una sola vez, incluso al fallar
    }
  });

  it("CANARY con C1∧C2∧C3 → PARTIAL (no lanza), witness emitido una vez", async () => {
    const emit = vi.fn(async () => {});
    const d = await selectAndGuardPath({ inputs: inputFor(true, [true, true, true]), emitWitness: emit, buildWitnessLine: witnessLine });
    expect(d.selectedPath).toBe("PARTIAL");
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("errorMessage estable + failedConjuncts en el CanaryPreconditionError", async () => {
    try {
      await selectAndGuardPath({ inputs: inputFor(true, [false, true, false]), emitWitness: async () => {}, buildWitnessLine: witnessLine });
      throw new Error("no lanzó");
    } catch (e) {
      expect(e).toBeInstanceOf(CanaryPreconditionError);
      expect((e as CanaryPreconditionError).message).toContain(CANARY_PRECONDITION_ERROR_CODE);
      expect((e as CanaryPreconditionError).failedConjuncts).toEqual(["C1", "C3"]);
    }
  });

  it("HISTORICAL (no-canary) → no lanza, witness una vez, devuelve HISTORICAL", async () => {
    const emit = vi.fn(async () => {});
    const d = await selectAndGuardPath({ inputs: inputFor(false, [true, false, true]), emitWitness: emit, buildWitnessLine: witnessLine });
    expect(d.selectedPath).toBe("HISTORICAL");
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("K) CANARY + fallo de persistencia del witness → CanaryWitnessPersistError, scraper 0 llamadas", async () => {
    const scraperSpy = vi.fn();
    const emit = vi.fn(async () => { throw new Error("DB down"); });
    await expect((async () => {
      await selectAndGuardPath({ inputs: inputFor(true, [true, true, true]), emitWitness: emit, buildWitnessLine: witnessLine });
      scraperSpy();
    })()).rejects.toBeInstanceOf(CanaryWitnessPersistError);
    expect(scraperSpy).not.toHaveBeenCalled();
  });

  it("L) NORMAL + fallo de persistencia del witness → se propaga el error original (semántica sin cambios)", async () => {
    const original = new Error("DB down");
    const emit = vi.fn(async () => { throw original; });
    await expect(
      selectAndGuardPath({ inputs: inputFor(false, [true, true, true]), emitWitness: emit, buildWitnessLine: witnessLine }),
    ).rejects.toBe(original); // NO envuelto en CanaryWitnessPersistError
  });
});

describe("2G-R9-MICROFIX · CanaryWitnessPersistError · errorMessage = constante literal, sin leak", () => {
  const SECRET = "postgres://u:p@db-host.internal:5432/neondb";
  const throwWithSecret = async () => { throw new Error(`connect ECONNREFUSED ${SECRET} extra-host db-host.internal`); };

  it("el .message persistido es EXACTAMENTE el reasonCode (no incluye cause.message)", async () => {
    const err = await selectAndGuardPath({ inputs: inputFor(true, [true, true, true]), emitWitness: throwWithSecret, buildWitnessLine: () => "[PathDecision] x" })
      .then(() => null, (e) => e);
    expect(err).toBeInstanceOf(CanaryWitnessPersistError);
    expect(err.message).toBe("CONTROLLED_CANARY_PATH_DECISION_PERSIST_FAILED"); // PERSISTED_ERROR_MESSAGE_IS_LITERAL_CONSTANT
  });

  it("SENTINEL LEAK: el .message NO contiene la connection string ni el hostname del cause", async () => {
    const err = await selectAndGuardPath({ inputs: inputFor(true, [true, true, true]), emitWitness: throwWithSecret, buildWitnessLine: () => "[PathDecision] x" })
      .then(() => null, (e) => e);
    expect(err.message).not.toContain(SECRET);
    expect(err.message).not.toContain("db-host.internal");
    expect(err.message).not.toContain("5432");
    expect(err.message).not.toContain("ECONNREFUSED");
  });

  it("cause se conserva como propiedad de la excepción (debugging / console)", async () => {
    const cause = new Error(SECRET);
    const err = new CanaryWitnessPersistError(cause);
    expect(err.cause).toBe(cause); // CAUSE_RETAINED_AS_EXCEPTION_PROPERTY
    expect(err.message).toBe("CONTROLLED_CANARY_PATH_DECISION_PERSIST_FAILED");
  });

  it("scraper 0 llamadas bajo persist-fail (sigue fail-closed)", async () => {
    const scraperSpy = vi.fn();
    await expect((async () => {
      await selectAndGuardPath({ inputs: inputFor(true, [true, true, true]), emitWitness: throwWithSecret, buildWitnessLine: () => "[PathDecision] x" });
      scraperSpy();
    })()).rejects.toBeInstanceOf(CanaryWitnessPersistError);
    expect(scraperSpy).not.toHaveBeenCalled();
  });
});

describe("2G-R9-PR2 · buildPathDecisionWitness (H/J · sin secretos)", () => {
  const identity = readWorkerIdentity({ RAILWAY_SERVICE_NAME: "pricecom-worker", RAILWAY_SERVICE_ID: "s", RAILWAY_REPLICA_ID: "r", RAILWAY_DEPLOYMENT_ID: "d", RAILWAY_GIT_COMMIT_SHA: "fab48e7" });

  it("contiene todos los campos requeridos, schemaVersion=1, failedConjuncts array, sin secretos", () => {
    const decision = decideExecutionPath(inputFor(true, [true, false, true]));
    const w = buildPathDecisionWitness({
      jobId: "job1", jobSource: CANARY_MARKER, inputs: inputFor(true, [true, false, true]), decision, pid: 7, identity,
    });
    expect(w.schemaVersion).toBe(PATH_DECISION_SCHEMA_VERSION);
    expect(Object.keys(w).sort()).toEqual([
      "catalogWriteMode", "extractionMode", "failedConjuncts", "jobId", "jobSource", "partialFlagEnabled",
      "pid", "railwayDeploymentId", "railwayGitCommitSha", "railwayReplicaId", "railwayServiceId",
      "railwayServiceName", "schemaVersion", "selectedPath",
    ]);
    expect(w.selectedPath).toBe("CANARY_FAIL_CLOSED");
    expect(w.failedConjuncts).toEqual(["C2"]);
    const blob = JSON.stringify(w).toLowerCase();
    for (const forbidden of ["password", "secret", "token", "database_url", "encrypted", "cookie"]) {
      expect(blob).not.toContain(forbidden);
    }
  });
});
