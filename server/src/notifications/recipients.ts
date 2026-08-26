// Turning an employee id into what dispatch.ts needs to actually reach or
// name them. There is no email-side recipient lookup here — who receives an
// HR email is entirely Power Automate's concern, not ours; see
// channels/email.ts.

import type pg from 'pg'
import { pool } from '../db.js'

type Queryable = Pick<pg.Pool, 'query'>

/** Null if the employee has never linked LINE (most employees, until they
 *  redeem a link code) or doesn't exist. */
export async function findLineUserIdForEmployee(
  employeeId: number,
  db: Queryable = pool
): Promise<string | null> {
  const { rows } = await db.query<{ line_user_id: string | null }>(
    `SELECT line_user_id FROM employees WHERE id = $1`,
    [employeeId]
  )
  return rows[0]?.line_user_id ?? null
}

/** Same "title + first name + last name" format every request table computes
 *  for its own employee/supervisor display columns (see e.g.
 *  leaveRequestQueries.ts's SELECT_LEAVE_REQUEST_LIST). Kept as a query
 *  rather than threaded through from the route as a string: a route handler
 *  building a RequestActionEvent should only need an employee id, the same
 *  as every other field on that event. */
export async function findEmployeeDisplayName(
  employeeId: number,
  db: Queryable = pool
): Promise<string | null> {
  const { rows } = await db.query<{ name: string | null }>(
    `SELECT (title || first_name_th || ' ' || last_name_th) AS name FROM employees WHERE id = $1`,
    [employeeId]
  )
  return rows[0]?.name ?? null
}
