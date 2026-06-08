# Source of Truth — Diseño conceptual

> Documento de **diseño**. No describe el estado implementado actual salvo donde
> se aclara explícitamente ("hoy"); describe el modelo objetivo ya acordado y los
> hallazgos que lo fundamentan. La implementación del contrato de sincronización
> vive en [1a-honest-sync-contract.md](./1a-honest-sync-contract.md).

---

## 1. Contexto

PricEcom nació con una lógica implícita heredada del flujo de importación:

```text
WooCommerce manda.
PricEcom refleja.
```

Para Electrofays esa premisa cambia **parcialmente**:

```text
PricEcom debe ser autoridad operativa en acciones manuales.
```

Si el usuario **publica / pausa / ignora** desde PricEcom, espera que WooCommerce
cambie en consecuencia. PricEcom deja de ser un espejo pasivo y pasa a ser la
fuente de la **intención operativa**. Woo se vuelve un **destino de
propagación**, no el dueño del estado.

El cambio es parcial —no global— porque la autoridad se define **por campo**
(sección 2), no para todo el producto.

---

## 2. Autoridad por campo

La autoridad **no es global**. No es cierto que:

```text
Woo manda en todo
```

ni que:

```text
PricEcom manda en todo
```

Cada campo tiene su propio dueño. Mezclar esto fue el origen de varias
divergencias. La regla es: **definir autoridad campo por campo, y nunca asumir
que "quien manda en el precio manda en las imágenes".**

---

## 3. Autoridad ≠ Capacidad

Distinción central del diseño:

```text
Autoridad ≠ Capacidad
```

- **Autoridad**: quién *debería* ser dueño de la verdad de un campo en el modelo
  objetivo.
- **Capacidad**: qué puede *efectivamente* hacer el sistema hoy con ese campo.
- **Dueño efectivo hoy**: quién manda en la práctica mientras falte capacidad.

Un campo puede tener autoridad futura en PricEcom pero, por falta de capacidad
(p. ej. no existe R2 para hostear imágenes), su dueño efectivo hoy sigue siendo
Woo. **No** se debe actuar como si la autoridad futura ya existiera: hasta que la
capacidad esté, el invariante no-destructivo (sección 5) protege al dueño
efectivo.

| Campo | Autoridad futura | Capacidad actual | Dueño efectivo hoy |
| --- | --- | --- | --- |
| Precio | PricEcom | Completa | **PricEcom** |
| Estado operativo manual | PricEcom | Parcial/completa | **PricEcom** |
| Imágenes | PricEcom (futura) | No implementada, falta R2 | **Woo** |
| Categorías | PricEcom (futura) | Sólo lectura / importadas | **Woo** |
| Descripciones | A definir | No consolidado | **Woo / preservar** |
| Bootstrap inicial | Woo | Importación | **Woo → PricEcom** |

---

## 4. Bootstrap inicial

La **primera conexión** de una tienda es un movimiento unidireccional:

```text
Woo → PricEcom
```

Se importa el estado completo de la tienda existente:

- productos
- imágenes
- categorías
- estados
- precios
- descripciones

Esto es **bootstrap**: sembrar PricEcom con la realidad preexistente de la
tienda. **No** es reconciliación steady-state. La reconciliación continua (qué
pasa cuando ambos lados cambian con el tiempo) se gobierna por la autoridad
por-campo (sección 2) y el contrato honesto de sync (documento 1A), no por
re-importaciones masivas.

---

## 5. Invariante no destructivo

Mientras **no** existan:

- Sprint 2 (R2 para imágenes),
- gestión de categorías,
- gestión consolidada de descripciones,

las acciones de **estado** y **precio** **NO deben pisar**:

- imágenes
- categorías
- descripciones

El payload hacia Woo debe ser **field-merge / no destructivo**: incluir sólo los
campos que la acción realmente cambia, y omitir el resto (la WC REST API v3 trata
los campos omitidos como "no modificar").

**Estado verificado hoy (read-only):** los payloads de actualización de
estado/precio **ya son no-destructivos** — el update manda `{ regular_price,
status }` (+ `name`/`description` sólo si el usuario los editó) y **omite**
`images`, `categories`, `short_description`, stock; el cambio de estado manda
sólo `{ status }`. El invariante se cumple hoy y debe **preservarse** en todo
cambio futuro hasta que las capacidades existan.

---

## 6. Dos ejes separados

El modelo distingue **dos ejes ortogonales**. Confundirlos es la causa raíz de
la confusión visible en Mi Tienda (sección 7).

### Eje operativo

**Intención del usuario + realidad del proveedor.** Qué quiere hacer el usuario
con el producto y si el proveedor lo sigue teniendo.

