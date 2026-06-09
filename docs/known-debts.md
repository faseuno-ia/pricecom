# Known debts

Deudas técnicas reconocidas en producción. Documento vivo: cada deuda nueva
que se decide postergar entra acá con el mismo formato. Cada entrada incluye
prioridad declarada (despreciable-por-ahora vs. hardening del próximo ciclo),
contexto y origen, impacto actual, trigger que la activa como prioritaria, y
solución concreta cuando se decida atacarla.

---

## `markPublicationsDrift` es unidireccional (no limpia OUTDATED residual)

**Prioridad:** Media — no corrompe datos ni toca Woo, pero ensucia la cola de
"Desactualizados" con falsos pendientes que hay que limpiar a mano.

**Contexto.** `lib/catalog/mark-publications-drift.ts` solo escribe en una
dirección:
- marca `syncStatus=OUTDATED + pendingSync=true` cuando detecta drift real
  (`|effectivePrice − priceInStore| > $0.50`);
- **NO** limpia OUTDATED→SYNCED cuando el drift desaparece. La función solo
  agrega a `drifts[]` las que driftan y hace `updateMany` sobre esas; no hay rama
  que des-marque las que ya estaban OUTDATED y ahora coinciden.

**Ejemplo real (2026-06-09).** Bazar 380: se subió el margen 27%→37% (D1 marcó
~194 publicaciones OUTDATED), luego se revirtió 37%→27% **sin sincronizar a Woo**.
Las 194 quedaron OUTDATED aunque `effectivePrice == priceInStore` otra vez (diff=0),
porque la reversión dejó el margen exacto original pero nada las des-marcó. La
reversión (`PRICING_RULE_CHANGED` 37→27) registró `marked=0`: no encontró drift
nuevo, pero tampoco limpió las viejas.

**Workaround actual.** `scripts/fix-outdated-residual.ts` (o una limpieza
controlada puntual con backup, como la del 2026-06-09 sobre Bazar 380): recalcula
`effectivePrice` vs `priceInStore`, y pasa a `SYNCED`/`pendingSync=false` las
residuales (`≤ $0.50`), dejando intactas las de drift real.

**Trigger para atacarla.**
- Cada reversión de margen/regla deja un lote de falsos OUTDATED que el cliente ve
  como pendientes.
- Se encara D2/D3 (donde la honestidad del estado de sync es central).

**Decisión pendiente.** Diseñar si la detección de drift puede limpiar
OUTDATED→SYNCED automáticamente **sin reintroducir falso verde** (el riesgo que
motivó el contrato honesto 1A: una pub realmente desincronizada no debe quedar
SYNCED por error). Probablemente: solo des-marcar cuando `effectivePrice` coincide
con `priceInStore` Y no hay otra causa de pendiente (título/desc user-edited,
acción de sistema), reusando el mismo `findDriftingPublications` como fuente única.

---

## "Pend. Sync" vs "Desactualizados": predicados inconsistentes, buckets no atómicos

**Prioridad:** Media — no rompe nada hoy (todos los contadores en 0 en prod),
pero los tres indicadores de "pendiente/desactualizado" pueden mostrar números
distintos y `OUTDATED` se cuenta doble. Quedó fuera de scope de 1A.2-kpi (que
solo tocó el bucket "Errores").

**Contexto y origen.** Detectado en el diagnóstico de 1A.2-kpi. Hoy conviven tres
predicados distintos para el eje sync de "pendiente":
- **KPI "Pendientes sync"** (`my-store/page.tsx`, `api/my-store/route.ts`) cuenta
  `pendingSync=true` → incluye **PENDING_SYNC + OUTDATED** (ambos setean
  `pendingSync=true`).
- **Chip "Pend. sync"** (`publications/route.ts`) filtra `syncStatus=PENDING_SYNC`
  → **NO** incluye OUTDATED.
- **Chip "Desactualizados"** (`publications/route.ts`) filtra `syncStatus=OUTDATED`.

**Consecuencia.**
- El KPI "Pendientes sync" y el chip "Pend. sync" pueden mostrar **números
  distintos** (el KPI infla con los OUTDATED).
- `OUTDATED` queda **contado en dos lugares**: KPI "Pendientes sync" + chip
  "Desactualizados".
- La suma de los buckets visibles de sync **no es atómica** (un OUTDATED aparece
  dos veces).

**Impacto hoy.** Nulo en prod (PENDING_SYNC=0, OUTDATED=0, todo SYNCED). El riesgo
es de consistencia cuando aparezcan pendientes/drift reales: el cliente vería un
KPI que no cuadra con el chip.

**Por qué no se arregla en 1A.2-kpi.** Ese sprint cambió la FUENTE de datos del
bucket "Errores" (a `syncStatus IN (ERROR, ERROR_SKU_CONFLICT)` vía
`SYNC_ERRORS_WHERE`), no los nombres ni el predicado de "pendiente". Alinear
"Pend. Sync" / "Desactualizados" es un debate de **predicado canónico + nombres**
(¿"pendiente" = `pendingSync=true` o `syncStatus=PENDING_SYNC`? ¿OUTDATED es su
propio bucket o parte de "pendientes"?), que merece su propio sprint.

**Trigger para atacarla.**
- Aparecen PENDING_SYNC u OUTDATED reales en prod y el cliente nota que KPI y chip
  no coinciden.
- Se encara el sprint de "predicado canónico / separación visual de ejes".

**Solución cuando importe.** Definir UN predicado canónico de "pendiente" y un
bucket único para OUTDATED, extraídos a `lib/store/sync-buckets.ts` (donde ya vive
`SYNC_ERRORS_WHERE`) como `SYNC_PENDING_WHERE` / `SYNC_OUTDATED_WHERE`, y usarlos
en KPI + chip + filtro para que cuadren atómicamente. Decidir nombres en ese mismo
sprint.

**Archivos afectados (estimación).** `app/(app)/my-store/page.tsx`,
`app/api/my-store/route.ts`, `app/api/my-store/publications/route.ts`,
`components/my-store/publications-table.tsx`, `lib/store/sync-buckets.ts`.

---

## `pausedBySystem=true` residual en productos OWN reactivados

**Prioridad:** Baja — no afecta conteos ni jerarquía visual hoy; es un flag
contradictorio que conviene limpiar antes de que alguien lo use como fuente.

**Contexto y origen.** Al implementar el fix de jerarquía visual (SIN_STOCK
restringido a `stockSource=SUPPLIER`), el cuadre contra prod (ELECTROFAYS)
surfaceó 2 productos OWN ex-varados con estado contradictorio:
`internalStatus=PUBLISHED` pero `pausedBySystem=true` (AL-202 y 12098). Son
restos de cuando el worker auto-pausaba por `SUPPLIER_REMOVED` sin mirar
`stockSource`. Hoy el worker ya respeta OWN/HYBRID y no los vuelve a pausar,
pero el flag viejo quedó pegado. HX178 y MELECH-329 (también OWN ex-varados)
tienen `pausedBySystem=false` correcto.

**Impacto hoy.** Nulo en la UI: el KPI "Pausados" exige `internalStatus=PAUSED`
(no PUBLISHED), así que estos 2 caen en PUBLISHED como corresponde y NO se
doble-cuentan. El cuadre cierra exacto (1427=1427). El riesgo es semántico:
un flag `pausedBySystem=true` sobre un producto PUBLISHED es mentira y podría
confundir a un futuro query o reporte que se apoye en ese campo.

**Trigger para atacarla.**
- Aparece lógica nueva (worker, sync, dashboard) que lea `pausedBySystem`
  como verdad sobre productos no pausados.
- Se decide un barrido de higiene de datos.

**Solución cuando importe.** UPDATE puntual con guard de prod + backup (mismo
patrón que `reconcile-hx178`): `SET pausedBySystem=false WHERE
stockSource IN ('OWN','HYBRID') AND internalStatus != 'PAUSED' AND
pausedBySystem=true`. Read-only primero para confirmar el universo (se esperan
2 hoy). Cero cambios de código.

---

## TOCTOU en guard 3 del SKU (Fase 4B)

**Prioridad:** Despreciable mientras la app sea single-operator y no haya
integraciones externas escribiendo en Woo en paralelo.

**Contexto.** El endpoint `PUT /api/catalog/publications/[id]/sku` y los
flujos `publishProductToWoo` CREATE/UPDATE-con-drift hacen un `GET
/products?sku=X` contra Woo (función `assertSkuNotInWoo`) ANTES de pushear.
Si el GET dice "libre" se persiste `pp.sku` y se hace el PUT/POST.

