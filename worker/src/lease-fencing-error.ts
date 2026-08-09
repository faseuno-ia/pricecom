// 2G-R8 · señal interna compartida: el CAS de ownership dentro de una tx fenced afectó 0 filas (lease
// perdido) → rollback de toda la transacción comercial. No es un fallo del job.
export class LeaseFencingError extends Error {
  constructor() { super("LEASE_FENCING_LOST"); this.name = "LeaseFencingError"; }
}
