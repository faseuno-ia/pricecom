# Wrapper price-only (`updatePriceOnlyInWoo`) — diseño

**Fecha:** 2026-06-13
**Estado:** Gate 1 COMPLETO (las cuatro decisiones resueltas); Gate 2 (implementación) desbloqueado.

**Qué es el wrapper:** un servicio puro y reutilizable —`updatePriceOnlyInWoo`— que pushea **solo el
precio** de un producto a WooCommerce **sin tocar status, SKU ni el resto de la publicación**. Pensado
para ser invocado sin reescritura por UI manual, scripts de corrección, el futuro flujo masivo (BAZAR) y
jobs automáticos. La primitiva del client que usaría —`updateProductPrice`— ya existe pero está
desconectada (`client.ts:254-256`, manda solo `{ regular_price }`).

> **Frontera del documento.** La Sección A es evidencia cerrada (cada hallazgo con su cita
> `archivo:línea`). La Sección B es trabajo pendiente: tensiones y opciones, **sin resolver**. No se
> mezclan. Ninguna decisión de la Sección B está tomada acá.

---

## SECCIÓN A — Hallazgos verificados contra el código

1. **`detectDrift` está muerto.** Su única aparición en el repo es la propia definición
   (`lib/integrations/woocommerce/drift-detector.ts:38`); no tiene callers ni imports en ningún otro
   archivo.

2. **El detector de drift VIVO es `findDriftingPublications` / `markPublicationsDrift`**
   (`lib/catalog/mark-publications-drift.ts:61` y `:204`). Se invoca desde ~7 paths: extracción
   (`lib/catalog/upsert-catalog-products.ts:397`), bulk-update (`app/api/catalog/bulk-update/route.ts:78,94,364`),
   apply-margin (`app/api/catalog/apply-margin/route.ts:74,90`), pricing-rules
   (`lib/catalog/mark-drift-for-rule-change.ts:89`), provider route (`app/api/providers/[id]/route.ts:72`)
   y catalog/[id] (`app/api/catalog/[id]/route.ts:274`).

3. **El detector vivo compara `effectivePrice` contra `priceInStore` con tolerancia 0.5.** Marca drift
   `price-drift` si `|effective − priceInStore| > 0.5` (`mark-publications-drift.ts:183`); si
   `priceInStore == null` marca drift `no-baseline` (`mark-publications-drift.ts:140`). La constante
   `DRIFT_TOLERANCE = 0.5` está en `mark-publications-drift.ts:38`.

4. **`publishProductToWoo`, rama de éxito, escribe `priceInStore = price` y `lastPushedPrice = price`**
   (`lib/integrations/woocommerce/publication-service.ts:360-361` en el create, `:380-381` en el update),
   con `status:"publish"` en el payload a Woo (`:245` update, `:333` create) y `status:"ACTIVE"` en la
   fila de `ProductPublication` (`:358` create, `:378` update). Además baja `cp.internalStatus = "PUBLISHED"`
   (`:389-392`).

5. **El EventLog `WOO_SYNC_SUCCESS` del push lleva `previousPrice = previousPriceInStore`**, leído de
   `priceInStore` **antes** del write (`publication-service.ts:215-221`) y emitido en el metadata del log
   (`:429`, dentro del `logInfo` de `:419-432`).

6. **La rama `catch` del push toca SOLO `{ syncStatus, syncError, pendingSync }`**
   (`publication-service.ts:459-467`). **No** toca `priceInStore` ni `lastPushedPrice` ni `pp.status`.

7. **Censo de consumidores de `priceInStore`** (grep exhaustivo `lib/` + `app/`). Los únicos **lectores**
   son:
   - el detector vivo `findDriftingPublications` (`mark-publications-drift.ts:140,183`),
   - el detector muerto `detectDrift` (`drift-detector.ts`, sin callers — ver A.1),
   - el display de UI (`app/api/my-store/publications/route.ts:233`),
   - la lectura de `previousPrice` del propio push (`publication-service.ts:215-221`).

   El resto son **escritores** —el pull (`app/api/my-store/sync/products/route.ts:190`, persistido en
   `:215`; de ahí la sobrescritura conocida) y el link inicial de unmatched
   (`app/api/my-store/unmatched/[id]/link/route.ts:89,104` y
   `app/api/my-store/unmatched/[id]/create-catalog/route.ts:99`)— o callers de `markPublicationsDrift`.
   **No existe ningún consumidor que asuma `priceInStore` = pull-only.**

