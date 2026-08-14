// Turning attendance_events into a daily verdict, in two steps so far:
//  - resolveExpectedShiftWindows: what shift-hours were *expected* on an
//    employee's work-date, as real instants (overnight-aware). Reads only
//    employee_shift_assignments/master_shifts/holidays/leave/swaps, never
//    attendance_events.
//  - matchAttendanceForDates: pairs raw attendance_events punches against
//    those expected windows. Still matching only — no late/absent/
//    worked-hours verdict (that reads the result of this) and nothing
//    persisted yet.
//
// Deliberately does not trust attendance_events.shift_id: that column is
// stamped via currentShiftJoinSql() at insert time, which resolves against
// "today's" Thailand calendar date (see that function's comment). For an
// overnight shift, a check-out after midnight would resolve against the
// *next* day's assignment, not the shift that actually started the evening
// before. This module resolves the expected window independently, anchored
// to a work_date, so that bug can't leak into attendance matching.

import type pg from 'pg'
import type { CalendarDayStatus } from '@hrm/shared'
import { pool } from './db.js'
import { addDays } from './shiftAssignmentQueries.js'
import { buildCalendarDaysForDates } from './calendarQueries.js'

type Queryable = Pick<pg.Pool, 'query'>

/** Combines a work-date with a shift's wall-clock time into a real instant,
 *  in Thailand's fixed UTC+7 (no DST) — same standing assumption as
 *  toThailandDateString. */
function thailandDateTime(dateStr: string, timeStr: string): Date {
  return new Date(`${dateStr}T${timeStr}+07:00`)
}

/** The core overnight-handling logic, isolated as a pure function so it's
 *  easy to reason about and hand-verify against master_shifts' convention:
 *  shiftEndTime < shiftStartTime means the shift ends the following calendar
 *  day (see that migration's comment). */
export function computeShiftWindow(
  workDate: string,
  shiftStartTime: string,
  shiftEndTime: string
): { checkInAt: Date; checkOutAt: Date; isOvernight: boolean } {
  const checkInAt = thailandDateTime(workDate, shiftStartTime)
  // <=, not <: equal start/end means a 24h shift, not a zero-length one.
  const isOvernight = shiftEndTime <= shiftStartTime
  const checkOutDate = isOvernight ? addDays(workDate, 1) : workDate
  const checkOutAt = thailandDateTime(checkOutDate, shiftEndTime)
  return { checkInAt, checkOutAt, isOvernight }
}

/** One employee's expected attendance for one work-date. status/label/shiftId
 *  carry through buildCalendarDaysForDates unchanged — this module only adds
 *  the computed window and grace minutes on top, and deliberately leaves the
 *  judgment of which statuses actually expect attendance to whatever
 *  consumes this (matching attendance_events against it is a later phase). */
export type ExpectedShiftWindow = {
  workDate: string
  status: CalendarDayStatus
  shiftId: number | null
  shiftName: string | null
  /** ISO 8601, UTC. Null exactly when shiftId is null. */
  expectedCheckInAt: string | null
  expectedCheckOutAt: string | null
  isOvernight: boolean
  /** Null exactly when shiftId is null. */
  lateGraceMinutes: number | null
  earlyLeaveGraceMinutes: number | null
}

async function loadGraceMinutes(
  shiftIds: number[],
  db: Queryable
): Promise<Map<number, { late: number; early: number }>> {
  const result = new Map<number, { late: number; early: number }>()
  if (shiftIds.length === 0) return result

  const { rows } = await db.query<{
    id: string
    late_grace_minutes: number
    early_leave_grace_minutes: number
  }>(`SELECT id, late_grace_minutes, early_leave_grace_minutes FROM master_shifts WHERE id = ANY($1)`, [
    shiftIds,
  ])
  for (const row of rows) {
    result.set(Number(row.id), { late: row.late_grace_minutes, early: row.early_leave_grace_minutes })
  }
  return result
}

/** Resolves the expected shift window for one employee across a set of
 *  work-dates, reusing buildCalendarDaysForDates (calendarQueries.ts) rather
 *  than re-deriving shift assignment/holiday/leave/swap classification —
 *  that function already resolves "which shift applies on date X" through
 *  the same ledger as getShiftIdForDate, plus the workday/holiday/leave/swap
 *  status per date. */
export async function resolveExpectedShiftWindows(
  employeeId: number,
  dates: string[],
  db: Queryable = pool
): Promise<ExpectedShiftWindow[]> {
  const calendarDays = await buildCalendarDaysForDates(employeeId, dates, db)

  const shiftIds = [...new Set(calendarDays.map((d) => d.shiftId).filter((id): id is number => id !== null))]
  const graceByShiftId = await loadGraceMinutes(shiftIds, db)

  return calendarDays.map((day) => {
    if (day.shiftId === null || day.shiftStartTime === null || day.shiftEndTime === null) {
      return {
        workDate: day.date,
        status: day.status,
        shiftId: null,
        shiftName: null,
        expectedCheckInAt: null,
        expectedCheckOutAt: null,
        isOvernight: false,
        lateGraceMinutes: null,
        earlyLeaveGraceMinutes: null,
      }
    }

    const { checkInAt, checkOutAt, isOvernight } = computeShiftWindow(
      day.date,
      day.shiftStartTime,
      day.shiftEndTime
    )
    const grace = graceByShiftId.get(day.shiftId) ?? { late: 0, early: 0 }

    return {
      workDate: day.date,
      status: day.status,
      shiftId: day.shiftId,
      shiftName: day.shiftName,
      expectedCheckInAt: checkInAt.toISOString(),
      expectedCheckOutAt: checkOutAt.toISOString(),
      isOvernight,
      lateGraceMinutes: grace.late,
      earlyLeaveGraceMinutes: grace.early,
    }
  })
}

