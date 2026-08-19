// Fake de PrismaClient 100% EN MEMORIA para tests OFFLINE (tests/unit).
//
// Motivo: C2-DESIGN-1 Gate 2 exige PRODUCTION_DB_REQUIRED_FOR_TESTS = false. Los tests de
// tests/integration/ usan la DB real (Neon branch de test); este fake permite ejercitar los
// MISMOS paths de producción (routes + publication-service + upsertCatalogProducts) sin
// abrir ninguna conexión.
//
// Alcance deliberadamente mínimo:
//   · `select` e `include` se IGNORAN: se devuelve la fila completa. El código bajo test lee
//     sólo los campos que necesita, y recibir campos extra es inocuo. Las relaciones se
//     embeben en las fixtures (ej. store.integrations, catalogProduct.provider/categories).
//   · el matcher de `where` soporta lo que realmente usan los paths bajo test:
//     igualdad, in, notIn, not, lt/lte/gt/gte, equals, AND/OR/NOT, claves únicas compuestas
//     (userId_providerId_sku, catalogProductId_storeId) y filtros de relación `{ is: {...} }`.
//   · toda escritura queda registrada en `__writes` para poder afirmar "cero writes de dominio".
//
// Si un test necesita algo que el fake no soporta, el fake LANZA (no devuelve silencio):
// preferimos un test roto y visible a un verde falso.

export type FakeRow = Record<string, unknown>;
export type FakeDb = Record<string, FakeRow[]>;

export interface FakeWrite {
  model: string;
  op: "create" | "update" | "updateMany" | "upsert" | "delete" | "deleteMany" | "createMany";
}

export interface FakePrismaHandle {
  __db: FakeDb;
  __writes: FakeWrite[];
}

const OPERATORS = new Set([
  "equals",
  "in",
  "notIn",
  "not",
  "lt",
  "lte",
  "gt",
  "gte",
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    !(v instanceof Date)
  );
}

function hasOperator(o: Record<string, unknown>): boolean {
  return Object.keys(o).some((k) => OPERATORS.has(k));
}

function eq(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a == null && b == null) return true;
  return a === b;
}

function num(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  return Number(v);
}

function matchValue(rowValue: unknown, cond: unknown): boolean {
  if (isPlainObject(cond)) {
    if (hasOperator(cond)) {
      for (const [op, c] of Object.entries(cond)) {
        switch (op) {
          case "equals":
            if (!eq(rowValue, c)) return false;
            break;
          case "in":
            if (!Array.isArray(c) || !c.some((x) => eq(rowValue, x))) return false;
            break;
          case "notIn":
            if (Array.isArray(c) && c.some((x) => eq(rowValue, x))) return false;
            break;
          case "not":
            if (isPlainObject(c)) {
              if (matchValue(rowValue, c)) return false;
            } else if (eq(rowValue, c)) {
              return false;
            }
            break;
          case "lt":
            if (!(num(rowValue) < num(c))) return false;
            break;
          case "lte":
            if (!(num(rowValue) <= num(c))) return false;
            break;
          case "gt":
            if (!(num(rowValue) > num(c))) return false;
            break;
          case "gte":
            if (!(num(rowValue) >= num(c))) return false;
            break;
          default:
            throw new Error(`fake-prisma: operador no soportado "${op}"`);
        }
      }
      return true;
    }
    const keys = Object.keys(cond);
    if (keys.length === 1 && keys[0] === "is") {
      const inner = cond.is;
      if (inner === null) return rowValue == null;
      return matchWhere(
        isPlainObject(rowValue) ? rowValue : {},
        inner as Record<string, unknown>,
      );
    }
    // Objeto anidado sin operadores: filtro de relación embebida.
    return matchWhere(
      isPlainObject(rowValue) ? rowValue : {},
      cond as Record<string, unknown>,
    );
  }
  return eq(rowValue, cond);
}

function asArray<T>(v: T | T[]): T[] {
  return Array.isArray(v) ? v : [v];
}

export function matchWhere(
  row: FakeRow,
  where: Record<string, unknown> | undefined,
): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (key === "AND") {
      if (
        !asArray<Record<string, unknown>>(
          cond as Record<string, unknown>,
        ).every((w) => matchWhere(row, w))
      )
        return false;
      continue;
    }
    if (key === "OR") {
      if (
        !asArray<Record<string, unknown>>(
          cond as Record<string, unknown>,
        ).some((w) => matchWhere(row, w))
      )
        return false;
      continue;
    }
    if (key === "NOT") {
      if (
        asArray<Record<string, unknown>>(cond as Record<string, unknown>).some(
          (w) => matchWhere(row, w),
        )
      )
        return false;
      continue;
    }
    const hasField = Object.prototype.hasOwnProperty.call(row, key);
    if (!hasField && isPlainObject(cond) && !hasOperator(cond)) {
      // Clave única compuesta: { userId_providerId_sku: { userId, providerId, sku } }
      if (!matchWhere(row, cond)) return false;
      continue;
    }
    if (!matchValue(row[key], cond)) return false;
  }
  return true;
}

function cloneRow(row: FakeRow): FakeRow {
  const out: FakeRow = {};
  for (const [k, v] of Object.entries(row)) {
    if (Array.isArray(v)) out[k] = v.map((x) => (isPlainObject(x) ? { ...x } : x));
    else if (isPlainObject(v)) out[k] = { ...v };
    else out[k] = v;
  }
  return out;
}