**Condición de carrera.** Entre el GET del guard y el PUT/POST del push, otro
proceso (usuario concurrente, integración externa cargando productos en Woo)
puede crear un producto con el mismo SKU. El push entonces falla con HTTP 400
`product_invalid_sku`. El código actual lo trata como error transitorio →
marca `pendingSync=true, syncStatus=ERROR`. El retry desde Mi Tienda
volvería a fallar igual: bucle de reintentos sin éxito.

**Impacto hoy.** Despreciable con un solo operador y sin integraciones
externas paralelas a WooCommerce. La ventana entre GET y PUT es chica
(cientos de ms) y nadie más toca Woo.

**Trigger para atacarla.**
- Cliente agrega un segundo operador con acceso al drawer / publicar.
- Aparece una integración externa que crea productos en Woo (otra app,
  importador masivo de Excel directo a Woo, etc.).
- Se observa al menos 1 incidente real del bucle.

**Solución cuando importe.** En el `catch` del push (tanto en el endpoint 4B
como en `publishProductToWoo`), inspeccionar el cuerpo del error. Si Woo
devolvió HTTP 400 con `code === "product_invalid_sku"` (formato documentado
de WC REST API v3), tratar como `ERROR_SKU_CONFLICT` en lugar de `ERROR`
transitorio: marcar `pendingSync=false`, syncStatus=ERROR_SKU_CONFLICT, log
con el error original. Cierra la ventana sin GET extra. Aproximadamente 15
líneas, contenidas a los catches existentes.

**No anticipar.** Mientras sea single-operator, el guard 3 pre-push cubre
estadísticamente el 100% de los casos.

---

## Instrumentación de `internalStatus` sin helper centralizado (Fase 4E)

**Prioridad:** Hardening — atacar antes de abrir multi-usuario o de planear
Fase 5 (eliminación de `cp.publicationSku`).

**Contexto.** Fase 4E cerró cuatro huecos donde rutas mutaban
`CatalogProduct.internalStatus` sin emitir `EventLog`:
`app/api/catalog/[id]/publication/route.ts:46` (rama IGNORED/RESTORE, la que
movió DURAVIT sin rastro), `app/api/catalog/bulk-update/route.ts` para
`action=prepare`, `pauseProductInWoo` en su early return sin
`externalProductId`, y el auto-pause del import al detectar
`SUPPLIER_REMOVED`. Cobertura reactiva: se encontraron leyendo todos los
sitios que escribían el campo.

**Impacto / riesgo.** No hay garantía estructural de que un sitio NUEVO
(otra ruta, otro endpoint del worker, otro script) que mute `internalStatus`
también emita el `EventLog` correspondiente. El próximo gap pasa
desapercibido hasta que el activity log muestra "este producto cambió de
PAUSED a IGNORED sin explicación" — exactamente el caso DURAVIT que motivó
4E. Reactividad escala mal: cada gap nuevo se paga con una sesión de
diagnóstico forense.

**Trigger para atacarla.**
- Aparece un segundo gap post-4E (señal de que el patrón reactivo ya no
  alcanza).
- Se abre la app a un segundo operador (cada cambio sin trazabilidad cuesta
  más cuando no fue uno mismo el que lo hizo).
- Se planea Fase 5: refactor obligado del área, buena ocasión para
  normalizar los call sites.

**Solución cuando importe.** Helper centralizado
`changeInternalStatus(prisma, productId, newStatus, source, opts?)` que:
1. Lea el `previousStatus` desde la DB en la misma transacción.
2. Aplique el `prisma.catalogProduct.update`.
3. Emita el `EventLog` con `previousStatus`/`newStatus`/`source`/userId
   SIEMPRE, no condicional.

Norma de revisión (lint custom o code review checklist): prohibir
mutaciones directas de `internalStatus` fuera del helper. Los call sites
hoy son heterogéneos (update único, `updateMany`, dentro de transacciones
compuestas) — el refactor debe normalizarlos primero, por eso encaja con
Fase 5.

**Archivos afectados.** `lib/catalog/upsert-catalog-products.ts`,
`lib/integrations/woocommerce/publication-service.ts`,
`app/api/catalog/[id]/publication/route.ts`,
`app/api/catalog/bulk-update/route.ts`,
`app/api/catalog/import/route.ts`, scripts de mantenimiento.

---

## Transición a PUBLISHED sin evento explícito (Fase 4E)

**Prioridad:** Hardening — encarar junto con la deuda anterior; mismo
refactor lo cubre.

**Contexto.** `publishProductToWoo` línea ~370 setea
`internalStatus = PUBLISHED` y queda rastreable solo por INFERENCIA: el
caller emite `WOO_PRODUCT_CREATED` (CREATE) o `WOO_SYNC_SUCCESS` (UPDATE)
inmediatamente después. No hay un `EventLog` explícito que diga "el
`internalStatus` pasó de X a PUBLISHED".

**Impacto / riesgo.** Único caso donde la trazabilidad del flag depende de
que un evento adyacente quede emitido. Si en el futuro se agrega una rama
en `publishProductToWoo` que mueva `internalStatus` a PUBLISHED pero NO
emita `WOO_PRODUCT_CREATED`/`WOO_SYNC_SUCCESS` (por ejemplo, un sync
parcial nuevo), el trace de la transición se pierde sin que nadie lo note.

**Trigger para atacarla.** Mismo que la deuda anterior: cuando se haga el
refactor con helper centralizado, este caso queda cubierto automáticamente.

**Solución cuando importe.** El helper `changeInternalStatus` de la entrada
anterior cubre este caso al volverlo explícito: cualquier transición a
PUBLISHED desde `publishProductToWoo` pasaría por el helper y emitiría un
evento de transición (puede coexistir con `WOO_PRODUCT_CREATED` como evento
de "creé el producto en Woo"; los dos cuentan cosas distintas).

**Archivos afectados.**
`lib/integrations/woocommerce/publication-service.ts` (sitio único).

---

## Import de Excel: duplicados de `sku` raw sin warning ("último gana")

**Prioridad:** Despreciable — comportamiento correcto del upsert; UX
nice-to-have. No hay corrupción de datos, solo opacidad para el usuario.

**Contexto.** `app/api/catalog/import/route.ts` hace upsert por
`(userId, providerId, sku)`. Si el Excel trae dos filas con el mismo `sku`
raw (identidad del producto en el proveedor), la segunda hace UPDATE sobre
la primera silenciosamente. Es semánticamente correcto — el `sku` es la
identidad y la última pasada gana — pero el usuario no se entera de que su
archivo tenía un duplicado.

**Impacto / riesgo.** Cosmético / educacional. El usuario que importa con
duplicados no nota el conflicto: el segundo valor pisa al primero sin
reporte. Es perfectamente posible que el "duplicado" sea voluntario
(corrección de precio fila a fila o sub-totales), en cuyo caso un warning
ruidoso sería peor que el silencio.

**Trigger para atacarla.**
- Caso de soporte donde "perdí datos del producto X tras el import" porque
  el Excel tenía un duplicado y la segunda fila tenía menos campos
  completos.
- Se observa al menos 1 incidente real en producción.

**Solución cuando importe.** Detectar duplicados de `sku` por proveedor en
una pasada inicial sobre `rows`. Agregar al `report` un campo
`duplicateRows: { sku: string; rowNumbers: number[] }[]`. Mostrarlo como
warning informativo en la UI del importador (no bloqueante, no advierte
"error"; redacción tipo "estas filas comparten SKU y la última prevaleció").

**Archivos afectados.** `app/api/catalog/import/route.ts` (detección +
extensión del `report`), componente del importador
(`components/catalog/catalog-import-form.tsx`) para mostrar el warning.

---

## Lint rule custom para `UnmatchedStoreProduct` (defensa real contra duplicación)

**Prioridad:** Alta — atacar en cuanto se pueda. Es la única defensa
automática contra que el bug "lista vs contador" vuelva a aparecer en un
sitio nuevo.

**Contexto.** El bug "63 vs 1" del cliente reapareció en 4 sitios distintos
durante la saga lazy SKU + dashboard:

1. Sync de productos (`app/api/my-store/sync/products/route.ts`) no
   matcheaba por `pp.sku` canónico → creaba stale.
2. Pestaña No vinculados (`app/api/my-store/unmatched/route.ts`) contaba
   crudo por `resolved=false` → mostraba 63.
3. Contador de Mi Tienda (`app/(app)/my-store/page.tsx`) contaba crudo →
   tarjeta y badge inicial en 63.
4. Dashboard principal (`app/(app)/dashboard/page.tsx`) contaba crudo →
   tarjeta "Atención requerida" + "Estado ecommerce" en 63.

