# Separar worker en Railway

## Por qué

Hoy la app web y el worker corren juntos con `concurrently` en un solo
servicio Railway. Eso causa que:

- Un worker colgado en una extracción afecte la app.
- Los deploys interrumpan extracciones en curso.
- No se pueda reiniciar el worker sin reiniciar la app.
- Playwright (~500MB RAM por contexto) compita por recursos con Next.js.

La solución es tener **dos servicios Railway** que apuntan al mismo repo
pero arrancan con comandos distintos, compartiendo DB y `ENCRYPTION_KEY`.

## Arquitectura

```
faseuno-ia/pricecom (un solo repo)
  ├── pricecom-app    (Next.js)            ── railway.toml         ── npm run start
  └── pricecom-worker (poll loop + scraper) ── worker/railway.toml  ── npm run worker:start
```

Ambos servicios comparten:
- La misma base de datos Neon (`DATABASE_URL`, `DIRECT_URL`).
- La misma clave de cifrado de credenciales (`ENCRYPTION_KEY`).
- El mismo deploy disparado por `git push origin main`. Railway redeploya
  el servicio cuyo `railway.toml` está más cerca del commit.

## Pasos para configurar el segundo servicio

1. En Railway dashboard → proyecto `extraordinary-delight`.
2. **New Service** → **GitHub Repo** → mismo repo `faseuno-ia/pricecom`.
3. Nombre: `pricecom-worker`.
4. En **Settings** del nuevo servicio:
   - Root Directory: `/` (raíz del repo — Railway lee `worker/railway.toml`
     solo si pones `Root Directory: worker`, pero como queremos compartir
     `node_modules` y la build, dejamos `/` y forzamos el start command).
   - Start Command: `npm run worker:start`.
5. En **Variables** del nuevo servicio, agregar:
   - `DATABASE_URL` (mismo valor que `pricecom-app`).
   - `DIRECT_URL` (mismo valor).
   - `ENCRYPTION_KEY` (mismo valor — sin esto las credenciales de
     proveedores no se pueden descifrar).
   - `WORKER_POLL_INTERVAL=5000`.
   - `WORKER_STALE_TIMEOUT_MS=600000`.
6. En el servicio original `pricecom-app`:
   - Asegurar que el Start Command sea `npm run start` (no `npm run dev`
     ni el comando con `concurrently`).
   - Eliminar `WORKER_*` si quedaron seteadas — el servicio app no las
     necesita.
7. Deploy ambos servicios.
8. Verificar en logs de `pricecom-worker` que el banner del poll loop
   aparece:
   ```
   ⚙  Worker iniciado
      PID:            ...
      Poll interval:  5000ms
   ```
9. Verificar en logs de `pricecom-app` que Next.js arranca solo (sin el
   banner del worker).

## Verificación funcional

- Lanzar una extracción desde `/new-extraction`.
- En logs de `pricecom-worker`: el job se toma, corre, y se completa.
- En logs de `pricecom-app`: solo aparece la request HTTP que creó el job.
- Reiniciar `pricecom-worker` desde Railway → la app sigue respondiendo.
- Hacer un cambio de UI y `git push` → solo `pricecom-app` se redeploya.

## Desarrollo local

**No cambia.** El script `npm run dev` sigue arrancando ambos con
`concurrently`:

```bash
npm run dev
# arranca next dev + tsx watch worker/src/index.ts en paralelo
```

La separación solo aplica al entorno productivo de Railway.

## Pendientes conocidos

- **Excels generados se pierden en cada deploy** del worker. El path es
  local al contenedor (`/public/exports/...`). Migrar a R2/S3 antes de
  hacer que esto sea visible a clientes finales. Es un problema separado
  de este sprint.
- **Playwright en Nixpacks**: si la build de `pricecom-worker` se queja por
  Chromium, agregar `PLAYWRIGHT_BROWSERS_PATH=0` o seguir las instrucciones
  oficiales de Playwright para Railway/Nixpacks.
