// Reading and writing employee_wage_assignments — the history of what an
// employee was paid, and when. See that migration's comment for why this
// replaced employee_finance.wage_type/wage_amount as the source of truth.
//
// Deliberately shaped after shiftAssignmentQueries.ts, down to the names, so
// that whoever has read one can read the other. It reuses that file's date
// helper rather than restating it: two implementations of "the day before this
// one" is exactly the kind of duplication that ends up disagreeing.
//
// Three kinds of read this file serves:
//  - "what wage applies right now" (currentWageJoinSql), for a screen.
//  - "what wage applied on the date this row is about" (wageJoinSqlForDate),
//    which is what the overtime report — and every payroll period after it —
//    actually needs.
//  - "what wage applied on date X" (getWageForDate), for a single lookup.

import type pg from 'pg'
import type { WageAssignment, WageType } from '@hrm/shared'
import { pool } from './db.js'
import { addDays } from './shiftAssignmentQueries.js'

type Queryable = Pick<pg.Pool, 'query'>

/**
 * A LEFT JOIN LATERAL resolving the wage in effect *today* (Thailand time)
 * for the employee identified by `employeeIdExpr` — a SQL expression naming a
 * column already in scope in the outer query, e.g. `'e.id'`. Never user
 * input, so splicing it in is safe; same contract as currentShiftJoinSql.
 *
 * The alias is always `current_wage`, exposing `wage_type` and `wage_amount`.
 */
export function currentWageJoinSql(employeeIdExpr: string): string {
  return `
  LEFT JOIN LATERAL (
    SELECT ewa.wage_type, ewa.wage_amount FROM employee_wage_assignments ewa
    WHERE ewa.employee_id = ${employeeIdExpr}
      AND ewa.effective_from <= (now() AT TIME ZONE 'Asia/Bangkok')::date
      AND (ewa.effective_to IS NULL OR ewa.effective_to >= (now() AT TIME ZONE 'Asia/Bangkok')::date)
  ) current_wage ON true
`
}

/**
 * A LEFT JOIN LATERAL resolving the wage in effect on the date `dateExpr`
 * names — a column already in scope in the outer query, e.g. `'d.work_date'`.
 * Both arguments are SQL expressions written by us, never user input.
 *
 * This is the one that matters. Joining employee_finance directly (which is
 * what the overtime report did before 046) prices last March's overtime at
 * today's wage, silently, and gets more wrong with every raise. Resolving per
 * row against the row's own date is what makes a report over a past range stay
 * true after the fact.
 *
 * The alias is always `wage_on_date`, exposing `wage_type` and `wage_amount`.
 */
export function wageJoinSqlForDate(employeeIdExpr: string, dateExpr: string): string {
  return `
  LEFT JOIN LATERAL (
    SELECT ewa.wage_type, ewa.wage_amount FROM employee_wage_assignments ewa
    WHERE ewa.employee_id = ${employeeIdExpr}
      AND ewa.effective_from <= ${dateExpr}
      AND (ewa.effective_to IS NULL OR ewa.effective_to >= ${dateExpr})
  ) wage_on_date ON true
`
}

export type WageOnDate = { wageType: WageType; wageAmount: number }

/** The wage in effect for an employee on a given Thailand calendar date
 *  ('YYYY-MM-DD'). Null when no wage was on file then — an employee hired
 *  later, or one whose finance tab has never been filled in. Callers render
 *  that as "—", never as zero. */
export async function getWageForDate(
  employeeId: number,
  date: string,
  db: Queryable = pool
): Promise<WageOnDate | null> {
  const { rows } = await db.query<{ wage_type: string; wage_amount: string }>(
    `SELECT wage_type, wage_amount FROM employee_wage_assignments
     WHERE employee_id = $1 AND effective_from <= $2
       AND (effective_to IS NULL OR effective_to >= $2)`,
    [employeeId, date]
  )
  const row = rows[0]
  if (!row) return null
  return { wageType: row.wage_type as WageType, wageAmount: Number(row.wage_amount) }
}

export type WageAssignmentRow = {
  id: string // bigint: pg hands these back as strings to avoid precision loss
  employee_id: string
  wage_type: string
  wage_amount: string // numeric: string too, same reason
  effective_from: string // 'YYYY-MM-DD' — see the DATE type parser in db.ts
  effective_to: string | null
  note: string | null
  created_by_kind: string
  created_by_id: string
  created_at: string
}

