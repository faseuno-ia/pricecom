# D2 — Modelo de autoridad del precio y reconciliación de sync (diseño)

> **Estado:** DISEÑO aprobado (Gate 1). **No implementado.** El plan de ejecución y los
> gates de implementación van en prompts separados, con OK explícito.
> **Origen:** Gate 0 (correctitud), Gate 0.5 (procedencia de `priceInStore`), Gate 1
> (elección de modelo). Este documento fija el **contrato** y el **diseño conceptual**;
> la maquinaria (migración, código, jobs) se implementa después.

---

## 1. El contrato de SYNCED (frontera del modelo — LITERAL)

> **`SYNCED` significa: el precio calculado actualmente por PricEcom coincide con el precio
> del último push exitoso registrado por PricEcom.**
>
> **`SYNCED` NO significa: el precio actualmente visible en Woo coincide con el cómputo de
> PricEcom.**

El sistema es **estructuralmente ciego** a divergencias originadas en Woo (edición directa del
admin en la tienda, o un push viejo que falló parcialmente del lado Woo), porque **PricEcom
nunca lee Woo en vivo** — no existe ese lector y construirlo es otro proyecto, fuera de este
modelo (Modelo C). Una fila puede estar `SYNCED` y diferir de lo que hay en Woo, **y eso es
correcto por definición**.

### Caso límite que el backfill expone (documentado para que no se lea como bug)

Cuando una fila tuvo un **push** y luego un **pull** con un valor distinto, el baseline de
autoridad es el **PUSH**, no el pull:

- Ejemplo real: `NY-9808C` — pusheamos **$6029** (nuestra intención); un pull posterior observó
  **$6028** en Woo y lo guardó en `priceInStore`.
- El baseline (`lastPushedPrice`) = **$6029** (lo que decidimos). El cómputo actual = $6029 →
  **`SYNCED`** (drift cero contra nuestro push).
- La diferencia observada contra Woo ($1) se **descarta deliberadamente**: autoridad PricEcom =
  nuestra intención manda.

→ **Una fila `SYNCED` con `lastPushedPrice != priceInStore` es CORRECTA, no un bug.** Son dos
campos con semántica distinta (intención-nuestra vs observado-en-Woo).

---

## 2. Modelo de autoridad por campo (Modelo C)

El invariante de `SYNCED` depende de **quién es autoridad del precio de la fila**:

| Autoridad | Señal | `SYNCED` significa |
|---|---|---|
| **PricEcom** | `lastPushedPrice != null` (hubo push nuestro) | `|computed − lastPushedPrice| ≤ tolerancia` (§4.9) — drift-desde-push |
| **Woo** | `lastPushedPrice == null` (nunca pusheamos) | "no reclamamos control" — correcto hasta que pusheemos |

La autoridad se **deriva** de la null-ness de `lastPushedPrice`. No hace falta columna de
autoridad separada.

> **Contrato del campo — obligatorio en el doc Y como comentario del schema Prisma (sin él,
> ningún nombre alcanza):**
> `lastPushedPrice` **ES el baseline de autoridad del precio**, no un dato histórico decorativo.
> - `lastPushedPrice != null` ⇒ **autoridad PricEcom** → `SYNCED` = drift-desde-push.
> - `lastPushedPrice == null` ⇒ **autoridad Woo** → `SYNCED` por definición.
> El comentario debe viajar pegado al campo en `schema.prisma` cuando se implemente.

### Campos (semántica fijada)

| Campo | Quién escribe | Significado |
|---|---|---|
| **`lastPushedPrice`** (NUEVO, `Float?`) | **solo paths de push** (`publishProductToWoo` éxito CREATE/UPDATE; push de edición de SKU) | precio calculado del último push exitoso = **baseline de autoridad PricEcom** |
| `priceInStore` (existente, redefinido) | pulls (`sync/products`, `link`, `create-catalog`) | "último valor observado en Woo" — **informativo**, ya NO es el comparando del invariante |
| `syncStatus` / `pendingSync` | reconciliación + paths de push/pause/edit | estado del eje sync |

Los **pulls NUNCA tocan `lastPushedPrice`** (esto es lo que evita que pisen el snapshot, la
causa raíz de los "artefactos" del Gate 0.5).

