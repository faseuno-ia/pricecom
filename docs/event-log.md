# EventLog — Audit Trail de PricEcom

## Propósito

Trazabilidad completa de acciones automáticas y manuales. Permite responder:
**qué pasó, quién lo hizo, qué lo disparó, cuándo ocurrió, qué entidad fue
afectada.**

Es un sink de eventos inmutable. Cualquier feature de la app (auto-pausa,
push a WooCommerce, edición desde el drawer, import Excel, etc.) puede emitir
filas acá vía el helper `logEvent` / `logInfo` / `logWarning` / `logError` /
`logCritical` exportado por `lib/events/event-log.ts`.

## Severidades

| Severidad   | Cuándo usarla                                                          |
|-------------|------------------------------------------------------------------------|
| `INFO`      | Operación normal exitosa.                                              |
| `WARNING`   | Situación que requiere atención pero no es crítica.                    |
| `ERROR`     | Fallo en una operación, requiere revisión.                             |
| `CRITICAL`  | Fallo grave que puede afectar datos o tienda en producción.            |

## Sources

| Source        | Quién genera el evento                                              |
|---------------|---------------------------------------------------------------------|
| `USER`        | Acción manual del usuario desde la UI.                              |
| `WORKER`      | Acción automática del worker de scraping.                           |
| `SYSTEM`      | Acción interna del sistema (auto-pausa, drift detection).           |
| `SYNC`        | Operación de sincronización con tienda externa.                     |
| `IMPORT`      | Importación de productos desde Excel.                               |
| `EXTRACTION`  | Extracción de datos de proveedor.                                   |
| `WOOCOMMERCE` | Respuesta o acción de la API de WooCommerce.                        |

## Tipos de eventos (catálogo)

`type` es un identificador semántico estable. Mantener este catálogo
sincronizado cuando se agreguen tipos nuevos.

### WooCommerce / Sync

| Type                          | Severity esperada |
|-------------------------------|-------------------|
| `WOO_PRODUCT_CREATED`         | INFO              |
| `WOO_PRODUCT_PAUSED`          | INFO              |
| `WOO_SYNC_SUCCESS`            | INFO              |
| `WOO_SYNC_ERROR`              | ERROR             |
| `PRODUCT_MARKED_OUTDATED`     | INFO              |

### Auto-pausa

| Type                          | Severity esperada |
|-------------------------------|-------------------|
| `PRODUCT_AUTO_PAUSED`         | WARNING           |
| `PRODUCT_SUPPLIER_REMOVED`    | WARNING           |

### Stock propio

| Type                              | Severity esperada |
|-----------------------------------|-------------------|
| `PRODUCT_MOVED_TO_OWN_STOCK`      | INFO              |
| `PRODUCT_REMOVED_FROM_OWN_STOCK`  | INFO              |

### Extracciones / Importaciones

| Type                          | Severity esperada |
|-------------------------------|-------------------|
| `EXTRACTION_COMPLETED`        | INFO              |
| `EXTRACTION_FAILED`           | ERROR             |
| `IMPORT_COMPLETED`            | INFO              |
| `IMPORT_PARTIAL`              | WARNING           |

### Acciones de usuario

| Type                              | Severity esperada |
|-----------------------------------|-------------------|
| `USER_EDITED_PUBLICATION_SKU`     | INFO              |
| `USER_PUBLISHED_PRODUCT`          | INFO              |
| `USER_PAUSED_PRODUCT`             | INFO              |
| `USER_IGNORED_PRODUCT`            | INFO              |
| `USER_RESTORED_PRODUCT`           | INFO              |
| `USER_CHANGED_CATEGORY`           | INFO              |
| `PROVIDER_DISCOUNT_CHANGED`       | INFO              |

## Filosofía

- El logging **nunca** rompe el flujo principal — `logEvent` envuelve el
  `prisma.create()` en try/catch. Si la DB está caída o la fila no se puede
  crear, se loguea en consola y se sigue.
- Todos los IDs relacionados se guardan cuando aplican (provider, product,
  publication, store, job) para facilitar joins y filtros en `/activity`.
- `metadata` acepta cualquier JSON adicional para contexto extra (precios
  old/new, payload Woo, batchId, etc). **No incluir secretos** (passwords,
  tokens) en metadata.
- **No usar hard delete sobre EventLog** — es inmutable por diseño. Si
  algún día se necesita compactar, hacer una rotación archivada por fecha,
  pero la API pública siempre debe poder leer histórico.
- Las FKs son `ON DELETE NO ACTION` (default). Si un Provider/Product/etc.
  se borra, las filas de EventLog quedan huérfanas (campo nullable apunta a
  un id que ya no existe). Es aceptable como registro histórico.

## Uso

```ts
import { logInfo, logError } from "@/lib/events/event-log";

// Éxito de un push a Woo
await logInfo({
  source: "SYNC",
  type: "WOO_SYNC_SUCCESS",
  title: `Publicación sincronizada — SKU ${publicationSku}`,
  productId,
  publicationId,
  storeId,
  metadata: { priceSent: 12345, externalProductId: "10545" },
});

// Error en el push
await logError({
  source: "SYNC",
  type: "WOO_SYNC_ERROR",
  title: `Fallo al sincronizar SKU ${publicationSku}`,
  description: errorMessage,
  productId,
  publicationId,
  metadata: { attempt: 3, status: 502 },
});
```

## Convenciones de naming

- **`type`**: `SCREAMING_SNAKE_CASE`. Verbo o estado en pasado: `WOO_PRODUCT_CREATED`,
  `PRODUCT_AUTO_PAUSED`. No es para mostrar al usuario directamente.
- **`title`**: oración corta legible en español, con datos concretos para
  identificar el evento en una lista (`SKU JOR541 pausado por baja de
  proveedor`).
- **`description`**: opcional, sólo si el title no alcanza. Pensado para el
  detalle de un evento individual (ej. el error message completo).
- **`metadata`**: JSON con contexto, no para reemplazar campos relacionales.
  Si hay un `productId` que ya tiene relación, **no** lo metas también en
  `metadata.productId`.
