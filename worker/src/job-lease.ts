// 2G-R8-Q1 · Lease heartbeat + fencing del ownership de un ExtractionJob. Genérico para todos los
// jobs. Un walk vivo renueva su lease (workerLockedAt) periódicamente vía CAS, de modo que
// releaseStaleJobs (10 min) NUNCA re-clame un job que sigue trabajando. Si el CAS pierde el lease
// (0 filas → reclaim ocurrió) o queda indeterminado (DB error), la ejecución vieja pierde autoridad
// y NO debe persistir ni terminalizar. Serializado: nunca hay dos renovaciones en vuelo, y el
// heartbeat se detiene antes de la finalización (handoff, evita robarse el lease a sí mismo).
import type { LeaseRenewResult } from "./queues/job-queue.interface";

export type LeaseState = "OWNED" | "LOST" | "UNKNOWN";
export interface LeaseRenewer {
  renewLease(jobId: string, expectedLeaseVersion: Date): Promise<LeaseRenewResult>;
}
type LeaseLog = (level: "DEBUG" | "INFO" | "WARN" | "ERROR", msg: string) => void;

export class JobLease {
  private version: Date;
  private _state: LeaseState = "OWNED";
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;
  private heartbeatCount = 0;

  constructor(
    private readonly jobId: string,
    initialVersion: Date,
    private readonly renewer: LeaseRenewer,
    private readonly intervalMs = 60000,
    private readonly onLog?: LeaseLog,
  ) {
    this.version = initialVersion;
  }

  get state(): LeaseState { return this._state; }
  get leaseVersion(): Date { return this.version; }
  get heartbeats(): number { return this.heartbeatCount; }
  /** El walker usa esto como isCancelled(): en cuanto perdemos/desconocemos el lease, cancelamos. */
  isCancelled(): boolean { return this._state !== "OWNED"; }

  start(): void {
    this.onLog?.("INFO", `[WorkerLease] ${JSON.stringify({ jobId: this.jobId, event: "START" })}`);
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
  }

  /** Una renovación serializada. Sin solape: si hay una en vuelo o ya no somos dueños, no arranca. */
  async tick(): Promise<void> {
    if (this.stopped || this._state !== "OWNED" || this.inFlight) return;
    this.inFlight = (async () => {
      const r = await this.renewer.renewLease(this.jobId, this.version);
      if (r.kind === "OWNED") {
        this.version = r.leaseVersion;
        this.heartbeatCount++;
      } else {
        // LOST (reclaim) o UNKNOWN (DB error): perdemos autoridad. Detener el heartbeat (5.ter: si
        // sigue reintentando y luego acierta, mantiene vivo un job que ya no hace trabajo útil).
        this._state = r.kind;
        this.clearTimer();
        this.onLog?.("WARN", `[WorkerLease] ${JSON.stringify({ jobId: this.jobId, event: "LEASE_" + r.kind })}`);
      }
    })();
    try { await this.inFlight; } finally { this.inFlight = null; }
  }

  /**
   * Handoff a finalización (5.bis): detiene el timer, espera cualquier renovación en vuelo, y
   * devuelve si seguimos siendo dueños + la versión ACTUAL (el heartbeat la fue avanzando). El
   * finalizer usa esa versión como fencing token. Prohíbe heartbeats concurrentes con la tx fenced.
   */
  async pauseForFinalization(): Promise<{ owned: boolean; leaseVersion: Date; state: LeaseState }> {
    this.stopped = true;
    this.clearTimer();
    if (this.inFlight) await this.inFlight;
    return { owned: this._state === "OWNED", leaseVersion: this.version, state: this._state };
  }

  async stop(reason: string): Promise<void> {
    this.stopped = true;
    this.clearTimer();
    if (this.inFlight) await this.inFlight;
    this.onLog?.("INFO", `[WorkerLease] ${JSON.stringify({ jobId: this.jobId, event: "STOP", state: this._state, heartbeatCount: this.heartbeatCount, leaseLost: this._state !== "OWNED", reason })}`);
  }

  private clearTimer(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