---

## 3. Bug A y Bug B — DOS problemas distintos (no colapsar)

> Comparten maquinaria (la barrida los ejecuta juntos) pero **son conceptos separados**. Esta
> sección existe para impedir que se lean como el mismo problema.

- **Bug A — LIMPIEZA (unidireccionalidad).** `markPublicationsDrift` marca `OUTDATED` pero
  **nunca lo limpia** cuando el drift desaparece. Evidencia: Bazar 380 (194 OUTDATED tras
  revertir un margen, con `effectivePrice == priceInStore`). Es un problema de **transición
  inversa faltante**.
- **Bug B — DETECCIÓN (gap).** Un input de precio cambia por un path que **nunca llama a
  detección**, y la fila queda `SYNCED` con drift real. Evidencia: `0308` — pusheado $11201
  (06-04), quedó `SYNCED`; el cómputo actual es $11805 sin ningún `PRODUCT_MARKED_OUTDATED`
  ni `PRICING_RULE_CHANGED`. **Un input de precio cambió sin rutear por detección** — esto
  está probado. La **causa fina del delta (margen vs costo) NO está demostrada**, solo
  inferida del precio; el diseño **no se apoya** en "fue el margen". El patrón (mutación de
  input sin detección) es real y reaparecible.
  - Nota: el path específico de `0308` (cambio de regla) **ya lo cerró D1** (merge 06-09);
    `0308` es residuo legacy pre-D1. Bug B remanente = residuo legacy + riesgo estructural de
    paths futuros sin garantía central.

---

## 4. Componentes del diseño

### 4.1 Baseline estable + autoridad derivada
Columna nueva `lastPushedPrice Float?` (§2). Autoridad = su null-ness. (Alternativas en §6.)

### 4.2 Backfill desde EventLog
Poblar `lastPushedPrice` para **toda** publicación con historia de push, tomando el **último**
`WOO_SYNC_SUCCESS.newPrice` / `WOO_PRODUCT_CREATED.price` de su `catalogProduct`.

> **Fuente de verdad del baseline histórico: EventLog es la ÚNICA fuente autorizada.** Es el
> único registro que conserva el precio exacto de cada push (las filas pull-pisadas ya
> perdieron el valor en `priceInStore`). Ni `priceInStore` ni Woo son autoritativos para
> reconstruir `lastPushedPrice` de filas pre-migración — solo EventLog.

- Con push → baseline = último precio pusheado. **Arregla los artefactos de pull-pisado**
  (ej. NY-9808C → baseline 6029 == cómputo → SYNCED).
- Sin push (filas NUNCA-PUSH) → `null` → autoridad Woo.
- Recupera las filas PERDIÓ-BASELINE sin leer Woo, sin pushear, sin falso-verde.
- *(Cardinalidad exacta de cada cohorte: NO se clava acá; se re-mide en el checkpoint D2-3.5,
  §4.3.)*
- Disciplina: script controlado (patrón Bazar 380), backup JSON, EventLog acotado por tipos de
  push, chunked, idempotente, prod-guard, borrado al final. **Solo escribe la columna nueva** →
  no-destructivo.
- Confianza alta (EventLog sin pruning). Filas pre-instrumentación → `null` = autoridad Woo
  (conservador).

### 4.3 CHECKPOINT D2-3.5 — medición (read-only, OBLIGATORIO entre backfill y barrida)

> **El backfill NO es neutral: arma el set sobre el que la barrida después actúa.** Por eso,
> tras poblar `lastPushedPrice` y **antes de que la barrida escriba una sola transición**, se
> corre una medición read-only y se reporta:
> - cuántas filas quedaron **autoridad-PricEcom** (`lastPushedPrice != null`),
> - de esas, cuántas tienen **drift latente** contra su nuevo baseline (`> tolerancia`, §4.9),
> - desglose (por proveedor / magnitud) de ese drift latente.
>
> Este número es el "trabajo" que la barrida va a hacer en su primera corrida. Se revisa
> **antes** de habilitar writes. (Es la foto que evita que la primera barrida sorprenda.)

