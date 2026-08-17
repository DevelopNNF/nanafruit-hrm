// The daily attendance verdict, and its persistence into attendance_daily.
//
// Consumes matchAttendanceForDates (attendanceMatchingQueries.ts), which has
// already resolved what was expected on each work-date and paired the raw
// punches onto it. What's left is the judgment — was work expected, did it
// happen, how late, how many minutes actually worked — plus writing the
// answer down.
//
// Same split as computeTotalDays in leaveRequestQueries.ts: computeAttendanceDay
// is pure and takes fully-resolved input, so the interesting rules can be
// reasoned about without a database in the picture; recomputeAttendanceDaily
// is the DB half around it.
//
// Everything written here is derived data — see 037_create_attendance_daily.sql.

import type pg from 'pg'
import type {
  AttendanceDailyFilter,
  AttendanceDailyItem,
  AttendanceDailySummary,
  AttendanceDayStatus,
  CalendarDayStatus,
} from '@hrm/shared'
import { pool } from './db.js'
import { parseDateOnlyUtc, toDateOnlyString } from './leaveRequestQueries.js'
import { matchAttendanceForDates, type MatchedAttendanceDay } from './attendanceMatchingQueries.js'

type Queryable = Pick<pg.Pool, 'query'>

export type AttendanceDayVerdict = {
  status: AttendanceDayStatus
  /** Minutes past the time the employee was due in, or 0 when within grace /
   *  not applicable. See computeAttendanceDay for why this is the full amount
   *  rather than the excess over grace. */
  lateMinutes: number
  earlyLeaveMinutes: number
  /** Minutes of the expected work intervals the employee was actually present
   *  for. Null unless both punches matched — one punch alone can't measure a
   *  duration. */
  workedMinutes: number | null
}

function minutesBetweenInstants(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 60_000)
}

/**
 * The verdict for one already-matched work-date.
 *
 * Work counts as expected when the day owed any working minutes at all —
 * expectedWorkMinutes > 0, which resolveExpectedShiftWindows has already
 * worked out by carving the unpaid break and any approved leave out of the
 * shift window. That single test covers every case uniformly: a day off owes
 * nothing, full-day leave owes nothing, and a half-day leave still owes the
 * half that wasn't taken.
 *
 * Lateness and early departure are measured against effectiveCheckInAt /
 * effectiveCheckOutAt — when the employee was really due in and out — not the
 * raw shift window. Someone on morning leave who arrives at 13:00 for a
 * 13:00 restart is on time, not four hours late.
 *
 * Grace decides *whether* lateness counts, not how much of it: with a
 * 15-minute grace, arriving 20 minutes late records 20, not 5. That matches
 * the usual reading of a grace period (ถ้าสายไม่เกิน X นาที ไม่ถือว่าสาย);
 * recording the excess instead would be a one-line change below.
 */
