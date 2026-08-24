// NEON-GATE2A-EXEC-1 · CLASE: BEHAVIORAL
//
// Contrato NUEVO: el web emite el wake al worker después de crear el ExtractionJob.
//
// Invariante bloqueante bajo prueba:
//   WAKE_FAILURE_BREAKS_CREATE = false
//   un wake fallido —por la razón que sea— NUNCA hace fallar la creación del job.
//
// 100% offline: fake de Prisma en memoria + spy de `globalThis.fetch`. Cero DB, cero red real.
//
// Los tests de nivel-cliente importan @/lib/worker/wake-client de forma DINÁMICA, adrede: así
// fallan sólo ellos mientras el módulo no existe, en vez de tumbar la carga del archivo entero
// y ocultar el rojo REAL de los tests de ruta.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/db/client", async () => {
  const { createFakePrisma } = await import("../helpers/fake-prisma");
  const client = createFakePrisma();
  return { prisma: client, default: client };
});

const USER_ID = "cmp504wd40000t25nssc377rw";

vi.mock("@/lib/auth", () => ({
  requireSession: async () => ({ user: { id: USER_ID } }),
  getSession: async () => ({ user: { id: USER_ID } }),
}));

import { prisma as fakePrisma } from "@/lib/db/client";
import {
  eventLogRows,
  loadFakeDb,
  type FakeDb,
  type FakePrismaHandle,
  type FakeRow,
} from "../helpers/fake-prisma";
import { installFetchSpy, type FetchSpyHandle, type FetchHandler } from "../helpers/fetch-spy";
import { POST as startPOST } from "@/app/api/extractions/start/route";
import type { NextRequest } from "next/server";

const handle = fakePrisma as unknown as FakePrismaHandle;
const PROVIDER_ID = "cmp3hop7700003mhu29jk9kxd";
const WAKE_URL = "http://earnest-adaptation.railway.internal:8080/wake";
const WAKE_SECRET = "secreto-de-test";