> **Conteos = fotos, no invariantes.** Toda cardinalidad citada en este documento
> (autoridad-Woo, NUNCA-PUSH, PERDIÓ-BASELINE, artefactos, overrides, etc.) es una **medición
> puntual** y el universo se mueve: NUNCA-PUSH se midió **434** (Gate 0.5) y **535** (mini-gate)
> con **11 días de diferencia → ~101 filas de drift** entre tomas. **Ningún número de este doc
> es un hecho clavado.** La cardinalidad real que gobierna la ejecución la fija **este
> checkpoint D2-3.5, re-medido al momento de correr**, no los conteos citados acá (que quedan
> solo como orden de magnitud y origen del diseño).

### 4.4 Reconciliación / barrida (idempotente, bidireccional, con guardrail)

**Set elegible (por chunk):** `status = ACTIVE` ∧ `syncStatus ∈ {SYNCED, OUTDATED}` ∧
`lastPushedPrice != null` (autoridad PricEcom).

Para cada fila: `eff = resolvePricing(...)`; `drift = |eff − lastPushedPrice|`.

| Condición | Acción | Resuelve |
|---|---|---|
| `eff == null` (no calculable) | dejar como está (no flipear a SYNCED) | seguridad |
| `drift > tolerancia` (§4.9) ∧ no-OUTDATED | → `OUTDATED` + `pendingSync=true` | **Bug B** |
| `drift ≤ tolerancia` (§4.9) ∧ OUTDATED ∧ **sin otra causa de pendiente** | → `SYNCED` + `pendingSync=false` | **Bug A** |
| resto | no-op | idempotencia |

**Guardrail bidireccional — causas de pendiente NO-precio que BLOQUEAN el clear `OUTDATED→SYNCED`
(lista CERRADA, no "etc."):**
1. `commercialTitleUserEdited = true` — título editado local sin pushear.
2. `commercialDescriptionUserEdited = true` — descripción editada local sin pushear.
3. `syncStatus = PENDING_SYNC` — acción de sistema encolada (pausa/auto-pausa/republish).
4. `syncStatus ∈ {ERROR, ERROR_SKU_CONFLICT}` — error vigente; el clear no debe taparlo.
5. `status != ACTIVE` — PAUSED/DRAFT/REMOVED no son "publicación activa sincronizada".

(3, 4 y 5 ya están excluidos por el set elegible; se reafirman como contrato. Si en el futuro
se agrega **drift de stock**, se suma como causa #6 — pero **stock está fuera de D2**: esta
barrida es solo precio.)

**Cadencia (híbrida, confirmada):** marcado **event-triggered** existente (D1, extracción,
edits, descuento) se mantiene + **barrida post-extracción** + **backstop periódico (~30 min)**.
Defensa en profundidad: triggers = latencia baja; barrida = cubre el path que nadie disparó
(Bug B) y limpia stale (Bug A).

**Idempotencia:** solo escribe en transiciones; sin cambios → 0 writes.

### 4.5 Autoridad-Woo (no tocar)
Filas `lastPushedPrice == null` quedan **fuera del set elegible**. Nunca se marcan OUTDATED.
`SYNCED` se mantiene = correcto. Forzarles baseline sería el bug.

### 4.6 Política "edit local reclama autoridad" — **PROSPECTIVA** (confirmado)
Cuando un edit local de precio (`finalPrice`/`manualMargin`) toca una fila `lastPushedPrice ==
null`, **reclama autoridad** → `syncStatus = PENDING_SYNC` + `pendingSync = true` (encolada
para push). Al pushear, se setea `lastPushedPrice` → autoridad PricEcom. Se aplica **solo a
edits nuevos** (prospectivo).

**Mini-gate de retroactividad (read-only, 2026-06-09) — resultado:** de **535** filas
autoridad-Woo, **solo 3** tienen override local (`finalPrice`; 0 `manualMargin`), todas de
**TOYS PALACE** y todas en `status=PAUSED`, creadas el mismo minuto (05-26 17:56 → operación
bulk, sin rastro de edit manual; **0 eventos IMPORT** en EventLog porque los imports fueron por
script). *(En esta medición se observaron **0** `finalPrice` de IMPOTEKNO en filas
autoridad-Woo; este documento NO verifica ninguna limpieza histórica — solo reporta lo
observado hoy.)*
→ **El retroactivo es despreciable y además inocuo-por-el-path:** esas 3 están PAUSED, así que
el drainer las *pausaría* en Woo, no empujaría su `finalPrice`. **Decisión: retroactivo NO se
hace** (prospectivo alcanza). Se deja registrado por si el universo cambia.