export function computeAttendanceDay(day: MatchedAttendanceDay): AttendanceDayVerdict {
  const hasCheckIn = day.actualCheckInAt !== null
  const hasCheckOut = day.actualCheckOutAt !== null
  const workExpected = day.expectedWorkMinutes > 0

  if (!workExpected) {
    return {
      status: hasCheckIn || hasCheckOut ? 'unscheduled_work' : 'day_off',
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
      workedMinutes: null,
    }
  }

  if (!hasCheckIn && !hasCheckOut) {
    return { status: 'absent', lateMinutes: 0, earlyLeaveMinutes: 0, workedMinutes: null }
  }

  // workExpected means at least one work interval survived, so the effective
  // bounds are set — see ExpectedShiftWindow, where they're null exactly when
  // nothing was owed.
  const dueIn = new Date(day.effectiveCheckInAt!)
  const dueOut = new Date(day.effectiveCheckOutAt!)
  const lateGrace = day.lateGraceMinutes ?? 0
  const earlyGrace = day.earlyLeaveGraceMinutes ?? 0

  let lateMinutes = 0
  if (day.actualCheckInAt !== null) {
    const actual = new Date(day.actualCheckInAt)
    const allowedUntil = new Date(dueIn.getTime() + lateGrace * 60_000)
    if (actual > allowedUntil) lateMinutes = minutesBetweenInstants(dueIn, actual)
  }

  let earlyLeaveMinutes = 0
  if (day.actualCheckOutAt !== null) {
    const actual = new Date(day.actualCheckOutAt)
    const allowedFrom = new Date(dueOut.getTime() - earlyGrace * 60_000)
    if (actual < allowedFrom) earlyLeaveMinutes = minutesBetweenInstants(actual, dueOut)
  }

  if (!hasCheckIn || !hasCheckOut) {
    return { status: 'incomplete', lateMinutes, earlyLeaveMinutes, workedMinutes: null }
  }

  // How much of what was owed the employee was actually there for: intersect
  // their presence with the expected work intervals. Intersecting rather than
  // clamping is what makes the break, a mid-shift hour of leave, and arriving
  // early all fall out of the same line — none of them are inside an expected
  // interval, so none of them count.
  const presentFrom = new Date(day.actualCheckInAt!).getTime()
  const presentTo = new Date(day.actualCheckOutAt!).getTime()
  let workedMs = 0
  for (const interval of day.expectedWorkIntervals) {
    const start = Math.max(presentFrom, new Date(interval.startAt).getTime())
    const end = Math.min(presentTo, new Date(interval.endAt).getTime())
    if (end > start) workedMs += end - start
  }

  return {
    status: 'present',
    lateMinutes,
    earlyLeaveMinutes,
    workedMinutes: Math.round(workedMs / 60_000),
  }
}

/** Every 'YYYY-MM-DD' from fromDate through toDate, inclusive. */
function expandDateRange(fromDate: string, toDate: string): string[] {
  const dates: string[] = []
  const end = parseDateOnlyUtc(toDate)
  for (let d = parseDateOnlyUtc(fromDate); d.getTime() <= end.getTime(); d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(toDateOnlyString(d))
  }
  return dates
}

/**
 * Recomputes and upserts one employee's attendance_daily rows across
 * [fromDate, toDate], returning how many rows were written.
 *
 * Idempotent by construction: the verdict is a pure function of data this
 * reads fresh every time, and the write is keyed on (employee_id, work_date),
 * so re-running over the same range converges rather than accumulating. That
 * is what lets the batch job simply recompute a rolling window instead of
 * tracking which days have been invalidated by a backdated approval.
 */
export async function recomputeAttendanceDaily(
  employeeId: number,
  fromDate: string,
  toDate: string,
  db: Queryable = pool
): Promise<number> {
  const dates = expandDateRange(fromDate, toDate)
  if (dates.length === 0) return 0

  const matched = await matchAttendanceForDates(employeeId, dates, db)

  for (const day of matched) {
    const verdict = computeAttendanceDay(day)
    await db.query(
      `INSERT INTO attendance_daily
         (employee_id, work_date, shift_id, day_status, attendance_status,
          expected_check_in_at, expected_check_out_at,
          effective_check_in_at, effective_check_out_at,
          actual_check_in_at, actual_check_out_at,
          actual_check_in_event_id, actual_check_out_event_id,
          late_minutes, early_leave_minutes, worked_minutes,
          expected_work_minutes, leave_minutes, is_overnight)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       ON CONFLICT (employee_id, work_date) DO UPDATE SET
         shift_id = EXCLUDED.shift_id,
         day_status = EXCLUDED.day_status,
         attendance_status = EXCLUDED.attendance_status,
         expected_check_in_at = EXCLUDED.expected_check_in_at,
         expected_check_out_at = EXCLUDED.expected_check_out_at,
         effective_check_in_at = EXCLUDED.effective_check_in_at,
         effective_check_out_at = EXCLUDED.effective_check_out_at,
         actual_check_in_at = EXCLUDED.actual_check_in_at,
         actual_check_out_at = EXCLUDED.actual_check_out_at,
         actual_check_in_event_id = EXCLUDED.actual_check_in_event_id,
         actual_check_out_event_id = EXCLUDED.actual_check_out_event_id,
         late_minutes = EXCLUDED.late_minutes,
         early_leave_minutes = EXCLUDED.early_leave_minutes,
         worked_minutes = EXCLUDED.worked_minutes,
         expected_work_minutes = EXCLUDED.expected_work_minutes,
         leave_minutes = EXCLUDED.leave_minutes,
         is_overnight = EXCLUDED.is_overnight,
         computed_at = now(),
         updated_at = now()`,
      [
        employeeId,
        day.workDate,
        day.shiftId,
        day.status,
        verdict.status,
        day.expectedCheckInAt,
        day.expectedCheckOutAt,
        day.effectiveCheckInAt,
        day.effectiveCheckOutAt,
        day.actualCheckInAt,
        day.actualCheckOutAt,
        day.actualCheckInEventId,
        day.actualCheckOutEventId,
        verdict.lateMinutes,
        verdict.earlyLeaveMinutes,
        verdict.workedMinutes,
        day.shiftId === null ? null : day.expectedWorkMinutes,
        day.leaveMinutes,
        day.isOvernight,
      ]
    )
  }

  return matched.length
}