Los 4 fueron arreglados (fixes 65a43fe, 0c69651, y este commit). La
lógica vive ahora centralizada en `lib/store/unmatched-where.ts` con
helpers `buildActiveUnmatchedWhere` / `buildDiscardedUnmatchedWhere`.

**Por qué no alcanza con disciplina humana.** Los tests de integración
NO pueden cubrir RSC (server components) directamente — no hay renderer
práctico en vitest. Eso deja un agujero estructural: el test 5 cubre el
helper, pero NO detecta si un RSC nuevo cuenta crudo. El dashboard
(consumidor 4) era exactamente ese caso: el helper estaba bien testeado,
pero el RSC del dashboard ignoró el helper y contó crudo, y el test no
lo atrapó. **El bug reapareció a pesar de tener el helper + el test del
helper.**

**Riesgo de fondo.** Cualquier RSC nuevo (sección del dashboard, página
nueva, widget) que muestre/cuente unmatched va a tener su propia
`prisma.unmatchedStoreProduct.count({where: {storeId, resolved: false}})`
si el desarrollador no piensa explícitamente en el helper. Los tests no
lo van a atrapar. El próximo bug se descubre en producción cuando un
cliente compara la lista con el contador.

**Trigger para atacarla.**
- Cualquier vista nueva que muestre/cuente unmatched (alta probabilidad
  de regresión inmediata).
- Onboarding de un nuevo dev (alta probabilidad de duplicación inocente).
- Refactor del dashboard o de mi-tienda.

**Solución recomendada.** Lint rule custom que prohíba `count` y
`findMany` directos sobre `unmatchedStoreProduct` fuera del helper.
Opciones a evaluar (decisión técnica pendiente — investigar el setup
de ESLint del repo y CI):

- **A. `no-restricted-syntax` de ESLint** con un selector AST que matchee
  `prisma.unmatchedStoreProduct.count` y `.findMany`, con override para
  `lib/store/unmatched-where.ts` (donde la regla SÍ aplica). No requiere
  plugin nuevo, regla estándar.
- **B. Test custom que haga grep del codebase** y falle si aparece el
  patrón prohibido fuera del helper. Más tosco pero no depende de la
  config de ESLint.

Cualquiera de las dos debe correrse en el build/CI (Railway) para que
falle ANTES del deploy, no solo en lint manual del dev.

