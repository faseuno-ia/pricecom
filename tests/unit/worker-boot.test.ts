import { describe, it, expect, vi } from "vitest";
import {
  resolveWorkerEnabled,
  readWorkerIdentity,
  buildWorkerBootWitness,
  buildDisabledHeartbeatWitness,
  bootWorker,
  DISABLED_HEARTBEAT_INTERVAL_MS,
  WORKER_BOOT_SCHEMA_VERSION,
  type BootDeps,
} from "../../worker/src/worker-boot";

const IDENTITY_ENV = {
  RAILWAY_SERVICE_NAME: "pricecom-worker",
  RAILWAY_SERVICE_ID: "svc-123",
  RAILWAY_REPLICA_ID: "rep-456",
  RAILWAY_DEPLOYMENT_ID: "dep-789",
  RAILWAY_GIT_COMMIT_SHA: "116b8f1",
};

function makeDeps(over: Partial<BootDeps> = {}): {
  deps: BootDeps; emits: string[]; startPoller: ReturnType<typeof vi.fn>; scheduleHb: ReturnType<typeof vi.fn>;
} {
  const emits: string[] = [];
  const startPoller = vi.fn();
  const scheduleHb = vi.fn();
  const deps: BootDeps = {
    workerEnabledRaw: undefined,
    pid: 4242,
    env: IDENTITY_ENV,
    emit: (m) => emits.push(m),
    startPoller,
    scheduleDisabledHeartbeat: scheduleHb,
    ...over,
  };
  return { deps, emits, startPoller, scheduleHb };
}
const bootLines = (emits: string[]) => emits.filter((m) => m.startsWith("[WorkerBoot] "));
const parseBoot = (emits: string[]) => JSON.parse(bootLines(emits)[0].slice("[WorkerBoot] ".length));

describe("2G-R9-PR1 · resolveWorkerEnabled (FAIL-CLOSED)", () => {
  it("B) ausente → false", () => { expect(resolveWorkerEnabled(undefined)).toBe(false); });
  it("C) 'false' → false", () => { expect(resolveWorkerEnabled("false")).toBe(false); });
  it("D) '1'/'yes'/'TRUE'/basura → false (sin truthy ni != 'false')", () => {
    for (const v of ["1", "0", "yes", "YES", "TRUE", "True", " true", "true ", "enabled", ""]) {
      expect(resolveWorkerEnabled(v)).toBe(false);
    }
  });
  it("E) 'true' (literal exacto) → true", () => { expect(resolveWorkerEnabled("true")).toBe(true); });
});

describe("2G-R9-PR1 · bootWorker orquestación", () => {
  it("E) WORKER_ENABLED='true' → startPoller UNA vez, sin heartbeat de deshabilitado", () => {
    const { deps, startPoller, scheduleHb } = makeDeps({ workerEnabledRaw: "true" });
    const r = bootWorker(deps);
    expect(startPoller).toHaveBeenCalledTimes(1);
    expect(scheduleHb).not.toHaveBeenCalled(); // N) timer NO arranca en modo habilitado
    expect(r).toMatchObject({ workerEnabled: true, pollerStarted: true, disabledHeartbeatScheduled: false });
  });

  it("B/C/D/F) modo deshabilitado → poller NUNCA arranca (cero lecturas de la cola)", () => {
    for (const raw of [undefined, "false", "1", "yes", "basura"]) {
      const { deps, startPoller, scheduleHb } = makeDeps({ workerEnabledRaw: raw });
      const r = bootWorker(deps);
      expect(startPoller).not.toHaveBeenCalled(); // startPoller es la ÚNICA superficie que lee la cola
      expect(scheduleHb).toHaveBeenCalledTimes(1);
      expect(r.pollerStarted).toBe(false);
    }
  });

  it("L) [WorkerBoot] se emite EXACTAMENTE UNA VEZ por proceso — modo habilitado", () => {
    const { deps, emits } = makeDeps({ workerEnabledRaw: "true" });
    bootWorker(deps);
    expect(bootLines(emits)).toHaveLength(1);
  });

  it("L/G) [WorkerBoot] se emite EXACTAMENTE UNA VEZ — modo deshabilitado", () => {
    const { deps, emits } = makeDeps({ workerEnabledRaw: undefined });
    bootWorker(deps);
    expect(bootLines(emits)).toHaveLength(1);
  });

  it("G) [WorkerBoot] refleja pollerStarted según el modo", () => {
    const en = makeDeps({ workerEnabledRaw: "true" }); bootWorker(en.deps);
    expect(parseBoot(en.emits)).toMatchObject({ workerEnabled: true, pollerStarted: true });
    const dis = makeDeps({ workerEnabledRaw: undefined }); bootWorker(dis.deps);
    expect(parseBoot(dis.emits)).toMatchObject({ workerEnabled: false, pollerStarted: false });
  });

  it("M) el heartbeat de deshabilitado se programa al intervalo correcto y emite [WorkerDisabledHeartbeat] sin leer la cola", () => {
    const { deps, emits, startPoller, scheduleHb } = makeDeps({ workerEnabledRaw: "false" });
    bootWorker(deps);
    expect(scheduleHb).toHaveBeenCalledTimes(1);
    const [onTick, intervalMs] = scheduleHb.mock.calls[0];
    expect(intervalMs).toBe(DISABLED_HEARTBEAT_INTERVAL_MS);
    expect(intervalMs).toBe(60000);
    // Simular dos ticks: emite el evento de estado, distinto de [WorkerBoot], sin tocar el poller.
    (onTick as () => void)(); (onTick as () => void)();
    const hb = emits.filter((m) => m.startsWith("[WorkerDisabledHeartbeat] "));
    expect(hb).toHaveLength(2);
    expect(startPoller).not.toHaveBeenCalled();
  });

  it("nombres de evento DISTINTOS: boot y heartbeat no colisionan", () => {
    const { deps, emits, scheduleHb } = makeDeps({ workerEnabledRaw: "false" });
    bootWorker(deps);
    (scheduleHb.mock.calls[0][0] as () => void)();
    expect(emits.some((m) => m.startsWith("[WorkerBoot] "))).toBe(true);
    expect(emits.some((m) => m.startsWith("[WorkerDisabledHeartbeat] "))).toBe(true);
    expect(emits[0].startsWith("[WorkerBoot] ")).toBe(true); // boot primero
  });
});