8. **Consecuencia verificada (no hipótesis).** Si el wrapper pushea `newPrice` a Woo pero deja
   `priceInStore` viejo, el detector vivo calcula `effective ≈ newPrice` vs `priceInStore` viejo →
   `> 0.5` (A.3) → marca la fila `OUTDATED` + `pendingSync` (`mark-publications-drift.ts:213-219`) →
   reentra al drainer → el drainer la republica vía `publishProductToWoo` (`status:"publish"`, A.4). Es
   decir: un wrapper "estricto" (que no toca `priceInStore`) **hoy** genera drift falso y republicación
   indirecta.

9. **Veredicto sobre `priceInStore` (cerrado, basado en el censo).** El wrapper mantiene la semántica
   **optimista**: escribe `priceInStore = newPrice` en éxito, idéntico al push. No por elegancia, sino
   porque el único consumidor crítico (`findDriftingPublications`) hoy depende de eso (A.3, A.8). Es deuda
   **acoplada a D2**: cuando D2 migre el baseline de drift a `lastPushedPrice`
   (ver `docs/d2-price-authority-design.md` §2, aprobado y **no implementado**), push y wrapper dejan de
   escribir `priceInStore` en el mismo cambio coordinado. Hasta entonces, escribirlo es lo correcto.

10. **`PublishResult` actual = `{ success: boolean; externalProductId?: number; error?: string }`**
    (`publication-service.ts:19-23`). **No** transporta la clasificación `ERROR_TERMINAL` vs
    `PENDING_SYNC`; esa distinción solo aterriza en DB (vía `syncFieldsForWooError`,
    `publication-service.ts:32-41`).

---

## SECCIÓN B — Decisiones abiertas para Gate 1

> Inventario de decisiones pendientes. Para cada una: la tensión y las opciones legítimas. **No se
> recomienda, no se elige, no se prejuzga nada acá.** Gate 1 las resuelve.

> **Estado:** RESUELTA en la Sección C. Las **cuatro** decisiones cerradas (C.D / C.C / C.B; y **A** en C.A — cuarta vía).

### A. `previousPrice` en el EventLog del wrapper
> **→ Resuelta en C.A (cuarta vía).**
- **Opción 1:** `previousPrice = priceInStore` previo (lo que hace el molde hoy, A.5 — consistente con el
  push).
- **Opción 2:** `previousPrice = lastPushedPrice` previo (baseline de autoridad 2B).
- **Tensión:** si hubo un pull entre dos pushes, `priceInStore` previo ≠ `lastPushedPrice` previo. Qué
  quiere significar el "triple cruce" de 2B define cuál corresponde. Sin resolver.

### B. Idempotencia cuando `newPrice == precio actual` (`priceInStore` / `lastPushedPrice`)
> **→ Resuelta en C.B.**
- **Sub-decisiones:** ¿salir temprano sin llamar a Woo? ¿llamar igual a Woo? ¿emitir EventLog o no?
- **Tensión:** el primer push real planeado es "pushear el mismo precio = no-op observable" para validar
  B-Prep-1 y 2B en prod. Si el wrapper cortocircuita con precio igual, ese test **no** ejercita el path
  HTTP ni valida nada. La decisión de idempotencia condiciona el plan de validación. Sin resolver.

### C. Forma del `Result`
> **→ Resuelta en C.C.**
- **Opción 1:** espejar `PublishResult { success, externalProductId?, error? }` (A.10) → el caller del
  flujo masivo **no** puede distinguir `ERROR_TERMINAL` de `PENDING_SYNC` sin re-leer DB (N queries).
- **Opción 2:** `Result` más rico que incluya la clasificación sync (`syncStatus` / `pendingSync`) para que
  el loop discrimine sin re-leer.