function jsonRequest(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

function baseFixture(): FakeDb {
  return {
    provider: [
      {
        id: PROVIDER_ID,
        userId: USER_ID,
        name: "IMPOTEKNO",
        isActive: true,
        providerType: "SCRAPER",
        baseUrl: "https://proveedor.example.test",
      },
    ],
    extractionJob: [],
    eventLog: [],
  };
}

function jobRows(): FakeRow[] {
  return handle.__db.extractionJob ?? [];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Error de transporte con la forma REAL de undici: TypeError con `cause.code`. */
function transportError(code: string): Error {
  const err = new TypeError("fetch failed");
  (err as unknown as { cause: unknown }).cause = Object.assign(new Error(code), { code });
  return err;
}

/** Aborto por timeout con la forma real de AbortSignal.timeout(). */
function timeoutError(): Error {
  const err = new Error("The operation was aborted due to timeout");
  err.name = "TimeoutError";
  return err;
}

function configureWake(): void {
  process.env.WORKER_WAKE_URL = WAKE_URL;
  process.env.WORKER_WAKE_SECRET = WAKE_SECRET;
}

function unconfigureWake(): void {
  delete process.env.WORKER_WAKE_URL;
  delete process.env.WORKER_WAKE_SECRET;
}

type StartBody = {
  jobId: string;
  status: string;
  wake?: { outcome: string; reason?: string; phase?: string };
};

async function startAndParse(): Promise<{ res: Response; body: StartBody }> {
  const res = await startPOST(jsonRequest({ providerId: PROVIDER_ID }));
  return { res, body: (await res.json()) as StartBody };
}

describe("NEON-GATE2A-EXEC-1 · BEHAVIORAL · emisión del wake", () => {
  let spy: FetchSpyHandle;
  const originalUrl = process.env.WORKER_WAKE_URL;
  const originalSecret = process.env.WORKER_WAKE_SECRET;

  function arm(handler?: FetchHandler): void {
    spy = installFetchSpy(handler);
  }

  beforeEach(() => {
    loadFakeDb(fakePrisma, baseFixture());
    unconfigureWake();
    arm();
  });

  afterEach(() => {
    spy.restore();
    if (originalUrl === undefined) delete process.env.WORKER_WAKE_URL;
    else process.env.WORKER_WAKE_URL = originalUrl;
    if (originalSecret === undefined) delete process.env.WORKER_WAKE_SECRET;
    else process.env.WORKER_WAKE_SECRET = originalSecret;
  });

  // ── El job SIEMPRE se crea (WAKE_FAILURE_BREAKS_CREATE = false) ────────────────────────

  it("job_is_created_when_wake_is_not_configured", async () => {
    // Estado esperado durante la ventana entre 2A-EXEC-1 y 2A-EXEC-2: sin variables en Railway.
    const { res, body } = await startAndParse();

    expect(res.status).toBe(201);
    expect(jobRows()).toHaveLength(1);
    expect(body.wake?.outcome).toBe("WORKER_WAKE_NOT_CONFIGURED");
  });

  it("missing_config_produces_no_http_attempt_at_all", async () => {
    // CERO llamadas, no "una llamada que falla".
    await startAndParse();
    expect(spy.count()).toBe(0);
    expect(spy.calls).toEqual([]);

    // CONTROL POSITIVO, obligatorio: sin esto el test pasa trivialmente mientras la emisión
    // no exista — "cero llamadas" sería cierto por ausencia de feature, no por ausencia de
    // configuración. El mismo spy, sobre el mismo path, DEBE ver la llamada cuando sí está
    // configurado.
    loadFakeDb(fakePrisma, baseFixture());
    configureWake();
    spy.restore();
    arm(async () => jsonResponse({ outcome: "ACCEPTED_AND_CLAIMED" }));

    await startAndParse();
    expect(spy.count(), "control positivo: configurado NO produjo llamada").toBe(1);
    expect(spy.calls[0].url).toBe(WAKE_URL);
  });

  it("job_is_created_when_wake_times_out", async () => {
    configureWake();
    arm(async () => {
      throw timeoutError();
    });

    const { res, body } = await startAndParse();

    expect(res.status).toBe(201);
    expect(jobRows()).toHaveLength(1);
    expect(body.wake?.outcome).toBe("TRANSPORT_ERROR");
    expect(body.wake?.reason).toBe("TIMEOUT");
  });

  it("job_is_created_when_wake_returns_5xx", async () => {
    configureWake();
    arm(async () => jsonResponse({ error: "boom" }, 503));

    const { res, body } = await startAndParse();

    expect(res.status).toBe(201);
    expect(jobRows()).toHaveLength(1);
    expect(body.wake?.outcome).toBe("WORKER_ERROR_RESPONSE");
  });

  it("job_is_created_when_transport_refuses_connection", async () => {
    configureWake();
    arm(async () => {
      throw transportError("ECONNREFUSED");
    });

    const { res, body } = await startAndParse();

    expect(res.status).toBe(201);
    expect(jobRows()).toHaveLength(1);
    expect(body.wake?.outcome).toBe("TRANSPORT_ERROR");
    expect(body.wake?.reason).toBe("ECONNREFUSED");
  });

  it("wake_result_is_present_in_the_start_response", async () => {
    configureWake();
    arm(async () => jsonResponse({ outcome: "ACCEPTED_AND_CLAIMED" }));

    const { res, body } = await startAndParse();

    expect(res.status).toBe(201);
    expect(body.jobId).toBe(jobRows()[0].id);
    expect(body.status).toBe("PENDING");
    expect(body.wake).toBeDefined();
    expect(body.wake?.outcome).toBe("ACCEPTED_AND_CLAIMED");
  });

  // ── Contrato del cliente ───────────────────────────────────────────────────────────────

  it("wake_client_sends_only_jobid", async () => {
    const { emitWake } = await import("@/lib/worker/wake-client");
    configureWake();
    arm(async () => jsonResponse({ outcome: "ACCEPTED_AND_CLAIMED" }));

    await emitWake("job-abc");

    expect(spy.count()).toBe(1);
    const call = spy.calls[0];
    expect(call.method).toBe("POST");
    expect(call.url).toBe(WAKE_URL);
    // El body es EXACTAMENTE { jobId }: ni providerId, ni url, ni write mode, ni comercial.
    expect(call.body).toEqual({ jobId: "job-abc" });
    expect(Object.keys(call.body as object)).toEqual(["jobId"]);
  });

  it("wake_client_classifies_each_worker_response_shape", async () => {
    const { emitWake } = await import("@/lib/worker/wake-client");
    configureWake();

    const cases: { body: unknown; status: number; outcome: string; phase?: string }[] = [
      { body: { outcome: "ACCEPTED_AND_CLAIMED" }, status: 200, outcome: "ACCEPTED_AND_CLAIMED" },
      {
        body: { outcome: "WORKER_BUSY_NOT_CLAIMED", phase: "CLAIMING" },
        status: 200,
        outcome: "WORKER_BUSY_NOT_CLAIMED",
        phase: "CLAIMING",
      },
      {
        body: { outcome: "WORKER_BUSY_NOT_CLAIMED", phase: "RUNNING" },
        status: 200,
        outcome: "WORKER_BUSY_NOT_CLAIMED",
        phase: "RUNNING",
      },
      { body: { outcome: "JOB_NOT_RECLAIMABLE" }, status: 200, outcome: "JOB_NOT_RECLAIMABLE" },
      { body: { outcome: "LEGACY_MODE_ACTIVE" }, status: 200, outcome: "LEGACY_MODE_ACTIVE" },
      { body: { error: "nope" }, status: 401, outcome: "WORKER_ERROR_RESPONSE" },
      { body: { error: "boom" }, status: 500, outcome: "WORKER_ERROR_RESPONSE" },
      { body: { outcome: "ALGO_QUE_NO_CONOCEMOS" }, status: 200, outcome: "UNRECOGNIZED_RESPONSE" },
      { body: "no es json", status: 200, outcome: "UNRECOGNIZED_RESPONSE" },
    ];

    for (const c of cases) {
      arm(async () =>
        typeof c.body === "string"
          ? new Response(c.body, { status: c.status })
          : jsonResponse(c.body, c.status),
      );
      const r = await emitWake("job-x");
      expect(r.outcome, `body=${JSON.stringify(c.body)} status=${c.status}`).toBe(c.outcome);
      if (c.phase) expect(r.phase).toBe(c.phase);
      spy.restore();
    }
    arm();
  });

  it("wake_client_distinguishes_enotfound_from_econnrefused", async () => {
    const { emitWake } = await import("@/lib/worker/wake-client");
    configureWake();

    arm(async () => {
      throw transportError("ENOTFOUND");
    });
    const notFound = await emitWake("job-1");
    expect(notFound.outcome).toBe("TRANSPORT_ERROR");
    expect(notFound.reason).toBe("ENOTFOUND");
    spy.restore();

    arm(async () => {
      throw transportError("ECONNREFUSED");
    });
    const refused = await emitWake("job-2");
    expect(refused.outcome).toBe("TRANSPORT_ERROR");
    expect(refused.reason).toBe("ECONNREFUSED");

    // No se colapsan en "falló": son razones distintas y separables.
    expect(notFound.reason).not.toBe(refused.reason);

    // Y quedan separables también en el audit trail.
    const reasons = eventLogRows(fakePrisma)
      .filter((r) => String(r.type).startsWith("WAKE_"))
      .map((r) => (r.metadata as { reason?: string })?.reason);
    expect(reasons).toContain("ENOTFOUND");
    expect(reasons).toContain("ECONNREFUSED");
  });

  // ── Severidad según configuración (§4) ─────────────────────────────────────────────────

  it("severity_depends_on_whether_wake_was_configured", async () => {
    const { emitWake } = await import("@/lib/worker/wake-client");

    // Sin configurar: estado esperado de migración ⇒ INFO, y ni siquiera se intenta.
    unconfigureWake();
    await emitWake("job-sin-config");
    const notConfigured = eventLogRows(fakePrisma).filter(
      (r) => r.type === "WAKE_NOT_CONFIGURED",
    );
    expect(notConfigured).toHaveLength(1);
    expect(notConfigured[0].severity).toBe("INFO");
    expect(spy.count()).toBe(0);

    // Configurado y rechazado: alguien afirmó que el worker debe responder ⇒ incidente.
    loadFakeDb(fakePrisma, baseFixture());
    configureWake();
    spy.restore();
    arm(async () => {
      throw transportError("ECONNREFUSED");
    });
    await emitWake("job-con-config");
    const failed = eventLogRows(fakePrisma).filter((r) => r.type === "WAKE_FAILED");
    expect(failed).toHaveLength(1);
    expect(failed[0].severity).toBe("ERROR");
  });

  it("emit_wake_never_throws", async () => {
    const { emitWake } = await import("@/lib/worker/wake-client");
    configureWake();

    // Un rechazo que ni siquiera es Error: el emisor tiene que ser TOTAL.
    arm(async () => {
      throw "explosión no-Error";
    });

    await expect(emitWake("job-raro")).resolves.toMatchObject({
      outcome: "TRANSPORT_ERROR",
    });
  });
});
