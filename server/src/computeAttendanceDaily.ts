// The attendance:compute batch job — fills attendance_daily for every active
// employee across a date range.
//
// A CLI script rather than an in-process scheduler because this repo has
// neither a scheduler nor a deploy config: keeping the trigger outside the
// code (system cron, or whatever the eventual platform offers) costs no
// dependency and defers that choice to deploy time. Same shape as migrate.ts.
//
// Default range is a rolling 7-day window ending yesterday, and the whole
// window is recomputed on every run. That is deliberate and does the work a
// recompute queue would otherwise have to: a backdated approval (a shift
// change, a day-off swap, a leave) that lands inside the window is picked up
// on the next run with no flag column and no approval-time hook. It also
// makes the run schedule forgiving — a run that catches an overnight shift
// mid-flight writes a provisional verdict that a later run corrects.
//
// Suggested cron: at least one run well after the longest shift ends (~10:00
// Thailand time clears a 22:00-07:00 shift). Extra runs only buy freshness.
//
// Usage:
//   npm run attendance:compute
//   npm run attendance:compute -- --from=2026-08-01 --to=2026-08-15

import 'dotenv/config'
import { pool } from './db.js'
import { recomputeAttendanceDaily } from './attendanceDailyQueries.js'
import { addDays, toThailandDateString } from './shiftAssignmentQueries.js'

const DEFAULT_WINDOW_DAYS = 7
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function parseDateArg(argv: string[], name: string): string | null {
  const prefix = `--${name}=`
  const arg = argv.find((a) => a.startsWith(prefix))
  if (arg === undefined) return null

  const value = arg.slice(prefix.length)
  if (!DATE_RE.test(value) || Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())) {
    throw new Error(`--${name} must be a valid YYYY-MM-DD date (got "${value}")`)
  }
  return value
}

/** The range to recompute. Defaults end yesterday rather than today because
 *  today's shifts haven't finished yet — though a run that does cover an
 *  unfinished day is harmless, since the next run recomputes it. */
function resolveRange(argv: string[]): { fromDate: string; toDate: string } {
  const today = toThailandDateString(new Date())
  const toDate = parseDateArg(argv, 'to') ?? addDays(today, -1)
  const fromDate = parseDateArg(argv, 'from') ?? addDays(toDate, -(DEFAULT_WINDOW_DAYS - 1))

  if (fromDate > toDate) {
    throw new Error(`--from (${fromDate}) must not be after --to (${toDate})`)
  }
  return { fromDate, toDate }
}

async function computeAll(): Promise<void> {
  const { fromDate, toDate } = resolveRange(process.argv.slice(2))
  console.log(`Computing attendance_daily for ${fromDate} .. ${toDate}`)

  const { rows: employees } = await pool.query<{ employee_id: string }>(
    `SELECT employee_id FROM employment_details WHERE status = 'Active' ORDER BY employee_id`
  )
  if (employees.length === 0) {
    console.log('No active employees — nothing to compute.')
    return
  }

  let totalRows = 0
  let failed = 0

  for (const { employee_id } of employees) {
    const employeeId = Number(employee_id)
    // One transaction per employee: a single bad record can't roll back the
    // whole run, and progress made before it stays committed.
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const written = await recomputeAttendanceDaily(employeeId, fromDate, toDate, client)
      await client.query('COMMIT')
      totalRows += written
      console.log(`  employee ${employeeId}: ${written} rows`)
    } catch (err) {
      await client.query('ROLLBACK')
      failed += 1
      console.error(`  employee ${employeeId}: FAILED — ${String(err)}`)
    } finally {
      client.release()
    }
  }

  console.log(`Done. ${totalRows} rows across ${employees.length - failed}/${employees.length} employees.`)
  // A partial run is a failed run as far as a cron wrapper is concerned — it
  // should be visible in the exit code, not just the log.
  if (failed > 0) process.exitCode = 1
}

try {
  await computeAll()
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
} finally {
  await pool.end()
}