/* Reading it back -----------------------------------------------------------
 * The admin report. Read-only by design: attendance_daily is derived, so there
 * is no update path here — correcting a day means correcting what it derives
 * from (a time correction, a shift change, an approved leave) and letting the
 * job recompute.
 */

type AttendanceDailyRow = {
  id: string
  employee_id: string
  employee_code: string
  employee_name: string
  work_date: string
  shift_id: string | null
  shift_code: string | null
  shift_name: string | null
  day_status: string
  attendance_status: string
  expected_check_in_at: string | null
  expected_check_out_at: string | null
  effective_check_in_at: string | null
  effective_check_out_at: string | null
  actual_check_in_at: string | null
  actual_check_out_at: string | null
  late_minutes: number
  early_leave_minutes: number
  worked_minutes: number | null
  expected_work_minutes: number | null
  leave_minutes: number
  is_overnight: boolean
  computed_at: string
}

const iso = (value: string | null): string | null => (value === null ? null : new Date(value).toISOString())

function rowToAttendanceDailyItem(row: AttendanceDailyRow): AttendanceDailyItem {
  return {
    id: Number(row.id),
    employeeId: Number(row.employee_id),
    employeeCode: row.employee_code,
    employeeName: row.employee_name,
    workDate: row.work_date,
    shiftId: row.shift_id === null ? null : Number(row.shift_id),
    shiftCode: row.shift_code,
    shiftName: row.shift_name,
    dayStatus: row.day_status as CalendarDayStatus,
    attendanceStatus: row.attendance_status as AttendanceDayStatus,
    expectedCheckInAt: iso(row.expected_check_in_at),
    expectedCheckOutAt: iso(row.expected_check_out_at),
    effectiveCheckInAt: iso(row.effective_check_in_at),
    effectiveCheckOutAt: iso(row.effective_check_out_at),
    actualCheckInAt: iso(row.actual_check_in_at),
    actualCheckOutAt: iso(row.actual_check_out_at),
    lateMinutes: row.late_minutes,
    earlyLeaveMinutes: row.early_leave_minutes,
    workedMinutes: row.worked_minutes,
    expectedWorkMinutes: row.expected_work_minutes,
    leaveMinutes: row.leave_minutes,
    isOvernight: row.is_overnight,
    computedAt: new Date(row.computed_at).toISOString(),
  }
}

/** SQL for one filter value. 'late'/'early_leave'/'leave' are minute-count
 *  tests rather than statuses — see ATTENDANCE_DAILY_FILTERS. */
const FILTER_SQL: Record<AttendanceDailyFilter, string> = {
  present: `d.attendance_status = 'present'`,
  late: `d.late_minutes > 0`,
  early_leave: `d.early_leave_minutes > 0`,
  leave: `d.leave_minutes > 0`,
  absent: `d.attendance_status = 'absent'`,
  incomplete: `d.attendance_status = 'incomplete'`,
  day_off: `d.attendance_status = 'day_off'`,
  unscheduled_work: `d.attendance_status = 'unscheduled_work'`,
}

