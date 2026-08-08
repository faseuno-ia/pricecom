// 2G-R8-Q1 · tests del JobLease (heartbeat + fencing del ownership). Sin red/DB: renewer mockeado.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { JobLease, type LeaseRenewer } from "../../worker/src/job-lease";
import type { LeaseRenewResult } from "../../worker/src/queues/job-queue.interface";

const V0 = new Date("2026-08-08T00:00:00.000Z");
const V = (ms: number) => new Date(V0.getTime() + ms);

function mockRenewer(script: LeaseRenewResult[] | ((expected: Date, n: number) => LeaseRenewResult)): LeaseRenewer & { calls: Date[] } {
  const calls: Date[] = [];
  let n = 0;
  const renewLease = vi.fn(async (_jobId: string, expected: Date) => {
    calls.push(expected);
    const r = typeof script === "function" ? script(expected, n) : script[Math.min(n, script.length - 1)];
    n++;
    return r;
  });
  return { renewLease, calls } as any;
}

describe("2G-R8-Q1 · JobLease heartbeat", () => {
  it("A · tick OWNED → la versión de lease avanza y heartbeatCount sube", async () => {
    const r = mockRenewer((_e, n) => ({ kind: "OWNED", leaseVersion: V((n + 1) * 1000) }));
    const lease = new JobLease("j1", V0, r);
    await lease.tick();
    expect(lease.state).toBe("OWNED");
    expect(lease.leaseVersion).toEqual(V(1000));
    expect(lease.heartbeats).toBe(1);
    await lease.tick();
    expect(lease.leaseVersion).toEqual(V(2000));
    expect(lease.heartbeats).toBe(2);
  });

  it("B · cada tick hace CAS contra la versión ACTUAL (no la inicial)", async () => {
    const r = mockRenewer((_e, n) => ({ kind: "OWNED", leaseVersion: V((n + 1) * 1000) }));
    const lease = new JobLease("j1", V0, r);
    await lease.tick(); // expected V0
    await lease.tick(); // expected V(1000)
    await lease.tick(); // expected V(2000)
    expect(r.calls).toEqual([V0, V(1000), V(2000)]);
  });

  it("C · renew LOST → state LOST, isCancelled=true", async () => {
    const lease = new JobLease("j1", V0, mockRenewer([{ kind: "LOST" }]));
    await lease.tick();
    expect(lease.state).toBe("LOST");
    expect(lease.isCancelled()).toBe(true);
  });

  it("D · renew UNKNOWN (DB error) → state UNKNOWN, isCancelled=true (fail-closed)", async () => {
    const lease = new JobLease("j1", V0, mockRenewer([{ kind: "UNKNOWN" }]));
    await lease.tick();
    expect(lease.state).toBe("UNKNOWN");
    expect(lease.isCancelled()).toBe(true);
  });

  it("D2 · tras LOST/UNKNOWN el heartbeat no vuelve a renovar (se detiene)", async () => {
    const r = mockRenewer([{ kind: "LOST" }, { kind: "OWNED", leaseVersion: V(9999) }]);
    const lease = new JobLease("j1", V0, r);
    await lease.tick(); // LOST
    await lease.tick(); // no-op (state != OWNED)
    expect(r.calls.length).toBe(1);
    expect(lease.state).toBe("LOST");
  });

  it("G · sin ticks solapados: una renovación en vuelo bloquea otra", async () => {
    let resolveRenew: (v: LeaseRenewResult) => void = () => {};
    const renewLease = vi.fn(() => new Promise<LeaseRenewResult>((res) => { resolveRenew = res; }));
    const lease = new JobLease("j1", V0, { renewLease } as any);
    const t1 = lease.tick();
    const t2 = lease.tick(); // debe ser no-op (inFlight)
    await t2;
    expect(renewLease).toHaveBeenCalledTimes(1);
    resolveRenew({ kind: "OWNED", leaseVersion: V(1000) });
    await t1;
    expect(lease.heartbeats).toBe(1);
  });
});

describe("2G-R8-Q1 · JobLease handoff a finalización (5.bis)", () => {
  it("E · pauseForFinalization OWNED → {owned:true, versión actual} y detiene el timer", async () => {
    const r = mockRenewer((_e, n) => ({ kind: "OWNED", leaseVersion: V((n + 1) * 1000) }));
    const lease = new JobLease("j1", V0, r);
    await lease.tick();
    const fin = await lease.pauseForFinalization();
    expect(fin).toEqual({ owned: true, leaseVersion: V(1000), state: "OWNED" });
  });

  it("F · pauseForFinalization tras LOST → owned=false", async () => {
    const lease = new JobLease("j1", V0, mockRenewer([{ kind: "LOST" }]));
    await lease.tick();
    const fin = await lease.pauseForFinalization();
    expect(fin.owned).toBe(false);
    expect(fin.state).toBe("LOST");
  });
});

describe("2G-R8-Q1 · JobLease timer (fake timers)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("H · start() dispara renovaciones en el intervalo; stop() limpia el timer (sin dangling)", async () => {
    const r = mockRenewer((_e, n) => ({ kind: "OWNED", leaseVersion: V((n + 1) * 1000) }));
    const lease = new JobLease("j1", V0, r, 1000);
    lease.start();
    await vi.advanceTimersByTimeAsync(3500); // ~3 intervalos
    expect(r.calls.length).toBeGreaterThanOrEqual(3);
    const countAfter = r.calls.length;
    await lease.stop("test");
    await vi.advanceTimersByTimeAsync(5000);
    expect(r.calls.length).toBe(countAfter); // el timer no siguió disparando
  });
});