**Prerequisito.** Esta regla NO sirve hasta que exista un gate de CI/build
que la ejecute antes del deploy. Hoy no hay (ver entrada "No hay gate de
CI/build" más abajo). Implementar la regla sin el gate solo agrega un
lint que el dev puede ignorar — no protege de regresiones reales. El
orden a respetar: primero montar el gate, después agregar esta regla
adentro.

**Distinguir uso legítimo de uso prohibido.** Hay sitios legítimos que
NO deben pasar por el helper:
- Lecturas por ID (`findFirst({id})` en endpoints
  `unmatched/[id]/{link,resolve,create-catalog}`).
- Escrituras (`upsert`, `update`, `updateMany` para resolver/limpiar).
- Scripts one-off (`scripts/link-from-excel.ts`,
  `scripts/fix-excel-duplicates.ts`).
- Setup/assertions de tests.

La regla solo prohíbe `count` y `findMany` que listan/cuentan al usuario.
`findFirst` por id, escrituras y scripts no deberían dispararla.

**Archivos afectados.**
- `.eslintrc.json` (o equivalente) si opción A.
- `tests/unit/no-crudo-unmatched.test.ts` (o similar) si opción B.
- Probablemente `package.json` para asegurar que el linter corre en
  build/CI.

---

## No hay gate de CI/build — lint ni tests corren antes del deploy — RESUELTA

**Estado:** ✅ RESUELTA el 2026-06-03. Gate de CI activo y verificado
end-to-end en producción.

**Plan ejecutado (opción A — GitHub Actions, decidido por simplicidad +
no enlentecer cada deploy).**

**Fase A — Workflow en modo informativo** (commit `c529e39`).
- `.github/workflows/ci.yml` creado: trigger en push a main + PR a main.
- Job único `test` sobre `ubuntu-latest`, Node 20 con cache npm.
- Service container `postgres:16` (POSTGRES_DB=test) — efímero por job,
  sin secrets externos, sin lifecycle de branches Neon que mantener. La
  alternativa (Neon ephemeral branch via API token) se descartó por
  agregar dependencia externa, secret, y costo sin aportar fidelidad
  útil (el SQL es idéntico).
- Steps: checkout → setup-node (con cache npm) → `npm ci` →
  escribir `.env.test` apuntando a `localhost:5432/test` con
  `TEST_DB_CONFIRMED=true` (el guard de `tests/setup/env.ts` pasa porque
  localhost no contiene `ep-raspy-cloud-ap9iuixg`) → `npx tsc --noEmit`
  → wait-for-postgres explícito (`pg_isready` loop) → `npm run db:test:reset`
  (DROP SCHEMA + `prisma migrate deploy` desde el baseline único
  post-rebaseline) → `npm run test`.
- `concurrency: cancel-in-progress` por (workflow, ref) para no gastar
  minutos en commits rápidos consecutivos.
- `permissions: contents: read` explícito (least-privilege).
- Validado: dos runs verdes seguidos sin flakiness, tiempo total ~1:20s
  contra Postgres vanilla.

**Fase B — Activar el gate** (commit `04db1a6`).
- Antes del toggle: limpieza de check huérfano. Investigación de los
  checks reportados en commits de main encontró `shimmering-analysis -
  pricecom` (proyecto Railway viejo abandonado conectado al mismo repo
  de GitHub) que reportaba ❌ Deployment failed en cada commit.
  Verificación crítica: las env vars de ese proyecto tenían placeholders
  del `.env.example` (DATABASE_URL=localhost, NEXTAUTH_SECRET=texto
  placeholder, ENCRYPTION_KEY=placeholder, sin Neon real) — **nunca
  tocó prod**. Proyecto eliminado de Railway (no solo desconectado).
  Verificado en commit siguiente: solo 3 checks reportan ahora — el
  nuestro de Actions + `extraordinary-delight - pricecom` + worker.
- Permisos de la Railway GitHub App: confirmados que ya tenían Read
  access a Checks y Commit statuses (el banner "Make sure you have
  accepted our updated GitHub permissions" en Railway era genérico,
  no requería acción).
- Toggle "Wait for CI" activado en Railway (Settings → Source →
  Check Suites: false → true).
- Validación end-to-end con el commit `04db1a6` (empty, único propósito
  probar el gate):
  - Push completado: `2026-06-03T15:56:17Z`.
  - Railway recibió el commit y quedó en estado **WAITING FOR CI**
    (verificado visualmente en Activity del deployment del commit
    `04db1a6`). NO deployó inmediato.
  - GitHub Actions corrió el workflow CI (~1:20s).
  - CI pasó verde.
  - Recién entonces Railway salió de WAITING, buildeó y deployó
    `04db1a6` como ACTIVE.
- **El gate funciona end-to-end en producción.**

**Por qué este commit es evidencia del cierre.** El propio commit que
documenta el cierre (este) se va a deployar pasando por el gate
recién verificado — primero por GitHub Actions (CI verde), después por
Railway. Cierre apropiado.

**Pendiente como capa futura (paso 2 explícito, NO bloqueante).**
ESLint + la regla custom de `UnmatchedStoreProduct` se agregan SOBRE el
gate ya funcionando, en un cambio separado:
1. Instalar `eslint` + `eslint-config-next`.
2. Agregar `.eslintrc.json` con la regla custom `no-restricted-syntax`
   prohibiendo `prisma.unmatchedStoreProduct.count`/`.findMany` fuera del
   helper `lib/store/unmatched-where.ts` (con overrides para `scripts/`
   y `tests/`).
3. Agregar step `npm run lint` al workflow `ci.yml` entre `npx tsc
   --noEmit` y `npm run db:test:reset`.

Ver entrada **"Lint rule custom para `UnmatchedStoreProduct`"** más
arriba para el detalle de la regla. Esa entrada apuntaba a este gate
como prerequisito — prerequisito ya cumplido.

---

**Contenido histórico (pre-resolución, para registro):**

**Prioridad original:** Alta. Era **prerequisito** de la regla de lint de
`UnmatchedStoreProduct` (entrada anterior), de cualquier futura regla de
lint, y de que la suite P0 de tests sirviera de red real. Cualquiera de
esas deudas atendida antes de cerrar ésta quedaba como decoración: la
herramienta existía, no protegía nada.

**Estado actual (descubierto investigando la regla de unmatched).**
- ESLint NO está instalado (`node_modules/eslint` no existe).
- NO hay `.eslintrc*` ni `eslint.config*`.
- NO hay scripts `lint` en `package.json`.
- NO hay `husky`, `lint-staged`, ni pre-commit hooks.
- NO hay `.github/workflows/` ni ningún CI externo.
- `next.config.mjs` no tiene sección `eslint`.
- El log "Linting and checking validity of types..." que aparece en
  `next build` es no-op silencioso cuando no hay config de ESLint.
- El Dockerfile de Railway corre solo `npm ci && npm run build`. No corre
  ni lint ni tests.

**Impacto / riesgo.**
- **La suite P0 de tests existe pero NO es una red real**. Los 18 tests
  verdes locales no impiden deployar con tests rojos: nadie los ejecuta
  antes del `git push`. La protección depende 100% de que el dev se
  acuerde de correr `npm run test`.
- **El bug de "unmatched contado crudo" reapareció 4 veces** (sync de
  productos, pestaña, contador de Mi Tienda, dashboard) precisamente
  porque no había un mecanismo que atrapara el patrón sin disciplina
  humana. Cada vez se descubrió en producción cuando un cliente lo
  reportó.
- Cualquier futura regla de lint (la de unmatched o la próxima) hereda
  el mismo problema: existe pero no se ejecuta antes del deploy.

**Trigger para atacarla.**
- Antes de implementar la regla de lint de unmatched o cualquier otra
  (esa regla pide este gate como prerequisito).
- Antes del próximo cliente/onboarding que requiera staging/preview
  builds.
- Apenas se detecte una regresión en producción que un test existente
  habría atrapado.

**Solución (decisión pendiente entre dos opciones).**

- **A. GitHub Actions** (CI separado del build de Railway). Workflow
  que corre en cada push a main: `npm ci && npm run test && npm run
  lint`. Si falla, el push se marca rojo pero **no bloquea** Railway por
  default — habría que conectar el branch protection o un check con
  Railway para que el deploy espere al CI verde. Más config, separa
  responsabilidades, no enlentece cada deploy.

- **B. Modificar el Dockerfile de Railway** para correr lint + tests
  antes del build. Algo como:
  ```dockerfile
  RUN npm ci --production=false
  RUN npm run lint
  RUN npm run test:unit  # los integration requieren DATABASE_URL_TEST
  RUN npm run build
  ```
  Más simple, todo en un lugar, falla naturalmente el deploy si el
  paso revienta. Trade-off: tests de integración necesitan
  `DATABASE_URL_TEST` accesible desde el build de Railway (variable de
  entorno separada). Y los integration son lentos (~120s) — cada
  deploy paga ese tiempo.

**Recomendación cuando se ataque.** Opción A para el camino largo
(escalable, deja Railway haciendo solo build/deploy). Opción B sirve
como medida tapón si se quiere algo rápido sin montar GitHub Actions.

**Conexión con otras deudas.**
- **Regla de lint de `UnmatchedStoreProduct`** (entrada anterior): no
  funciona sin este gate.
- **Migration history no reconstruye el schema de prod** (más abajo) —
  **PREREQUISITO YA RESUELTO el 2026-06-03** (commit `e1d7ef1`). Una DB
  de test efímera ahora se bootstrappea con `DROP SCHEMA + prisma migrate
  deploy` desde el repo en cualquier branch fresca de Neon. Eso desbloquea
  CI (tanto opción A como B). El script `scripts/db-test-reset.ts` del
  repo es la receta exacta que el pipeline puede reutilizar.

**Camino más corto post-rebaseline.** Antes de este cierre, opción A
(GitHub Actions) tenía como obstáculo que su DB efímera tenía que correr
`db push` desde `schema.prisma` (ocultando drift). Hoy: corre `prisma
migrate deploy` directo contra una branch nueva de Neon (o un Postgres
in-job), produce el schema real, y los tests de integración corren contra
eso. Sin trabajo adicional sobre la cadena de migraciones.

**Archivos afectados.**
- Si A: `.github/workflows/ci.yml` (nuevo).
- Si B: `Dockerfile`, `package.json` (scripts).
- En ambos: instalar ESLint + config base, agregar `npm run lint` script.

---

## `store.findFirst` sin orderBy + scoping cross-store sin tests

**Prioridad:** Atar a la decisión de arquitectura multicliente. Hoy
despreciable (clientes tienen 1 store en práctica). Sube a alta apenas se
soporte multi-store por usuario — antes de eso, NO es seguro.

**Síntoma inmediato (gap de cobertura).** Fix 1 del bug "62 stale en No
vinculados" (`app/api/my-store/sync/products/route.ts`) agregó una tercera
query al match con scoping `publications: { some: { storeId: store.id, sku: skuRaw } }`.
El `storeId` ahí es la línea que evita matchear pub de otra store del mismo
user. El test 2 de `tests/integration/unmatched-sync.test.ts` cubre el
scoping por USUARIO (no cruza user1↔user2). El scoping por STORE quedó
sin test específico (sería el "test 5"). Una regresión que rompiera ese
`storeId` pasaría el typecheck y los 4 tests actuales.

**Por qué no se agregó el test en el hot fix.** El route hace
`prisma.store.findFirst({ where: { userId } })` sin `orderBy`, sin filtro
por `platform`, sin filtro por `isActive`. Con dos stores válidas del
mismo user, qué store gana es no-determinista (Postgres sin ORDER BY no
garantiza orden). Probar el caso requiere refactor (extraer helper) o
setup forzado (deshabilitar una store) — fuera del scope de un hot fix.

**Problema de fondo (lo importante).** El gap de cobertura es solo el
síntoma. El problema real es que ese `findFirst` sin orden NI scoping
explícito es un **bug latente para multi-store**. Hoy es inocuo porque
los clientes tienen 1 store. Cuando un cliente conecte 2 (escenario
"Woo + Tienda Nube" de la visión multicliente, o staging de migración),
el sync podría correr contra la store equivocada de forma no determinista
— sin error visible, solo productos cruzados entre stores.

**Conexión con readiness multicliente.** Esto NO es un caso aislado.
Es parte de la deuda más amplia: el código está escrito asumiendo
"una store por user" en muchos lugares (también "un user activo" en otros
flujos). Antes de soportar multicliente real, hay que **auditar todos los
`findFirst`** sobre `store`, `user`, `provider`, etc. que asumen
unicidad. Cada uno necesita o:
- Recibir el id explícito en la request (front pasa storeId/etc.).
- Tener `orderBy` determinista (con criterio explícito de "primero").
- Tener scoping correcto (filtro adicional como `isActive: true` o
  `platform` requerido).

**Trigger para atacarla.**
- Decisión de soportar multi-store por usuario (Woo + otra plataforma).
- Cliente conecta una segunda store al mismo usuario aunque sea como
  prueba.
- Caso de cruce reportado entre stores.
- Cualquier refactor estructural del module de stores.

**Solución del gap de test del Fix 1 (cuando se haga).** Extraer la lógica
de match del route a un helper exportable:

```ts
export async function findCatalogProductForWooSku(
  prisma: PrismaClient,
  userId: string,
  storeId: string,
  skuRaw: string
): Promise<{ id: string; internalStatus: InternalPublicationStatus } | null>
```

Test directo con los 3 paths de match (publicationSku, cp.sku raw, pp.sku
canónico) + el scoping por store:
1. Match por publicationSku.
2. Match por cp.sku raw.
3. Match por pp.sku canónico (Fase 3+).
4. NO match cuando pp.sku canónico existe en OTRA store del mismo user.

**Solución del problema de fondo.** Auditoría de queries antes de
multi-store. Out of scope del Fix 1 y de su test gap — es trabajo de
arquitectura cuando llegue el momento.

**Archivos afectados (mínimo del test gap).**
`app/api/my-store/sync/products/route.ts` (extracción del helper),
`tests/integration/unmatched-sync.test.ts` (4 casos del helper).

**Archivos afectados (deuda de fondo).** A definir por la auditoría
multicliente; al menos `app/api/my-store/*` y todo lugar que use
`store.findFirst({ where: { userId } })` o `user.findFirst()`.

---

## Migration history no reconstruye el schema de prod (riesgo de continuidad) — RESUELTA

**Estado:** ✅ RESUELTA el 2026-06-03 (commit `e1d7ef1`). Solución D aplicada
end-to-end con verificación empírica.

**Validación realizada.**
- `prisma db pull` contra prod → drift único aislado a 6 FKs de EventLog
  (NoAction explícito vs default Prisma 5 SetNull).
- `schema.prisma` reconciliado: las 6 FKs ahora declaran NoAction explícito
  → drift cero contra prod (`migrate diff` → "empty migration").
- Baseline único generado en `prisma/migrations/20260603000000_baseline/`
  (749 líneas, 20 tablas + 17 enums + 66 índices + 35 FKs).
- 12 migraciones viejas archivadas en
  `prisma/migrations-archive/20260603-pre-rebaseline/` con README explicando
  motivo.
- Bootstrap end-to-end contra branch de Neon de test: DROP SCHEMA +
  `migrate deploy` desde cero aplicó el baseline. Verificación
  `migrate diff` del resultado vs `schema.prisma` → cero diferencias.
  Suite completa verde post-rebaseline: unit 3/3 + integration 15/15.
- `scripts/db-test-reset.ts` cambió de `db push --force-reset` a
  `DROP SCHEMA + migrate deploy`. Branch test ahora usa el mismo path
  que prod.
- En prod: `prisma migrate resolve --applied 20260603000000_baseline`
  (no-DDL, solo INSERT 1 fila). Estado verificado: 13 filas en
  `_prisma_migrations` todas APPLIED, las 12 viejas con checksums
  intactos vs dump pre-resolve.
- Deploy de prod del commit del rebaseline (`e1d7ef1`) verificado:
  `prisma migrate deploy` reportó "1 migration found in prisma/migrations" +
  "No pending migrations to apply" (las 12 orphans en `_prisma_migrations`
  son ignoradas como esperado). App y worker arrancaron normalmente,
  consistency check limpio.

**Redes que se mantienen disponibles como cierre.**
- Dump de `_prisma_migrations` pre-resolve: `backups/prisma-migrations-pre-rebaseline-2026-06-03T04-08-13.json`
  (gitignored, local). Permite reconstruir el estado original si llegara
  a hacer falta.
- Branch backup de Neon "backup-pre-rebaseline-20260603" (parent
  production). Red nuclear.

**Pendiente como higiene menor (NO bloqueante).** Las 12 orphans en
`_prisma_migrations` de prod siguen siendo `APPLIED` aunque no existen en
el repo. Prisma las ignora (verificado empíricamente), no afectan
funcionalidad. Cleanup pendiente para cuando se quiera limpieza
cosmética: DELETE directo o `migrate resolve --rolled-back` (este último
FALLA porque las orphans están APPLIED, no FAILED — así que el cleanup
es DELETE directo sobre `_prisma_migrations`).

**Impacto del cierre en otras deudas.**
- Habilita el gate de CI/build (entrada anterior): la DB ahora se
  bootstrappea desde migraciones, así que CI puede montar una DB efímera
  con `migrate deploy`.
- Habilita Fase 5 (eliminar `cp.publicationSku`): cualquier migración
  nueva ahora se genera contra un schema que el repo reproduce sin drift.

---

**Contenido histórico (pre-resolución, para registro):**

**Prioridad original:** Alta — atacar ANTES de montar CI, ANTES de Fase 5
(que toca schema), o ante cualquier necesidad de un entorno nuevo
(staging, disaster recovery, onboarding). NO es una deuda menor: era un
riesgo de continuidad del negocio.

**Contexto y origen.** Descubierta durante el setup de testing (sprint P0
de tests). Al intentar `prisma migrate deploy` contra una branch limpia de
Neon, falla en la migración 2 (`add_extraction_job_source`) con
"relation 'ProductChange' does not exist". Investigación: el init
(`20260508025918`) solo crea 6 tablas (User, Provider,
ProviderScraperConfig, ExtractionJob, ExtractedProduct, ExtractionLog) y 2
enums (JobStatus, LogLevel). Las 11 migraciones posteriores son casi
todas `ALTER TABLE` que asumen ~15 tablas más sin que ninguna las cree:
CatalogProduct, ProductPublication, ProductChange, ExtractionComparison,
UnmatchedStoreProduct, Store, StoreIntegration, PricingRule,
CatalogProductImage, CategoryAssignment, entre otras. Casi todos los
enums tampoco están: ProductChangeType, ChangeReviewStatus,
PublicationStatus, PublicationSyncStatus, InternalPublicationStatus,
CatalogProductStatus, StockSource, CatalogSourceType, StorePlatform,
PricingScope, etc.

**Hipótesis confirmada por evidencia.** El proyecto se construyó
originalmente con `prisma db push` masivo (sin migraciones formales). En
algún momento se empezó a usar `prisma migrate dev` para cambios
incrementales, pero el init quedó como un esqueleto histórico que nunca
representó el schema real. Hoy las migraciones funcionan en prod **solo
porque prod ya tiene las tablas que faltan**, no porque las generen.

**Impacto / riesgo (NO cosmético).**
- **Continuidad de negocio.** Si prod se cae y hay que recrear desde
  backups + migraciones, el schema no es reproducible: el código asume
  tablas que ninguna migración crea. La única fuente del schema real es
  la propia DB de prod.
- **Imposible CI con DB efímera.** Cualquier pipeline de CI que monte una
  DB limpia y aplique migraciones falla. El sprint actual lo bypassea
  con `db push` desde `schema.prisma` (ver `scripts/db-test-reset.ts`),
  pero eso oculta drift y no aplica a CI sin trabajo extra.
- **Imposible staging / disaster recovery / onboarding.** Cualquier
  entorno nuevo que necesite el schema desde migraciones no se puede
  bootstrappear.
- **Fase 5 (eliminar `cp.publicationSku`) tiene riesgo aumentado.** La
  migración nueva se va a generar contra el estado actual, pero hay
  drift potencial entre `schema.prisma` y prod (ver hallazgo paralelo
  abajo). Si `schema.prisma` divergió de prod, una migración nueva podría
  generar SQL inválido.

**Bypass actual.** `scripts/db-test-reset.ts` usa `prisma db push
--force-reset --skip-generate`, que aplica `schema.prisma` directo sin
pasar por el historial de migraciones. Es suficiente para el sprint de
tests porque el código importa el Prisma Client generado de
`schema.prisma`, así que testear contra ese schema es testear contra el
schema que el código asume. La deuda con CI y con prod sigue abierta.

**Solución recomendada: D (rebaseline desde prod real).**

1. **`prisma db pull`** contra la DATABASE_URL de prod → introspección
   directa del schema actual de prod.
2. **Comparar** el resultado contra `schema.prisma` actual del repo. Si
   divergen, es un segundo hallazgo: el código asume un schema distinto
   al que prod tiene. **Esta comparación es obligatoria como parte de la
   solución** — no atacarla cuando se encare D sería volver a tener
   drift no detectado.
3. **Reconciliar** `schema.prisma` con la realidad de prod
   (probablemente algunas inconsistencias menores: índices, constraints,
   defaults). Decidir caso por caso qué lado tiene razón.
4. **Generar nueva migración baseline** con
   `prisma migrate diff --from-empty --to-schema-datasource <prod-url>
   --script > prisma/migrations/<timestamp>_baseline/migration.sql`. Esto
   produce el SQL exacto que va de "DB vacía" a "schema de prod real".
5. **Archivar las migraciones viejas** (mover a
   `prisma/migrations-archive/` o eliminar). Documentar en
   `prisma/migrations/README.md` que el baseline reemplaza a las
   anteriores.
6. **En prod**: `prisma migrate resolve --applied <nuevo-baseline>`. Esto
   marca el baseline como aplicado sin re-ejecutar el DDL — prod sigue
   intacto pero su `_prisma_migrations` ahora refleja el baseline en vez
   del historial roto.

**Por qué D sobre C (rebaseline desde `schema.prisma`).** D parte del
schema **real** de prod (vía introspección), no de `schema.prisma`. El
drift descubierto en este sprint sugiere que `schema.prisma` puede haber
divergido de prod en algún punto; partir de prod garantiza que el baseline
refleje la verdad operativa, no la "verdad declarada" que podría tener
bugs.

**Riesgo de D.** El paso 6 toca prod (el `migrate resolve`). Es no-DDL
(solo inserta una fila en `_prisma_migrations`) y no tiene efecto sobre
las tablas, pero hay que hacerlo con backup tomado, en su propio
momento, NO en mitad de un sprint. El resto de los pasos son sobre el
repo y se pueden hacer en cualquier momento sin tocar prod.

**Archivos afectados.** `prisma/migrations/*` (todas), `schema.prisma`
(potencialmente, según hallazgos de la comparación), `scripts/db-test-reset.ts`
(volver a `migrate deploy` cuando la cadena esté sana).

---

## Importador de Excel: "PRECIO WEB" se mapea a `finalPrice` sin warning

**Prioridad:** Media-alta. La próxima vez que el cliente reimporte un Excel
con la columna "PRECIO WEB", repite el incidente — 385 finalPrice fantasma
silenciosos.

**Contexto y origen.** El 15/05/2026 el cliente subió un Excel para corregir
SKU comerciales de IMPOTEKNO. El archivo incluía una columna "PRECIO WEB" con
el cálculo del precio actual de cada producto. `lib/catalog/import-aliases.ts`
mapea "PRECIO WEB" (entre otros: "Precio final", "PRECIO FINAL", "Precio
venta", "PRECIO VENTA") al campo `finalPrice` del CatalogProduct.
`scripts/import-store-excel.ts:258-260` aplica el override sin advertencia:

```ts
if (finalPrice != null) {
  updateData.finalPrice = finalPrice;
  report.pricesApplied++;
}
```

`finalPrice` es un **override** que pisa la regla de pricing automática. Una
vez seteado, el motor (`resolvePricing`) devuelve `effectivePrice = finalPrice`
sin recalcular desde wholesale × margen. Resultado: 385 productos quedaron
con precio "congelado" en la foto del 15/05; cualquier cambio futuro de
wholesale del proveedor no se reflejó en la tienda, hasta que se descubrió
el 2026-06-03 y se limpió.

**Impacto / riesgo.**
- **Drift silencioso de precios.** El cliente no ve ningún warning durante
  o post-import. El report dice "385 prices applied" como si fuera una
  acción intencional, no un override sticky.
- **Reincidencia esperable.** Cualquier Excel del proveedor que traiga
  "PRECIO WEB" o cualquiera de los aliases (Precio final/PRECIO FINAL/
  Precio venta/PRECIO VENTA/finalPrice) va a disparar lo mismo. Es muy
  probable que los proveedores manden Excels con esa columna como
  información comercial, no como instrucción de override.
- **Limpieza es costosa.** El backfill del 2026-06-03 requirió: diagnóstico
  forense de 4h para confirmar origen, dump JSON de respaldo, UPDATE masivo
  en transacción con verificación, y backfill de drift posterior. No es
  algo que escale a "lo arreglamos cuando pase".

**Trigger para atacarla.**
- Cualquier indicio de que el cliente vaya a reimportar un Excel del mismo
  proveedor o de otro con columnas similares.
- Onboarding de un nuevo proveedor que mande catálogo Excel — alta
  probabilidad de columnas "Precio venta" o similares.
- Más de un caso de soporte donde "los precios de Woo no se actualizan
  después del extract".

**Solución cuando importe.** Tres niveles, elegir según appetite:

1. **Warning explícito en el report del importador** (mínimo). Sumar al
   `report` una sección "finalPriceOverridesApplied: { sku, value }[]"
   distinta de `pricesApplied`, mostrarla en la UI con texto claro tipo
   "Estos N productos quedarán con precio fijo. La regla automática del
   proveedor NO se aplicará mientras tengan finalPrice seteado. ¿Confirmás?".
   Requiere paso de confirmación adicional en el flujo.

2. **Sacar los aliases ambiguos** ("PRECIO WEB", "Precio venta", "PRECIO
   VENTA"). Mantener solo "finalPrice" y "Precio final"/"PRECIO FINAL" como
   alias del override real. Los otros son terminología de catálogo
   comercial, no de override. Cambio en `lib/catalog/import-aliases.ts:65-72`.

3. **Modo importación explícito**. Que el upload pida elegir entre
   "Importar catálogo (sin tocar precios)" y "Importar con override de
   precios". Default debería ser el primero. El segundo dispara los
   warnings del nivel 1.

Recomendación: combinar 1 + 2. El nivel 3 es más invasivo y rompe UX para
casos legítimos.

**Archivos afectados.** `lib/catalog/import-aliases.ts`,
`scripts/import-store-excel.ts:258-260`, `app/api/catalog/import/route.ts`
(si el flujo de UI vive ahí), componente del importador en
`components/catalog/*`. Tests para los nuevos warnings.

**Backup del incidente.** `backups/finalprices-cleanup-pre-2026-06-03T20-45-55-741Z.json`
guarda los 385 valores originales con `{id, finalPrice, wholesalePrice,
sourceType, providerName, sku, supplierName}`. Mantenerlo vivo unos días
post-cleanup por si hay que revertir algún finalPrice puntual; luego archivar.

---

## Endpoints de edición de título/descripción no llaman a `markPublicationsDrift`

**Prioridad:** Media. Gap conocido tras el backfill del 2026-06-03 que dejó
3 publications en estado `user-edited` sin marcar.

**Contexto y origen.** Durante el backfill de drift histórico se detectaron
3 pp con `commercialTitleUserEdited=true` o `commercialDescriptionUserEdited=true`
pero `syncStatus=SYNCED` y `pendingSync=false`. Si el usuario editó esos
campos, la pp debería haber quedado marcada como OUTDATED + pendingSync — pero
no lo está. Indica que el(los) endpoint(s) que setearon los flags
`commercial*UserEdited=true` no llamaron a `markPublicationsDrift` después.

`findDriftingPublications` marca como "user-edited" cualquier pp con esos
flags porque no hay snapshot remoto de título/descripción para comparar
(`mark-publications-drift.ts:123-136`). Es marca defensiva: si los flags
están, asumimos drift.

**Impacto / riesgo.** Cosmético hoy (3 pp), pero indica que cualquier futura
edición de título/descripción que pase por el mismo endpoint queda con el
mismo gap. El cliente edita el título en la UI, ve "guardado", pero la
pp no aparece en la cola de pendientes y Woo nunca recibe el cambio. Lo
descubre cuando compara su tienda con el catálogo y nota que "esto no se
actualizó".

**Trigger para atacarla.**
- Caso de soporte donde "edité el título y no aparece en la tienda".
- Cualquier refactor de los endpoints de edición de pp.
- Auditoría del wrapper `markPublicationsDrift` para verificar que TODOS
  los call sites de mutación visible-en-Woo lo invocan.

**Solución cuando importe.**
1. Identificar el/los endpoint(s) que setean `commercialTitleUserEdited` o
   `commercialDescriptionUserEdited`. Candidatos: `app/api/catalog/publications/[id]/*`,
   posiblemente bulk-update o drawer de edición.
2. En cada call site que mute esos flags, llamar a `markPublicationsDrift`
   con el `catalogProductId` correspondiente — misma función que ya
   importa `upsertCatalogProducts` post-Fix 1.
3. Test de integración por endpoint que verifique que tras la edición la
   pp queda `pendingSync=true + syncStatus=OUTDATED`.
4. Bonus: limpiar los 3 user-edited residuales del backfill del
   2026-06-03 con un script puntual que solo los marque a ellos. No urgente.

**Archivos afectados (a investigar).** `app/api/catalog/publications/[id]/*`,
componentes del drawer de edición de publicaciones. Suite
`tests/integration/` para casos por endpoint.

---

## Publications LACHIPELU sin wholesale ni finalPrice (no-price-calculable)

**Prioridad:** Baja — bloqueada por acción del cliente. 16 pp en estado
"no-price-calculable" detectadas por el backfill del 2026-06-03; NO se
marcaron porque `publishProductToWoo` abortaría con "Sin precio calculado".

**Contexto.** 16 catalog products de LACHIPELU - Vanesa tienen
`wholesalePrice=null` Y `finalPrice=null`. Sin ninguno de los dos,
`resolvePricing` no puede generar un precio. Las pp están publicadas y
ACTIVE en Woo con un `priceInStore` viejo, pero no hay forma de calcular
un precio efectivo nuevo para sincronizar.

SKUs afectados: LA98, LA75, LA92, LA91, LA60, LA50, LA35, LA39, LA72,
LA63, y 6 más (lista completa en log del backfill 2026-06-03 21:56:32).

**Impacto / riesgo.** Bloqueante para sincronizar esas 16 pp con Woo.
Como el sync abortaría con error "Sin precio calculado", marcarlas como
OUTDATED solo ensucia la cola — el cliente las vería como pendientes
pero ningún sync las podría procesar.

**Trigger para atacarla.** El cliente debe cargar wholesale o finalPrice
en cada uno (manualmente o vía extracción del proveedor si LACHIPELU tiene
scraper configurado). Una vez con precio, automáticamente entran a la
cola de drift cuando el wholesale del proveedor cambie.

**Solución.** Tarea del cliente, no de ingeniería. Posible mejora UX:
mostrar en el dashboard un widget "Productos sin precio configurable" con
la lista, link directo al editor de cada uno. No urgente con 16
productos; sí relevante si el número crece.

**Archivos afectados.** Ninguno desde el backend hasta que se decida el
widget de UI; en ese caso, `app/(app)/dashboard/page.tsx` + helper de
query reusable.

---

## Auto-push de precios con guardrails (Nivel 2)

**Prioridad:** Sprint futuro — feature pedida por el cliente, no es
deuda técnica per se. Acá para no perderla del roadmap.

**Contexto.** Hoy el flujo es: worker extrae → cp cambia → pp queda
OUTDATED + pendingSync → cliente entra a "Sincronizar pendientes" y
manualmente decide qué empujar. Funciona bien para revisar cambios
sensibles (los 12 que SUBEN del backfill 2026-06-03 son ejemplo: cliente
debería mirarlos antes), pero es trabajo manual recurrente para los 248
que BAJAN o son drift técnico de $1.

El cliente pidió un Nivel 2: que el sistema auto-pushee a Woo los cambios
de precio bajo condiciones seguras, sin intervención manual.

**Guardrails mínimos (sin estos NO se implementa).**
1. **Variación máxima por sync individual.** Threshold configurable (sugerido
   ±10% o ±$X). Sobre el threshold, queda en cola manual como hoy. El
   cliente revisa.
2. **Anomalías a revisión manual.** wholesale=null, finalPrice=null,
   priceInStore=null, regla sin margen calculable → NO push automático.
   Esos zombies van a cola para que el cliente entienda.
3. **Nunca push de $0 o null.** Salvaguarda dura: si effectivePrice
   resuelve a 0 o null, abortar sin tocar Woo. Esto ya existe en
   `publishProductToWoo` ("Sin precio calculado") pero conviene
   reafirmarlo en la capa de auto-push como segunda barrera.
4. **Rate limiting / batching.** No empujar 260 productos a Woo de golpe.
   Batch configurable (sugerido 20-50 por minuto) para no saturar la API
   ni dar la sensación de "todo cambió de repente" si el cliente está
   mirando la tienda.
   - **Dato medido (D1, 2026-06):** la DETECCIÓN de drift `markPublicationsDrift`
     sobre ~900 publicaciones tarda ≈2754ms (sincrónica, sin tocar Woo). Es la
     marca, no el push. Señal de volumen: si crece bastante, el batching/job de
     sync —y eventualmente la propia detección— sube de prioridad.
5. **Reporte vía EventLog.** Cada auto-push emite un evento
   `WOO_AUTO_PUSH_SUCCESS` o `WOO_AUTO_PUSH_SKIPPED_<reason>` con el
   delta de precio y guardrail aplicado. El cliente puede revisar el
   activity log y entender qué se movió sin él.
6. **Modo opt-in por proveedor.** No habilitar global. Que el cliente
   active auto-push provider por provider. Empezar por uno (probablemente
   BAZAR 380 o IMPOTEKNO donde los movimientos son predecibles), evaluar,
   expandir.

**Trigger para atacarla.** Cuando el cliente confirme que el flujo manual
post-backfill del 2026-06-03 le funciona y quiera dar el siguiente paso.
NO antes — el auto-push sin haber validado el flujo manual primero es
riesgoso (ejemplo: si Fix 1 tuviera un bug latente que mete precios
incorrectos en la cola, el auto-push los empujaría sin filtro humano).

**Solución cuando importe.** Diseño concreto pendiente. Componentes
probables: worker job nuevo (`auto-push-pending.ts`) que corre cada N
minutos, leyendo `productPublication` con `pendingSync=true` +
`syncStatus=OUTDATED`, aplicando los guardrails 1-4, y llamando
`publishProductToWoo` con `dryRun=false`. Settings nuevas por
`Provider.autoPushEnabled` y `User.autoPushMaxPercent` /
`autoPushMaxAmountAbs`.

**Archivos afectados (estimación).** Worker (nuevo job),
`schema.prisma` (campos de config), `lib/integrations/woocommerce/*`
(integrar con el publish existente), UI para configurar guardrails por
proveedor en `app/(app)/providers/*`.

---

## Agujero de trazabilidad en `CatalogProductImage`

**Prioridad:** Media — no bloqueante, pero descubierta justo antes de meter
R2 (object storage), donde la falta de trazabilidad escala mal: cada archivo
en R2 va a ser pago, y sin origen claro no se puede auditar/limpiar con
confianza.

**Contexto y origen.** Descubierto durante el diseño del Sprint 1A
(`docs/sprint-1a-image-source-model.md`) al pedir "demostrar el origen real
de las 832 USER images antes de migrar". El schema actual de
`CatalogProductImage` tiene `{id, catalogProductId, url, position,
isPrimary, source, altText, createdAt}` y nada más:

- Sin `importBatchId` ni equivalente que diga qué proceso/importación creó
  la fila.
- Sin `sourceNote` ni metadata libre.
- Sin `verifiedAt` que documente "esta URL fue confirmada empíricamente
  contra la tienda externa el día X".
- `EventLog` no registra creación/modificación de imágenes (búsqueda
  `type ILIKE '%image%'` → cero filas históricas).

**Impacto / riesgo.**

- **Auditoría imposible.** Si aparece una imagen incorrecta (URL muerta,
  apunta al producto equivocado, no es la imagen activa en Woo), no se
  puede rastrear qué proceso la insertó. Se diagnostica por patrón temporal
  (clustering de `createdAt`) y por inferencia de los call sites del código
  — exactamente la situación de las 832 USER images de hoy: el diag del 1A
  pudo identificar el LUGAR donde viven los archivos (Media Library de
  WordPress de `electrofays.com`) pero NO pudo demostrar qué proceso de
  PricEcom las insertó.
- **Pre-R2 es el momento de discutirlo.** Cuando se introduzca object
  storage (R2), cada imagen tendrá un costo y una vida útil. Sin
  trazabilidad de procedencia: no se puede limpiar selectivamente
  (¿borrar las del Excel 16/05 si el cliente abandonó esos productos?
  ¿retener las del sync verificado?). El agujero pre-existente se amplifica.
- **Estrategia conservadora del 1A (`STORE` solo poblado desde sync
  verificado, fila por fila) atenúa el problema hacia adelante**: cada
  fila futura `STORE` viene con un acoplamiento empírico documentable. Las
  832 USER existentes siguen sin trazabilidad.

**Trigger para atacarla.**

- Antes de meter R2 o cualquier flujo que asuma "sé de dónde vino esta
  imagen para decidir qué hacer con ella" (cleanup automático, retención,
  cross-storage migration, etc.).
- Sprint 4 (sync verificado de Woo) o 6 (consolidación de modelos), donde
  el modelo de imágenes pasa a ser load-bearing y la opacidad del origen
  bloquea decisiones.
- Caso real de imagen incorrecta sin forma de rastrearla.

**Solución candidata (decidir según appetite cuando se ataque).** Varios
caminos posibles, no exclusivos:

1. **Campos nuevos en `CatalogProductImage`** (cambio de schema mínimo,
   alta compatibilidad):
   - `imageOrigin: ImageOrigin?` enum opcional con valores
     `SCRAPER | IMPORT | MANUAL_UPLOAD | SYNC_FROM_STORE | SCRIPT_<name>`,
     etc. Distinto de `source` (que es el contrato de etiqueta), describe
     el PROCESO de creación.
   - `imageOriginRef: String?` para el id externo del proceso (job id,
     importBatch id, sync run id, script-run timestamp).
   - `verifiedAt: DateTime?` y `verifiedSource: String?` para registrar
     verificación empírica contra la tienda (popular cuando `source` pasa
     a `STORE`).
   - `createdByUserId: String?` cuando aplicable.

2. **Tabla de auditoría dedicada** (`CatalogProductImageAudit`): una fila
   por evento de creación/modificación, con `imageId, action, processName,
   actorId, createdAt, metadata Json`. Cero impacto en el modelo de
   imágenes pero introduce una tabla nueva. Útil si se quiere rastrear
   también ediciones y borrados, no solo creación.

3. **Emitir `EventLog` desde los call sites de creación** (sin cambio de
   schema). Mínimo esfuerzo: agregar `logInfo({type: 'IMAGE_CREATED', ...})`
   en los ~6 lugares donde se crea `CatalogProductImage`. Cubre creaciones
   futuras pero no resuelve las 832 históricas (que se quedan sin rastro
   en cualquier caso).

**Recomendación cuando se ataque.** Combinar 1 + 3: schema con
`imageOrigin` + `verifiedAt`, y emisión paralela de `EventLog` para
auditoría temporal. La tabla de auditoría dedicada (opción 2) queda como
escalación si la cardinalidad de eventos hace ruido en `EventLog`.

**Lo que NO sirve.** Inferir origen retroactivo por dominio o estructura
de URL para las 832 históricas. Mismo argumento del Sprint 1A §5: convierte
inferencia en verdad de negocio y enmascara el agujero como resuelto.

**Archivos afectados (estimación).** `schema.prisma`,
`prisma/migrations/<futura>_add_image_origin/`, los ~6 call sites que
crean `CatalogProductImage` (ver `docs/sprint-1a-image-source-model.md`
para la lista), `lib/events/event-log.ts` si se agregan tipos nuevos.

---

## Divergencia intención ↔ Woo en publicaciones IGNORED

**Prioridad:** Media — no bloqueante hoy (afecta a 2 publicaciones), pero
puede crecer y confundir al usuario: el dashboard dice "Ignorados: 18" y
él asume que ninguno se vende, cuando en realidad 2 siguen activos en
WooCommerce.

**Contexto y origen.** Surge al rediseñar los KPIs de Mi Tienda para que
cuenten por `cp.internalStatus` (decisión del usuario) en vez de
`pp.status` (estado en la tienda externa). El diag empírico encontró 2
publicaciones con `cp.internalStatus = IGNORED` pero `pp.status = ACTIVE`
en la store ELECTROFAYS. Es decir: el usuario decidió no comerciar esos
productos, pero alguien los reactivó en Woo y siguen vendibles. Caso
ancla: TP-658 (DURAVIT TORRE MINI) — el mismo del Sprint 1A.

**Mecánica subyacente.** `mapInternalStatus()` en
`app/api/my-store/sync/products/route.ts` PROTEGE `cp.internalStatus =
IGNORED|PAUSED` durante el pull (no los pisa con PUBLISHED). Pero
`pp.status` se reescribe sin guard según lo que Woo reporta: si Woo dice
`publish`, queda `pp.status = ACTIVE`. Así, la intención (`cp.internalStatus`)
y la realidad operativa (`pp.status`) divergen cuando alguien reactiva en
Woo un producto previamente ignorado en PricEcom.

**Impacto / riesgo.**
- **Confusión del KPI**: "Ignorados: N" sugiere que N productos NO se
  venden. Mientras hayan IGNORED con `pp.status = ACTIVE`, esa lectura es
  falsa para esos N.
- **Hoy son 2** en ELECTROFAYS. Si la cantidad crece (cliente abre más
  stores, agrega operadores en Woo, integra con un canal que republica
  silenciosamente), la divergencia se vuelve material.
- **Riesgo de venta indeseada**: el cliente decide IGNORED por razones
  comerciales (margen negativo, problema con proveedor, producto
  descatalogado). Si Woo sigue vendiéndolo, se concretan ventas que el
  cliente no quería.

**Trigger para atacarla.**
- N > 5 IGNORED con `pp.status = ACTIVE`, o cualquier caso reportado por
  el cliente.
- Apertura de multi-store o multi-operador (probabilidad de divergencia
  aumenta con más actores tocando Woo).
- Refactor del dashboard que profundice los KPIs.

**Solución cuando importe.** Exponer la divergencia en la UI, NO
resolverla con un guard que pise Woo automáticamente (violaría el
principio "Woo es source of truth para estado activo"; el sync debe
poder reflejar el estado real). Ideas concretas no exclusivas:
1. Sub-KPI o badge: "Ignorados: 18 (**2 activos en Woo — revisar**)".
2. Filtro dedicado en la tabla "IGNORED con pp.status=ACTIVE" para
   que el usuario los vea de un vistazo y decida (reactivar
   internalStatus a PUBLISHED, o pausar en Woo).
3. EventLog automático cuando el sync detecte un IGNORED que pasa a
   `pp.status = ACTIVE` (no hoy — el sync ya emite eventos de cambio
   pero no marca esta divergencia específica).
4. Reverso del razonamiento: agregar un guard opcional al sync que
   FORCE pause en Woo cuando detecta IGNORED + Woo dice publish — solo
   activable explícitamente por el usuario, nunca por default.

**Archivos afectados (estimación).** `app/(app)/my-store/page.tsx` (KPI
con sub-conteo), `components/my-store/my-store-dashboard.tsx` (badge UI),
`components/my-store/publications-table.tsx` + `app/api/my-store/publications/route.ts`
(filtro nuevo), opcionalmente `app/api/my-store/sync/products/route.ts`
(emisión del evento de divergencia).

---

## Solapamiento "Sin stock" ↔ "Pausados (manual)" en caso de borde — RESUELTA

**Estado:** ✅ RESUELTA al reusar `visualStatusToWhere` de
`lib/catalog/list-filters.ts` en los KPIs de Mi Tienda. Una sola fuente
de verdad para la jerarquía visual
(`OUTDATED > SIN_STOCK > PAUSED > PUBLISHED > PREPARED > NOT_PUBLISHED > IGNORED`)
compartida entre Catálogo y Mi Tienda. Verificación empírica contra
prod: la suma de los 7 baldes cierra EXACTO al total de publicaciones
de la store (1427 = 1427), cero solapamiento residual.

**Cierre activado por.** Detección de un caso análogo en otro KPI:
SV-628 (PREPARED + supplierStatus=SUPPLIER_REMOVED) doble-contado en
"Preparados" y "Sin stock" del KPI Mi Tienda, mientras el Catálogo
(que sí aplica la jerarquía) lo mostraba solo en "Sin stock". Daniel
decidió alinear ambos sitios reusando `visualStatusToWhere` en vez de
duplicar la lógica.

**Cambios.**
- `lib/catalog/list-filters.ts`: agregar `export` a `visualStatusToWhere`
  (cero cambios de lógica; solo visibilidad).
- `app/(app)/my-store/page.tsx`: reemplazar los WHERE literales por
  `visualStatusToWhere("PUBLISHED" | "PAUSED" | "IGNORED" | "PREPARED")`.
  Para "Pausados" se combina con `pausedBySystem=false` para preservar
  la semántica "pausa manual real" (decisión original del lote anterior).

**Resultado en prod.** El SV-628 pasó de contarse como Preparado (1) +
Sin stock (1) a contarse solo como Sin stock (1). La suma de los baldes
cierra exacto al total de publicaciones, sin doble conteo en ninguna
combinación de baldes.

---

**Contenido histórico (pre-resolución, para registro):**

**Prioridad original:** Baja — cosmético, no es bug. La suma de KPIs no
cierra exactamente al total de publicaciones (1417 sumadas vs 1416
reales) por un solo caso de borde.

**Contexto y origen.** Tras el rediseño de KPIs de Mi Tienda, dos baldes
miden dimensiones distintas que pueden coincidir en una misma publicación:
- "Sin stock" cuenta por `cp.supplierStatus = SUPPLIER_REMOVED` (475).
- "Pausados" cuenta por `cp.internalStatus = PAUSED + pausedBySystem = false`
  (1, la pausa manual real).

El producto que está pausado manualmente por el usuario, además de tener
su proveedor dado de baja, cae en AMBOS KPIs. Es 1 cp en prod hoy
(ELECTROFAYS): el usuario lo pausó manualmente y casualmente el proveedor
también lo removió.

**Impacto / riesgo.** Visual: la suma de los KPIs `919 + 475 + 1 + 18 + 4
= 1417` versus el total `1416` da una unidad de más. Ambas etiquetas son
ciertas para esa publicación — ni "Sin stock" ni "Pausados (manual)" la
cuentan mal. El problema es que las dimensiones (intención del usuario
vs estado del proveedor) son ortogonales por diseño, no excluyentes.

**Trigger para atacarla.**
- Cliente pregunta "¿por qué los KPIs no suman al total?".
- Decisión de mostrar la suma como dato verificable en la UI (hoy no se
  muestra).
- Rediseño futuro que quiera categorías mutuamente excluyentes.

**Solución cuando importe.** Si se quiere que los baldes sumen exacto al
total, decidir una jerarquía de etiqueta para el caso de borde. Tres
opciones razonables:
1. **"Sin stock" gana**: el producto se cuenta solo ahí (es la
   restricción operativa más fuerte). "Pausados" excluye los que además
   tienen `supplierStatus = SUPPLIER_REMOVED`.
2. **"Pausados (manual)" gana**: la decisión humana se prioriza sobre la
   condición operativa. "Sin stock" excluye los que además tienen
   `internalStatus = PAUSED + pausedBySystem = false`.
3. **Dejarlo como está + nota explicativa**: las dimensiones son
   ortogonales y conceptualmente correctas; agregar tooltip en los KPIs
   explicando que pueden solapar.

Recomendación inicial: opción 3 (no agrupar artificialmente algo que es
ortogonal). Las opciones 1 o 2 son válidas si el cliente prefiere baldes
mutuamente excluyentes.

**Archivos afectados (estimación).** Solo `app/(app)/my-store/page.tsx`
(query) y `components/my-store/my-store-dashboard.tsx` (tooltip si se
elige opción 3). Cero impacto fuera del dashboard.

---
