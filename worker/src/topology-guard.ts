// 2G-R9-PR1 · Predicado puro para el guard de CI de topología.
//
// ENTRYPOINT-BASED, no filename-based: el servicio WEB nunca debe arrancar NINGÚN entrypoint del worker.
// Todos los entrypoints que pueden terminar iniciando pollLoop() viven bajo `worker/src/` (index.ts lo
// define; dev.ts lo importa forzando WORKER_ENABLED=true; cualquier wrapper futuro también viviría ahí).
// Por eso el predicado detecta CUALQUIER referencia a `worker/src/` en una superficie de arranque web —
// así cubre index.ts, dev.ts y wrappers aún inexistentes sin depender de una lista de nombres.

/** true si `content` (una superficie de arranque) referencia algún entrypoint del worker (`worker/src/…`). */
export function startupSurfaceReferencesWorkerLoop(content: string): boolean {
  return /worker\/src\//.test(content);
}

/** true si `content` referencia el entrypoint de DESARROLLO (dev.ts), que fuerza WORKER_ENABLED=true. */
export function startupSurfaceReferencesDevEntrypoint(content: string): boolean {
  return /worker\/src\/dev(\.ts)?/.test(content);
}
