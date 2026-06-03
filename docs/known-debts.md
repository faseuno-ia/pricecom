# Known debts

Deudas técnicas reconocidas en producción. Documento vivo: cada deuda nueva
que se decide postergar entra acá con el mismo formato. Cada entrada incluye
prioridad declarada (despreciable-por-ahora vs. hardening del próximo ciclo),
contexto y origen, impacto actual, trigger que la activa como prioritaria, y
solución concreta cuando se decida atacarla.

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