function rowToWageAssignment(row: WageAssignmentRow): WageAssignment {
  return {
    id: Number(row.id),
    wageType: row.wage_type as WageType,
    wageAmount: Number(row.wage_amount),
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    note: row.note,
    createdByKind: row.created_by_kind,
    createdById: row.created_by_id,
    createdAt: new Date(row.created_at).toISOString(),
  }
}

const WAGE_ASSIGNMENT_COLUMNS =
  'id, employee_id, wage_type, wage_amount, effective_from, effective_to, note, created_by_kind, created_by_id, created_at'

/** One employee's full wage history, most recent interval first. */
export async function listWageAssignments(
  employeeId: number,
  db: Queryable = pool
): Promise<WageAssignment[]> {
  const { rows } = await db.query<WageAssignmentRow>(
    `SELECT ${WAGE_ASSIGNMENT_COLUMNS} FROM employee_wage_assignments
     WHERE employee_id = $1 ORDER BY effective_from DESC, id DESC`,
    [employeeId]
  )
  return rows.map(rowToWageAssignment)
}

export type CreateWageChangeParams = {
  employeeId: number
  wageType: WageType
  wageAmount: number
  effectiveFrom: string
  note: string | null
  createdByKind: string
  createdById: string
}

export type CreateWageChangeResult =
  | { kind: 'ok'; assignment: WageAssignment }
  // effectiveFrom lands on or before an interval already on the books — most
  // often an attempt to backdate past a raise that was already recorded. There
  // is no edit or delete route, so the caller reports it and a human decides.
  | { kind: 'overlap' }

/**
 * Records a new wage, closing the employee's current open-ended one the day
 * before it takes effect. Runs on `client`, so the caller is expected to be
 * inside a transaction.
 *
 * Order is load-bearing: close the open row first, then insert. Inserting
 * first trips employee_wage_assignments_no_overlap, because until the old row
 * is closed both rows are unbounded and two unbounded ranges always overlap.
 *
 * The overlap pre-check duplicates what that EXCLUDE constraint enforces, on
 * purpose and with a different job for each. The check is here so HR gets a
 * sentence in Thai instead of an SQLSTATE; the constraint is there because two
 * admins saving at the same moment would each pass the check and both commit.
 * Same split as createShiftChange, which pre-checks for the same reason.
 *
 * Backdating is allowed, unlike a shift change — see WageChangeInput. What is
 * not allowed is backdating *across* an interval already closed, since that
 * would rewrite a stretch of history the overtime report has already priced.
 */
export async function createWageChange(
  client: pg.PoolClient,
  params: CreateWageChangeParams
): Promise<CreateWageChangeResult> {
  const { employeeId, wageType, wageAmount, effectiveFrom, note, createdByKind, createdById } =
    params

  // FOR UPDATE: two admins recording a raise for the same employee at once
  // would otherwise both read the same open row and both try to close it.
  const { rows: openRows } = await client.query<WageAssignmentRow>(
    `SELECT ${WAGE_ASSIGNMENT_COLUMNS} FROM employee_wage_assignments
     WHERE employee_id = $1 AND effective_to IS NULL FOR UPDATE`,
    [employeeId]
  )
  const openRow = openRows[0] ?? null

  // Any row still running on effectiveFrom, other than the open baseline this
  // change supersedes. Closing that baseline at effectiveFrom - 1 is only
  // valid if it actually started earlier; a baseline starting on or after
  // effectiveFrom would end up with effective_to < effective_from, which the
  // period-order CHECK rejects — so that case counts as an overlap too.
  const { rows: overlapRows } = await client.query(
    `SELECT 1 FROM employee_wage_assignments
     WHERE employee_id = $1
       AND COALESCE(effective_to, 'infinity'::date) >= $2::date
       AND NOT (effective_to IS NULL AND effective_from < $2::date)
     LIMIT 1`,
    [employeeId, effectiveFrom]
  )
  if (overlapRows.length > 0) {
    return { kind: 'overlap' }
  }

  if (openRow) {
    await client.query(`UPDATE employee_wage_assignments SET effective_to = $2 WHERE id = $1`, [
      openRow.id,
      addDays(effectiveFrom, -1),
    ])
  }

  const { rows: insertedRows } = await client.query<WageAssignmentRow>(
    `INSERT INTO employee_wage_assignments
       (employee_id, wage_type, wage_amount, effective_from, note, created_by_kind, created_by_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${WAGE_ASSIGNMENT_COLUMNS}`,
    [employeeId, wageType, wageAmount, effectiveFrom, note, createdByKind, createdById]
  )
  const inserted = insertedRows[0]
  if (!inserted) throw new Error('insert into employee_wage_assignments returned no id')

  return { kind: 'ok', assignment: rowToWageAssignment(inserted) }
}
