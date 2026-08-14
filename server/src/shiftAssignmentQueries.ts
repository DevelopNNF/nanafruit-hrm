// Reading and writing employee_shift_assignments — the history of which
// shift applied to an employee, and when. See that migration's comment for
// why this replaced employment_details.shift_id as the source of truth.
//
// Two kinds of read this file serves:
//  - "what shift applies right now" (currentShiftJoinSql), spliced into a
//    larger query in place of a direct join on employment_details.shift_id.
//  - "what shift applied on date X" (getShiftIdForDate), for a backdated
//    action that needs to know what was true *then*, not what's true now.

import type pg from 'pg'
import { pool } from './db.js'

type Queryable = Pick<pg.Pool, 'query'>

/** The Thailand calendar date a UTC instant falls on — same standing
 *  assumption as leaveRequests.ts's thailandToday: the org runs on
 *  Thailand time regardless of the server's own timezone. */
export function toThailandDateString(instant: Date): string {
  const bangkok = new Date(instant.getTime() + 7 * 60 * 60 * 1000)
  return bangkok.toISOString().slice(0, 10)
}

export function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * A LEFT JOIN LATERAL that resolves to the shift_id in effect *today*
 * (Thailand time) for the employee identified by `employeeIdExpr` — a SQL
 * expression naming a column already in scope in the outer query, e.g.
 * `'e.id'` or `'d.employee_id'`. Never user input, so string splicing here
 * is safe.
 *
 * The alias is always `current_shift`; the caller joins master_shifts onto
 * `current_shift.shift_id` same as it would have onto a direct column.
 *
 * Uses `now() AT TIME ZONE 'Asia/Bangkok'` rather than a JS-computed date
 * parameter so every call site of a query built from this fragment doesn't
 * have to grow a parameter just to say "today".
 */
export function currentShiftJoinSql(employeeIdExpr: string): string {
  return `
  LEFT JOIN LATERAL (
    SELECT shift_id FROM employee_shift_assignments esa
    WHERE esa.employee_id = ${employeeIdExpr}
      AND esa.effective_from <= (now() AT TIME ZONE 'Asia/Bangkok')::date
      AND (esa.effective_to IS NULL OR esa.effective_to >= (now() AT TIME ZONE 'Asia/Bangkok')::date)
  ) current_shift ON true
`
}

/** The shift_id in effect for an employee on a given Thailand calendar date
 *  ('YYYY-MM-DD'). Null if the employee had no shift assigned on that date
 *  (never assigned yet, or only assigned starting later). */
export async function getShiftIdForDate(
  employeeId: number,
  date: string,
  db: Queryable = pool
): Promise<number | null> {
  const { rows } = await db.query<{ shift_id: string | null }>(
    `SELECT shift_id FROM employee_shift_assignments
     WHERE employee_id = $1 AND effective_from <= $2
       AND (effective_to IS NULL OR effective_to >= $2)`,
    [employeeId, date]
  )
  const row = rows[0]
  return row?.shift_id == null ? null : Number(row.shift_id)
}

export type ShiftAssignmentRow = {
  id: string
  employee_id: string
  shift_id: string | null
  effective_from: string
  effective_to: string | null
  note: string | null
  created_by_kind: string
  created_by_id: string
  created_at: string
}

export type ShiftAssignment = {
  id: number
  shiftId: number | null
  effectiveFrom: string
  effectiveTo: string | null
  note: string | null
  createdByKind: string
  createdById: string
  createdAt: string
}

function rowToShiftAssignment(row: ShiftAssignmentRow): ShiftAssignment {
  return {
    id: Number(row.id),
    shiftId: row.shift_id === null ? null : Number(row.shift_id),
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    note: row.note,
    createdByKind: row.created_by_kind,
    createdById: row.created_by_id,
    createdAt: new Date(row.created_at).toISOString(),
  }
}

const SHIFT_ASSIGNMENT_COLUMNS =
  'id, employee_id, shift_id, effective_from, effective_to, note, created_by_kind, created_by_id, created_at'

/** One employee's full shift history, most recent interval first. */
export async function listShiftAssignments(
  employeeId: number,
  db: Queryable = pool
): Promise<ShiftAssignment[]> {
  const { rows } = await db.query<ShiftAssignmentRow>(
    `SELECT ${SHIFT_ASSIGNMENT_COLUMNS} FROM employee_shift_assignments
     WHERE employee_id = $1 ORDER BY effective_from DESC, id DESC`,
    [employeeId]
  )
  return rows.map(rowToShiftAssignment)
}

