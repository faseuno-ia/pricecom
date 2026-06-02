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

## Migration history no reconstruye el schema de prod (riesgo de continuidad)

**Prioridad:** Alta — atacar ANTES de montar CI, ANTES de Fase 5 (que toca
schema), o ante cualquier necesidad de un entorno nuevo (staging, disaster
recovery, onboarding). Lo que pase primero. NO es una deuda menor: es un
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