describe("2G-R9-PR1 · witnesses (identidad Railway, sin secretos)", () => {
  it("readWorkerIdentity mapea las variables RAILWAY_* (null si ausentes)", () => {
    expect(readWorkerIdentity(IDENTITY_ENV)).toEqual({
      railwayServiceName: "pricecom-worker", railwayServiceId: "svc-123", railwayReplicaId: "rep-456",
      railwayDeploymentId: "dep-789", railwayGitCommitSha: "116b8f1",
    });
    expect(readWorkerIdentity({})).toEqual({
      railwayServiceName: null, railwayServiceId: null, railwayReplicaId: null, railwayDeploymentId: null, railwayGitCommitSha: null,
    });
  });

  it("H) [WorkerBoot] contiene sólo campos de identidad/estado — sin secretos", () => {
    // NEON-GATE2A-EXEC-2 · el testigo suma executorMode/listenHost/listenPort. Se pasan valores
    // reales para que el conteo de claves signifique algo, y se mantiene la lista EXACTA: la
    // afirmación de abajo (sin secretos en el blob) es la que carga la intención de seguridad,
    // pero una lista cerrada es lo que impide que alguien agregue un campo sin revisarlo acá.
    const w = buildWorkerBootWitness({ workerEnabled: true, pollerStarted: true, pid: 1, identity: readWorkerIdentity(IDENTITY_ENV), executorMode: "WAKE", listenHost: "::", listenPort: 8080 });
    expect(Object.keys(w).sort()).toEqual([
      "executorMode", "listenHost", "listenPort",
      "pid", "pollerStarted", "railwayDeploymentId", "railwayGitCommitSha", "railwayReplicaId",
      "railwayServiceId", "railwayServiceName", "schemaVersion", "workerEnabled",
    ]);
    expect(w.executorMode).toBe("WAKE");
    expect(w.listenPort).toBe(8080);
    expect(w.schemaVersion).toBe(WORKER_BOOT_SCHEMA_VERSION);
    const blob = JSON.stringify(w).toLowerCase();
    for (const forbidden of ["password", "secret", "token", "database_url", "consumerkey", "encrypted"]) {
      expect(blob).not.toContain(forbidden);
    }
  });

  it("H) [WorkerDisabledHeartbeat] no contiene secretos ni campos ajenos a identidad/estado", () => {
    const w = buildDisabledHeartbeatWitness({ pid: 1, identity: readWorkerIdentity(IDENTITY_ENV) });
    expect(w).toMatchObject({ schemaVersion: 1, workerEnabled: false, pollerStarted: false, pid: 1, railwayServiceName: "pricecom-worker" });
    const blob = JSON.stringify(w).toLowerCase();
    for (const forbidden of ["password", "secret", "token", "database_url", "encrypted"]) {
      expect(blob).not.toContain(forbidden);
    }
  });
});