export type CreateShiftChangeParams = {
  employeeId: number
  shiftId: number | null
  effectiveFrom: string
  /** Null/absent for a permanent change. Set for a temporary swap — a
   *  follow-up row reopening the previous shift is inserted automatically,
   *  effective the day after. */
  effectiveTo: string | null
  note: string | null
  createdByKind: string
  createdById: string
}

export type CreateShiftChangeResult =
  | { kind: 'ok'; assignment: ShiftAssignment; previousShiftId: number | null }
  // A temporary swap needs an existing open-ended assignment to revert to;
  // there's nothing to resume for an employee who has never had a shift.
  | { kind: 'no_baseline' }
  // Overlaps an assignment that already covers part of the requested range
  // (most commonly a previously scheduled future change). The caller
  // resolves this by hand — there's no cancel/edit route yet.
  | { kind: 'overlap' }

/**
 * Creates a new shift assignment, closing the employee's current open-ended
 * one at effectiveFrom - 1, and — for a temporary swap (effectiveTo set) —
 * inserting a third row that reopens the previous shift starting the day
 * after effectiveTo. All three writes happen on `client`, so the caller is
 * expected to be inside a transaction.
 *
 * Rejects (rather than truncates or splits) any overlap with an assignment
 * already on the books, other than the open-ended row being superseded —
 * see the migration's comment on why this is a schema of intervals rather
 * than a single mutable "current shift" pointer.
 */
export async function createShiftChange(
  client: pg.PoolClient,
  params: CreateShiftChangeParams
): Promise<CreateShiftChangeResult> {
  const { employeeId, shiftId, effectiveFrom, effectiveTo, note, createdByKind, createdById } =
    params

  // FOR UPDATE: two admins acting on the same employee at once would
  // otherwise both read the same "current" baseline and both try to close
  // it, corrupting the open-row invariant.
  const { rows: openRows } = await client.query<ShiftAssignmentRow>(
    `SELECT ${SHIFT_ASSIGNMENT_COLUMNS} FROM employee_shift_assignments
     WHERE employee_id = $1 AND effective_to IS NULL FOR UPDATE`,
    [employeeId]
  )
  const openRow = openRows[0] ?? null

  if (effectiveTo !== null && openRow === null) {
    return { kind: 'no_baseline' }
  }

  const { rows: overlapRows } = await client.query(
    `SELECT 1 FROM employee_shift_assignments
     WHERE employee_id = $1
       AND effective_from <= COALESCE($3::date, 'infinity'::date)
       AND COALESCE(effective_to, 'infinity'::date) >= $2::date
       -- excludes the open baseline this change is expected to supersede
       AND NOT (effective_to IS NULL AND effective_from <= $2::date)
     LIMIT 1`,
    [employeeId, effectiveFrom, effectiveTo]
  )
  if (overlapRows.length > 0) {
    return { kind: 'overlap' }
  }

  if (openRow) {
    await client.query(`UPDATE employee_shift_assignments SET effective_to = $2 WHERE id = $1`, [
      openRow.id,
      addDays(effectiveFrom, -1),
    ])
  }

  const { rows: insertedRows } = await client.query<ShiftAssignmentRow>(
    `INSERT INTO employee_shift_assignments
       (employee_id, shift_id, effective_from, effective_to, note, created_by_kind, created_by_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${SHIFT_ASSIGNMENT_COLUMNS}`,
    [employeeId, shiftId, effectiveFrom, effectiveTo, note, createdByKind, createdById]
  )
  const inserted = insertedRows[0]
  if (!inserted) throw new Error('insert into employee_shift_assignments returned no id')

  const previousShiftId = openRow?.shift_id == null ? null : Number(openRow.shift_id)

  if (effectiveTo !== null && openRow) {
    await client.query(
      `INSERT INTO employee_shift_assignments
         (employee_id, shift_id, effective_from, effective_to, note, created_by_kind, created_by_id)
       VALUES ($1, $2, $3, NULL, $4, $5, $6)`,
      [
        employeeId,
        openRow.shift_id,
        addDays(effectiveTo, 1),
        `resumed after temporary shift change (assignment #${inserted.id})`,
        createdByKind,
        createdById,
      ]
    )
  }

  return { kind: 'ok', assignment: rowToShiftAssignment(inserted), previousShiftId }
}