let idCounter = 0;
function nextId(model: string): string {
  idCounter += 1;
  return `fake-${model}-${idCounter}`;
}

type Args = Record<string, unknown>;

function makeDelegate(db: FakeDb, writes: FakeWrite[], model: string) {
  const rows = (): FakeRow[] => (db[model] ??= []);
  const whereOf = (args?: Args) =>
    (args?.where as Record<string, unknown> | undefined) ?? undefined;

  return {
    findUnique: async (args: Args) =>
      rows().find((r) => matchWhere(r, whereOf(args))) ?? null,
    findUniqueOrThrow: async (args: Args) => {
      const found = rows().find((r) => matchWhere(r, whereOf(args)));
      if (!found) throw new Error(`fake-prisma: ${model} no encontrado`);
      return found;
    },
    findFirst: async (args?: Args) =>
      rows().find((r) => matchWhere(r, whereOf(args))) ?? null,
    findMany: async (args?: Args) =>
      rows().filter((r) => matchWhere(r, whereOf(args))),
    count: async (args?: Args) =>
      rows().filter((r) => matchWhere(r, whereOf(args))).length,
    create: async (args: Args) => {
      writes.push({ model, op: "create" });
      const data = (args.data ?? {}) as FakeRow;
      const row = { id: data.id ?? nextId(model), ...data };
      rows().push(row);
      return row;
    },
    createMany: async (args: Args) => {
      writes.push({ model, op: "createMany" });
      const data = asArray<FakeRow>((args.data ?? []) as FakeRow);
      for (const d of data) rows().push({ id: d.id ?? nextId(model), ...d });
      return { count: data.length };
    },
    update: async (args: Args) => {
      writes.push({ model, op: "update" });
      const row = rows().find((r) => matchWhere(r, whereOf(args)));
      if (!row)
        throw new Error(
          `fake-prisma: ${model}.update no encontró la fila ${JSON.stringify(args.where)}`,
        );
      Object.assign(row, args.data as FakeRow);
      return row;
    },
    updateMany: async (args?: Args) => {
      writes.push({ model, op: "updateMany" });
      const targets = rows().filter((r) => matchWhere(r, whereOf(args)));
      for (const r of targets) Object.assign(r, (args?.data ?? {}) as FakeRow);
      return { count: targets.length };
    },
    upsert: async (args: Args) => {
      writes.push({ model, op: "upsert" });
      const row = rows().find((r) => matchWhere(r, whereOf(args)));
      if (row) {
        Object.assign(row, args.update as FakeRow);
        return row;
      }
      const data = (args.create ?? {}) as FakeRow;
      const created = { id: data.id ?? nextId(model), ...data };
      rows().push(created);
      return created;
    },
    delete: async (args: Args) => {
      writes.push({ model, op: "delete" });
      const list = rows();
      const idx = list.findIndex((r) => matchWhere(r, whereOf(args)));
      if (idx < 0) throw new Error(`fake-prisma: ${model}.delete no encontró la fila`);
      return list.splice(idx, 1)[0];
    },
    deleteMany: async (args?: Args) => {
      writes.push({ model, op: "deleteMany" });
      const list = rows();
      const keep = list.filter((r) => !matchWhere(r, whereOf(args)));
      const removed = list.length - keep.length;
      db[model] = keep;
      return { count: removed };
    },
  };
}

/**
 * Crea un fake de PrismaClient. Devuelve un Proxy: cualquier `model` se resuelve a un
 * delegate genérico, de modo que no hay que declarar de antemano las tablas que el código
 * bajo test va a tocar.
 */
export function createFakePrisma(seed: FakeDb = {}) {
  const db: FakeDb = {};
  const writes: FakeWrite[] = [];
  for (const [k, v] of Object.entries(seed)) db[k] = v.map(cloneRow);

  const delegates = new Map<string, ReturnType<typeof makeDelegate>>();

  const client: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== "string") return undefined;
        if (prop === "__db") return db;
        if (prop === "__writes") return writes;
        if (prop === "$transaction") {
          return async (arg: unknown) =>
            typeof arg === "function"
              ? (arg as (tx: unknown) => Promise<unknown>)(client)
              : Promise.all(arg as Promise<unknown>[]);
        }
        if (prop === "$connect" || prop === "$disconnect") return async () => {};
        if (prop.startsWith("$")) {
          return async () => {
            throw new Error(`fake-prisma: ${prop} no está soportado en tests offline`);
          };
        }
        if (!delegates.has(prop)) delegates.set(prop, makeDelegate(db, writes, prop));
        return delegates.get(prop);
      },
    },
  );

  return client as FakePrismaHandle & Record<string, ReturnType<typeof makeDelegate>>;
}

/** Reemplaza in-place el contenido del fake (para reusar la misma instancia entre tests). */
export function loadFakeDb(client: unknown, seed: FakeDb): void {
  const handle = client as FakePrismaHandle;
  for (const k of Object.keys(handle.__db)) delete handle.__db[k];
  for (const [k, v] of Object.entries(seed)) handle.__db[k] = v.map(cloneRow);
  handle.__writes.length = 0;
}

/** Escrituras a modelos de DOMINIO (todo menos el audit trail `eventLog`). */
export function domainWrites(client: unknown): FakeWrite[] {
  return (client as FakePrismaHandle).__writes.filter((w) => w.model !== "eventLog");
}

/** Filas de EventLog escritas vía lib/events/event-log. */
export function eventLogRows(client: unknown): FakeRow[] {
  return (client as FakePrismaHandle).__db.eventLog ?? [];
}
