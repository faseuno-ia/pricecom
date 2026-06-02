// Test trivial unit: el helper buildPublicationSku concatena prefix + sku.
// Sin DB, sin .env.test, sin guards. Solo valida que el andamiaje de
// vitest + tsconfig-paths funcione (resolución de @/lib/...).

import { describe, it, expect } from "vitest";
import { buildPublicationSku } from "@/lib/catalog/publication-sku";

describe("buildPublicationSku", () => {
  it("concatena el prefix con el sku", () => {
    expect(buildPublicationSku("TEK-", "003")).toBe("TEK-003");
  });

  it("devuelve null si el sku es vacío o null", () => {
    expect(buildPublicationSku("TEK-", "")).toBeNull();
    expect(buildPublicationSku("TEK-", null)).toBeNull();
  });

  it("trim al sku y al prefix antes de concatenar", () => {
    expect(buildPublicationSku("  TEK- ", " 003 ")).toBe("TEK-003");
  });
});
