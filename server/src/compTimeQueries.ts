// Reading overtime_comp_time_entries (the comp-time-off ledger) and the
// derived per-employee/year balance summary — same relationship
// leaveBalanceQueries.ts has to leave_balance_entries: the summary has no
// table of its own, since the ledger is the only source of truth.
//
// Unlike leave balances, there is no carry-over batch job here: the balance
// resets every January 1st simply by scoping every query to the current
// year (see the migration's comment), so a prior year's entries fall out of
// every sum on their own.

import type pg from 'pg'
import type { CompTimeBalance, OvertimeCompTimeEntry } from '@hrm/shared'
import { pool } from './db.js'
import { addDays } from './shiftAssignmentQueries.js'
import { matchAttendanceForDates } from './attendanceMatchingQueries.js'
import { getOvertimeRoundingMinutes } from './attendanceDailyQueries.js'
import { findOvertimeGroupById } from './overtimeGroupQueries.js'
import {
  actualMinutesPerRequest,
  allocateOvertimeDayMinutesToRequests,
  candidateCompAccrualMinutes,
  computeOvertimeForDay,
  splitCompTimeForAnnualCap,
} from './overtimeCalculation.js'

type Queryable = Pick<pg.Pool, 'query'>

export type OvertimeCompTimeEntryRow = {
  id: string // bigint: pg hands these back as strings to avoid precision loss
  employee_id: string
  year: number
  entry_type: string
  amount_minutes: number
  source_overtime_request_id: string | null
  source_redemption_id: string | null
  reason: string | null
  created_by_name: string
  created_at: string // timestamptz — ISO 8601 already, per pg's default
}

export const SELECT_OVERTIME_COMP_TIME_ENTRY = `
  SELECT id, employee_id, year, entry_type, amount_minutes,
         source_overtime_request_id, source_redemption_id,
         reason, created_by_name, created_at
  FROM overtime_comp_time_entries
`

export function rowToOvertimeCompTimeEntry(row: OvertimeCompTimeEntryRow): OvertimeCompTimeEntry {
  return {
    id: Number(row.id),
    employeeId: Number(row.employee_id),
    year: row.year,
    entryType: row.entry_type as OvertimeCompTimeEntry['entryType'],
    amountMinutes: row.amount_minutes,
    sourceOvertimeRequestId: row.source_overtime_request_id === null ? null : Number(row.source_overtime_request_id),
    sourceRedemptionId: row.source_redemption_id === null ? null : Number(row.source_redemption_id),
    reason: row.reason,
    createdByName: row.created_by_name,
    createdAt: new Date(row.created_at).toISOString(),
  }
}

export async function listOvertimeCompTimeEntries(
  employeeId: number,
  year: number,
  db: Queryable = pool
): Promise<OvertimeCompTimeEntry[]> {
  const { rows } = await db.query<OvertimeCompTimeEntryRow>(
    `${SELECT_OVERTIME_COMP_TIME_ENTRY}
     WHERE employee_id = $1 AND year = $2
     ORDER BY created_at`,
    [employeeId, year]
  )
  return rows.map(rowToOvertimeCompTimeEntry)
}

type CompTimeBalanceRow = {
  balance_minutes: string
  accrued_this_year_minutes: string
  pending_redemption_minutes: string
}

/** This employee's comp-time-off balance for one year. Unlike
 *  listLeaveBalanceSummaries, there is nothing to LEFT JOIN against a master
 *  table here — an employee either has ledger entries for the year or they
 *  don't, and a balance of zero either way is exactly right (there is no
 *  per-type "shows up even with zero entries" row the way leave types work).
 *
 *  pending_redemption_minutes comes from comp_time_off_requests rather than
 *  the ledger, same reasoning as listLeaveBalanceSummaries' pending_days: a
 *  pending redemption hasn't posted a 'usage' entry yet (only approval
 *  does). Scoped by the redemption's off_date year, not its created_at year,
 *  so a request filed in December for a January date nets against the right
 *  year's balance. */
export async function getCompTimeBalance(
  employeeId: number,
  year: number,
  db: Queryable = pool
): Promise<CompTimeBalance> {
  const { rows } = await db.query<CompTimeBalanceRow>(
    `SELECT
       COALESCE((SELECT SUM(amount_minutes) FROM overtime_comp_time_entries
                 WHERE employee_id = $1 AND year = $2), 0) AS balance_minutes,
       COALESCE((SELECT SUM(amount_minutes) FROM overtime_comp_time_entries
                 WHERE employee_id = $1 AND year = $2 AND entry_type = 'accrual'), 0) AS accrued_this_year_minutes,
       COALESCE((SELECT SUM(requested_minutes) FROM comp_time_off_requests
                 WHERE employee_id = $1 AND status = 'pending' AND EXTRACT(YEAR FROM off_date) = $2), 0)
         AS pending_redemption_minutes`,
    [employeeId, year]
  )
  const row = rows[0]
  const balanceMinutes = Number(row?.balance_minutes ?? 0)
  const accruedThisYearMinutes = Number(row?.accrued_this_year_minutes ?? 0)
  const pendingRedemptionMinutes = Number(row?.pending_redemption_minutes ?? 0)
  return {
    year,
    balanceMinutes,
    accruedThisYearMinutes,
    pendingRedemptionMinutes,
    availableMinutes: balanceMinutes - pendingRedemptionMinutes,
  }
}

