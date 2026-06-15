# WooCommerce Store API extractor — diseño

Extractor de catálogo para proveedores que son tiendas WooCommerce con la
**Store API** abierta. En vez de scrapear HTML con Playwright, consume el JSON
de `/wp-json/wc/store/v1/products`. Implementado en
`lib/extractors/woo-store-api-extractor.ts`.

Estado: completo, deployado y validado en prod con 2 proveedores —
**JUGUETES ELY** (`importadorahaote.com`) y **LEDMOMENTS** (`ledmoments.com`).
Ambos extraídos y re-extraídos OK, sin duplicados, con SKUs pelados.

---

## Qué es y por qué

Algunos proveedores exponen su catálogo como una tienda WooCommerce con la
Store API pública. Esa API devuelve los productos en JSON estructurado
(precios, categorías, imágenes, flags), así que **no hace falta parsear HTML**.

Ventajas frente al scraper HTML:
- **Más rápido y fiable**: LEDMOMENTS = 543 productos en ~9s. No hay navegador,
  ni selectores que se rompan cuando el proveedor cambia el theme.
- **Datos limpios**: precio, categorías e imágenes vienen tipados desde la API,
  no inferidos de markup.

El extractor es un módulo **puro**: recibe `fetch` inyectado (`fetchFn`), así que
es testeable con fixtures sin red (`tests/unit/woo-store-api-extractor.test.ts`).

---

## providerType `WOO_STORE_API`

Valor nuevo del enum `ProviderType` (`prisma/schema.prisma`). El dispatch vive en
`worker/src/index.ts`: en `processJob` hay un branch por `provider.providerType`:

- `WOO_STORE_API` → llama `extractWooStoreApi({ baseUrl, skuPrefix, fetchFn, onProgress, onLog })`.
- cualquier otro → `ScraperService.run(...)` (flujo HTML existente, **idéntico**).

Ambos caminos producen `ScrapedProduct[]` — el **mismo contrato** —, así que
todo el pipeline aguas abajo (`createMany`, `upsertCatalogProducts`, comparación,
Excel) es idéntico para ambos. El branch es la única bifurcación.

`WOO_STORE_API` se trata como **fuente extraíble** (igual que `SCRAPER`) en toda
la UI y el gating de backend, vía el helper `lib/providers/provider-type.ts`
(`isExtractableProvider` = SCRAPER || WOO_STORE_API). La única diferencia con
SCRAPER es que **no tiene selectores** (`hasScraperSelectors` = solo SCRAPER), por
lo que se le oculta el gear/link de configuración de selectores.

---

## Acceso a la API

Ambos sitios **devuelven 403 a IPs de datacenter** (incluido el entorno de Claude
Code), pero responden **200 desde IP residencial AR y desde Railway** (donde corre
el worker). **No se necesita proxy.** Por eso los dry-runs del extractor contra la
API real los corre Daniel desde su máquina, no Claude Code.

---

## Paginación

- `per_page=100`, `?page=N`.
- El total de páginas se lee del header **`X-WP-TotalPages`** en la respuesta de
  la página 1.
- **Fail-loud**: cualquier respuesta con HTTP ≠ 200 (en cualquier página) **aborta
  la extracción con throw**. Nunca devuelve una lista parcial — una extracción
  incompleta haría que el upsert marcara como `SUPPLIER_REMOVED` a los productos
  de las páginas que faltaron.

---

## Precio

```
wholesalePrice = Number(prices.price) / 10 ** prices.currency_minor_unit
```

- Haote: `currency_minor_unit = 0` → `price` tal cual.
- LEDMOMENTS: `currency_minor_unit = 2` → `price / 100`.

Es el precio **RAW del proveedor, sin descuento**. El `listDiscountPercent`
(JUGUETES ELY = 0, LEDMOMENTS = 40) lo aplica el **pricing-engine**, NO el
extractor. El extractor nunca toca márgenes ni descuentos.

---

## Filtros de exclusión

