// One-time backfill for the comp_time_allocated_normal_minutes/
// comp_time_allocated_extra_minutes/comp_time_money_source_minutes columns
// added by migration 079, needed once before Phase 6's buildOvertimeLines
// (payrollEntryQueries.ts) can safely read overtime_requests instead of
// attendance_daily's day-level aggregate.
//
// Why this is needed: every overtime_requests row approved BEFORE this
// deployment has those columns sitting at their 0 default — the allocation
// step (postCompTimeAccrualForApprovedRange) only runs as part of the
// approve action itself, so an old approval never triggered it. Without this
// backfill, buildOvertimeLines would read 0 money-payable minutes for every
// pre-existing approved request and silently stop paying OT that was validly
// approved and worked, the same class of gap migration 054's grace-minutes
// backfill existed to close (see attendance:compute's own comment).
//
// Safe to run more than once: postCompTimeAccrualForApprovedRange always
// refreshes comp_time_allocated_* (pure bookkeeping of how a day split
// across its requests) and only guards the LEDGER posting against
// double-firing — every request here has comp_time_requested = false by
// construction (comp-time didn't exist before this deployment), so this
// backfill only ever touches the money-side columns, never the ledger.
//
// Usage:
//   npm run backfill:comp-time

import 'dotenv/config'
import { pool, withTransaction } from './db.js'
import { addDays } from './shiftAssignmentQueries.js'
import { postCompTimeAccrualForApprovedRange } from './compTimeQueries.js'

async function main(): Promise<void> {
  const { rows } = await pool.query<{ employee_id: string; min_date: string; max_date: string }>(
    `SELECT employee_id, min(ot_date)::text AS min_date, max(ot_date)::text AS max_date
     FROM overtime_requests
     WHERE status = 'approved'
     GROUP BY employee_id
     ORDER BY employee_id`
  )

  console.log(`Backfilling comp-time allocation for ${rows.length} employee(s) with approved OT requests`)

  let failed = 0
  for (const row of rows) {
    const employeeId = Number(row.employee_id)
    // Same +/-1 day pad postCompTimeAccrualForApprovedRange's own callers
    // (the approve routes) use, for the same reason: an overnight OT block
    // can be attributed to the day before it was filed against.
    const fromDate = addDays(row.min_date, -1)
    const toDate = addDays(row.max_date, 1)
    try {
      await withTransaction((client) =>
        postCompTimeAccrualForApprovedRange(
          employeeId,
          fromDate,
          toDate,
          'backfill',
          'Backfill (Phase 6 migration)',
          client
        )
      )
      console.log(`  employee ${employeeId}: ${fromDate}..${toDate} OK`)
    } catch (err) {
      failed += 1
      console.error(`  employee ${employeeId}: FAILED — ${String(err)}`)
    }
  }

  console.log(failed === 0 ? 'Backfill complete, no failures.' : `Backfill complete with ${failed} failure(s).`)
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => {
    void pool.end()
  })