- **Tensión:** reusabilidad del flujo masivo vs simetría con el push. Sin resolver.

### D. Fallo parcial Woo OK / DB FAIL (el más delicado)
> **→ Resuelta en C.D.**
- **Escenario:** Woo responde 200, la escritura de `priceInStore` / `lastPushedPrice` falla → Woo
  actualizado, PricEcom sin baseline → drift falso → `OUTDATED` → reintento → republicación. Es la
  desincronización de espejo que enseñó el incidente, y A.8 confirma que el detector vivo la castiga al
  toque.
- A registrar como **pregunta abierta de diseño** (orden de operaciones push↔write, manejo del
  200-then-fail, idempotencia del reintento), **no** como solución. Sin resolver.
- **Nota anexa (sin resolver):** el reintento transitorio hoy lo toma el drainer vía
  `publishProductToWoo`, que republica — así que el invariante "no republica" del wrapper se sostiene en
  happy-path pero el reintento queda fuera de su control. Entrelazado con C y D. Material de Gate 1.

---

**Cierre.** Ninguna de las decisiones de la Sección B está tomada. La Sección A es lo verificado contra el
código real; la Sección B es lo que Gate 1 debe resolver **antes** de implementar el wrapper.

---

## SECCIÓN C — Decisiones Gate 1

> Resuelve las decisiones que la Sección B dejó abiertas, en orden **D → C → B** (D es la raíz: define la
> máquina de estados y arrastra a C y B). **A queda reabierta** al final (C.A). Cada decisión resuelta
> lleva opción elegida, por qué (citando la Sección A) y efecto en el contrato.

### C.D — Fallo parcial Woo OK / DB FAIL + reintento  [RESUELTA]

**Orden: push-first** (Woo primero, DB después). DB-first generaría **falso-verde**: el detector vivo
vería `effective == priceInStore` → `SYNCED` con Woo viejo (A.3). Push-first replica el molde (A.4) y
hace que un fallo de Woo deje `priceInStore` intacto = consistente con el Woo real (viejo).

**Dos regiones de fallo:**
- **Woo falla (no hubo 200):** `syncFieldsForWooError` tal cual — `terminal/unknown → ERROR_TERMINAL + pSync=false`; `recoverable/ambiguous → PENDING_SYNC + pSync=true`. Woo y `priceInStore` quedan viejos, consistentes.
- **Woo 200 + DB falla:** el error es de Prisma, no `WooApiError` → `syncFieldsForWooError` lo daría `unknown → ERROR_TERMINAL`, lo cual es **incorrecto** (es reintentable). **Branch deliberado:** forzar `PENDING_SYNC + pSync=true` (write mínimo best-effort) para que el drainer lo tome. **Backstop** si hasta ese write falla: `markPublicationsDrift` periódico lo agarra **precisamente porque `priceInStore` quedó viejo** (A.8) → `OUTDATED` → drainer → converge. *(Gate 2: diseñar qué write mínimo, dónde, y qué pasa si también falla; la convergencia vía backstop ya está cubierta.)*

**Corrección de diseño (cerrada, verificada contra código — NO es una opción):** el gate de precondición
es **`status = ACTIVE`** (la fila debe estar activa en PricEcom), **no** el OR `status=ACTIVE ∨
externalStatus=publish`. Motivo verificado: una fila `status=PAUSED + externalStatus=publish` (el caso de
drift que el predicado del drainer levanta, `sync/publications/route.ts:117`) pasaría el OR, pero en el
retry el `shouldPause` del drainer (`sync/publications/route.ts:151-154`) ve `status=PAUSED` → la
**pausa** en Woo en vez de republicar, revirtiendo el push de precio en una pausa y rompiendo el contrato
del wrapper. `status=ACTIVE` garantiza `shouldPause=false` → el retry del drainer republica
(`status:publish` sobre fila ya publish) = inocuo.

**Quién reintenta y el invariante "no republica":** el reintento lo toma el drainer vía
`publishProductToWoo` (`sync/publications/route.ts:157`, republica `status:publish`, A.4). Con el gate
`status=ACTIVE` ese retry es inocuo. El invariante "no republica" del wrapper se sostiene: ni el wrapper
ni su retry vuelven visible algo que no lo estaba.