Definidos como constantes nombradas en el extractor. Se excluyen del resultado:

- `is_purchasable === false` — productos de alquiler / no comprables.
- `type === "woosb"` — bundles/combos (plugin WooSB).
- `type === "variable"` con `prices.price_range != null` — variables con rango de
  precio (no un precio único).

Validado contra la API real: **0 leaks** de cada filtro en ambos proveedores.

---

## SKU del proveedor (CRÍTICO)

> **El `sku` del proveedor = `String(product.id)` PELADO, SIN prefijo.**

El `skuPrefix` (`ELY-`, `LEDM-`) **NO** va en el `sku` del proveedor. El prefijo
se aplica recién **al PUBLICAR**, donde se genera el SKU comercial:

```
SKU comercial = provider.skuPrefix + catalogProduct.sku   (en publication-service)
```

Ejemplo correcto: producto Woo id `31385` → `cp.sku = "31385"` → al publicar →
`"ELY-" + "31385" = "ELY-31385"`.

### Lección (regresión real, ya corregida)

La **primera versión** del extractor hacía `sku = ${skuPrefix}${id}` (ej.
`"ELY-31385"`). Eso era un bug: al publicar habría dado **doble prefijo**
(`"ELY-" + "ELY-31385" = "ELY-ELY-31385"`).

- Corregido en el código por el commit **`d739e8f`** (`sku: String(p.id)`).
- Los **2094 SKUs ya extraídos** con la versión vieja se limpiaron con un `UPDATE`
  server-side (quitar el prefijo). 0 colisiones, 0 publicaciones afectadas (nada
  estaba publicado todavía).
- Hay un **test anti-regresión** que pinea que el `sku` **NO depende del
  `skuPrefix`**: mismo id con prefijos distintos → mismo `sku` pelado.

`skuPrefix` se mantiene en `WooStoreApiOptions` por compatibilidad con el call
site del worker, pero el extractor **no lo usa** para el `sku`.

---

## Mayúsculas

`supplierName` y `supplierDescription` se guardan en **MAYÚSCULAS** vía
`toLocaleUpperCase("es-AR")` (respeta acentos y ñ). Es una **regla UNIVERSAL**:
aplica a TODOS los proveedores (scrapers HTML + Woo), no solo a este frente.

Vive en `upsertCatalogProducts` (helper `lib/catalog/uppercase.ts`), **no** en el
extractor: el extractor entrega el `name` **crudo** y el upsert lo mayuscula. Así
la regla está en un solo lugar y vale para todos los orígenes de catálogo.

---

## Stock

Se **ignora `is_in_stock`**: la presencia de un producto en la respuesta de la API
significa "disponible". `ScrapedProduct.stock = null`.

La **ausencia** de un producto que antes estaba (entre extracciones) se maneja con
el mecanismo existente de `SUPPLIER_REMOVED` del upsert/comparación. Verificado: 0
productos en estado publicado-pero-sin-stock.

---

## Categoría

`supplierCategory` = **última categoría del array** `categories` (la más
específica). **No** se auto-mapea a una categoría de Woo — el mapeo a categoría de
la tienda es manual hoy (ver deuda en `known-debts.md`).

---

## Imágenes

Se toma solo la **imagen principal**: `images[0].src`. Las imágenes secundarias se
descartan en esta etapa (ver deuda de multi-imagen + storage R2 en
`known-debts.md`).

---

## Creación de proveedores

Los proveedores `WOO_STORE_API` se crean **por script** (no por la UI). El
`provider-form` (`components/providers/provider-form.tsx`) y el `providerSchema`
de zod (`lib/utils/schemas.ts`) **no soportan** `WOO_STORE_API` todavía — es una
deuda latente si se quisiera crear/editar Woo desde la UI (ver `known-debts.md`).

El alta se hizo asociando los proveedores al `userId` real (admin@pricecom.com,
el mismo de los proveedores existentes), con guard de idempotencia por `baseUrl`
y verificación post-insert.