/** How far outside an expected window (both before check-in and after
 *  check-out) a raw punch still counts as belonging to that work-date. A
 *  punch clock has no concept of "which shift session" it belongs to, so
 *  this is what lets a genuinely-early arrival or genuinely-late departure
 *  still match — symmetric and fixed rather than per-shift-configurable,
 *  since this is a data-correlation tolerance, not an HR late/early policy
 *  (that's lateGraceMinutes/earlyLeaveGraceMinutes on master_shifts). */
const MATCH_BUFFER_MINUTES = 120

function withBufferMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000)
}

export type MatchedAttendanceDay = ExpectedShiftWindow & {
  /** ISO 8601 UTC — the earliest check_in event within [expectedCheckInAt -
   *  buffer, expectedCheckOutAt + buffer]. Null when no shift was expected
   *  that day, or no check_in event fell in the window. */
  actualCheckInAt: string | null
  actualCheckInEventId: number | null
  /** The latest check_out event in the same window. */
  actualCheckOutAt: string | null
  actualCheckOutEventId: number | null
}

type RawEvent = { id: number; eventType: 'check_in' | 'check_out'; eventTime: Date }

/** Every attendance_events row for one employee whose event_time falls in
 *  [from, to], ordered ascending. No join — this is a matching query, not a
 *  display one, unlike SELECT_ATTENDANCE_EVENT in attendanceQueries.ts. */
async function loadEventsInRange(
  employeeId: number,
  from: Date,
  to: Date,
  db: Queryable
): Promise<RawEvent[]> {
  const { rows } = await db.query<{ id: string; event_type: string; event_time: string }>(
    `SELECT id, event_type, event_time FROM attendance_events
     WHERE employee_id = $1 AND event_time BETWEEN $2 AND $3
     ORDER BY event_time ASC`,
    [employeeId, from.toISOString(), to.toISOString()]
  )
  return rows.map((row) => ({
    id: Number(row.id),
    eventType: row.event_type as 'check_in' | 'check_out',
    eventTime: new Date(row.event_time),
  }))
}

/** Pairs raw attendance_events punches onto resolveExpectedShiftWindows'
 *  output for one employee across a set of work-dates. Windows sharing a
 *  buffered range with a neighbor (most commonly: an overnight shift's
 *  checkout the next morning followed shortly after by a day-shift's
 *  check-in) can contest the same punch — resolved by processing windows in
 *  chronological order and letting the earlier work-date claim first. */
export async function matchAttendanceForDates(
  employeeId: number,
  dates: string[],
  db: Queryable = pool
): Promise<MatchedAttendanceDay[]> {
  const windows = await resolveExpectedShiftWindows(employeeId, dates, db)

  const withShift = windows
    .filter((w) => w.shiftId !== null && w.expectedCheckInAt !== null && w.expectedCheckOutAt !== null)
    .sort((a, b) => a.expectedCheckInAt!.localeCompare(b.expectedCheckInAt!))

  const matchedByWorkDate = new Map<string, MatchedAttendanceDay>()

  if (withShift.length > 0) {
    const rangeStart = withBufferMinutes(new Date(withShift[0]!.expectedCheckInAt!), -MATCH_BUFFER_MINUTES)
    const rangeEnd = withBufferMinutes(
      new Date(withShift[withShift.length - 1]!.expectedCheckOutAt!),
      MATCH_BUFFER_MINUTES
    )
    const events = await loadEventsInRange(employeeId, rangeStart, rangeEnd, db)

    const claimed = new Set<number>()
    for (const window of withShift) {
      const windowStart = withBufferMinutes(new Date(window.expectedCheckInAt!), -MATCH_BUFFER_MINUTES)
      const windowEnd = withBufferMinutes(new Date(window.expectedCheckOutAt!), MATCH_BUFFER_MINUTES)

      const inWindow = events.filter(
        (e) => !claimed.has(e.id) && e.eventTime >= windowStart && e.eventTime <= windowEnd
      )
      // Claim every punch in range, not just the two chosen below, so a
      // mid-window punch (e.g. a lunch-run check-out/check-in pair) can never
      // be picked up again by a neighboring date's overlapping window.
      for (const e of inWindow) claimed.add(e.id)

      const checkIns = inWindow.filter((e) => e.eventType === 'check_in')
      const checkOuts = inWindow.filter((e) => e.eventType === 'check_out')
      const firstCheckIn = checkIns[0] ?? null
      const lastCheckOut = checkOuts[checkOuts.length - 1] ?? null

      matchedByWorkDate.set(window.workDate, {
        ...window,
        actualCheckInAt: firstCheckIn ? firstCheckIn.eventTime.toISOString() : null,
        actualCheckInEventId: firstCheckIn ? firstCheckIn.id : null,
        actualCheckOutAt: lastCheckOut ? lastCheckOut.eventTime.toISOString() : null,
        actualCheckOutEventId: lastCheckOut ? lastCheckOut.id : null,
      })
    }
  }

  return windows.map(
    (window) =>
      matchedByWorkDate.get(window.workDate) ?? {
        ...window,
        actualCheckInAt: null,
        actualCheckInEventId: null,
        actualCheckOutAt: null,
        actualCheckOutEventId: null,
      }
  )
}
