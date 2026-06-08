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

### Automatismos operativos (pendiente de auditoría completa)

Los automatismos de la sección 9 forman parte del modelo Source of Truth y deben
ser **auditados contra el código** antes de considerarse implementados.

La lección del incidente EF18 fue **asumir que una regla existía cuando en
realidad no estaba garantizada por el código**. No repetir ese supuesto: lo de la
sección 9 es comportamiento deseado, no comportamiento verificado.

Diagnóstico pendiente (read-only). La columna marcada (`✓`) indica el grado de
evidencia **ya** disponible en el diagnóstico del worker (§8-bis); el resto es lo
que falta auditar:

| Automatismo | Estado actual (según código leído) | Funciona | Parcial | Falta | Riesgo |
| --- | --- | --- | --- | --- | --- |
| Remoción por proveedor | `SUPPLIER_REMOVED`; auto-pausa si `stockSource=SUPPLIER`; despublica (`draft`) | — | ✓ §8-bis (upsert + consistency-check caso 2) | Push honesto a Woo ante fallo (depende de 1A) | Medio |
| Reaparición del proveedor | Reactiva sólo si `pausedBySystem=true`; respeta manual e ignorados | — | ✓ §8-bis (reactivación + fix OWN/HYBRID) | Confirmar no-pisado de ignorados end-to-end | Bajo |
| Cambio de precio | `markPublicationsDrift` → `OUTDATED` + `pendingSync` | — | ✓ §8-bis (mark-drift) | Confirmación real contra Woo (ver decisión `OUTDATED`) | Medio |
| Cambio de margen del proveedor | Recalcula afectados + encola sync | — | ✓ parcial (mismo motor de drift) | Propagación completa del cambio de margen a todos los afectados | Medio |
| **Conversión a Stock Propio (E)** | Permite republicar OWN aunque el proveedor no lo tenga | — | — | ✗ Sin auditar específicamente | **Alto** (clase EF18) |
| **Retorno Stock Propio → Proveedor (F)** | `OWN→SUPPLIER` manteniendo `internalStatus`; no forzar publicación | — | — | ✗ Sin auditar específicamente | **Alto** |

Parte de la evidencia ya existe en el diagnóstico del worker (§8-bis). La
auditoría futura debe **reutilizar esa evidencia y no comenzar desde cero**.

> Estas decisiones son **posteriores** a 1A y dependen de cómo cierre el contrato
> honesto. Ver [1a-honest-sync-contract.md](./1a-honest-sync-contract.md).
