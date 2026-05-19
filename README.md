# PricEcom.

**Inteligencia de precios.** Extractor de catálogos de proveedores
mayoristas que genera Excel estructurados con productos, precios y stock, y
permite descargar las imágenes de los productos en lote.

---

## Stack

- **Next.js 14** (App Router) — UI dark mode + API routes
- **Prisma** + **PostgreSQL** (Neon en producción, Docker local opcional)
- **Playwright** + **Cheerio** — scraping con JS ejecutado y parsing estático
- **ExcelJS** — generación de spreadsheets
- **JSZip** — empaquetado de imágenes en el cliente
- **Tailwind CSS** + `lucide-react` + `sonner` — UI

---

## Arquitectura

```
pricecom/
├── app/                              ← Next.js 14 (App Router)
│   ├── dashboard/                    ← KPIs + worker health + actividad reciente
│   ├── providers/                    ← cards, edit, config de selectores
│   ├── extractions/                  ← lista paginada + detalle por job
│   ├── new-extraction/               ← cards selector + progress + logs live
│   └── api/
│       ├── providers/                ← CRUD + selectores CSS
│       ├── extractions/              ← start, status, download Excel
│       └── products/
│           └── download-images/      ← ZIP de imágenes con fallback de resolución
├── components/
│   ├── extractions/                  ← products-table, new-extraction-form
│   ├── providers/                    ← scraper-config-form, provider-actions
│   ├── layout/                       ← sidebar, footer
│   └── ui/                           ← status-badge, progress-bar
├── worker/
│   └── src/
│       ├── index.ts                  ← poll loop + job lock atómico
│       └── queues/
│           ├── job-queue.interface.ts
│           ├── db-polling-queue.ts   ← implementación PostgreSQL (default)
│           └── bullmq-queue.stub.ts  ← stub para migración futura a Redis
├── lib/
│   ├── scraper/                      ← motor Playwright + Cheerio
│   ├── excel/                        ← generador ExcelJS
│   ├── db/                           ← cliente Prisma singleton
│   ├── system/                       ← worker health, queue depth
│   └── utils/                        ← schemas Zod, AES-256, helpers
├── prisma/
│   └── schema.prisma                 ← Provider, ExtractionJob, ExtractedProduct, ...
└── exports/                          ← Excels generados (creada en runtime)
```

---

## Setup

### 1. Dependencias

```bash
npm install
npx playwright install chromium
```

### 2. Base de datos — Neon (recomendado)

1. Crear un proyecto en https://neon.tech (free tier alcanza para development).
2. Copiar el connection string (incluye `?sslmode=require`).
3. Generar también un `DIRECT_URL` desde la consola de Neon (sin pooling).

**Alternativa local con Docker:**

```bash
docker run -d --name pricecom-pg -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=pricecom -p 5432:5432 postgres:16
```

### 3. Variables de entorno

```bash
cp .env.example .env
```

Editar `.env`:

```env
DATABASE_URL="postgresql://...neon.tech/...?sslmode=require"
DIRECT_URL="postgresql://...neon.tech/...?sslmode=require"   # sin pooling
NEXTAUTH_URL="http://localhost:3000"
NEXTAUTH_SECRET="<openssl rand -base64 32>"
ENCRYPTION_KEY="<64 hex chars: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\">"
```

### 4. Schema + cliente Prisma

```bash
npx prisma db push       # crea/actualiza tablas sin migración
npx prisma generate      # regenera el cliente TypeScript
```

> `db push` es lo más simple para development con Neon. Si necesitás migraciones
> versionadas, usá `npx prisma migrate dev --name <nombre>`.

### 5. Arrancar

```bash
npm run dev              # Next.js (3000) + worker en paralelo
```

O por separado:

```bash
npm run dev:app          # solo Next.js
npm run worker           # solo worker (tsx watch)
```

---

## Hot reload del worker — gotcha

`tsx watch` del worker **no detecta cambios en `lib/`**. Después de editar
archivos compartidos (scraper, utils, db) hay que reiniciar `npm run dev`
para que el worker tome los cambios.

---

## Scripts

