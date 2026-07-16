// The API contract, shared by server (producer) and admin/liff (consumers).
//
// Types only — no runtime code. Consumers import with `import type`, which is
// erased at compile time, so nothing here needs a build step or resolves at
// runtime. Adding a value export (a constant, a schema) would break that and
// force this package to be built before server can start.

/** GET /api/health */
export type HealthResponse = HealthOk | HealthError

export type HealthOk = {
  status: 'ok'
  database: string
  /** ISO 8601, as produced by Date.prototype.toISOString */
  serverTime: string
}

export type HealthError = {
  status: 'error'
  message: string
}