Valores: `Publicado`, `Pausado`, `Ignorado`, `Sin stock`, `Preparado`,
`No publicado`.

Campos: `CatalogProduct.internalStatus`, `CatalogProduct.supplierStatus`,
`CatalogProduct.stockSource`, `CatalogProduct.pausedBySystem`.

### Eje sync

**Relación entre PricEcom y Woo.** Si lo que PricEcom decidió ya se propagó a la
tienda.

Valores: `SYNCED`, `PENDING_SYNC`, `OUTDATED`, `ERROR`.

Campos: `ProductPublication.syncStatus`, `ProductPublication.pendingSync`.

### Son ortogonales

Un producto puede estar en cualquier combinación de ambos ejes:

```text
Publicado + OUTDATED      (publicado, pero el precio calculado difiere del último pusheado)
Pausado   + PENDING_SYNC  (el usuario pausó, falta aplicar la pausa en Woo)
Ignorado  + ERROR         (ignorado en PricEcom, el push a Woo falló de forma terminal)
```

El badge operativo y el indicador de sync deben poder convivir; hoy se fusionan
y el eje sync tapa al operativo (sección 7).

---

## 7. Hallazgos del diagnóstico (read-only, confirmados contra prod)

Snapshot store ELECTROFAYS; censo `syncStatus`: `SYNCED`=1419, `OUTDATED`=8 (no
existen otros valores con filas).

- **Los 8 productos de la captura eran `PUBLISHED + OUTDATED`** (operativamente
  `internalStatus=PUBLISHED`, `supplierStatus=ACTIVE`, `pp.status=ACTIVE`,
  `externalStatus=publish`). Su "Desactualizado" es puro eje sync.
- **`deriveVisualStatus` pone `OUTDATED` por encima de los estados operativos**
  (`OUTDATED > SIN_STOCK > PAUSED > PUBLISHED > …`, en
  `lib/catalog/visual-status.ts`), por eso el badge muestra "Desactualizado" y
  **tapa "Publicado"**.
- **KPI "Pendientes Sync"** cuenta `pendingSync=true` (`app/(app)/my-store/page.tsx`
  → `my-store-dashboard.tsx`).
- **Chip "Pend. Sync"** filtra `syncStatus="PENDING_SYNC"`
  (`app/api/my-store/publications/route.ts`).
- **Chip "Desactualizados"** filtra `syncStatus="OUTDATED"` (misma ruta).
- Resultado: el KPI dice **8** (`pendingSync=true`), pero esos 8 son
  `syncStatus=OUTDATED`, así que **no** aparecen bajo "Pend. Sync"
  (`syncStatus=PENDING_SYNC` = 0 filas) y **sí** bajo "Desactualizados". El "8"
  es real pero está etiquetado con el nombre del eje equivocado.
- **El botón "Sincronizar pendientes" tiene un target real distinto al badge:**
  el badge muestra `pendingSync=true` = **8**, pero el set que el endpoint
  realmente sincroniza (`pendingSync=true OR syncStatus∈{PENDING_SYNC,OUTDATED,
  ERROR} OR (status=PAUSED & externalStatus=publish)`) = **9** (hay 1 caso
  `PAUSED & publish` sin `pendingSync`).
- **`pendingSync` no debe borrarse sin más**: los escritores lo manejan como una
  **cola con significado propio** (p. ej. `ERROR_SKU_CONFLICT` lleva
  `pendingSync=false` para *sacar* de la cola). Hoy correlaciona 1:1 con
  `syncStatus≠SYNCED`, pero eso es coincidencia del snapshot, no redundancia de
  diseño.
- **`syncStatus.PAUSED` tiene 0 filas y 0 escritores**: nadie escribe ese valor
  del enum (la pausa real vive en `pp.status=PAUSED` y
  `internalStatus=PAUSED`). Documentar como **dead member / deuda**; **no borrar
  todavía**.

---

## 8. Mapeo de estado operativo hacia Woo

La **intención fina** vive en PricEcom; Woo sólo necesita saber **visible / no
visible**.

| PricEcom | Woo |
| --- | --- |
| PUBLISHED | `publish` |
| PAUSED | `draft` |
| IGNORED | `draft` |
| SIN STOCK / auto-pausa | `draft` |

Reglas:

- **No usar `trash`** para ignorados (perdería la ficha; `draft` la conserva).
- **No usar `private`** salvo decisión futura explícita.
- Múltiples estados operativos de PricEcom colapsan a `draft` en Woo: la
  distinción Pausado vs Ignorado vs Sin stock es **interna**, Woo no la necesita.

---

## 9. Automatismos esperados