| Comando | Descripción |
|---|---|
| `npm run dev` | Next.js + worker en paralelo (hot reload) |
| `npm run dev:app` | Solo Next.js |
| `npm run worker` | Solo worker con `tsx watch` |
| `npm run worker:start` | Worker sin hot reload (producción) |
| `npm run build` | Build producción |
| `npm run start` | Servir build |
| `npm run db:push` | Aplicar schema sin migración |
| `npm run db:migrate` | Crear y aplicar migración |
| `npm run db:studio` | Abrir Prisma Studio |
| `npm run db:seed` | Crear usuario inicial |

---

## Variables de entorno

| Variable | Req. | Descripción |
|---|---|---|
| `DATABASE_URL` | ✅ | Connection string de PostgreSQL (con pooling en Neon) |
| `DIRECT_URL` | ✅ | Connection string directo (sin pooling) para migrations |
| `NEXTAUTH_URL` | ✅ | URL pública (ej: `http://localhost:3000`) |
| `NEXTAUTH_SECRET` | ✅ | Secreto JWT (32+ bytes random) |
| `ENCRYPTION_KEY` | ✅ | Clave AES-256 (64 hex chars) para credenciales de proveedores |
| `WORKER_POLL_INTERVAL` | ❌ | Polling en ms (default: 5000) |
| `WORKER_STALE_TIMEOUT_MS` | ❌ | Cuánto esperar antes de liberar un job RUNNING huérfano (default: 600000) |

---

## Concurrencia del worker

El worker toma jobs con una query atómica de PostgreSQL:

```sql
UPDATE "ExtractionJob"
SET    status = 'RUNNING', "workerLockedAt" = NOW(), "workerPid" = $pid
WHERE  id = (
  SELECT id FROM "ExtractionJob"
  WHERE  status = 'PENDING'
  ORDER  BY "createdAt" ASC
  LIMIT  1
  FOR UPDATE SKIP LOCKED
)
RETURNING id, "providerId";
```

`FOR UPDATE SKIP LOCKED` garantiza que N workers en paralelo nunca tomen el
mismo job. Si un worker muere con un job en RUNNING, cada ~12 polls se revisan
locks viejos (`workerLockedAt > WORKER_STALE_TIMEOUT_MS`) y se devuelven a
PENDING automáticamente.

---

## Scraper — paginación soportada

El campo `nextPageSelector` del proveedor activa modos distintos:

| Selector contiene | Modo | Cómo funciona |
|---|---|---|
| `page` | **path** | Construye `/page/N/` incrementalmente (Tienda Nube clásico) |
| `mpage` o `load-more` | **mpage** | Construye `?mpage=N` (Tienda Nube scroll infinito); el DOM acumula tarjetas, el scraper trackea offset para procesar solo las nuevas |
| (cualquier otro) | **selector** | Clickea el botón "siguiente" hasta que no se encuentra |

Tras cada navegación URL espera `networkidle` + `waitForProductsToStabilize`
(polling del conteo de cards hasta que se estabilice, máx 5s) antes de leer
el DOM. Corta automáticamente al detectar:
- 0 productos nuevos tras dedup
- HTTP ≥ 400
- `maxPages` alcanzado

El motivo de corte queda logueado como `Motivo final de corte: stop: ...`
para diagnóstico.

---

## Descarga de imágenes

`POST /api/products/download-images` recibe `{ productIds: string[] }` (máx 100
por request) y devuelve un ZIP. Características:

- **Fallback de resolución** para Tienda Nube: intenta `-1024-0`, `-640-0`,
  `-480-0`, `-320-0`, `-240-0` en orden hasta que una responda 200.
- **Nombrado configurable**: `[imageFilenamePrefix][SKU].[ext]` donde el prefijo
  se configura por proveedor (ej: `B380-` → `B380-21022.jpg`).
- **Errores no rompen el ZIP**: las URLs fallidas se acumulan en `errores.txt`
  dentro del archivo.
- **Persistencia**: `imageFileName` + `imageDownloadedAt` se guardan por producto.

La UI soporta **descarga en lotes** transparente: si seleccionás más de 100
productos, el cliente trocea, hace N requests, y mergea los ZIPs con JSZip
en el browser antes de bajar el archivo final.

---

## Archivos Excel

Se guardan en `/exports` (fuera de `/public`) y se sirven via
`/api/extractions/download/[filename]` con validación de path traversal.

Hojas: **Productos** (14 columnas con formato) + **Resumen** (estadísticas).

---

## API REST

