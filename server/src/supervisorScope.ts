// Who may act on which employees in a bulk admin/ action, without a
// dedicated Entra App Role for "supervisor". Shared by every bulk-on-behalf
// feature that needs it — Bulk OT Request (routes/overtimeRequests.ts) and
// the daily shift-assignment bulk endpoint (routes/employees.ts) so far.
//
// HR/Admin may act on any active employee — the same pair that already
// decides OT requests and writes employment data everywhere else in this
// app. Anyone else is in scope only if their Entra session resolves, via
// employees.entra_upn (060's migration), to an employee record that is
// itself somebody's supervisor (employment_details.supervisor_employee_id).
// There is no dedicated Entra App Role for "supervisor": HR did not want to
// manage Entra role assignments in the Entra portal for a handful of line
// supervisors, and "has direct reports" is already the real-world
// definition of the job. A supervisor's Entra account still needs *some*
// HRM role assigned (even HRM.Viewer) to get past MeProvider's "no role at
// all" gate in admin/ — that gate is unrelated to this scope and cannot be
// bypassed from here.
//
// A caller with neither is 'none' — no access at all, not an empty 'team':
// callers use this to tell "you cannot use this bulk action" apart from
// "you can, but nobody reports to you yet".

import type pg from 'pg'
import type { AuthUser } from '@hrm/shared'
import { pool } from './db.js'
import { findEmployeeIdByEntraUpn, listActiveDirectReportIds } from './employeeQueries.js'

type Queryable = Pick<pg.Pool, 'query'>

export type SupervisorScope =
  | { kind: 'all' }
  | { kind: 'team'; supervisorEmployeeId: number; employeeIds: number[] }
  | { kind: 'none' }

export async function resolveSupervisorScope(
  auth: AuthUser,
  db: Queryable = pool
): Promise<SupervisorScope> {
  if (auth.kind !== 'admin') return { kind: 'none' }
  if (auth.roles.includes('HRM.HR') || auth.roles.includes('HRM.Admin')) return { kind: 'all' }

  const supervisorEmployeeId = await findEmployeeIdByEntraUpn(auth.upn, db)
  if (supervisorEmployeeId === null) return { kind: 'none' }

  const employeeIds = await listActiveDirectReportIds(supervisorEmployeeId, db)
  if (employeeIds.length === 0) return { kind: 'none' }

  return { kind: 'team', supervisorEmployeeId, employeeIds }
}

/** Never trust the client's own idea of who it may act on — every
 *  employeeId in a bulk action is checked against the server-resolved scope
 *  again here, the same way canWrite alone is never enough and every route
 *  re-derives what it needs from req.auth. */
export function scopeAllows(scope: SupervisorScope, employeeId: number): boolean {
  if (scope.kind === 'all') return true
  if (scope.kind === 'team') return scope.employeeIds.includes(employeeId)
  return false
}
