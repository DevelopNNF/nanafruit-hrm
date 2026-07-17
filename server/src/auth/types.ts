import type { AuthUser } from '@hrm/shared'

/** The admin arm of AuthUser, named because the Entra verifier returns exactly it. */
export type AdminUser = Extract<AuthUser, { kind: 'admin' }>

/** The employee arm, likewise for the session verifier. */
export type EmployeeUser = Extract<AuthUser, { kind: 'employee' }>

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * Set by the `authenticate` middleware. Optional because the type covers
       * every request, including the ones that never passed through it — inside
       * a route mounted behind `authenticate`, it is always present.
       */
      auth?: AuthUser
    }
  }
}