### 4.7 Limpieza del residuo legacy (0308 y similares)
**No requiere script aparte:** tras backfill + primera barrida, `0308` (`lastPushedPrice≈11201`,
`eff≈11805`) → **OUTDATED** correcto; los artefactos de pull-pisado → **SYNCED** correcto
(auto-corregidos). La primera barrida la gobierna el **gate de dry-run → writes (§4.7.1)**.

### 4.7.1 Gate de dry-run → writes (OK humano explícito, patrón Bazar 380)

> **La primera corrida de la barrida NO escribe transiciones — solo reporta lo que haría.**
> La transición **dry-run → writes es un gate con OK humano explícito** (mismo patrón que la
> limpieza de Bazar 380: FASE 1 dry-run → backup → revisión → FASE 2 writes), **no** una
> decisión de quien ejecuta el job.
> **El feature flag por sí solo NO autoriza writes:** habilita el job en modo medición; la
> autorización de escribir es un **paso humano separado** sobre el reporte del dry-run + backup
> tomado. Sin ese OK, la barrida nunca pasa de dry-run.

### 4.8 Batching y límites operativos
Barrida = job del worker. Acotada: `findMany` del set elegible + reglas (2 queries), cómputo en
memoria, `updateMany` por transición. Medición Gate 0: ~2754ms / 900 filas → barrida full del
universo actual < ~5s (orden de magnitud, no invariante). Igual **chunked** (~500/lote) y con
**tope por corrida** para crecer sin saturar Neon (free) ni competir con el worker. **CERO
llamadas a Woo** (§5).

### 4.9 Parámetros operativos (única fuente de verdad)

Estos son **parámetros operativos**, no reglas conceptuales — se definen UNA vez acá y las
demás secciones los **referencian** (no los re-definen):

| Parámetro | Valor | Dónde se usa |
|---|---|---|
| `DRIFT_TOLERANCE` | **$0.50** | comparación `\|computed − lastPushedPrice\|` en barrida (§4.4) y checkpoint D2-3.5 (§4.3) |
| cadencia backstop periódico | **~30 min** | §4.4 |
| disparo adicional | **post-extracción** | §4.4 |
| chunk por lote | **~500** | §4.8 |
| tope por corrida | **TBD (gate de implementación)** | §4.8 |

La tolerancia `$0.50` está alineada con la que ya usa `markPublicationsDrift` hoy; **no es un
invariante conceptual del modelo**, es un umbral ajustable.

---

## 5. Impacto DB / Impacto Woo

**DB:** +1 columna nullable (`lastPushedPrice`), additiva (migración rápida en Neon, sin lock
relevante). Sin índice nuevo inicial (`@@index([storeId, lastPushedPrice])` se agrega después si
el volumen lo pide). Backfill: lee EventLog acotado, escribe la columna nueva, chunked. Barrida:
writes solo en transiciones.

**Woo:** **CERO.** Todo D2 (baseline + backfill + checkpoint + barrida + autoridad + política de
edit local prospectiva) **no hace una sola llamada a Woo** — solo lee DB, computa con
`resolvePricing`, escribe flags. La propagación real (push) sigue siendo el drainer existente,
**separado**. Es la propiedad de seguridad central y el argumento para hacer D2 **antes** del
sprint del catch/propagación.

**Frontera de entorno (secuenciamiento aceptado):** todo D2 (baseline, backfill, checkpoint,
barrida, autoridad y política edit-local prospectiva) **no realiza llamadas a Woo**, por lo que
es **ejecutable contra prod con la disciplina de datos tipo Bazar 380** (backup, dry-run,
transacción, re-conteo) **sin esperar la separación de entorno no-prod**. Los cambios que
impliquen **pushes reales a Woo quedan fuera de alcance de D2** y siguen gateados por el sprint
de `publishProductToWoo` (clasificación de errores) y por la decisión de entorno no-prod.

