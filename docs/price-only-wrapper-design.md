# Wrapper price-only (`updatePriceOnlyInWoo`) — diseño

**Fecha:** 2026-06-13
**Estado:** Gate 0 cerrado en lo verificado; decisiones de implementación abiertas para Gate 1.

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

### A. `previousPrice` en el EventLog del wrapper
- **Opción 1:** `previousPrice = priceInStore` previo (lo que hace el molde hoy, A.5 — consistente con el
  push).
- **Opción 2:** `previousPrice = lastPushedPrice` previo (baseline de autoridad 2B).
- **Tensión:** si hubo un pull entre dos pushes, `priceInStore` previo ≠ `lastPushedPrice` previo. Qué
  quiere significar el "triple cruce" de 2B define cuál corresponde. Sin resolver.

### B. Idempotencia cuando `newPrice == precio actual` (`priceInStore` / `lastPushedPrice`)
- **Sub-decisiones:** ¿salir temprano sin llamar a Woo? ¿llamar igual a Woo? ¿emitir EventLog o no?
- **Tensión:** el primer push real planeado es "pushear el mismo precio = no-op observable" para validar
  B-Prep-1 y 2B en prod. Si el wrapper cortocircuita con precio igual, ese test **no** ejercita el path
  HTTP ni valida nada. La decisión de idempotencia condiciona el plan de validación. Sin resolver.

### C. Forma del `Result`
- **Opción 1:** espejar `PublishResult { success, externalProductId?, error? }` (A.10) → el caller del
  flujo masivo **no** puede distinguir `ERROR_TERMINAL` de `PENDING_SYNC` sin re-leer DB (N queries).
- **Opción 2:** `Result` más rico que incluya la clasificación sync (`syncStatus` / `pendingSync`) para que
  el loop discrimine sin re-leer.
- **Tensión:** reusabilidad del flujo masivo vs simetría con el push. Sin resolver.

### D. Fallo parcial Woo OK / DB FAIL (el más delicado)
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
