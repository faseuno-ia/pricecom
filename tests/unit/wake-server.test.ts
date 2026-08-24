// NEON-GATE2A-EXEC-2 · CLASE: DEFECT_RED
//
// Contrato NUEVO del worker event-driven. Deben fallar ANTES de implementar.
//
// Offline: sin DB, sin red. El claim real (SQL, FOR UPDATE SKIP LOCKED, filtro de source,
// recencia del fallback, release por jobId) se prueba contra Postgres en
// tests/integration/worker-directed-claim.test.ts — acá se prueba el HANDLER: a quién reclama,
// cuándo NO reclama, y cómo transiciona el estado local.
//
// Los módulos nuevos se importan DINÁMICAMENTE dentro de cada test: mientras no existan, falla
// sólo ese test en vez de tumbar la carga del archivo y ocultar el rojo real de los de fuente.

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const SECRET = "secreto-de-test";

/** Filtra comentarios antes de contar: el JSDoc transcribe código y falsearía el conteo. */
function codeOnly(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
}

type FakeJob = { id: string; status: string; source?: string | null; createdAt: number };

/**
 * Cola falsa con la SEMÁNTICA del claim dirigido: reclama SÓLO el id pedido, y sólo si sigue
 * PENDING y no es IMPORT. No emula el lock de Postgres — eso es de integración.
 */
function fakeQueue(jobs: FakeJob[]) {
  const claims: string[] = [];
  return {
    jobs,
    claims,
    async claimJob(jobId: string) {
      claims.push(jobId);
      const j = jobs.find((x) => x.id === jobId);
      if (!j || j.status !== "PENDING" || j.source === "IMPORT") return null;
      j.status = "RUNNING";
      return { jobId: j.id, providerId: "prov-1", leaseVersion: new Date() };
    },
    async isRunningLeaseAlive() {
      return true;
    },
    // F1 · defaults inertes para los 17 tests previos: la foto refleja el status real y el lease
    // se reporta VIVO, así que ninguno de ellos entra por accidente en la rama de recuperación.
    async inspectJob(jobId: string) {
      const j = jobs.find((x) => x.id === jobId);
      return j ? { status: j.status, leaseAlive: true } : null;
    },
    async releaseStaleJob() {
      return false;
    },
  };
}

async function makeDeps(overrides: Record<string, unknown> = {}) {
  const { ExecutionState } = await import("../../worker/src/execution-state");
  const q = fakeQueue([
    { id: "job-a", status: "PENDING", createdAt: 0 },
    { id: "job-b", status: "PENDING", createdAt: 0 },
  ]);
  const started: string[] = [];
  const witnesses: { type: string; jobId: string }[] = [];
  const deps = {
    secret: SECRET,
    state: new ExecutionState(),
    legacyFallbackEnabled: false,
    claimMaxDurationMs: 30_000,
    liveLeaseThresholdMs: 240_000,
    now: () => 1_000_000,
    claimJob: q.claimJob,
    isRunningLeaseAlive: q.isRunningLeaseAlive,
    inspectJob: q.inspectJob,
    releaseStaleJob: q.releaseStaleJob,
    startExecution: (p: { jobId: string }) => {
      started.push(p.jobId);
    },
    onWitness: async (e: { type: string; jobId: string }) => {
      witnesses.push(e);
    },
    ...overrides,
  };
  return { deps, queue: q, started, witnesses };
}

function req(jobId: string): { secretHeader?: string; rawBody: string } {
  return { secretHeader: SECRET, rawBody: JSON.stringify({ jobId }) };
}

/** Sin default: `undefined` significa "no mandó el header", no "mandá el correcto". */
function reqWithSecret(jobId: string, secretHeader: string | undefined) {
  return { secretHeader, rawBody: JSON.stringify({ jobId }) };
}

/** Ejecuta el resultado del handler como lo hace el servidor: responder y DESPUÉS arrancar. */
function settle(r: { afterRespond?: () => void }) {
  r.afterRespond?.();
}