---

## 6. Plan de migración + rollback

**Secuencia:**
1. **Schema:** `ADD COLUMN lastPushedPrice` (nullable) vía `prisma migrate`. Additiva, sin downtime.
2. **Código de push:** los paths de push setean `lastPushedPrice = price`. Deploy.
3. **Backfill:** script controlado (backup → set desde EventLog → idempotente → borrar). Dry-run primero.
4. **CHECKPOINT (§4.3):** medición read-only — autoridad-PricEcom + drift latente. **Antes** de cualquier write de la barrida.
5. **Barrida:** detrás de **feature flag** (que **NO** autoriza writes por sí solo). Arranca en
   **dry-run** (reporta sin escribir). El paso **dry-run → writes es un gate con OK humano
   explícito** sobre el reporte + backup (§4.7.1) — no lo decide quien ejecuta.
6. **Política edit-local (prospectiva):** se engancha en los paths de edit.

**Rollback (por capa):**
- **Barrida:** apagar feature flag → comportamiento previo. Backup de la primera corrida restaura `syncStatus`/`pendingSync`. *(Acá vive el riesgo real — por eso dry-run + flag + backup.)*
- **Backfill:** solo pobló la columna nueva → rollback = `SET lastPushedPrice = NULL`. No tocó campos existentes → reversión trivial.
- **Código de push:** revertir el write → la columna deja de actualizarse; inerte.
- **Schema:** columna additiva/nullable → **dejarla** aunque se revierta el código (inocua). Drop solo por limpieza cosmética (destructivo del baseline → evitar).

Orden de seguridad: schema → push-code → backfill (dry-run→apply) → **checkpoint** → barrida
(dry-run→flag on). Cada paso reversible sin tocar el anterior.

---

## 7. Alternativas evaluadas

**Baseline:** (A) columna `lastPushedPrice` + autoridad derivada **[elegida]**; (B) repurposear
`priceInStore` + nueva `wooObservedPrice` [toca todos los writers de pull, más superficie];
(C) `priceAuthority` enum explícita [redundante con la null-ness]; (D) derivar on-read desde
EventLog [caro + el valor pull-pisado ya se perdió → hay que materializar igual].

**Sweep:** (A) híbrida triggered + periódica **[elegida, defensa en profundidad]**; (B) solo
periódica [latencia alta]; (C) solo triggered [es la debilidad de Bug B]; (D) on-read [estado no
materializado].

**Edit-local:** (A) `PENDING_SYNC` (intención de push) **[elegida]**; (B) `OUTDATED` con baseline
= `priceInStore` (valor de Woo) [contradice el modelo].

**Limpieza legacy:** (A) la primera barrida con dry-run+backup **[elegida]**; (B) script one-off
por cohorte [más manual].

---

## 8. Fuera de alcance de D2 (gates separados)

- **Propagación / batching del drainer** (push real a Woo): D2 detecta y limpia estado, **no
  empuja**. Sprint propio.
- **Bug del catch de `publishProductToWoo`** (clasificación de errores): sprint separado.
- **Lector de Woo en vivo / invariante divergencia-con-Woo:** fuera de Modelo C (§1).
- **Drift de stock:** la barrida es solo precio.

---

## 9. Decisiones — estado

**Confirmadas (Gate 1):**
1. Modelo C (autoridad-por-campo).
2. `lastPushedPrice` persistido, autoridad derivada de su null-ness, separado de `priceInStore`.
3. Política edit-local **prospectiva** (retroactivo descartado por el mini-gate §4.6).
4. Barrida híbrida: post-extracción + backstop periódico ~30 min.
5. Primera corrida: dry-run → backup → revisión → writes.
6. Contrato de SYNCED literal + caso límite NY-9808C (§1).
7. Checkpoint de medición entre backfill y barrida (§4.3).
8. Bug A y Bug B documentados como conceptos separados (§3).

**Pendientes (gate de implementación, prompt separado):**
- Plan de ejecución detallado y secuenciado.
- Nombre final de la feature flag, cadencia exacta del backstop, tamaño de chunk/tope.
