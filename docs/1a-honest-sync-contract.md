# 1A — Contrato honesto de sincronización (pause / ignore / publish ante fallo de Woo)

> Documento de **diseño**. No es código ni un plan de implementación cerrado:
> define el comportamiento objetivo y los habilitadores técnicos necesarios.
> Contexto conceptual: [source-of-truth-design.md](./source-of-truth-design.md).
> Decisión madre ya tomada (no se rediscute): para Electrofays, PricEcom es
> autoridad del estado operativo en transiciones manuales.

---

## 1. Problema

Hoy:

- `pause` / `ignore` son **DB-first pero optimistas**: el endpoint escribe la
  intención local (`internalStatus=PAUSED/IGNORED`, `pausedBySystem=false`)
  **antes** de llamar a Woo, y si Woo falla deja `pp.syncStatus=ERROR,
  pendingSync=true` **sin revertir** la intención.
- El fallo de Woo se reporta por un canal separado (`wooErrors`), mientras la
  respuesta principal cuenta la fila como actualizada.
- El badge operativo (p. ej. "Pausado") **tapa** el `pp.syncStatus=ERROR` porque
  el eje sync no se muestra en el badge.

Resultado: la UI puede comunicar éxito/estado operativo sin mostrar claramente
que Woo no cambió. Esto permite divergencias silenciosas:

```text
PricEcom = PAUSED
Woo      = publish
```

(la familia de bugs tipo HX178 / EF18).

---

## 2. Decisión principal

Adoptar **DB-first honesto**:

- La intención del usuario **se guarda siempre** en PricEcom.
- Woo es **destino de propagación**, no condición de validez de la intención.
- **Pero**: si Woo no cambió, la UI **NO** puede mostrar éxito verde — muestra
  advertencia (recuperable) o error (terminal), y el caso queda **visible y
  durable** en cola.

---

## 3. Contrato honesto

Una acción manual **aceptada** significa exactamente una de estas dos cosas:

```text
intención guardada en PricEcom
+ Woo actualizado
```

o

```text
intención guardada en PricEcom
+ sync pendiente/error visible y durable
```

**Nunca**:

```text
PricEcom actualizado
+ Woo ignorado silenciosamente
```

---

## 4. Acciones cubiertas

- `publish`
- `pause`
- `ignore`

Prioridad y matiz:

- **`pause` / `ignore` son prioridad urgente** (son las que producen la
  divergencia silenciosa hoy).
- **`publish` simétrico depende** de que la UI muestre claramente el eje sync
  (ver §3 sub-sprint 1A.3 y §10). Si la UI todavía no distingue el eje sync, un
  "Publicado" local con Woo caído puede leerse como mentira.

---

## 5. Estados ante resultado de Woo

| Resultado Woo | Intención local | `syncStatus` | `pendingSync` | UI |
| --- | --- | --- | --- | --- |
| **OK** | guardada | `SYNCED` | `false` | éxito (verde) |
| **Recuperable** | guardada | `PENDING_SYNC` | `true` | advertencia visible + en cola |
| **Terminal** | guardada | `ERROR` | `false` | error visible / requiere revisión |

Cambios respecto de hoy:

1. El fallo **recuperable** pasa a `PENDING_SYNC` (hoy el catch genérico usa
   `ERROR`), reservando `ERROR` para terminal.
2. `pendingSync` deja de quedar en `true` en terminal (hoy queda `true` →
   reintenta para siempre).
3. La UI **deja de mostrar verde** en recuperable/terminal.

> Detalle por campo (`internalStatus`, `pp.status`, `externalStatus`) por acción:
> la intención operativa se persiste siempre; el fallo de sync **no** debe
> escribir el eje operativo (`pp.status`) — ver §7.3 y §9 (1A.1).

---

## 6. Taxonomía de fallo

Extiende el patrón ya existente (`ERROR_SKU_CONFLICT → pendingSync=false`); no
inventa uno nuevo.

### Recuperable → `PENDING_SYNC` + `pendingSync=true`

- timeout
- error de red
- Woo no responde
- 500 / 502 / 503
- rate limit

### Terminal → `ERROR` + `pendingSync=false`

- SKU conflict confirmado
- payload inválido / error de validación (400 `rest_invalid_param`)
- ID de publicación inválido confirmado
- recurso eliminado confirmado

### Ambiguo (no clasificar sólo por status HTTP)

- **401 / 403 (auth):** puede ser credencial vencida (no se arregla
  reintentando) o un blip temporal. El client ya reintenta el 401 una vez con
  credenciales en query params (workaround mod_security). Tratamiento:
  **recuperable con tope + escalado**; si persiste para *todos* los pushes, es
  salud de integración global (banner de conexión), **no** marcar miles de
  productos como ERROR.
- **404 / producto no encontrado:** puede ser "borrado en Woo", "nunca existió"
  o "recreable". `getProduct` distingue 404 (devuelve `null`); `updateProduct`
  **no** (lanza). Tratamiento: ante 404 en update/pause, **confirmar con
  `getProduct(externalProductId)`** — si `null` → terminal (limpiar
  `externalProductId`, "borrado en tienda"); si existe → fue blip → recuperable.

> **Modos que no encajan limpio (reportados):** (a) *timeout-en-create donde Woo
> sí creó* no es un fallo sino un éxito no confirmado → se trata como
> idempotencia (§7.2), no como categoría de error. (b) *401 global por credencial
> vencida* no es per-producto → carril de salud de integración (§10).

---

## 7. Habilitadores técnicos detectados

### 7.1 `client.ts` debe exponer errores estructurados

- **Hoy:** lanza `Error` genérico con el status HTTP **embebido en el string**
  (`"WooCommerce update error: HTTP 404 …"`). No hay clase ni `.status`.
