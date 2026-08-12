// 2G-R9-PR1 · Entrypoint de DESARROLLO LOCAL. Habilita el poller por defecto para que `npm run dev`
// siga levantando el worker sin fricción. En PRODUCCIÓN NO se usa este archivo: Railway arranca
// worker/src/index.ts directamente (worker/Dockerfile) y WORKER_ENABLED lo inyecta el servicio
// pricecom-worker. Respeta un WORKER_ENABLED explícito si ya viene seteado (p. ej. "false" para probar
// el modo deshabilitado en local).
process.env.WORKER_ENABLED = process.env.WORKER_ENABLED ?? "true";
void import("./index");