> Los automatismos documentados en esta sección representan el comportamiento
> deseado del sistema. No deben considerarse plenamente verificados.
>
> Parte de estos flujos ya fue auditada parcialmente en el diagnóstico previo del
> worker y del consistency-check (§8-bis del diagnóstico):
>
> - el worker auto-reactiva únicamente cuando `pausedBySystem=true`;
> - la auto-pausa respeta `stockSource`;
> - `markPublicationsDrift` participa en la detección de cambios de precio;
> - el fix OWN/HYBRID ya validó parte del comportamiento de reactivación.
>
> Sin embargo, todavía no existe una auditoría completa y específica de los seis
> automatismos operativos definidos más abajo, especialmente:
>
> - Conversión a Stock Propio (E)
> - Retorno de proveedor sobre producto OWN (F)

Reglas deseadas del modelo (las que tocan Woo deben respetar el **contrato
honesto** del documento 1A):

- **Proveedor remueve un producto:**
  - marcar `supplierStatus=SUPPLIER_REMOVED`;
  - si `stockSource=SUPPLIER` → llevar a SIN STOCK / pausa automática
    (`pausedBySystem=true`);
  - despublicar en Woo (`draft`) con contrato honesto;
  - si `stockSource=OWN/HYBRID` → **sobrevive** (no se auto-pausa).

- **Proveedor vuelve:**
  - reactivar **sólo si la pausa era automática** (`pausedBySystem=true`);
  - **no pisar** una pausa manual (`pausedBySystem=false`);
  - **no pisar** ignorados.

- **Cambia el precio:**
  - marcar / encolar sync de precio;
  - actualizar Woo.

- **Cambia el margen/descuento del proveedor:**
  - recalcular los productos afectados;
  - marcar / encolar sync de precios;
  - actualizar Woo.

- **El usuario marca un producto removido como Stock propio:**
  - permitir republicar aunque el proveedor no lo tenga;
  - `stockSource=OWN`;
  - Woo puede volver a `publish`.

- **El proveedor vuelve a traer un producto marcado como Stock propio:**
  - pasar de `OWN` a `SUPPLIER` si corresponde;
  - mantener el `internalStatus` actual;
  - **no forzar** publicación si estaba pausado o ignorado.

---

## 10. Decisiones abiertas

Marcadas explícitamente como **no resueltas** en este documento:

- **Predicado canónico de "pendiente":** `pendingSync=true` vs
  `syncStatus=PENDING_SYNC` vs un superset documentado. Hoy se usan ambos y por
  eso KPI y chip divergen.
- **Separación visual completa de ejes:** badge operativo + indicador de sync
  como dos señales distintas en la UI.
- **Definición futura de `OUTDATED`:** drift interno (precio calculado vs
  snapshot `priceInStore`) vs drift real contra Woo (vía API). El detalle —y por
  qué es la decisión de mayor alcance— está justo debajo de esta lista.
- **Limpieza futura del enum:** `syncStatus.PAUSED` (dead member) y otros valores
  sin uso real (`READY` salvo default, `ERROR_SKU_CONFLICT` sin filas hoy).
- **Semántica de OWN:** definir si `stockSource=OWN` representa stock físico real o
  workaround operativo. Esta decisión condiciona el diseño de F (retorno
  OWN→SUPPLIER).

**Sobre la decisión `OUTDATED` (detalle):**

> El significado actual de `OUTDATED` está basado en divergencia entre datos
> actuales de PricEcom y snapshots internos (`priceInStore` y campos
> relacionados).
>
> El mecanismo actual no consulta WooCommerce en vivo y, por lo tanto, no puede
> detectar divergencias originadas en Woo.
>
> Ejemplo:
>
> ```text
> PricEcom = PAUSED
> Woo = publish
> ```
>
> (clase de incidente HX178).
>
> Por definición, ese tipo de divergencia es invisible para el `OUTDATED`
> actual.
>
> Decidir si `OUTDATED` debe evolucionar para representar divergencia real
> contra Woo tiene blast radius sobre:
>
> - worker;
> - consistency-check;
> - botón de sincronización;
> - KPIs;
> - contrato honesto;
> - reconciliaciones futuras;
> - detección de divergencias tipo HX178.
>
> Esta es probablemente la decisión arquitectónica de mayor alcance que
> permanece abierta dentro del modelo Source of Truth.

### Automatismos operativos (auditoría read-only A–F)

> **Estado: auditados read-only contra el código (no implementados).** Esta
> sección reemplaza al "pendiente de auditoría": A–F ya fueron verificados
> end-to-end leyendo el código real (lección EF18: no asumir que una regla existe,
> confirmarla con sospecha reforzada sobre lo que ya creíamos saber). La sección 9
> sigue siendo el comportamiento *deseado*; lo de abajo es lo *verificado*.

