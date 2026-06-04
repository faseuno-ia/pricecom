# Sprint 1A — Image Source Model

**Estado:** diseño + branch listo para revisión. Cero ejecución contra prod.
NO mergeado a `main` (el merge es Sprint 1B).

**Branch:** `sprint-1a-image-source`.

**Resumen del entregable:**

- `prisma/schema.prisma` — agrega `STORE` al enum `ImageSource` con comentario
  de contrato.
- `prisma/migrations/20260604000000_add_store_to_imagesource/migration.sql` —
  migración hand-written, `ALTER TYPE ... ADD VALUE 'STORE'`, una sola línea.
- Cero `UPDATE`. Cero reclasificación de las 832 filas existentes.
- Este documento.
- Entrada de deuda en `docs/known-debts.md` ("Agujero de trazabilidad en
  CatalogProductImage").

---

## 1. Baseline congelado

Counts frescos contra prod (`ep-raspy-cloud-ap9iuixg`), día 2026-06-03,
posterior a la limpieza de finalPrice de los 385 + los 6 de IMPOTEKNO:

```
Total CatalogProductImage:    832
  source = USER:              832   (100%)
  source = SUPPLIER:            0
  source = GENERATED:           0
```

Solo `USER` está poblada. `SUPPLIER` y `GENERATED` existen en el enum pero
nunca se usaron en producción.

### Cierre de los cuatro números del diag (832 / 822 / 813 / 812)

| # | Significado | Valor | Verificado |
|---|---|---|---|
| 832 | Total `CatalogProductImage source=USER` | 832 | ✓ |
| 813 + 19 | USER por `cp.sourceType`: 813 SCRAPED + 19 IMPORTED | = 832 | ✓ |
| 822 | Imágenes USER cuyo `cp` tiene al menos una `pp.externalProductId NOT NULL` | 832 − 10 | ✓ |
| 812 | `cps` SCRAPED con USER image **y** `pp.externalProductId NOT NULL` | 812 | ✓ |

**Las 10 imágenes USER sin `pp.externalProductId` se descomponen:**

- **1 SCRAPED** → la excepción TP-658 (DURAVIT TORRE MINI), §8.
- **9 IMPORTED** → 9 productos cargados por Excel el 2026-05-16 23h que
  **nunca llegaron a publicarse a Woo**. Tienen `cp.importBatchId` pero
  ninguna `pp.externalProductId`. Caso conocido a tratar como tarea aparte
  (sin acción en 1A; sus imágenes USER se quedan USER).

### Distribución temporal (DATO, no inferencia)

```
2026-05-16 05h:  409 imágenes USER  ← batch one-off
2026-05-16 23h:   19 imágenes USER  ← Excel (importBatchId set, 19 IMPORTED)
2026-05-18 03h:  404 imágenes USER  ← batch one-off
```

Cero imágenes USER fuera de esos tres clusters. Cero `EventLog` que registre
la creación de imágenes (búsqueda `type ILIKE '%image%'` → ninguno).

### Estructura de URL (DATO estructural, no dominio inferido)

832/832 URLs matchean `^https?://electrofays\.com/wp-content/uploads/YYYY/MM/<filename>`.
Esto es la convención física de la **WordPress Media Library** del cliente.
El path estructural demuestra que los archivos **viven en el storage de
WordPress de electrofays.com**, no en PricEcom. **No demuestra** qué proceso
escribió la fila en `CatalogProductImage`.

El `<filename>` es el SKU comercial del producto (`TP-640253.jpg`,
`JOR669N.png`, `B380-49008.jpg`), no el `wooId`: query empírica confirma
que `0 de 822` URLs contienen el `pp.externalProductId` en el path.

---

## 2. Enum + migración

### Cambio en `schema.prisma`

```prisma
enum ImageSource {
  SUPPLIER
  USER
  STORE        // ← nuevo en 1A
  GENERATED
}
```

Con bloque de comentario `///` arriba del enum que documenta el contrato (§3).
La posición de `STORE` en el archivo es cosmética: Postgres appendea físicamente
el nuevo valor al final del orden del tipo, independientemente del schema.

### Archivo de migración

`prisma/migrations/20260604000000_add_store_to_imagesource/migration.sql`:

```sql
ALTER TYPE "ImageSource" ADD VALUE 'STORE';
```

**Timestamp.** `20260604000000` es posterior al baseline único
`20260603000000_baseline`. Ordena después en la cadena de migraciones que
`prisma migrate deploy` aplica.

### Caveats de la migración

1. **`ADD VALUE` es forward-only.** Postgres no permite `DROP` de un valor
   de enum sin recrear el tipo entero — junto con cualquier columna que lo
   use. No hay rollback "limpio". Ver §6.

2. **No combinar `ADD VALUE` con `UPDATE = 'STORE'` en la misma migración
   o transacción.** Postgres rechaza usar un valor recién agregado dentro
   de la transacción que lo agregó. Cualquier reclasificación a `STORE`
   va a una migración POSTERIOR, separada.

3. **Orden físico.** El `ADD VALUE` appendea al final del orden interno del
   enum en Postgres, independientemente de su posición en `schema.prisma`.
   Esto es cosmético: el código debe comparar por nombre del valor
   (`'STORE'`), no por orden.

4. **Hand-written.** El archivo NO se generó con `prisma migrate dev` (que
   habría EJECUTADO la migración contra una DB real). Editado a mano. La
   verificación de drift schema↔migración la hace el CI (`db:test:reset`)
   cuando el branch se mergea — ahí el branch deja de divergir solo en
   schema.prisma.

---

## 3. Contrato formal de las cuatro fuentes

| valor | significado operacional |
|---|---|
| **STORE** | Imagen cuya relación con la tienda fue verificada mediante sincronización directa contra la plataforma externa. Garantía empírica de "este URL es el que la tienda externa retorna como imagen del producto X". NO significa "imagen alojada en el dominio de la tienda" — el dominio puede coincidir o no, eso es estructural. |
| **USER** | El usuario la subió manualmente desde PricEcom, **o** el origen de la fila no es demostrable a nivel de fila. Categoría conservadora por default. |
| **SUPPLIER** | (futuro) Imagen importada del catálogo del proveedor — Sprint posterior cuando el worker propage imágenes desde la página del proveedor. |
| **GENERATED** | (futuro) Generada / placeholder / IA. |

El contrato es deliberadamente **estricto en STORE**: solo se etiqueta así cuando
hay verificación empírica (no inferencia estructural, no asunción por dominio).
Esto deja el modelo abierto a auditarse: si en el futuro aparece una `STORE`
incorrecta, hay un acoplamiento empírico que se puede revisar contra el sync.

---

## 4. Estrategia B (aprobada): cero reclasificación masiva

### Qué hace 1A

- Agrega `STORE` al enum (este sprint).
- Cero `UPDATE` sobre las 832 filas existentes.

### Cómo se puebla `STORE` en el futuro

`STORE` se asigna **fila por fila**, **solo** desde el sync verificado del
Sprint 4 (planeado, no construido todavía):

```
Sprint 4 (futuro):
  Para cada producto que se sincroniza desde Woo (pull verificado):
    1. Leer pp.image_url devuelto por GET /products/{wooId}.
    2. JOIN contra CatalogProductImage WHERE catalogProductId = cp.id.
    3. Si alguna fila tiene url == woo.image_url (exact match):
        → UPDATE source = 'STORE' para esa fila puntual.
    4. Si no coincide → dejar la(s) fila(s) en USER.
       Caso "cliente cambió la imagen en Woo y PricEcom tiene una vieja",
       a tratar aparte (no es responsabilidad del sprint que reclasifica).
```

### Garantías que da esta estrategia

- Ninguna fila se etiqueta `STORE` sin verificación empírica.
- Si la URL difiere entre PricEcom y Woo (cliente cambió la imagen, o
  PricEcom tiene una stale), la fila se queda como `USER` y queda visible
  para futuro reconciliador. No se enmascara como `STORE` por simulacro.
- El modelo crece monotónicamente: una fila `STORE` representa un evento
  empírico documentable; nunca se "infiere" STORE.

---

## 5. Por qué NO la opción A (migración masiva por estructura de URL)

La opción descartada:

```
UPDATE CatalogProductImage
SET source = 'STORE'
WHERE source = 'USER'
  AND url LIKE 'https://electrofays.com/wp-content/uploads/%'
```

Hubiera reclasificado las 832 en una sola operación. Se descarta por:

1. **Convierte una inferencia en verdad de negocio.** La estructura
   `/wp-content/uploads/` demuestra DÓNDE vive el archivo (en la Media
   Library del cliente). NO demuestra QUIÉN creó la fila en
   `CatalogProductImage` ni si Woo sigue refiriéndose a esa URL como su
   imagen activa del producto. Etiquetar `STORE` por estructura **redefine
   silenciosamente el contrato** de `STORE` de "verificado empíricamente"
   a "URL con cierta forma".

2. **Pierde la garantía empírica del enum.** Una vez que `STORE` se asigna
   por estructura, deja de servir como acoplamiento auditable: ya no se
   puede preguntar "qué garantizan las filas STORE", porque algunas son
   empíricas y otras son estructurales.

3. **Viola el principio "demostrar antes de tocar"** que el cliente fijó
   tras la limpieza de finalPrice. El criterio del Sprint 1A es el mismo
   que se usó para los 385 finalPrice: **no presuponer; verificar fila por
   fila**.

4. **Casos límite reales:** si en el futuro el cliente migra a otra tienda
   externa (o agrega una segunda store con el mismo proveedor), una
   reclasificación masiva por URL queda inconsistente — la URL apunta al
   storage de electrofays.com mientras la tienda activa es otra.

---

## 6. Rollback honesto

- **Postgres no permite `DROP` de un valor de enum sin recrear el tipo.** Un
  rollback estricto exige recrear `ImageSource` (con `SUPPLIER`, `USER`,
  `GENERATED` solamente), recrear todas las columnas que lo usan
  (`CatalogProductImage.source`), recopiar las filas, descartar el tipo
  viejo. Operación cara y de riesgo en un schema vivo.

- **Rollback efectivo de 1A:** revertir el commit del branch antes de
  mergear. No deja huella en prod porque la migración nunca se aplicó
  (1A NO se mergea; el merge es 1B). El reverter del repo y `git push`
  con la rama eliminada cierra el ciclo sin tocar la DB.

- **Rollback después de aplicar (si en algún momento futuro se decide):**
  el valor `STORE` queda inerte (no usado por ninguna fila si no se ejecuta
  UPDATE). Mientras nadie haya populado `STORE`, el rollback de DDL no es
  necesario — el valor es un constructo lógico no referenciado. **1A no
  populará `STORE`**, así que el rollback post-aplicación queda trivial
  hasta que el Sprint 4 empiece a poblarlo.

- **Si en 1B+ ya hay filas `STORE` y se decide rollback:** se requiere un
  paso previo de `UPDATE source = 'USER' WHERE source = 'STORE'` (degradar
  a la categoría conservadora) en una migración independiente, **antes** de
  cualquier intento de remover el valor del enum.

---

## 7. Las 19 IMPORTED

Las 19 imágenes USER con `cp.sourceType = IMPORTED` (cps con
`importBatchId` no nulo, del Excel del 2026-05-16 23h) **se quedan como
`USER`** en 1A. Razones:

- No son `STORE`: el origen es el Excel, no la tienda externa. El cliente
  proveyó el URL como parte del import; no hay garantía empírica de que
  Woo siga refiriéndose a esas URLs.
- Hay trazabilidad indirecta vía `JOIN CatalogProduct.importBatchId`. El
  modelo no necesita un nuevo enum value para distinguirlas: la información
  vive en el `cp`, no en la `image`.
- 10 de las 19 tienen `pp.externalProductId` (publicaciones efectivas);
  cuando el Sprint 4 las verifique, esas 10 pueden eventualmente
  reclasificarse a `STORE` fila por fila. Las otras 9 no tienen `pp` con
  `externalProductId` — nunca llegaron a Woo — y se quedan `USER`
  indefinidamente, lo cual es correcto.
- "Fuente = Excel" como información derivada queda disponible sin nuevos
  enum values. Si en el futuro se quiere un tag explícito, se discute como
  refinamiento separado (campo derivado, tabla de auditoría, o nuevo enum
  value en otro sprint).

---

## 8. Excepción documentada: TP-658 (DURAVIT TORRE MINI)

La única `cp` SCRAPED con USER image que NO tiene `pp.externalProductId`:

```
cp.id:                cmp6gif1g0asx889lovt90phw
cp.sku:               658                                       (publicationSku: TP-00658)
cp.supplierName:      DURAVIT TORRE MINI
cp.provider:          TOYS PALACE
cp.internalStatus:    PAUSED
cp.supplierStatus:    ACTIVE
cp.createdAt:         2026-05-15T05:08:18Z
cp.updatedAt:         2026-06-03T22:11:39Z

image (1):
  source=USER  position=0  isPrimary=true
  url=https://electrofays.com/wp-content/uploads/2026/05/TP-658.jpg
  createdAt=2026-05-16T05:55:53Z   (parte del batch del 16/05 05h)

publication (1):
  pp.id:                cmpkhqtz8005ldlttkxr1d1ks
  pp.status:            PAUSED
  pp.syncStatus:        SYNCED
  pp.externalProductId: null        ← lo que dispara la excepción
  pp.externalStatus:    "publish"   ← inconsistente con externalProductId=null
  pp.externalUrl:       null
  pp.sku / externalSku: null
  pp.lastSyncedAt:      2026-05-30T12:59Z
```

### Timeline (`EventLog.productId = cp.id`)

```
2026-05-15  cp creado por el worker (SCRAPED).
2026-05-16  imagen USER creada (parte del batch desconocido).
2026-05-25  publication creada.
2026-05-26  USER_EDITED_PUBLICATION_SKU             (editó SKU comercial).
2026-05-26  WOO_SYNC_SUCCESS  "Precio sincronizado — SKU TP-00658"
2026-05-26  WOO_PRODUCT_PAUSED                       (pausado en Woo).
2026-05-30  WOO_SYNC_SUCCESS x2.
2026-05-31  USER_EDITED_PUBLICATION_SKU             (editó SKU otra vez).
2026-06-03  PRODUCT_PAUSED_WITHOUT_WOO              ← handler "pause sin Woo".
            "Producto pausado (sin presencia en WooCommerce)"
```

### Diagnóstico

- El producto FUE publicado en Woo (los `WOO_SYNC_SUCCESS` lo prueban).
- Entre 2026-05-30 y 2026-06-03 fue **removido de Woo** sin
  `EventLog` que lo documente. El handler de `pauseProductInWoo` del
  2026-06-03 encontró que ya no había `externalProductId` y entró al
  early-return "pause sin Woo" (publication-service.ts:464-488), emitiendo
  `PRODUCT_PAUSED_WITHOUT_WOO`.
- El estado actual de la `pp` es inconsistente: `externalProductId=null`
  pero `externalStatus="publish"`. Es un residual del proceso de remoción
  no rastreado.
- Encaja con el patrón de la deuda 4E ("Instrumentación de internalStatus
  sin helper centralizado"): es exactamente el tipo de transición sin
  trazabilidad que motivó esa entrada.

### Por qué 1A NO toca este caso

- 1A solo agrega el enum value. Cero `UPDATE`.
- Reconciliar `pp` huérfanas (sin `externalProductId` pero con
  `externalStatus` no-nulo) es una tarea aparte, fuera del alcance del
  modelo de imágenes.
- La imagen USER de TP-658 se queda como `USER`. Apunta a un archivo
  (`/wp-content/uploads/2026/05/TP-658.jpg`) que puede o no seguir en la
  Media Library de Woo — sin verificación empírica, no hay forma de saber
  desde PricEcom. Es exactamente el caso para el cual `STORE` exige
  sincronización directa: hasta que el Sprint 4 vaya a Woo y pregunte, la
  fila se queda en la categoría conservadora.

---

## 9. Resumen del sprint

| Tarea | Resultado |
|---|---|
| Investigar excepción (Tarea 1) | Identificada: TP-658 DURAVIT TORRE MINI, link huérfano post-remoción en Woo. Documentada en §8. |
| Reconciliar denominadores (Tarea 2) | Cuatro números cuadrados: 832 / 822 / 813 / 812 + 10 excepciones explicadas. §1. |
| Branch + artefactos (Tarea 3) | Branch `sprint-1a-image-source` con commit que incluye schema + migración hand-written. |
| Doc de diseño (Tarea 4) | Este documento. |
| Deuda de trazabilidad (Tarea 5) | Entrada nueva en `docs/known-debts.md`. |

**Cero escrituras a DB. Cero push a `main`. Branch listo para revisión, no
mergeado.** El merge es Sprint 1B.

---

## 10. Estado de prod al cierre de 1A

Confirmado read-only:

- `_prisma_migrations`: solo el baseline `20260603000000_baseline` está
  aplicado.
- `CatalogProductImage`: 832 USER, 0 SUPPLIER, 0 GENERATED. Sin cambios
  desde la limpieza de finalPrice.
- `ImageSource` enum en Postgres: contiene `SUPPLIER`, `USER`, `GENERATED`.
  El `STORE` del branch NO está aplicado.

Cuando 1B mergee y `prisma migrate deploy` corra en el siguiente deploy de
`main`, va a aplicar `20260604000000_add_store_to_imagesource` — un
`ALTER TYPE` de un solo statement. Sin impacto sobre datos, sin downtime.
