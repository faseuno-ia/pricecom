# PriceHub

**Inteligencia de precios mayoristas.** Extractor de listas de precios desde
páginas web de proveedores mayoristas. Genera archivos Excel estructurados con
productos, precios y stock.

---

## Arquitectura

```
precio-mayorista/
├── app/                        ← Next.js 14 (UI + API Routes)
│   ├── dashboard/
│   ├── providers/
│   │   ├── new/
│   │   └── [id]/edit/ y config/
│   ├── extractions/
│   ├── new-extraction/         ← progress bar + logs en vivo
│   └── api/
│       ├── providers/
│       └── extractions/
│           ├── start/
│           ├── [id]/status/    ← polling (status + progress + logs)
│           └── download/[fn]/  ← descarga segura del Excel
├── worker/
│   └── src/
│       ├── index.ts            ← Poll loop principal
│       └── queues/
│           ├── job-queue.interface.ts    ← Interfaz IJobQueue
│           ├── db-polling-queue.ts       ← Implementación PostgreSQL (actual)
│           └── bullmq-queue.stub.ts      ← Stub para migración futura a Redis
├── lib/
│   ├── scraper/                ← Motor Playwright + Cheerio
│   ├── excel/                  ← Generador ExcelJS
│   ├── db/                     ← Cliente Prisma singleton
│   └── utils/                  ← Schemas Zod, cifrado AES-256, helpers
├── exports/                    ← Archivos Excel generados (creada automáticamente)
└── docker-compose.yml
```

---

## Instalación

### 1. Instalar dependencias

```bash
npm install
```

### 2. Levantar PostgreSQL

```bash
docker compose up -d
```

PostgreSQL en `localhost:5432` — usuario: `postgres`, contraseña: `postgres`, DB: `precio_mayorista`

### 3. Configurar variables de entorno

```bash
cp .env.example .env
```

Generar las claves:

```bash
# NEXTAUTH_SECRET
echo "NEXTAUTH_SECRET=$(openssl rand -base64 32)" >> .env

# ENCRYPTION_KEY
echo "ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" >> .env
```

### 4. Crear tablas

```bash
npx prisma migrate dev --name init
```

### 5. Instalar Playwright

```bash
npx playwright install chromium
```

### 6. (Opcional) Usuario inicial

```bash
npm run db:seed
# → admin@example.com / admin123
```

---

## Correr el proyecto

**Todo junto (recomendado):**
```bash
npm run dev
```

**Por separado:**
```bash
# Terminal 1
npm run dev:app      # Next.js en http://localhost:3000

# Terminal 2
npm run worker       # Worker con hot reload
```

**Producción:**
```bash
npm run build
npm run start &
npm run worker:start
```

---

## Scripts

| Comando | Descripción |
|---------|-------------|
| `npm run dev` | App + Worker (hot reload) |
| `npm run dev:app` | Solo Next.js |
| `npm run worker` | Solo Worker (tsx watch) |
| `npm run worker:start` | Worker sin hot reload |
| `npm run build` | Build producción |
| `npx prisma migrate dev` | Crear y aplicar migración |
| `npm run db:push` | Aplicar schema sin migración |
| `npm run db:studio` | Abrir Prisma Studio |
| `npm run db:seed` | Crear usuario inicial |

---

## Variables de entorno

| Variable | Req. | Descripción |
|----------|------|-------------|
| `DATABASE_URL` | ✅ | URL PostgreSQL |
| `NEXTAUTH_URL` | ✅ | URL pública de la app |
| `NEXTAUTH_SECRET` | ✅ | Secreto JWT |
| `ENCRYPTION_KEY` | ✅ | Clave AES-256 para credenciales |
| `WORKER_POLL_INTERVAL` | ❌ | Polling en ms (default: 5000) |
| `WORKER_STALE_TIMEOUT_MS` | ❌ | Tiempo para liberar job bloqueado (default: 600000) |

---

## Bloqueo atómico (FOR UPDATE SKIP LOCKED)

El worker usa una query PostgreSQL atómica para evitar race conditions:

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

`FOR UPDATE SKIP LOCKED` garantiza que N workers en paralelo nunca tomen el mismo job.

Jobs stale: si un worker muere, el job queda en RUNNING. Cada ~12 polls, el worker revisa
jobs con `workerLockedAt` viejo y los devuelve a PENDING automáticamente.

---

## Migración futura a Redis/BullMQ

El worker está desacoplado detrás de la interfaz `IJobQueue`. Para migrar:

1. `npm install bullmq ioredis`
2. Implementar `BullMqQueue` (ver `worker/src/queues/bullmq-queue.stub.ts`)
3. En `worker/src/index.ts` cambiar **una sola línea**:
   ```typescript
   // Cambiar:
   const queue: IJobQueue = new DbPollingQueue(prisma)
   // Por:
   const queue: IJobQueue = new BullMqQueue()
   ```

El resto del código no cambia.

---

## Archivos Excel

Se guardan en `/exports` (fuera de `/public`) y se sirven via
`/api/extractions/download/[filename]` con validación de path traversal.

**Hojas:** "Productos" (14 columnas con formato) + "Resumen" (estadísticas).

---

## API REST

```
POST   /api/providers                  Crear proveedor
GET    /api/providers                  Listar
GET/PUT/DELETE /api/providers/:id      Detalle / Editar / Eliminar
POST   /api/providers/:id/config       Guardar selectores CSS

POST   /api/extractions/start          Crear job PENDING
GET    /api/extractions                Historial
GET    /api/extractions/:id/status     Estado + progress + logs
GET    /api/extractions/download/:fn   Descargar Excel
```

---

## ⚠️ Aviso legal

Usar únicamente sobre sitios donde se tenga autorización, acceso legítimo o relación
comercial con el proveedor. El uso no autorizado puede violar términos de servicio.
