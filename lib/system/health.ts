import { prisma } from "@/lib/db/client";

const WORKER_HEARTBEAT_WINDOW_MS = 60 * 1000; // 1 min

export type WorkerStatus = "active" | "idle" | "stalled";

export interface WorkerHealth {
  status: WorkerStatus;
  lastSeenAt: Date | null;
  runningJobs: number;
}

/**
 * Heurística para estado del worker basada en jobs RUNNING:
 * - active: worker actualizó un job RUNNING dentro de la ventana de heartbeat
 * - stalled: hay jobs RUNNING pero ninguno actualizado recientemente → worker muerto con lock
 * - idle: no hay jobs en RUNNING (no podemos saber si está vivo, pero no hay señal de problema)
 */
export async function getWorkerStatus(): Promise<WorkerHealth> {
  const running = await prisma.extractionJob.findMany({
    where: { status: "RUNNING" },
    select: { updatedAt: true, workerLockedAt: true },
    orderBy: { updatedAt: "desc" },
  });

  if (running.length === 0) {
    return { status: "idle", lastSeenAt: null, runningJobs: 0 };
  }

  const lastSeen = running[0].updatedAt;
  const ageMs = Date.now() - lastSeen.getTime();
  return {
    status: ageMs < WORKER_HEARTBEAT_WINDOW_MS ? "active" : "stalled",
    lastSeenAt: lastSeen,
    runningJobs: running.length,
  };
}

/** Jobs en cola que merecen badge en el sidebar: PENDING o RUNNING. */
export async function getQueueDepth(): Promise<number> {
  return prisma.extractionJob.count({
    where: { status: { in: ["PENDING", "RUNNING"] } },
  });
}