```
POST   /api/providers                       Crear proveedor
GET    /api/providers                       Listar
GET    /api/providers/:id                   Detalle
PUT    /api/providers/:id                   Editar
PATCH  /api/providers/:id                   Update parcial (ej: isActive)
DELETE /api/providers/:id                   Eliminar (cascade jobs+products)
POST   /api/providers/:id/config            Guardar selectores CSS

POST   /api/extractions/start               Crear job PENDING
GET    /api/extractions                     Historial
GET    /api/extractions/:id/status          Estado + progress + logs
GET    /api/extractions/:id/logs            Logs
GET    /api/extractions/download/:fn        Descargar Excel

POST   /api/products/download-images        ZIP de imágenes (≤100 IDs/request)
```

---

## Migración futura a Redis/BullMQ

El worker está desacoplado detrás de la interfaz `IJobQueue`. Para migrar:

1. `npm install bullmq ioredis`
2. Implementar `BullMqQueue` (ver `worker/src/queues/bullmq-queue.stub.ts`)
3. En `worker/src/index.ts` cambiar **una línea**:
   ```ts
   // const queue: IJobQueue = new DbPollingQueue(prisma);
   const queue: IJobQueue = new BullMqQueue();
   ```

El resto del código no cambia.

---

## Integración Ecommerce futura

PricEcom no se queda en extraer y exportar a Excel. La siguiente fase convierte
los catálogos extraídos en publicaciones reales en las tiendas del usuario,
cerrando el ciclo proveedor → catálogo propio → venta online.

### Flujo objetivo

1. **Seleccionar productos** extraídos (desde la vista de detalle de extracción
   o desde un buscador transversal de productos de todos los proveedores).
2. **Aplicar margen de venta** vía `PricingRule` con scopes anidados
   (global → proveedor → categoría → producto), método `markup` o `margin`,
   y redondeo opcional al múltiplo más cercano.
3. **Asignar categorías y subcategorías** propias usando `Category`
   (jerárquica vía `parentId`) y `ProductCategoryMapping` para traducir las
   categorías raw del proveedor a la taxonomía propia.
4. **Gestionar imágenes**: usar la descarga masiva ya disponible o re-subir
   las URLs originales al CDN de la tienda destino.
5. **Publicar masivamente** en una o más tiendas (`Store`) seleccionadas. Cada
   publicación queda registrada en `ProductPublication` con su `status`
   (`selected → prepared → published` o `error_publication`).
6. **Guardar el `externalProductId`** devuelto por la tienda en cada
   publicación exitosa, para soportar updates idempotentes posteriores.
7. **Sincronizar precio y stock** en futuras extracciones: cuando un producto
   ya publicado vuelve a aparecer en una extracción nueva, se le aplica la
   `PricingRule` correspondiente y se hace `updateProduct(externalId, ...)` en
   cada tienda en la que esté publicado.

### Plataformas previstas

| Plataforma | Conector | Estado |
|---|---|---|
| TiendaNube | `lib/integrations/tiendanube/` | Stub — pendiente de implementar |
| Shopify | `lib/integrations/shopify/` | Stub — pendiente de implementar |
| WooCommerce | `lib/integrations/woocommerce/` | Stub — pendiente de implementar |

Todos los conectores implementan la misma interfaz `IEcommerceIntegration`
(`lib/integrations/integration.interface.ts`) — `createProduct`,
`updateProduct`, `uploadImage`, `productExistsBySku`. Esto permite que la
capa de negocio (selección, pricing, publicación) sea agnóstica de la
plataforma destino.

### Nota técnica

Los modelos actuales (`Store`, `StoreIntegration`, `ProductPublication`,
`PricingRule`, `Category`, `ProductCategoryMapping`) están diseñados como
esqueletos extensibles: cada uno tiene los campos mínimos para arrancar
pero puede crecer (índices, relaciones adicionales, campos específicos por
plataforma) **sin migraciones destructivas**. La sincronización
producto ↔ publicación queda explícita vía `ProductPublication.externalProductId`,
y el estado del flow vive en `ExtractedProduct.publicationStatus` y
`ProductPublication.status`. **Ningún modelo o decisión del schema actual
debería bloquear esta evolución**: la integración ecommerce se monta
encima sin tocar la lógica de scraping ni el worker.

---

## Aviso legal

Esta herramienta debe usarse únicamente sobre sitios donde el usuario tenga
autorización, acceso legítimo o relación comercial con el proveedor. El uso
no autorizado puede violar los términos de servicio del sitio extraído.
