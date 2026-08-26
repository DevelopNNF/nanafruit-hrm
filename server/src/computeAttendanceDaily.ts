// The attendance:compute CLI — fills attendance_daily for every active
// employee across a date range.
//
// One of two entry points into the same run (see attendanceDailyJob.ts); the
// other is POST /api/cron/attendance-daily, which is what an external
// scheduler such as cron-job.org calls. This one is for running a range by
// hand: a backfill, or re-deriving a month after fixing master data.
//
// Usage:
//   npm run attendance:compute
//   npm run attendance:compute -- --from=2026-08-01 --to=2026-08-15

import 'dotenv/config'
import { pool } from './db.js'
import { DEFAULT_WINDOW_DAYS, defaultRange, runAttendanceCompute, withAttendanceJobLock } from './attendanceDailyJob.js'
import { addDays } from './shiftAssignmentQueries.js'
import { sendAttendanceDigest } from './notifications/attendanceDigest.js'

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

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const toArg = parseDateArg(argv, 'to')
  const fromArg = parseDateArg(argv, 'from')
  // --to alone still means "the 7 days ending there", same as no args at all
  // means "the 7 days ending yesterday".
  const toDate = toArg ?? defaultRange().toDate
  const fromDate = fromArg ?? addDays(toDate, -(DEFAULT_WINDOW_DAYS - 1))

  if (fromDate > toDate) {
    throw new Error(`--from (${fromDate}) must not be after --to (${toDate})`)
  }

  console.log(`Computing attendance_daily for ${fromDate} .. ${toDate}`)

  const result = await withAttendanceJobLock(() =>
    runAttendanceCompute({ fromDate, toDate }, (employeeId, rows, error) => {
      if (error) console.error(`  employee ${employeeId}: FAILED — ${String(error)}`)
      else console.log(`  employee ${employeeId}: ${rows} rows`)
    })
  )

  if (result === null) {
    // Another run holds the lock — the scheduler is mid-run, or a second copy
    // of this script is. Not an error worth a non-zero exit on its own, but
    // worth saying out loud rather than exiting silently having done nothing.
    console.log('Another attendance run is already in progress — nothing to do.')
    return
  }

  console.log(
    `Done in ${(result.durationMs / 1000).toFixed(1)}s. ` +
      `${result.rows} rows across ${result.employees - result.failed}/${result.employees} employees.`
  )

  // Only on the plain default-window call (no explicit --from/--to) — same
  // reasoning as the cron route. Awaited, unlike the route's fire-and-forget:
  // this process exits (and closes the pool) right after main() returns, so
  // an un-awaited notify() here would race that shutdown instead of just
  // running alongside a server that stays up.
  if (toArg === null && fromArg === null) {
    await sendAttendanceDigest(toDate)
  }

  // A partial run is a failed run as far as a cron wrapper is concerned — it
  // should be visible in the exit code, not just the log.
  if (result.failed > 0) process.exitCode = 1
}

try {
  await main()
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
} finally {
  await pool.end()
}