**Caveat acotado (documentar, no bloqueante):** el `publishProductToWoo` del drainer **recomputa** el
precio con `resolvePricing` (`sync/publications/route.ts:162`), no usa el `newPrice` del wrapper. Para los
usos previstos (BAZAR, validación 2B) `newPrice == regla` → converge igual. Un `newPrice` arbitrario ≠
regla sería "corregido" por el retry hacia la regla — fuera del uso previsto.

**Máquina de estados resultante:**

| Caso | Resultado |
|---|---|
| guardrail falla | `{ GUARDRAIL }`, no toca Woo |
| Woo falla (terminal) | `ERROR_TERMINAL`, `pSync=false` (fuera del drainer) |
| Woo falla (transitorio) | `PENDING_SYNC`, `pSync=true` (drainer reintenta, inocuo por gate `status=ACTIVE`) |
| Woo 200, DB ok | `SYNCED`, `pSync=false`, `priceInStore = lastPushedPrice = newPrice` |
| Woo 200, DB falla | best-effort `PENDING_SYNC`, `pSync=true` (converge vía drainer/backstop) |

### C.C — Forma del `Result`  [RESUELTA]

**Elección: `Result` enriquecido** (no espejar `PublishResult` de A.10). El loop del flujo masivo
necesita reporte agregado por ítem **sin re-leer DB**; `PublishResult` no distingue `ERROR_TERMINAL` de
`PENDING_SYNC` ni el rechazo por guardrail. Expone la clasificación que el wrapper **ya** computa (vía
`syncFieldsForWooError`) — superficie nueva, no lógica nueva.

```
type PriceOnlyOutcome =
  | { ok: true;  wooId; newPrice; previousPrice; priceUnchanged }
  | { ok: false; kind: "GUARDRAIL";      reason }   // Woo NUNCA tocado
  | { ok: false; kind: "PENDING_SYNC";   error }    // transitorio (incl. 200-then-DB-fail)
  | { ok: false; kind: "ERROR_TERMINAL"; error }    // requiere humano
```

Los `kind` espejan el `syncStatus` que el wrapper escribió → una sola fuente de verdad. `GUARDRAIL` se
distingue porque esos ítems **nunca** tocaron Woo. Difiere de A.10 a propósito (reusabilidad > simetría
con el molde).

### C.B — Idempotencia (`newPrice == precio actual`)  [RESUELTA]

**Elección: NO early-exit.** Siempre llama a Woo, siempre emite EventLog, **sin flag de forzar**.

Razones encadenadas:
1. La validación 2B "mismo precio = no-op observable" **muere** si cortocircuita; con always-push la validación **es** el path normal.
2. Que la DB diga "ya está en X" no implica que Woo esté en X (el cliente edita a mano — ceguera D2 §1); always-push impone la autoridad igual.
3. **Interlock con C.D:** el retry de 200-then-DB-fail **es** un re-push del mismo precio; cortocircuitar con precio igual lo saltearía y nunca convergería → rompería D.

**EventLog:** `WOO_SYNC_SUCCESS` siempre. La señal `priceUnchanged` se computa contra **`lastPushedPrice`
previo** (`priceUnchanged = lastPushedPrice previo == newPrice`, decisión C.A — cuarta vía) y se etiqueta
en metadata (alimenta el `priceUnchanged` del Result). El campo logueado `previousPrice` sigue siendo
`priceInStore` previo (observación, homogéneo con el push); `priceUnchanged` es señal derivada aparte.

### C.A — `previousPrice` del EventLog  [RESUELTA — cuarta vía]

**Decisión: cuarta vía — desacoplar la metadata histórica de la señal de validación.** El doc había
acoplado `previousPrice` (metadata) con `priceUnchanged` (señal); son separables, y se separan:
- **`previousPrice` = `priceInStore` previo** — logueado en el EventLog, **homogéneo con el push** (A.5):
  el mismo campo significa lo mismo lo emita el push o el wrapper = observación previa.
