// 2G-R9-PR1 · Predicado puro para el guard de CI de topología: detecta si una superficie de arranque
// referencia el entrypoint del worker (worker/src/index[.ts]). Se usa contra las superficies del
// SERVICIO WEB (root Dockerfile CMD/ENTRYPOINT, railway startCommand, Procfile, npm start) para impedir
// que se reintroduzca el poller-sidecar accidental (causa raíz del dual-poller 2026-05-24).

export function startupSurfaceReferencesWorkerLoop(content: string): boolean {
  return /worker\/src\/index(\.ts)?/.test(content);
}
