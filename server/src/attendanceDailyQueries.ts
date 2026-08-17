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
import { pool } from './db.js'
import { parseDateOnlyUtc, toDateOnlyString } from './leaveRequestQueries.js'
import { matchAttendanceForDates, type MatchedAttendanceDay } from './attendanceMatchingQueries.js'

type Queryable = Pick<pg.Pool, 'query'>

/**
 * Whether work was expected on a date, and whether it happened.
 *
 * Late and early-leave are deliberately *not* statuses here — they're
 * magnitudes reported alongside, so a day that is both late and short
 * doesn't need a combinatorial status of its own.
 */
export const ATTENDANCE_DAY_STATUSES = [
  /** Work expected, both punches matched. */
  'present',
  /** Work expected, exactly one punch matched — usually a forgotten clock-out. */
  'incomplete',
  /** Work expected, no punches at all. */
  'absent',
  /** No work expected, and none happened. */
  'day_off',
  /** No work expected, but punches exist — a day off worked, which the OT
   *  rates in master_overtime_groups are what ultimately price. */
  'unscheduled_work',
] as const
export type AttendanceDayStatus = (typeof ATTENDANCE_DAY_STATUSES)[number]

export type AttendanceDayVerdict = {
  status: AttendanceDayStatus
  /** Minutes past the shift's start, or 0 when within grace / not applicable.
   *  See computeAttendanceDay for why this is the full amount rather than the
   *  excess over grace. */
  lateMinutes: number
  earlyLeaveMinutes: number
  /** Clamped to the shift window and net of the scheduled break. Null unless
   *  both punches matched — one punch alone can't measure a duration. */
  workedMinutes: number | null
}

function minutesBetweenInstants(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 60_000)
}

/** Minutes the two instant ranges have in common — 0 when they don't touch. */
function overlapMinutes(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): number {
  const start = Math.max(aStart.getTime(), bStart.getTime())
  const end = Math.min(aEnd.getTime(), bEnd.getTime())
  return end <= start ? 0 : Math.round((end - start) / 60_000)
}

/**
 * The verdict for one already-matched work-date.
 *
 * Work counts as expected when a shift applied *and* the day classified as
 * 'workday' or 'swap_workday'. The other four CalendarDayStatus values
 * (weekly_off, holiday, leave, swap_dayoff) all mean nothing was scheduled —
 * this is the judgment resolveExpectedShiftWindows deliberately left to its
 * caller rather than baking in.
 *
 * Grace decides *whether* lateness counts, not how much of it: with a
 * 15-minute grace, arriving 20 minutes late records 20, not 5. That matches
 * the usual reading of a grace period (ถ้าสายไม่เกิน X นาที ไม่ถือว่าสาย);
 * recording the excess instead would be a one-line change below.
 */
export function computeAttendanceDay(day: MatchedAttendanceDay): AttendanceDayVerdict {
  const hasCheckIn = day.actualCheckInAt !== null
  const hasCheckOut = day.actualCheckOutAt !== null
  const workExpected =
    day.shiftId !== null && (day.status === 'workday' || day.status === 'swap_workday')

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

  // workExpected already guarantees a shift applied, so the expected instants
  // are set — see ExpectedShiftWindow, where they're null exactly when
  // shiftId is.
  const expectedCheckIn = new Date(day.expectedCheckInAt!)
  const expectedCheckOut = new Date(day.expectedCheckOutAt!)
  const lateGrace = day.lateGraceMinutes ?? 0
  const earlyGrace = day.earlyLeaveGraceMinutes ?? 0

  let lateMinutes = 0
  if (day.actualCheckInAt !== null) {
    const actual = new Date(day.actualCheckInAt)
    const allowedUntil = new Date(expectedCheckIn.getTime() + lateGrace * 60_000)
    if (actual > allowedUntil) lateMinutes = minutesBetweenInstants(expectedCheckIn, actual)
  }

  let earlyLeaveMinutes = 0
  if (day.actualCheckOutAt !== null) {
    const actual = new Date(day.actualCheckOutAt)
    const allowedFrom = new Date(expectedCheckOut.getTime() - earlyGrace * 60_000)
    if (actual < allowedFrom) earlyLeaveMinutes = minutesBetweenInstants(actual, expectedCheckOut)
  }

  if (!hasCheckIn || !hasCheckOut) {
    return { status: 'incomplete', lateMinutes, earlyLeaveMinutes, workedMinutes: null }
  }

  // Clamped to the shift: arriving early or staying late doesn't inflate the
  // day's worked minutes, because that overhang is OT and gets priced by its
  // own rate rather than counted here.
  const clampedStart = new Date(
    Math.max(new Date(day.actualCheckInAt!).getTime(), expectedCheckIn.getTime())
  )
  const clampedEnd = new Date(
    Math.min(new Date(day.actualCheckOutAt!).getTime(), expectedCheckOut.getTime())
  )
  const spanMinutes = Math.max(0, minutesBetweenInstants(clampedStart, clampedEnd))

  // Subtract only the part of the break the employee was actually present
  // for: someone who left at 11:00 never reached a 12:00 break and shouldn't
  // be docked for it.
  let breakMinutes = 0
  if (day.expectedBreakStartAt !== null && day.expectedBreakEndAt !== null && spanMinutes > 0) {
    breakMinutes = overlapMinutes(
      clampedStart,
      clampedEnd,
      new Date(day.expectedBreakStartAt),
      new Date(day.expectedBreakEndAt)
    )
  }

  return {
    status: 'present',
    lateMinutes,
    earlyLeaveMinutes,
    workedMinutes: Math.max(0, spanMinutes - breakMinutes),
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
          actual_check_in_at, actual_check_out_at,
          actual_check_in_event_id, actual_check_out_event_id,
          late_minutes, early_leave_minutes, worked_minutes, is_overnight)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (employee_id, work_date) DO UPDATE SET
         shift_id = EXCLUDED.shift_id,
         day_status = EXCLUDED.day_status,
         attendance_status = EXCLUDED.attendance_status,
         expected_check_in_at = EXCLUDED.expected_check_in_at,
         expected_check_out_at = EXCLUDED.expected_check_out_at,
         actual_check_in_at = EXCLUDED.actual_check_in_at,
         actual_check_out_at = EXCLUDED.actual_check_out_at,
         actual_check_in_event_id = EXCLUDED.actual_check_in_event_id,
         actual_check_out_event_id = EXCLUDED.actual_check_out_event_id,
         late_minutes = EXCLUDED.late_minutes,
         early_leave_minutes = EXCLUDED.early_leave_minutes,
         worked_minutes = EXCLUDED.worked_minutes,
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
        day.actualCheckInAt,
        day.actualCheckOutAt,
        day.actualCheckInEventId,
        day.actualCheckOutEventId,
        verdict.lateMinutes,
        verdict.earlyLeaveMinutes,
        verdict.workedMinutes,
        day.isOvernight,
      ]
    )
  }

  return matched.length
}
