// Reading leave_balance_entries directly, and the derived per-leave-type
// summary that sums them — the summary has no table of its own, since the
// ledger is the only source of truth (see the migration's comment).

import type pg from 'pg'
import type { CarryOverLeaveParams, CarryOverPreviewRow, LeaveBalanceEntry, LeaveBalanceSummary } from '@hrm/shared'
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
  pending_days: string
}

/** Every active leave type, whether or not it has any entries yet for this
 *  employee/year — a type nobody has granted anything for still shows up,
 *  with zeros, rather than silently vanishing from the summary.
 *
 * pending_days comes from leave_requests rather than the ledger — a pending
 * request hasn't posted a 'usage' entry yet (only approval does) — so it's
 * aggregated in its own subquery first and joined in as a single value per
 * leave type, rather than alongside leave_balance_entries directly, which
 * would double-count via the cross product of two unrelated one-to-many
 * joins. Its year is EXTRACT(YEAR FROM start_date): a leave_requests row has
 * no year column of its own, unlike leave_balance_entries. */
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
       COALESCE(SUM(lbe.amount_days), 0) AS remaining_days,
       COALESCE(lr.pending_days, 0) AS pending_days
     FROM master_leave_types mlt
     LEFT JOIN leave_balance_entries lbe
       ON lbe.leave_type_id = mlt.id AND lbe.employee_id = $1 AND lbe.year = $2
     LEFT JOIN (
       SELECT leave_type_id, SUM(total_days) AS pending_days
       FROM leave_requests
       WHERE employee_id = $1 AND status = 'pending' AND EXTRACT(YEAR FROM start_date) = $2
       GROUP BY leave_type_id
     ) lr ON lr.leave_type_id = mlt.id
     WHERE mlt.is_active = true
     GROUP BY mlt.id, mlt.leave_code, mlt.leave_name, mlt.sort_order, lr.pending_days
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
    pendingDays: Number(row.pending_days),
  }))
}

/** The join/calc core shared by the carry-over preview (a plain SELECT) and
 *  commit (an INSERT ... SELECT wrapping this same query) — one source of
 *  truth for "who's eligible and for how much" so the two can't drift.
 *  Params: $1 fromYear, $2 toYear, $3 leaveTypeId, $4 requestedDays,
 *  $5 maxDays. */
export const CARRY_OVER_SOURCE_CTE = `
  WITH source AS (
    SELECT
      e.id AS employee_id,
      e.employee_code,
      (e.title || e.first_name_th || ' ' || e.last_name_th) AS employee_name,
      COALESCE(src.remaining, 0) AS source_remaining,
      COALESCE(dst.remaining, 0) AS dest_remaining_before,
      EXISTS (
        SELECT 1 FROM leave_balance_entries co
        WHERE co.employee_id = e.id AND co.leave_type_id = $3
          AND co.year = $2 AND co.entry_type = 'carry_over'
      ) AS already_carried_over
    FROM employees e
    JOIN employment_details d ON d.employee_id = e.id AND d.status = 'Active'
    LEFT JOIN (
      SELECT employee_id, SUM(amount_days) AS remaining FROM leave_balance_entries
      WHERE leave_type_id = $3 AND year = $1 GROUP BY employee_id
    ) src ON src.employee_id = e.id
    LEFT JOIN (
      SELECT employee_id, SUM(amount_days) AS remaining FROM leave_balance_entries
      WHERE leave_type_id = $3 AND year = $2 GROUP BY employee_id
    ) dst ON dst.employee_id = e.id
  )
  SELECT *,
    -- maxDays ($5) is a ceiling on the DESTINATION total after carry-over,
    -- not on the carry-over amount itself: someone already sitting close to
    -- the cap in toYear gets topped up by less than requestedDays, never
    -- pushed over it. Still never carries more than they have left in
    -- fromYear (source_remaining) or more than requestedDays asks for.
    CASE WHEN already_carried_over THEN 0
         ELSE GREATEST(0, LEAST($4::numeric, source_remaining, $5::numeric - dest_remaining_before))
    END AS carry_over_amount
  FROM source
`

type CarryOverSourceRow = {
  employee_id: string
  employee_code: string
  employee_name: string
  source_remaining: string
  dest_remaining_before: string
  already_carried_over: boolean
  carry_over_amount: string
}

function carryOverParams(params: CarryOverLeaveParams): [number, number, number, number, number] {
  return [params.fromYear, params.toYear, params.leaveTypeId, params.requestedDays, params.maxDays]
}

export async function computeLeaveCarryOverPreview(
  params: CarryOverLeaveParams,
  db: Queryable = pool
): Promise<CarryOverPreviewRow[]> {
  const { rows } = await db.query<CarryOverSourceRow>(
    `${CARRY_OVER_SOURCE_CTE} ORDER BY employee_name`,
    carryOverParams(params)
  )
  return rows.map((row) => {
    const carryOverAmount = Number(row.carry_over_amount)
    const destRemainingBeforeDays = Number(row.dest_remaining_before)
    return {
      employeeId: Number(row.employee_id),
      employeeCode: row.employee_code,
      employeeName: row.employee_name,
      sourceRemainingDays: Number(row.source_remaining),
      destRemainingBeforeDays,
      carryOverAmount,
      destRemainingAfterDays: destRemainingBeforeDays + carryOverAmount,
      alreadyCarriedOver: row.already_carried_over,
    }
  })
}