- **Sin esto, la taxonomía recuperable/terminal no es implementable limpio.** Es
  el primer trabajo, no un detalle.
- **Recomendado:** `WooApiError { status, code, body }` (status HTTP, `code` de
  la WC REST API como `product_invalid_sku`, y cuerpo). Alternativa peor:
  parsear el string.

### 7.2 Reintentos idempotentes

- **UPDATE por ID (PUT)** es idempotente: reaplicar el mismo payload deja el
  mismo estado → reintentar una pausa que Woo ya aplicó **no duplica ni rompe**.
- **CREATE / primer publish (POST)** **no** es idempotente.
- **Riesgo:** timeout en create puede crear el producto en Woo pero perder la
  respuesta. El reintento, al buscar por SKU, encuentra el producto **propio** y
  hoy devolvería un falso `ERROR_SKU_CONFLICT` (terminal).
- **Recomendación:** en el create-retry, antes de declarar conflicto, buscar por
  SKU (`findProductsBySku`, ya existe); si el match es **único** y **no está
  vinculado a otra publicación** de PricEcom → **adoptarlo** (escribir
  `externalProductId`, pasar a SYNCED). Sólo si el match es con OTRO producto
  real → `ERROR_SKU_CONFLICT`.

### 7.3 Confirmación de éxito real

- Usar el **response del REST API de Woo** (`/wp-json/wc/v3`): los métodos de
  escritura **ya devuelven el `WooProduct` actualizado** (`res.json()`). Un 2xx
  con ese cuerpo **es** la confirmación de que Woo aplicó el cambio.
- **No usar HTML / storefront**: SpeedyCache cachea el HTML público, no el REST
  API. Un push correcto que "se ve viejo" en la tienda pública es cache de HTML,
  no un fallo de sync. **El storefront no es fuente de verdad; el REST API sí.**
- **No usar el snapshot interno** (`priceInStore`) como confirmación contra Woo:
  ese snapshot es lo que escribimos nosotros (detecta drift propio, otro eje).
- **Caso ambiguo (timeout sin response):** `getProduct(externalProductId)`
  resuelve — si el estado en Woo ya es el esperado, marcar SYNCED (idempotente).

### 7.4 UI no verde

- Si Woo no cambió, la UI **debe** mostrar pendiente/error **visible**. Sin esto,
  todo el contrato es inútil: la divergencia seguiría tapada por el badge
  operativo. Requisito mínimo de 1A: "no verde". La separación visual completa de
  ejes es posterior (ver source-of-truth §10).

---

## 8. Borde worker / auto-reactivación

`pausedBySystem` es el **discriminador** que mantiene separados los dos mundos:

- `pausedBySystem=false` representa **intención manual**.
- El worker **no debe auto-reactivar** pausas manuales (hoy ya respeta
  `pausedBySystem=false` en `upsert-catalog-products.ts`).
- El **drainer / reintento NO debe tocar `pausedBySystem`** (debe reusar
  `pauseProductInWoo`, que no lo escribe) → preserva la marca manual.
- Por lo tanto, **drenar una pausa manual pendiente y auto-reactivar por
  proveedor NO compiten**: para el universo de pausas manuales, la reactivación
  está desactivada por diseño.
- Para pausas **automáticas** (`pausedBySystem=true`), la reactivación por
  proveedor sigue siendo válida (ambos lados son del sistema; gana la reaparición
  del proveedor).

Este es exactamente el borde donde vivió el bug EF18 → cuidado reforzado: ningún
paso del drenado puede escribir `pausedBySystem`.

---

## 9. Sub-sprints propuestos

### 1A.1 — Base técnica
- `WooApiError` estructurado (`{ status, code, body }`).
- Clasificación recuperable / terminal / ambiguo.
- **Evitar escribir `pp.status=ERROR`** por un fallo de sync.
- Mantener el fallo de sync en el **eje sync**, no en el operativo.

### 1A.2 — pause / ignore honestos
- Mantener DB-first.
- Woo OK → `SYNCED`.
- Woo recuperable → `PENDING_SYNC`.
- Woo terminal → `ERROR`.
- UI no verde.
- Definir drainer interino: usar el botón manual existente, o mergear junto con
  1A.4.

### 1A.3 — publish simétrico
- Evaluar si `publish` debe ser DB-first honesto también.
- **Sólo si** la UI de sync es suficientemente visible.
- Si no, mantener `publish` Woo-first hasta completar la UI.

### 1A.4 — drainer / reintentos
- Botón manual + worker, o motor compartido.
- Idempotencia (§7.2).
- Backoff.
- Tope de reintentos.
- Posible necesidad de `syncAttempts` / `nextRetryAt`.
- Diagnóstico previo de unicidad de SKU en Woo (para "adoptar por SKU").

---

## 10. Decisiones abiertas

- **Schema para reintentos:** `syncAttempts`, `nextRetryAt`, último error, último
  intento.
- **Drenado en el interín** si 1A.2 se mergea antes de 1A.4.
- **Diagnóstico de unicidad de SKU** en Woo antes de "adoptar por SKU".
- **Carril separado de salud de integración** para 401/403 global.
- **Publish simétrico sí/no** según el estado de la UI de sync.
- **Separación visual completa de ejes** (operativo + sync).
- **Definición final de `OUTDATED`** (drift interno vs Woo real).

---

## 11. Qué NO hacer todavía

- **No** R2.
- **No** imágenes.
- **No** categorías.
- **No** borrar `pendingSync`.
- **No** borrar `syncStatus.PAUSED`.
- **No** rediseñar todo el eje sync en este sprint.
- **No** hacer auto-corrección masiva sin dry-run.
- **No** hacer writes en prod sin backup JSON y EventLog.
