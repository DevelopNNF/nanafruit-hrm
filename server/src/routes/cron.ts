// The endpoint an external scheduler (cron-job.org and friends) calls to run
// the attendance recompute.
//
// Mounted OUTSIDE `authenticate`, because a scheduler has no Entra account and
// no LINE session — it can only present a static credential. That makes this
// the one route in the app authenticated by a shared secret, so it is kept in
// its own file with its own check rather than blended into the routes a person
// calls, and it does exactly one thing.
//
// Why a distinct `X-Cron-Key` header instead of `Authorization: Bearer`: this
// credential is not a token any verifier here understands, and reusing that
// header invites a future refactor to route it through the JWT path, where it
// would fail confusingly at best. A different header keeps the two kinds of
// caller visibly separate.

import { Router } from 'express'
import type { Request, Response } from 'express'
import { timingSafeEqual } from 'node:crypto'
import { fail, handleUnexpected } from '../http.js'
import { cronLimiter } from '../rateLimit.js'
import {
  DEFAULT_WINDOW_DAYS,
  defaultRange,
  runAttendanceCompute,
  withAttendanceJobLock,
} from '../attendanceDailyJob.js'
import { addDays } from '../shiftAssignmentQueries.js'
import { sendAttendanceDigest } from '../notifications/attendanceDigest.js'

export const cronRouter = Router()

/** Read at call time, not module load, so a missing value is reported per
 *  request rather than crashing the whole server on boot over one route. */
function configuredSecret(): string | null {
  const secret = process.env['ATTENDANCE_CRON_SECRET']
  return typeof secret === 'string' && secret.length > 0 ? secret : null
}

/** Constant-time compare. Lengths are checked first because timingSafeEqual
 *  throws on a mismatch; the length itself is not worth hiding. */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function parseDateParam(value: unknown): string | null | undefined {
  if (value === undefined) return null
  if (typeof value !== 'string' || !DATE_RE.test(value)) return undefined
  return Number.isNaN(new Date(`${value}T00:00:00Z`).getTime()) ? undefined : value
}

/** null means "not given" (run every employee); undefined means the value present is invalid. */
function parseEmployeeIdParam(value: unknown): number | null | undefined {
  if (value === undefined) return null
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined
  return Number(value)
}

/**
 * POST /api/cron/attendance-daily
 *
 * Runs the same recompute as the attendance:compute CLI. Synchronous: the run
 * takes well under a scheduler's request timeout at this company's size
 * (roughly 70ms per employee per week), and answering only once the work is
 * done is what lets the scheduler's own success/failure log mean something. If
 * the employee count ever grows enough to approach that timeout, narrowing the
 * window with ?from=&to= is the first lever, not a background queue.
 *
 * ?employeeId= is optional and narrows the run to that one employee instead
 * of every active one, over the same date range. Omit it for the normal
 * whole-company run.
 */
cronRouter.post('/cron/attendance-daily', cronLimiter, async (req: Request, res: Response) => {
  const expected = configuredSecret()
  if (expected === null) {
    // Never fall through to "no secret configured means open". A deployment
    // that forgot the variable gets a disabled endpoint, not a public one.
    return fail(res, 503, 'ATTENDANCE_CRON_SECRET is not configured on this server')
  }

  const provided = req.get('x-cron-key')
  if (typeof provided !== 'string' || !secretMatches(provided, expected)) {
    return fail(res, 401, 'invalid or missing X-Cron-Key')
  }

  const toParam = parseDateParam(req.query['to'])
  if (toParam === undefined) return fail(res, 400, 'to must be YYYY-MM-DD')

  const fromParam = parseDateParam(req.query['from'])
  if (fromParam === undefined) return fail(res, 400, 'from must be YYYY-MM-DD')

  const employeeIdParam = parseEmployeeIdParam(req.query['employeeId'])
  if (employeeIdParam === undefined) return fail(res, 400, 'employeeId must be a positive integer')

  const toDate = toParam ?? defaultRange().toDate
  const fromDate = fromParam ?? addDays(toDate, -(DEFAULT_WINDOW_DAYS - 1))
  if (fromDate > toDate) return fail(res, 400, `from (${fromDate}) must not be after to (${toDate})`)

  try {
    const result = await withAttendanceJobLock(() =>
      runAttendanceCompute({ fromDate, toDate }, undefined, employeeIdParam ?? undefined)
    )

    if (result === null) {
      // The previous trigger is still running. 409 rather than 200 so a
      // scheduler firing faster than the job completes is visible in its log
      // instead of looking like a series of successful no-ops.
      return fail(res, 409, 'another attendance run is already in progress')
    }

    console.log(
      `[cron] attendance-daily ${result.fromDate}..${result.toDate}: ` +
        `${result.rows} rows, ${result.employees - result.failed}/${result.employees} employees, ` +
        `${(result.durationMs / 1000).toFixed(1)}s`
    )

    // Only on the plain daily call (no explicit ?from=/?to=/?employeeId=) — an
    // ad-hoc backfill, re-run over an arbitrary range, or single-employee
    // re-run must not re-send a company-wide digest for days that already had
    // one. See attendanceDigest.ts's header comment on why this isn't
    // otherwise guarded against duplicate sends.
    if (toParam === null && fromParam === null && employeeIdParam === null) {
      void sendAttendanceDigest(toDate)
    }

    // A partial run answers 500: the scheduler should show it as failed and
    // alert, the same way the CLI exits non-zero. The body still reports what
    // did get through, so the log says how bad it was.
    res.status(result.failed > 0 ? 500 : 200).json({
      status: result.failed > 0 ? 'partial' : 'ok',
      ...result,
    })
  } catch (err) {
    handleUnexpected(res, err)
  }
})