- **`priceUnchanged` = (`lastPushedPrice` previo == `newPrice`)** — señal de no-op **derivada**, computada
  aparte del campo logueado, usando el baseline de autoridad 2B.

**Por qué:** desacoplarlos da las dos cosas a la vez — EventLog homogéneo con el push **y** señal de no-op
limpia — sin el compromiso de migrar `publishProductToWoo` (salida b) ni la heterogeneidad semántica del
mismo campo (salida c).

**Fundamento de compatibilidad (census verificado contra código):** un solo emisor de `WOO_SYNC_SUCCESS`
(`publication-service.ts:421`); **cero lectores de `metadata.previousPrice`** en todo el repo (los dos
lectores de EventLog —`app/(app)/activity/page.tsx` y `app/(app)/dashboard/page.tsx`— lo tratan como
display opaco; el único acceso a `.metadata` es el writer, `lib/events/event-log.ts:52`); `lastPushedPrice`
**sin lector** en código (solo se escribe, `publication-service.ts:361/381`) y el "triple cruce" de 2B
**no implementado**. Por lo tanto nada depende hoy de la semántica de `previousPrice` → la cuarta vía no
rompe consumidores.

> **Nota honesta:** como hoy **nadie** lee `previousPrice`, el census da *compatible para las cuatro
> salidas* (a/b/c/cuarta vía). La cuarta vía se elige por el mejor set-up futuro (log homogéneo + señal
> limpia) a **costo presente cero**, no por evitar una ruptura actual.

**Salidas previas (conservadas como registro del trade-off — descartadas a favor de la cuarta vía):**
- ~~(a)~~ `previousPrice = priceInStore` previo, sin señal de no-op derivada — descartada (no da la señal limpia).
- ~~(b)~~ Opción 2 + migrar el push — descartada (scope acoplado a D2, más grande que el wrapper).
- ~~(c)~~ Opción 2 solo en el wrapper — descartada (heterogeneidad semántica del mismo campo).

---

## Contrato actualizado del wrapper (C.D / C.C / C.B / C.A — cerrado)

- **Firma:** `updatePriceOnlyInWoo(prisma, client, publicationId, newPrice)` — servicio puro reutilizable.
- **Precondiciones (guardrail, fail-closed):** `newPrice > 0`; `externalProductId` presente;
  **`status = ACTIVE`** (corrección C.D). Si fallan → `{ GUARDRAIL }`, no toca Woo.
- **Secuencia:** resolver publication → leer `priceInStore` previo (→ `previousPrice`) y `lastPushedPrice`
  previo (→ señal `priceUnchanged`) (C.A — cuarta vía) → guardrails → **push-first** `{regular_price}` →
  Woo 200 → DB (`priceInStore=newPrice`, `lastPushedPrice=newPrice`, `SYNCED`, `pSync=false`,
  `syncError=null`, `lastSyncedAt/lastSyncAt=now()`; **no toca**
  `status`/`externalStatus`/`sku`/`externalSku`/`internalStatus`/títulos) → EventLog `WOO_SYNC_SUCCESS`
  siempre `{wooId, previousPrice = priceInStore previo, newPrice, priceUnchanged = (lastPushedPrice previo == newPrice)}`
  → return `PriceOnlyOutcome`. Errores: Woo-fail → `syncFieldsForWooError`; 200-then-DB-fail →
  best-effort `PENDING_SYNC`.
- **Invariantes (Gate 0, intactos):** no `status` → no republica; no `sku` → sin guard 3; no marca drift;
  éxito `pSync=false` → no encola. **Nuevo (C.D):** el único retry que republica es el del drainer,
  inocuo por gate `status=ACTIVE`.

---

**Cierre de la Sección C.** Las cuatro decisiones (C.D / C.C / C.B / C.A) quedan **cerradas**. C.A se
resolvió por la **cuarta vía** (`previousPrice = priceInStore` previo, homogéneo con el push;
`priceUnchanged` derivado de `lastPushedPrice` previo). **Gate 1 completo → Gate 2 (implementación)
desbloqueado.**