async function sumAccruedThisYearMinutes(employeeId: number, year: number, db: Queryable): Promise<number> {
  const { rows } = await db.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount_minutes), 0) AS total FROM overtime_comp_time_entries
     WHERE employee_id = $1 AND year = $2 AND entry_type = 'accrual'`,
    [employeeId, year]
  )
  return Number(rows[0]?.total ?? 0)
}

/** Every 'YYYY-MM-DD' from fromDate through toDate, inclusive — same shape as
 *  attendanceDailyQueries.ts's own expandDateRange, kept local here since the
 *  string-compare trick (date strings sort chronologically) is a one-liner
 *  not worth sharing across modules for. */
function expandDateRange(fromDate: string, toDate: string): string[] {
  const dates: string[] = []
  for (let d = fromDate; d <= toDate; d = addDays(d, 1)) dates.push(d)
  return dates
}

/**
 * The approval-time step that turns a per-request comp-time CHOICE into a
 * per-request comp-time OUTCOME: how much of each approved OT request's
 * share of its work-date accrues as comp-time-off versus stays payable as
 * money. Called once per approve decision (both the single and batch approve
 * routes), over the SAME [otDate-1, otDate+1] window recomputeAttendanceDaily
 * already recomputes for the same reason — an overnight OT block can end up
 * attributed to the day before (see resolveOvertimeOwnerDate) — and only
 * AFTER that recompute has run, since this reads attendance_daily's freshly
 * written picture of the day via the same matchAttendanceForDates /
 * computeOvertimeForDay pipeline, not a second, possibly-stale one.
 *
 * Must run inside the same transaction as the approval itself — `db` is
 * always the transaction client, never the pool, since a comp-time ledger
 * posting must never survive an approval that then rolls back.
 *
 * Per work-date with any approved OT at all, this:
 *   1. Re-derives that day's rounded normal/extra OT minutes exactly as
 *      recomputeAttendanceDaily just did (computeOvertimeForDay).
 *   2. Allocates those day-level minutes back to the day's individual
 *      approved requests (allocateOvertimeDayMinutesToRequests) — there can
 *      be more than one, and this is what lets a per-request comp-time
 *      choice apply to the right slice of a shared day.
 *   3. For every request in that allocation, freshens
 *      comp_time_allocated_normal/extra_minutes — purely descriptive
 *      bookkeeping of how the day was divided, safe to overwrite every time
 *      the set of approved requests for a day changes (e.g. a second request
 *      on the same day gets approved later).
 *   4. For a request that has NOT already posted an 'accrual' ledger entry:
 *      money-only (comp_time_requested = false) requests get
 *      comp_time_money_source_minutes set to their full allocated total;
 *      comp-time-requested ones get run through candidateCompAccrualMinutes
 *      + splitCompTimeForAnnualCap against this employee's running
 *      accrued-this-year total, and the result (accrual vs. money-overflow)
 *      is written to the row and, if any minutes accrued, posted as a ledger
 *      entry.
 *   5. A request that ALREADY has a posted accrual entry is left alone on
 *      steps 4 (though its allocated_normal/extra from step 3 still
 *      refreshes) — its accrual is frozen once posted, the same
 *      no-silent-recompute principle leave_balance_entries and this table's
 *      own migration comment both commit to. If a later sibling request
 *      changes how much of the day it "should" have gotten, correcting an
 *      already-posted accrual is a manual `adjustment` ledger entry, not
 *      something this function ever does automatically.
 *
 * Concurrency: acquires a transaction-scoped advisory lock per
 * (employeeId, year) the first time that year is touched in this call,
 * before reading how much has accrued so far — pg_advisory_xact_lock
 * releases automatically at commit/rollback, so nothing to clean up. This
 * closes the narrow window where two approvals for the same employee (e.g.
 * a single approve racing a batch approve) could both read the same
 * pre-accrual total and together accrue past the annual cap.
 */
export async function postCompTimeAccrualForApprovedRange(
  employeeId: number,
  fromDate: string,
  toDate: string,
  actorOid: string,
  actorName: string,
  db: Queryable
): Promise<void> {
  const dates = expandDateRange(fromDate, toDate)
  if (dates.length === 0) return

  const matched = await matchAttendanceForDates(employeeId, dates, db)
  const roundingMinutes = await getOvertimeRoundingMinutes(employeeId, db)

  // Layers this call's own accruals on top of what's already in the DB, so
  // several work-dates processed in one call (e.g. an overnight block's two
  // neighbouring days) see each other's effect on the same annual cap
  // instead of each reading the same stale pre-call snapshot.
  const accruedThisYearByYear = new Map<number, number>()
  const lockedYears = new Set<number>()

  for (const day of matched) {
    if (day.overtimeIntervals.length === 0) continue

    const overtime = computeOvertimeForDay({
      dayStatus: day.status,
      overtimeIntervals: day.overtimeIntervals,
      actualCheckInAt: day.actualCheckInAt,
      actualCheckOutAt: day.actualCheckOutAt,
      roundingMinutes,
    })

    const actualByRequest = actualMinutesPerRequest(
      day.overtimeIntervals,
      day.actualCheckInAt,
      day.actualCheckOutAt
    )
    const requestsForAllocation = day.overtimeIntervals.map((interval) => ({
      requestId: interval.requestId,
      actualMinutes: actualByRequest.get(interval.requestId) ?? 0,
    }))
    const allocations = allocateOvertimeDayMinutesToRequests({
      dayStatus: day.status,
      dayNormalMinutes: overtime.normalMinutes,
      dayExtraMinutes: overtime.extraMinutes,
      requests: requestsForAllocation,
    })

    const requestIds = allocations.map((a) => a.requestId)

    const { rows: requestRows } = await db.query<{
      id: string
      comp_time_requested: boolean
      overtime_group_id: string
    }>(
      `SELECT id, comp_time_requested, overtime_group_id FROM overtime_requests WHERE id = ANY($1::bigint[])`,
      [requestIds]
    )
    const requestInfoById = new Map(
      requestRows.map((r) => [
        Number(r.id),
        { compTimeRequested: r.comp_time_requested, overtimeGroupId: Number(r.overtime_group_id) },
      ])
    )

    const { rows: postedRows } = await db.query<{ source_overtime_request_id: string }>(
      `SELECT source_overtime_request_id FROM overtime_comp_time_entries
       WHERE entry_type = 'accrual' AND source_overtime_request_id = ANY($1::bigint[])`,
      [requestIds]
    )
    const alreadyPostedIds = new Set(postedRows.map((r) => Number(r.source_overtime_request_id)))

    const year = Number(day.workDate.slice(0, 4))

    for (const allocation of allocations) {
      await db.query(
        `UPDATE overtime_requests
         SET comp_time_allocated_normal_minutes = $2, comp_time_allocated_extra_minutes = $3
         WHERE id = $1`,
        [allocation.requestId, allocation.normalMinutes, allocation.extraMinutes]
      )

      if (alreadyPostedIds.has(allocation.requestId)) continue

      const info = requestInfoById.get(allocation.requestId)
      if (!info) continue // defensive — every allocation id came from this same query moments ago

      const totalAllocated = allocation.normalMinutes + allocation.extraMinutes
      const group = info.compTimeRequested ? await findOvertimeGroupById(info.overtimeGroupId, db) : null

      if (!info.compTimeRequested || !group || !group.compTimeEnabled) {
        // Money-only, or (defensively) a group that had comp-time turned off
        // between submission and this approval — validateOvertimeRequestInput's
        // re-validation at approval time is meant to force a reject before
        // this function ever runs, so the latter case is a fallback, not the
        // normal path.
        await db.query(
          `UPDATE overtime_requests
           SET comp_time_accrual_minutes = 0, comp_time_money_source_minutes = $2
           WHERE id = $1`,
          [allocation.requestId, totalAllocated]
        )
        continue
      }

      if (!lockedYears.has(year)) {
        await db.query('SELECT pg_advisory_xact_lock($1, $2)', [employeeId, year])
        lockedYears.add(year)
      }

      const candidate = candidateCompAccrualMinutes({
        status: day.status,
        allocatedNormalMinutes: allocation.normalMinutes,
        allocatedExtraMinutes: allocation.extraMinutes,
        group,
      })
      const alreadyAccruedThisYear =
        accruedThisYearByYear.get(year) ?? (await sumAccruedThisYearMinutes(employeeId, year, db))
      const split = splitCompTimeForAnnualCap({
        candidateAccrualMinutes: candidate,
        sourceMinutes: totalAllocated,
        alreadyAccruedThisYearMinutes: alreadyAccruedThisYear,
        group,
      })
      accruedThisYearByYear.set(year, alreadyAccruedThisYear + split.accrualMinutes)

      await db.query(
        `UPDATE overtime_requests
         SET comp_time_accrual_minutes = $2, comp_time_money_source_minutes = $3
         WHERE id = $1`,
        [allocation.requestId, split.accrualMinutes, split.moneySourceMinutesFromOverflow]
      )

      if (split.accrualMinutes > 0) {
        await db.query(
          `INSERT INTO overtime_comp_time_entries
             (employee_id, year, entry_type, amount_minutes, source_overtime_request_id,
              created_by_oid, created_by_name)
           VALUES ($1, $2, 'accrual', $3, $4, $5, $6)`,
          [employeeId, year, split.accrualMinutes, allocation.requestId, actorOid, actorName]
        )
      }
    }
  }
}
