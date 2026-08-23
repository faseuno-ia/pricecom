// NEON-GATE2A-EXEC-1 · CLASE: CHARACTERIZATION
//
// Conducta de POST /api/extractions/start que NO debe cambiar al cablear la emisión del wake.
// Pasan ANTES y DESPUÉS del cambio.
//
// 100% offline: fake de Prisma en memoria, sin DB y sin red.

import { describe, it, expect, beforeEach, vi } from "vitest";

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
  loadFakeDb,
  type FakeDb,
  type FakePrismaHandle,
  type FakeRow,
} from "../helpers/fake-prisma";
import { POST as startPOST } from "@/app/api/extractions/start/route";
import type { NextRequest } from "next/server";

const handle = fakePrisma as unknown as FakePrismaHandle;
const PROVIDER_ID = "cmp3hop7700003mhu29jk9kxd";

function jsonRequest(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

/** Proveedor activo del usuario de la sesión, sin jobs en curso. */
function baseFixture(extra: Partial<FakeDb> = {}): FakeDb {
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
    ...extra,
  };
}

function jobRows(): FakeRow[] {
  return handle.__db.extractionJob ?? [];
}

describe("NEON-GATE2A-EXEC-1 · CHARACTERIZATION · start route", () => {
  beforeEach(() => {
    loadFakeDb(fakePrisma, baseFixture());
  });

  it("existing_start_route_rejection_for_pending_or_running_is_unchanged", async () => {
    // route.ts:29-37 · el 409 por PENDING/RUNNING del mismo proveedor pertenece a 2B: intacto.
    for (const status of ["PENDING", "RUNNING"] as const) {
      loadFakeDb(
        fakePrisma,
        baseFixture({
          extractionJob: [
            {
              id: `job-en-curso-${status}`,
              providerId: PROVIDER_ID,
              userId: USER_ID,
              status,
              startUrl: null,
            },
          ],
        }),
      );

      const res = await startPOST(jsonRequest({ providerId: PROVIDER_ID }));
      const body = (await res.json()) as { error: string; jobId: string };

      expect(res.status).toBe(409);
      expect(body.error).toBe("Ya hay una extracción en curso para este proveedor");
      expect(body.jobId).toBe(`job-en-curso-${status}`);
      // No se creó ningún job nuevo.
      expect(jobRows()).toHaveLength(1);
    }
  });

  it("job_creation_payload_is_unchanged", async () => {
    // route.ts:40-47 · la fila creada conserva exactamente sus campos.
    const res = await startPOST(
      jsonRequest({ providerId: PROVIDER_ID, startUrl: "https://proveedor.example.test/catalogo" }),
    );
    const body = (await res.json()) as { jobId: string; status: string };

    expect(res.status).toBe(201);
    expect(body.status).toBe("PENDING");

    expect(jobRows()).toHaveLength(1);
    const job = jobRows()[0];
    expect(job.providerId).toBe(PROVIDER_ID);
    expect(job.userId).toBe(USER_ID);
    expect(job.status).toBe("PENDING");
    expect(job.startUrl).toBe("https://proveedor.example.test/catalogo");
    expect(body.jobId).toBe(job.id);
  });

  it("job_creation_payload_is_unchanged · startUrl vacío se normaliza a null", async () => {
    const res = await startPOST(jsonRequest({ providerId: PROVIDER_ID, startUrl: "" }));
    expect(res.status).toBe(201);
    expect(jobRows()[0].startUrl).toBeNull();
  });

  it("validaciones previas del route siguen intactas", async () => {
    // body inválido → 400 (route.ts:11-13)
    const bad = await startPOST(jsonRequest({}));
    expect(bad.status).toBe(400);

    // proveedor ajeno / inexistente → 404 (route.ts:21-23)
    const notFound = await startPOST(jsonRequest({ providerId: "cmzzzzzzzzzzzzzzzzzzzzzzz" }));
    expect(notFound.status).toBe(404);

    // proveedor inactivo → 400 (route.ts:24-26)
    loadFakeDb(
      fakePrisma,
      baseFixture({
        provider: [
          {
            id: PROVIDER_ID,
            userId: USER_ID,
            name: "IMPOTEKNO",
            isActive: false,
            providerType: "SCRAPER",
            baseUrl: "https://proveedor.example.test",
          },
        ],
      }),
    );
    const inactive = await startPOST(jsonRequest({ providerId: PROVIDER_ID }));
    expect(inactive.status).toBe(400);

    // en ninguno de los tres se creó un job
    expect(jobRows()).toHaveLength(0);
  });
});