export type AttendanceDailyFilterInput = {
  /** Inclusive, 'YYYY-MM-DD'. */
  fromDate?: string
  toDate?: string
  employeeId?: number
  departmentId?: number
  status?: AttendanceDailyFilter
}

/** How many rows one request will return. The summary is computed over the
 *  whole filtered range regardless, so truncation never skews the figures. */
const LIST_LIMIT = 1000

export async function listAttendanceDaily(
  filter: AttendanceDailyFilterInput,
  db: Queryable = pool
): Promise<{ days: AttendanceDailyItem[]; summary: AttendanceDailySummary; truncated: boolean }> {
  const conditions: string[] = []
  const params: unknown[] = []

  if (filter.fromDate !== undefined) {
    params.push(filter.fromDate)
    conditions.push(`d.work_date >= $${params.length}::date`)
  }
  if (filter.toDate !== undefined) {
    params.push(filter.toDate)
    conditions.push(`d.work_date <= $${params.length}::date`)
  }
  if (filter.employeeId !== undefined) {
    params.push(filter.employeeId)
    conditions.push(`d.employee_id = $${params.length}`)
  }
  if (filter.departmentId !== undefined) {
    params.push(filter.departmentId)
    conditions.push(`ed.department_id = $${params.length}`)
  }
  if (filter.status !== undefined) {
    conditions.push(FILTER_SQL[filter.status])
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  // employment_details is joined unconditionally rather than only when
  // filtering by department: it's a 1:1 table on employee_id, so it costs
  // nothing, and branching the FROM clause on a filter is how the two shapes
  // drift apart later.
  const from = `
    FROM attendance_daily d
    JOIN employees e ON e.id = d.employee_id
    JOIN employment_details ed ON ed.employee_id = d.employee_id
    LEFT JOIN master_shifts ms ON ms.id = d.shift_id
    ${where}`

  const [listResult, summaryResult] = await Promise.all([
    db.query<AttendanceDailyRow>(
      `SELECT d.id, d.employee_id, e.employee_code,
              (e.title || e.first_name_th || ' ' || e.last_name_th) AS employee_name,
              d.work_date, d.shift_id, ms.shift_code, ms.shift_name,
              d.day_status, d.attendance_status,
              d.expected_check_in_at, d.expected_check_out_at,
              d.effective_check_in_at, d.effective_check_out_at,
              d.actual_check_in_at, d.actual_check_out_at,
              d.late_minutes, d.early_leave_minutes, d.worked_minutes,
              d.expected_work_minutes, d.leave_minutes, d.is_overnight, d.computed_at
       ${from}
       ORDER BY d.work_date DESC, e.employee_code
       LIMIT ${LIST_LIMIT + 1}`,
      params
    ),
    db.query<{
      total: string
      present: string
      late: string
      early_leave: string
      absent: string
      incomplete: string
      last_computed_at: string | null
    }>(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE d.attendance_status = 'present')     AS present,
              count(*) FILTER (WHERE d.late_minutes > 0)                  AS late,
              count(*) FILTER (WHERE d.early_leave_minutes > 0)           AS early_leave,
              count(*) FILTER (WHERE d.attendance_status = 'absent')      AS absent,
              count(*) FILTER (WHERE d.attendance_status = 'incomplete')  AS incomplete,
              max(d.computed_at) AS last_computed_at
       ${from}`,
      params
    ),
  ])

  const truncated = listResult.rows.length > LIST_LIMIT
  const s = summaryResult.rows[0]

  return {
    days: listResult.rows.slice(0, LIST_LIMIT).map(rowToAttendanceDailyItem),
    summary: {
      total: Number(s?.total ?? 0),
      present: Number(s?.present ?? 0),
      late: Number(s?.late ?? 0),
      earlyLeave: Number(s?.early_leave ?? 0),
      absent: Number(s?.absent ?? 0),
      incomplete: Number(s?.incomplete ?? 0),
      lastComputedAt: s?.last_computed_at ? new Date(s.last_computed_at).toISOString() : null,
    },
    truncated,
  }
}
