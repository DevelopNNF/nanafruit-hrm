// Running the attendance recompute over every active employee — the shared
// body behind both entry points: the `attendance:compute` CLI script and the
// POST /api/cron/attendance-daily endpoint an external scheduler calls.
//
// Neither entry point owns this logic, so the two can't drift on what a run
// means: same default window, same per-employee isolation, same lock.

import { pool } from './db.js'
import { recomputeAttendanceDaily } from './attendanceDailyQueries.js'
import { addDays, toThailandDateString } from './shiftAssignmentQueries.js'

/** How many days back a run covers when no explicit range is given. */
export const DEFAULT_WINDOW_DAYS = 7

/**
 * A fixed key for the Postgres advisory lock that serialises runs. Arbitrary
 * but stable — it only has to not collide with another advisory lock in this
 * database, and this is the only one.
 */
const ATTENDANCE_JOB_LOCK_KEY = 4_200_001

export type AttendanceRunRange = { fromDate: string; toDate: string }

/**
 * The window to recompute when none was given: the last 7 days ending
 * yesterday, Thailand time.
 *
 * Ends yesterday because today's shifts haven't finished — though a run that
 * does cover an unfinished day is harmless, since the whole window is
 * recomputed on every run and the next one corrects it. That same property is
 * what lets a backdated approval be picked up without a queue to track it.
 */
export function defaultRange(): AttendanceRunRange {
  const toDate = addDays(toThailandDateString(new Date()), -1)
  return { fromDate: addDays(toDate, -(DEFAULT_WINDOW_DAYS - 1)), toDate }
}

export type AttendanceRunResult = {
  fromDate: string
  toDate: string
  /** Active employees the run covered. */
  employees: number
  /** How many of them threw — their own transaction rolled back, the rest still committed. */
  failed: number
  /** attendance_daily rows written across all of them. */
  rows: number
  /** Wall-clock duration, for the caller's log. */
  durationMs: number
}

/**
 * Recomputes [fromDate, toDate] for every active employee.
 *
 * One transaction per employee, so a single bad record can't roll back the
 * whole run and progress made before it stays committed. A thrown employee is
 * counted in `failed` rather than aborting the loop — a run that gets 49 of 50
 * employees done is worth more than one that gets none.
 *
 * Does NOT take the lock itself: callers wrap it in withAttendanceJobLock, so
 * that acquiring and reporting a busy run is the caller's decision (the CLI
 * says so on stderr, the HTTP route answers 409).
 */
export async function runAttendanceCompute(
  range: AttendanceRunRange,
  onEmployee?: (employeeId: number, rows: number, error?: unknown) => void
): Promise<AttendanceRunResult> {
  const startedAt = Date.now()

  const { rows: employees } = await pool.query<{ employee_id: string }>(
    `SELECT employee_id FROM employment_details WHERE status = 'Active' ORDER BY employee_id`
  )

  let rows = 0
  let failed = 0

  for (const { employee_id } of employees) {
    const employeeId = Number(employee_id)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const written = await recomputeAttendanceDaily(employeeId, range.fromDate, range.toDate, client)
      await client.query('COMMIT')
      rows += written
      onEmployee?.(employeeId, written)
    } catch (err) {
      await client.query('ROLLBACK')
      failed += 1
      onEmployee?.(employeeId, 0, err)
    } finally {
      client.release()
    }
  }

  return {
    ...range,
    employees: employees.length,
    failed,
    rows,
    durationMs: Date.now() - startedAt,
  }
}

/**
 * Runs `fn` holding the advisory lock, or returns null without running if
 * another run already holds it.
 *
 * Two runs over the same dates would not corrupt anything — the upsert is
 * idempotent — but they would double the database load for no benefit, and a
 * scheduler that fires again while the previous call is still going is exactly
 * how that happens. The lock lives in Postgres rather than in this process so
 * it also covers someone running the CLI by hand while the cron fires, and a
 * second server instance if there ever is one.
 */
export async function withAttendanceJobLock<T>(fn: () => Promise<T>): Promise<T | null> {
  const client = await pool.connect()
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [ATTENDANCE_JOB_LOCK_KEY]
    )
    if (!rows[0]?.locked) return null

    try {
      return await fn()
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [ATTENDANCE_JOB_LOCK_KEY])
    }
  } finally {
    client.release()
  }
}
