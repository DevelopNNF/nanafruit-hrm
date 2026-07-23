// The context and its hooks live apart from MeProvider so that the provider file
// exports a component and nothing else, which is what Fast Refresh needs to
// swap it without remounting the tree under it.

import { createContext, use } from 'react'
import type { AuthUser, Role } from '@hrm/shared'

export const MeContext = createContext<AuthUser | null>(null)

/** Roles allowed to change anything. Mirrors `canWrite` in server/src/routes/employees.ts. */
const WRITE_ROLES: readonly Role[] = ['HRM.HR', 'HRM.Admin']

export function useMe(): AuthUser {
  const me = use(MeContext)
  if (!me) throw new Error('useMe() outside MeProvider')
  return me
}

/**
 * Whether to offer the controls that change data. The server checks this again
 * on every write — hiding a button is how the UI stays honest about what it can
 * do, not how the rule is enforced.
 */
export function useCanWrite(): boolean {
  const me = useMe()
  return me.kind === 'admin' && me.roles.some((role) => WRITE_ROLES.includes(role))
}

/**
 * Whether to offer the controls that change master_locations — Admin only,
 * unlike useCanWrite's HR+Admin: a wrong radius here is a security control
 * (who may clock in from where), not a scheduling detail. Mirrors the
 * server's canWrite in server/src/routes/locations.ts.
 */
export function useIsAdmin(): boolean {
  const me = useMe()
  return me.kind === 'admin' && me.roles.includes('HRM.Admin')
}