describe("NEON-GATE2A-EXEC-2 · DEFECT_RED · wake dirigido", () => {
  // ── A quién reclama ────────────────────────────────────────────────────────────────

  it("wake_for_job_b_cannot_claim_older_job_a", async () => {
    const { handleWake } = await import("../../worker/src/wake-server");
    const { deps, queue, started } = await makeDeps();

    const r = await handleWake(deps, req("job-b"));
    settle(r);

    expect(r.body.outcome).toBe("ACCEPTED_AND_CLAIMED");
    expect(queue.claims).toEqual(["job-b"]);
    expect(started).toEqual(["job-b"]);
    // job-a, más viejo, sigue intacto: el wake dirigido no puede seleccionarlo.
    expect(queue.jobs.find((j) => j.id === "job-a")!.status).toBe("PENDING");
  });

  it("accepted_wake_executes_at_most_one_job", async () => {
    const { handleWake } = await import("../../worker/src/wake-server");
    const { deps, queue, started } = await makeDeps();

    const r = await handleWake(deps, req("job-a"));
    settle(r);

    expect(started).toHaveLength(1);
    expect(queue.claims).toHaveLength(1);
    expect(queue.jobs.find((j) => j.id === "job-b")!.status).toBe("PENDING");
  });

  it("abandoned_pending_never_runs_due_to_other_job_wake", async () => {
    const { handleWake } = await import("../../worker/src/wake-server");
    const { deps, queue, started } = await makeDeps();
    // job-a es el abandonado; se despiertan otros jobs varias veces.
    queue.jobs.push({ id: "job-c", status: "PENDING", createdAt: 0 });

    for (const id of ["job-b", "job-c"]) {
      const r = await handleWake(deps, req(id));
      settle(r);
      deps.state.releaseRunning(id);
    }

    expect(started).toEqual(["job-b", "job-c"]);
    expect(queue.claims).not.toContain("job-a");
    expect(queue.jobs.find((j) => j.id === "job-a")!.status).toBe("PENDING");
  });

  it("duplicate_wake_same_job_single_execution", async () => {
    const { handleWake } = await import("../../worker/src/wake-server");
    const { deps, started } = await makeDeps();

    const first = await handleWake(deps, req("job-a"));
    settle(first);
    const second = await handleWake(deps, req("job-a"));
    settle(second);

    expect(first.body.outcome).toBe("ACCEPTED_AND_CLAIMED");
    expect(second.body.outcome).toBe("WORKER_BUSY_NOT_CLAIMED");
    expect(second.body.phase).toBe("RUNNING");
    expect(started).toEqual(["job-a"]);
  });

  it("unauthorized_wake_cannot_execute_any_job", async () => {
    const { handleWake } = await import("../../worker/src/wake-server");
    const { deps, queue, started } = await makeDeps();

    for (const bad of [undefined, "", "secreto-equivocado", SECRET + "x"]) {
      const r = await handleWake(deps, reqWithSecret("job-a", bad));
      settle(r);
      expect(r.status).toBe(401);
    }

    expect(queue.claims).toEqual([]);
    expect(started).toEqual([]);
    expect(deps.state.snapshot().phase).toBe("IDLE");
  });

  // ── Single-flight ──────────────────────────────────────────────────────────────────

  it("concurrent_wakes_for_different_jobs_do_not_create_parallel_execution", async () => {
    const { handleWake } = await import("../../worker/src/wake-server");
    const { deps, started } = await makeDeps();

    // Se lanzan SIN await intermedio: el check-and-set síncrono es lo único que los serializa.
    const pa = handleWake(deps, req("job-a"));
    const pb = handleWake(deps, req("job-b"));
    const [ra, rb] = await Promise.all([pa, pb]);
    settle(ra);
    settle(rb);

    const outcomes = [ra.body.outcome, rb.body.outcome].sort();
    expect(outcomes).toEqual(["ACCEPTED_AND_CLAIMED", "WORKER_BUSY_NOT_CLAIMED"]);
    expect(started).toHaveLength(1);
  });

  it("busy_wake_does_not_claim_second_job", async () => {
    const { handleWake } = await import("../../worker/src/wake-server");
    const { deps, queue, started } = await makeDeps();

    settle(await handleWake(deps, req("job-a")));
    const busy = await handleWake(deps, req("job-b"));
    settle(busy);

    expect(busy.body.outcome).toBe("WORKER_BUSY_NOT_CLAIMED");
    expect(busy.body.occupantJobId).toBe("job-a");
    expect(queue.claims).toEqual(["job-a"]); // job-b NUNCA se reclamó
    expect(started).toEqual(["job-a"]);
  });

  it("busy_pending_requires_explicit_redispatch", async () => {
    const { handleWake } = await import("../../worker/src/wake-server");
    const { deps, queue, started } = await makeDeps();

    settle(await handleWake(deps, req("job-a")));
    settle(await handleWake(deps, req("job-b"))); // rechazado por BUSY

    // job-a termina y libera el estado local.
    deps.state.releaseRunning("job-a");

    // Sin un wake nuevo, job-b NO arranca solo.
    expect(started).toEqual(["job-a"]);
    expect(queue.jobs.find((j) => j.id === "job-b")!.status).toBe("PENDING");

    // Sólo un redispatch explícito lo ejecuta.
    settle(await handleWake(deps, req("job-b")));
    expect(started).toEqual(["job-a", "job-b"]);
  });

  it("worker_does_not_queue_busy_wakes_for_later", async () => {
    const { handleWake } = await import("../../worker/src/wake-server");
    const { deps, started } = await makeDeps();

    settle(await handleWake(deps, req("job-a")));
    for (let i = 0; i < 5; i++) settle(await handleWake(deps, req("job-b")));

    deps.state.releaseRunning("job-a");
    await new Promise((r) => setTimeout(r, 20)); // margen para cualquier cola diferida

    expect(started).toEqual(["job-a"]); // ninguna de las 5 quedó encolada
  });

  // ── Cota de CLAIMING ───────────────────────────────────────────────────────────────

  it("second_wake_during_claiming_is_busy_not_stuck", async () => {
    const { handleWake } = await import("../../worker/src/wake-server");
    const { deps } = await makeDeps();

    deps.state.tryBeginClaiming("job-a", 1_000_000 - 5_000); // hace 5 s, dentro de la cota

    const r = await handleWake(deps, req("job-b"));
    expect(r.body.outcome).toBe("WORKER_BUSY_NOT_CLAIMED");
    expect(r.body.phase).toBe("CLAIMING");
  });

  it("claiming_state_is_time_bounded", async () => {
    const { handleWake } = await import("../../worker/src/wake-server");
    const { deps, witnesses } = await makeDeps();

    deps.state.tryBeginClaiming("job-a", 1_000_000 - 31_000); // 31 s > CLAIM_MAX_DURATION

    const r = await handleWake(deps, req("job-b"));
    expect(r.body.outcome).toBe("STUCK_CLAIMING_SUSPECTED");
    expect(witnesses.map((w) => w.type)).toContain("STUCK_CLAIMING_SUSPECTED");
    // La DB es testigo, no reseteador: el estado local NO se toca.
    expect(deps.state.snapshot().phase).toBe("CLAIMING");
  });

  it("claiming_failure_releases_local_state", async () => {
    const { handleWake } = await import("../../worker/src/wake-server");

    // (a) el claim devuelve null → JOB_NOT_RECLAIMABLE y vuelta a IDLE
    const a = await makeDeps();
    a.queue.jobs.find((j) => j.id === "job-a")!.status = "COMPLETED";
    const r1 = await handleWake(a.deps, req("job-a"));
    expect(r1.body.outcome).toBe("JOB_NOT_RECLAIMABLE");
    expect(a.deps.state.snapshot().phase).toBe("IDLE");
    expect(a.started).toEqual([]);

    // (b) el claim LANZA → el estado local igual vuelve a IDLE
    const b = await makeDeps({
      claimJob: async () => {
        throw new Error("DB caída");
      },
    });
    const r2 = await handleWake(b.deps, req("job-a"));
    expect(r2.status).toBeGreaterThanOrEqual(500);
    expect(b.deps.state.snapshot().phase).toBe("IDLE");
    expect(b.started).toEqual([]);
  });

  it("running_finally_returns_to_idle", async () => {
    const { handleWake } = await import("../../worker/src/wake-server");
    const { deps } = await makeDeps();

    settle(await handleWake(deps, req("job-a")));
    expect(deps.state.snapshot().phase).toBe("RUNNING");

    expect(deps.state.releaseRunning("job-a")).toBe(true);
    expect(deps.state.snapshot().phase).toBe("IDLE");

    // El CAS es por jobId: liberar un job ajeno no puede soltar la exclusión.
    settle(await handleWake(deps, req("job-b")));
    expect(deps.state.releaseRunning("job-a")).toBe(false);
    expect(deps.state.snapshot().phase).toBe("RUNNING");
  });

  // ── Fallback ───────────────────────────────────────────────────────────────────────

  it("fallback_on_makes_wake_respond_legacy_mode_active", async () => {
    const { handleWake } = await import("../../worker/src/wake-server");
    const { deps, queue, started } = await makeDeps({ legacyFallbackEnabled: true });

    const r = await handleWake(deps, req("job-a"));
    settle(r);

    expect(r.body.outcome).toBe("LEGACY_MODE_ACTIVE");
    // Un solo dueño del claim: con el fallback encendido, el endpoint NO reclama.
    expect(queue.claims).toEqual([]);
    expect(started).toEqual([]);
    expect(deps.state.snapshot().phase).toBe("IDLE");
  });

  // ── Fuente: el bucle desaparece ────────────────────────────────────────────────────

  it("fallback_off_leaves_no_periodic_db_activity", () => {
    const src = codeOnly("worker/src/index.ts");
    // El while(true) operativo se va, y el barrido stale global pierde su call site.
    expect(src).not.toMatch(/while\s*\(\s*true\s*\)/);
    expect(src).not.toMatch(/releaseStaleJobs\s*\(/);

    // Queda UN solo bucle y vive detras del fallback: su claim es el de ventana de atencion
    // (nunca el global), aparece una unica vez, y solo dentro de la funcion del fallback.
    // No se afirma ausencia del literal POLL_INTERVAL_MS: LEGACY_POLL_INTERVAL_MS lo contiene y
    // es legitimo — el fallback si tiene intervalo. Lo que importa es que este gateado.
    expect(src).toMatch(
      /LEGACY_POLL_FALLBACK\s*=\s*process\.env\.WORKER_LEGACY_POLL_FALLBACK === "true"/,
    );
    expect(src.match(/claimNextAttendedJob\(/g) ?? []).toHaveLength(1);
    const fallbackFnAt = src.indexOf("function startLegacyFallbackExecutor");
    expect(fallbackFnAt).toBeGreaterThan(-1);
    expect(src.indexOf("claimNextAttendedJob(")).toBeGreaterThan(fallbackFnAt);
  });

  it("consistency_check_has_no_autonomous_timer", () => {
    const src = codeOnly("worker/src/index.ts");
    expect(src).not.toMatch(/CONSISTENCY_CHECK_EVERY/);
    expect(src).not.toMatch(/pollCount/);
    expect(src).not.toMatch(/runConsistencyCheck\s*\(/);
  });

  // ── T2 ─────────────────────────────────────────────────────────────────────────────

  it("t2_runs_at_end_of_attempt_including_failed_jobs", async () => {
    const { shouldRunEndOfAttemptConsistency } = await import(
      "../../worker/src/consistency-t2"
    );

    // El attempt corrió el upsert FULL y DESPUÉS falló: dejó material commiteado ⇒ T2 corre.
    expect(
      shouldRunEndOfAttemptConsistency({ fullUpsertAttempted: true, succeeded: false }),
    ).toBe(true);
    expect(
      shouldRunEndOfAttemptConsistency({ fullUpsertAttempted: true, succeeded: true }),
    ).toBe(true);

    // PARTIAL / PRICE_ONLY no pueden producir case2 ⇒ T2 no corre.
    expect(
      shouldRunEndOfAttemptConsistency({ fullUpsertAttempted: false, succeeded: true }),
    ).toBe(false);
    expect(
      shouldRunEndOfAttemptConsistency({ fullUpsertAttempted: false, succeeded: false }),
    ).toBe(false);
  });
});

/**
 * NEON-GATE2A-EXEC-2 · REMEDIACIÓN F1 · escenario del job huérfano.
 *
 * Cola falsa que modela la fila REAL: status + antigüedad del lease. `claimJob` sólo gana si la
 * fila está PENDING; `releaseStaleJob` la devuelve a PENDING sólo si sigue RUNNING y vencida
 * —re-verificando el predicado, como hace el UPDATE—; `inspectJob` es lectura pura.
 */
function orphanQueue(opts: {
  status: string;
  leaseAgeMs: number;
  liveLeaseThresholdMs?: number;
  releaseReturns?: boolean;
  claimAlwaysNull?: boolean;
}) {
  const threshold = opts.liveLeaseThresholdMs ?? 240_000;
  const state = { status: opts.status, leaseAgeMs: opts.leaseAgeMs };
  const calls = { claim: [] as string[], release: [] as string[], inspect: [] as string[] };
  return {
    calls,
    row: state,
    async claimJob(jobId: string) {
      calls.claim.push(jobId);
      if (opts.claimAlwaysNull) return null;
      if (state.status !== "PENDING") return null;
      state.status = "RUNNING";
      state.leaseAgeMs = 0;
      return { jobId, providerId: "prov-1", leaseVersion: new Date() };
    },
    async inspectJob(jobId: string) {
      calls.inspect.push(jobId);
      return { status: state.status, leaseAlive: state.leaseAgeMs < threshold };
    },
    async releaseStaleJob(jobId: string) {
      calls.release.push(jobId);
      if (opts.releaseReturns === false) return false;
      if (state.status !== "RUNNING" || state.leaseAgeMs < threshold) return false;
      state.status = "PENDING";
      return true;
    },
  };
}

async function orphanDeps(q: ReturnType<typeof orphanQueue>) {
  const { ExecutionState } = await import("../../worker/src/execution-state");
  const started: string[] = [];
  const witnesses: { type: string; jobId: string }[] = [];
  return {
    started,
    witnesses,
    deps: {
      secret: SECRET,
      state: new ExecutionState(),
      legacyFallbackEnabled: false,
      claimMaxDurationMs: 30_000,
      liveLeaseThresholdMs: 240_000,
      now: () => 1_000_000,
      claimJob: q.claimJob,
      inspectJob: q.inspectJob,
      releaseStaleJob: q.releaseStaleJob,
      isRunningLeaseAlive: async () => true,
      startExecution: (p: { jobId: string }) => {
        started.push(p.jobId);
      },
      onWitness: async (e: { type: string; jobId: string }) => {
        witnesses.push(e);
      },
    },
  };
}

describe("NEON-GATE2A-EXEC-2 · REMEDIACIÓN F1 · stale recovery cableada", () => {
  it("orphan_running_job_is_recovered_by_directed_wake", async () => {
    const { handleWake } = await import("../../worker/src/wake-server");
    // El escenario EXACTO de F1: el worker reinició, así que su memoria está limpia (IDLE), pero
    // la fila quedó RUNNING con el lease de la ejecución que murió. Arrancar en RUNNING local
    // probaría STUCK_BUSY_SUSPECTED, que es otro camino y ya funcionaba.
    const q = orphanQueue({ status: "RUNNING", leaseAgeMs: 60 * 60 * 1000 });
    const { deps, started } = await orphanDeps(q);
    expect(deps.state.snapshot().phase).toBe("IDLE");

    const r = await handleWake(deps, req("job-a"));
    settle(r);

    expect(r.body.outcome).toBe("ACCEPTED_AND_CLAIMED");
    expect(q.calls.release).toEqual(["job-a"]);
    expect(q.calls.claim).toEqual(["job-a", "job-a"]);
    expect(started).toEqual(["job-a"]);
    expect(deps.state.snapshot().phase).toBe("RUNNING");
  });

  it("stale_release_is_attempted_only_after_claim_returns_null", async () => {
    const { handleWake } = await import("../../worker/src/wake-server");
    const q = orphanQueue({ status: "PENDING", leaseAgeMs: 0 });
    const { deps, started } = await orphanDeps(q);

    const r = await handleWake(deps, req("job-a"));
    settle(r);

    expect(r.body.outcome).toBe("ACCEPTED_AND_CLAIMED");
    expect(q.calls.claim).toEqual(["job-a"]);
    // El claim directo ganó: no hay nada que inspeccionar ni que liberar.
    expect(q.calls.release).toEqual([]);
    expect(q.calls.inspect).toEqual([]);
    expect(started).toEqual(["job-a"]);

    // CONTROL POSITIVO — sin esto la aserción de arriba es cierta por vacuidad: mientras nadie
    // cablee releaseStaleJob, "cero llamadas" se cumple sola y el test no prueba el ORDEN, que es
    // lo único que afirma. Mismo fake, mismo camino, escenario donde el release SÍ corresponde.
    const orphan = orphanQueue({ status: "RUNNING", leaseAgeMs: 60 * 60 * 1000 });
    const second = await orphanDeps(orphan);
    settle(await handleWake(second.deps, req("job-a")));
    expect(orphan.calls.release).toEqual(["job-a"]);
  });

  it("live_lease_is_never_released_by_a_wake", async () => {
    const { handleWake } = await import("../../worker/src/wake-server");
    // Otro worker está ejecutando este job AHORA y renovando su lease.
    const q = orphanQueue({ status: "RUNNING", leaseAgeMs: 1_000 });
    const { deps, started } = await orphanDeps(q);

    const r = await handleWake(deps, req("job-a"));
    settle(r);

    expect(r.body.outcome).toBe("WORKER_BUSY_NOT_CLAIMED");
    expect(r.body.phase).toBe("RUNNING");
    expect(r.body.occupantJobId).toBe("job-a");
    // Liberar un lease vivo le roba el job a quien lo está corriendo.
    expect(q.calls.release).toEqual([]);
    expect(q.calls.claim).toEqual(["job-a"]);
    expect(started).toEqual([]);
    expect(q.row.status).toBe("RUNNING");
  });

  it("stale_recovery_retries_claim_exactly_once", async () => {
    const { handleWake } = await import("../../worker/src/wake-server");
    // El release funciona pero el claim sigue perdiendo (otro actor se adelantó).
    const q = orphanQueue({ status: "RUNNING", leaseAgeMs: 60 * 60 * 1000, claimAlwaysNull: true });
    const { deps, started } = await orphanDeps(q);

    const r = await handleWake(deps, req("job-a"));
    settle(r);

    expect(r.body.outcome).toBe("JOB_NOT_RECLAIMABLE");
    // ONE_WAKE = ONE_ATTEMPT: un release, dos claims, y se acabó. No hay tercer claim.
    expect(q.calls.release).toHaveLength(1);
    expect(q.calls.claim).toHaveLength(2);
    expect(started).toEqual([]);
    expect(deps.state.snapshot().phase).toBe("IDLE");
  });

  it("release_returning_zero_rows_does_not_retry_release", async () => {
    const { handleWake } = await import("../../worker/src/wake-server");
    // 0 filas = otro actor movió la fila entre la inspección y el release. La inspección era
    // orientativa, no autoridad: no se reevalúa staleness ni se vuelve a liberar.
    const q = orphanQueue({
      status: "RUNNING",
      leaseAgeMs: 60 * 60 * 1000,
      releaseReturns: false,
      claimAlwaysNull: true,
    });
    const { deps, started } = await orphanDeps(q);

    const r = await handleWake(deps, req("job-a"));
    settle(r);

    expect(r.body.outcome).toBe("JOB_NOT_RECLAIMABLE");
    expect(q.calls.release).toHaveLength(1);
    // El claim restante se consume igual: el release fallido no lo cancela.
    expect(q.calls.claim).toHaveLength(2);
    expect(started).toEqual([]);
    expect(deps.state.snapshot().phase).toBe("IDLE");
  });
});
