// Reading leave_balance_entries directly, and the derived per-leave-type
// summary that sums them — the summary has no table of its own, since the
// ledger is the only source of truth (see the migration's comment).

import type pg from 'pg'
import type { LeaveBalanceEntry, LeaveBalanceSummary } from '@hrm/shared'
import { pool } from './db.js'

type Queryable = Pick<pg.Pool, 'query'>

export type LeaveBalanceEntryRow = {
  id: string // bigint: pg hands these back as strings to avoid precision loss
  employee_id: string
  leave_type_id: string
  year: number
  entry_type: string
  amount_days: string // numeric: pg hands these back as strings too
  reason: string | null
  created_by_name: string
  created_at: string // timestamptz — ISO 8601 already, per pg's default
}

export const SELECT_LEAVE_BALANCE_ENTRY = `
  SELECT id, employee_id, leave_type_id, year, entry_type, amount_days,
         reason, created_by_name, created_at
  FROM leave_balance_entries
`

export function rowToLeaveBalanceEntry(row: LeaveBalanceEntryRow): LeaveBalanceEntry {
  return {
    id: Number(row.id),
    employeeId: Number(row.employee_id),
    leaveTypeId: Number(row.leave_type_id),
    year: row.year,
    entryType: row.entry_type as LeaveBalanceEntry['entryType'],
    amountDays: Number(row.amount_days),
    reason: row.reason,
    createdByName: row.created_by_name,
    createdAt: new Date(row.created_at).toISOString(),
  }
}

export async function listLeaveBalanceEntries(
  employeeId: number,
  year: number,
  db: Queryable = pool
): Promise<LeaveBalanceEntry[]> {
  const { rows } = await db.query<LeaveBalanceEntryRow>(
    `${SELECT_LEAVE_BALANCE_ENTRY}
     WHERE employee_id = $1 AND year = $2
     ORDER BY created_at`,
    [employeeId, year]
  )
  return rows.map(rowToLeaveBalanceEntry)
}

type LeaveBalanceSummaryRow = {
  leave_type_id: string
  leave_code: string
  leave_name: string
  granted_days: string
  used_days: string
  adjustment_days: string
  remaining_days: string
}

/** Every active leave type, whether or not it has any entries yet for this
 *  employee/year — a type nobody has granted anything for still shows up,
 *  with zeros, rather than silently vanishing from the summary. */
export async function listLeaveBalanceSummaries(
  employeeId: number,
  year: number,
  db: Queryable = pool
): Promise<LeaveBalanceSummary[]> {
  const { rows } = await db.query<LeaveBalanceSummaryRow>(
    `SELECT
       mlt.id AS leave_type_id, mlt.leave_code, mlt.leave_name,
       COALESCE(SUM(lbe.amount_days) FILTER (WHERE lbe.entry_type IN ('grant', 'carry_over')), 0) AS granted_days,
       COALESCE(-SUM(lbe.amount_days) FILTER (WHERE lbe.entry_type = 'usage'), 0) AS used_days,
       COALESCE(SUM(lbe.amount_days) FILTER (WHERE lbe.entry_type = 'adjustment'), 0) AS adjustment_days,
       COALESCE(SUM(lbe.amount_days), 0) AS remaining_days
     FROM master_leave_types mlt
     LEFT JOIN leave_balance_entries lbe
       ON lbe.leave_type_id = mlt.id AND lbe.employee_id = $1 AND lbe.year = $2
     WHERE mlt.is_active = true
     GROUP BY mlt.id, mlt.leave_code, mlt.leave_name, mlt.sort_order
     ORDER BY mlt.sort_order, mlt.leave_name`,
    [employeeId, year]
  )

  return rows.map((row) => ({
    leaveTypeId: Number(row.leave_type_id),
    leaveCode: row.leave_code,
    leaveName: row.leave_name,
    year,
    grantedDays: Number(row.granted_days),
    usedDays: Number(row.used_days),
    adjustmentDays: Number(row.adjustment_days),
    remainingDays: Number(row.remaining_days),
  }))
}