| Automatismo | Estado actual | Funciona | Parcial | Falta | Riesgo |
| --- | --- | --- | --- | --- | --- |
| **A** Remoción por proveedor | Path worker funciona; path import incompleto | Sí, worker | Import/manual | Alinear import con 1A.2 | Medio |
| **B** Reaparición | Funciona con `pausedBySystem` | Sí | Depende de A | — | Bajo |
| **C** Precio proveedor | Marca drift | Sí, hasta marcar | Sync manual | Auto-push no existe | Medio |
| **D** Margen / regla | Por-producto sí; regla no | Parcial | Sí | Regla no marca drift/EventLog | Alto |
| **E** Stock propio | Acción manual existe | Sí | Guards faltantes | Validaciones / republicación auto | Medio-Alto |
| **F** OWN→SUPPLIER | No existe | No | — | Diseño completo | Alto |

**A — Remoción por proveedor.** Path **worker** (extracción) funciona end-to-end:
detecta SKU ausente → `SUPPLIER_REMOVED`; si `stockSource=SUPPLIER` (+ PREPARED/
PUBLISHED) auto-pausa con `pausedBySystem=true` e intenta push a Woo (`draft`) con
contrato honesto; OWN/HYBRID sobreviven (filtro positivo `="SUPPLIER"`).
**Gap (path import/manual):** la auto-pausa del import **no** setea
`pausedBySystem=true` y **no** pushea inmediatamente a Woo. Cruce crítico: esos
productos quedan indistinguibles de una pausa manual, así que **B nunca los
auto-reactiva** cuando el proveedor reaparece — el path import **degrada
permanentemente B** para esos productos, y puede dejar `PricEcom=PAUSED /
Woo=publish`. Decisión: A-import entra en el scope de **1A.2** o queda como
**deuda crítica** (no es un detalle menor).

**B — Reaparición.** Funciona: `handleReappeared` reactiva sólo si
`pausedBySystem=true`; no toca pausas manuales; IGNORED protegido (doble guard).
EF18 cubierto. **Gap:** depende de que A haya seteado bien `pausedBySystem`; si la
remoción vino por el path import (sin ese flag), B no reactiva.

**C — Cambio de precio del proveedor.** Funciona hasta marcar drift: el worker
detecta el cambio de `wholesalePrice` y `markPublicationsDrift` marca
`OUTDATED + pendingSync`. **Gap:** Woo **no** se actualiza automáticamente — el
push es **manual** (botón "Sincronizar pendientes"). En este flujo, "actualizar
Woo" hoy significa **marcar y esperar el sync manual**, no auto-push.

**D — Cambio de margen / regla de pricing. Parcial.** Funciona el cambio de margen
**por producto** (marca drift). **Falta:** el cambio de **regla** de pricing
(global/proveedor/categoría) **no marca drift**, **no genera `pendingSync`** y
**no genera EventLog**. Como `resolvePricing` lee las reglas en runtime, PricEcom
puede mostrar precios nuevos mientras Woo sigue con los viejos **sin alerta**.
**Riesgo Alto** (cientos/miles de productos en silencio). Decisión: separar D en
(1) **detección** —la regla debe marcar drift + EventLog— y (2) **propagación**
—depende del drainer / contrato honesto de 1A—.

**E — Conversión a Stock Propio.** Existe y funciona como **acción manual**:
`copy_own_stock` setea `stockSource=OWN`; habilita publicar aunque
`supplierStatus=SUPPLIER_REMOVED` (el push no chequea `supplierStatus`); el worker
respeta OWN. **Gaps:** guards insuficientes de precio/SKU al convertir; **no**
republica automáticamente (el usuario debe publicar). **Riesgo Medio-Alto.**

**F — Retorno OWN → SUPPLIER. No existe.** Ningún path automático cambia
`stockSource=OWN` a `SUPPLIER` cuando el proveedor reaparece (la reaparición no
toca `stockSource`; confirmado con grep de escritores en todo el repo: sólo lo
escriben acciones manuales/creación). El retorno es **100% manual**
(`remove_own_stock`). **Riesgo Alto** — el ciclo de vida OWN queda incompleto.
**Decisión abierta (bloqueante de F): definir qué significa `OWN`:**
- (1) **stock físico real** del cliente → **no** debe volver a SUPPLIER
  automáticamente al reaparecer el proveedor;
- (2) **workaround** para publicar un removido → **sí** tiene sentido volver a
  SUPPLIER al reaparecer.

No implementar F sin cerrar esta semántica (ver "Semántica de OWN" en decisiones
abiertas).

Parte de la evidencia provino del diagnóstico del worker (§8-bis); la auditoría la
reutilizó y la confirmó end-to-end.

> Estas decisiones son **posteriores** a 1A y dependen de cómo cierre el contrato
> honesto. Ver [1a-honest-sync-contract.md](./1a-honest-sync-contract.md).
