// NEON-GATE2A-EXEC-2 · Estado de ejecución LOCAL del worker (en memoria).
//
// Es el ÚNICO mecanismo de EXCLUSIÓN (single-flight por réplica). No es la fuente de verdad para
// clasificar un job de cara al operador — eso es evidencia durable en DB.
//
// POR QUÉ EN MEMORIA Y NO EN LA DB
//   `IDLE → CLAIMING` tiene que ser un check-and-set SÍNCRONO: entre leer el estado y escribirlo
//   no puede haber ningún `await`. Node es single-threaded, así que un check-and-set síncrono lo
//   serializa el event loop y dos wakes concurrentes no pueden ganar los dos. Un chequeo contra
//   la DB es un `await`: ambos wakes podrían atravesarlo antes de que ninguno haya reclamado.
//
//   FOR UPDATE SKIP LOCKED protege "dos ejecutores → mismo job". NO protege
//   "una réplica → job A + job B a la vez": son dos filas distintas y ambos claims ganan.
//
// LA DB NO RESETEA ESTE ESTADO
//   Puede contradecirlo y emitir un testigo (STUCK_*), nunca corregirlo. El caso que lo obliga:
//   lease LOST/UNKNOWN (job-lease.ts:52-58) detiene el heartbeat, la DB deja de ver lease vivo, y
//   sin embargo hay un Chromium vivo. Auto-resetear ahí fabricaría el falso negativo que esta
//   exclusión existe para impedir.

export type ExecutionPhase = "IDLE" | "CLAIMING" | "RUNNING";

export type LocalExecutionState =
  | { phase: "IDLE" }
  | { phase: "CLAIMING"; jobId: string; since: number }
  | { phase: "RUNNING"; jobId: string; since: number };

export type BeginClaimResult =
  | { ok: true }
  | { ok: false; current: LocalExecutionState };

export class ExecutionState {
  private state: LocalExecutionState = { phase: "IDLE" };

  snapshot(): LocalExecutionState {
    return this.state;
  }

  /**
   * `IDLE → CLAIMING(jobId, now)`.
   *
   * SÍNCRONO A PROPÓSITO: leer y escribir ocurren en el mismo turno del event loop, sin ningún
   * punto de cesión en el medio. Es la sección crítica completa. No convertir en async.
   */
  tryBeginClaiming(jobId: string, now: number): BeginClaimResult {
    if (this.state.phase !== "IDLE") return { ok: false, current: this.state };
    this.state = { phase: "CLAIMING", jobId, since: now };
    return { ok: true };
  }

  /** `CLAIMING(jobId) → RUNNING(jobId)`. CAS: sólo si seguimos reclamando ESE job. */
  promoteToRunning(jobId: string, now: number): boolean {
    if (this.state.phase !== "CLAIMING" || this.state.jobId !== jobId) return false;
    this.state = { phase: "RUNNING", jobId, since: now };
    return true;
  }

  /** `CLAIMING(jobId) → IDLE`. CAS por jobId: no puede soltar la exclusión de otro. */
  releaseClaiming(jobId: string): boolean {
    if (this.state.phase !== "CLAIMING" || this.state.jobId !== jobId) return false;
    this.state = { phase: "IDLE" };
    return true;
  }

  /** `RUNNING(jobId) → IDLE`. CAS por jobId. */
  releaseRunning(jobId: string): boolean {
    if (this.state.phase !== "RUNNING" || this.state.jobId !== jobId) return false;
    this.state = { phase: "IDLE" };
    return true;
  }
}
