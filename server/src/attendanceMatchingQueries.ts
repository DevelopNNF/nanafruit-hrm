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
import { isWorkday, parseDateOnlyUtc, toDateOnlyString } from './leaveRequestQueries.js'

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

/** A wall-clock range stated against a work-date, resolved to real instants
 *  and anchored to whichever calendar day places it inside the shift. A range
 *  stated as 02:00-03:00 belongs to the *next* calendar day when the shift
 *  itself started at 22:00 the evening before, so a range landing before the
 *  shift's own start is pushed forward a day. Only one wrap is ever needed:
 *  neither a break nor a partial leave is allowed to cross midnight on its
 *  own (routes/shifts.ts and the leave form both enforce start < end). */
function anchorRangeToShift(
  workDate: string,
  startTime: string,
  endTime: string,
  shiftCheckInAt: Date
): { startAt: Date; endAt: Date } {
  const sameDayStart = thailandDateTime(workDate, startTime)
  const date = sameDayStart < shiftCheckInAt ? addDays(workDate, 1) : workDate
  return { startAt: thailandDateTime(date, startTime), endAt: thailandDateTime(date, endTime) }
}

/** The shift's unpaid break as real instants — see anchorRangeToShift for the
 *  which-calendar-day rule. */
export function computeBreakWindow(
  workDate: string,
  breakStartTime: string,
  breakEndTime: string,
  shiftCheckInAt: Date
): { breakStartAt: Date; breakEndAt: Date } {
  const { startAt, endAt } = anchorRangeToShift(workDate, breakStartTime, breakEndTime, shiftCheckInAt)
  return { breakStartAt: startAt, breakEndAt: endAt }
}

/** Half-open interval of epoch milliseconds. */
type Interval = { start: number; end: number }

/** `base` with every part that overlaps any of `cuts` removed, in order. One
 *  cut can split one base interval in two — an hour of leave in the middle of
 *  a shift leaves work expected on both sides of it — so this returns a list
 *  rather than a narrowed pair. */
function subtractIntervals(base: Interval[], cuts: Interval[]): Interval[] {
  let remaining = base.filter((i) => i.end > i.start)
  for (const cut of cuts) {
    if (cut.end <= cut.start) continue
    const next: Interval[] = []
    for (const piece of remaining) {
      if (cut.end <= piece.start || cut.start >= piece.end) {
        next.push(piece) // no overlap
        continue
      }
      if (cut.start > piece.start) next.push({ start: piece.start, end: cut.start })
      if (cut.end < piece.end) next.push({ start: cut.end, end: piece.end })
    }
    remaining = next
  }
  return remaining
}

function totalMinutes(intervals: Interval[]): number {
  return Math.round(intervals.reduce((sum, i) => sum + (i.end - i.start), 0) / 60_000)
}

/** One approved leave covering some part of a date. `startTime`/`endTime` are
 *  null for a plain full-day leave, and set to an exact clock range for a
 *  half-day or hourly one — see leave_requests' migration comment. */
type LeaveOnDate = { startTime: string | null; endTime: string | null }

/**
 * Approved leave overlapping [minDate, maxDate], grouped by calendar date.
 *
 * This deliberately re-queries leave_requests rather than reading it off
 * buildCalendarDaysForDates: that function collapses a leave to a single
 * `status = 'leave'` on the whole day and drops start_time/end_time, which is
 * all the calendar UI needs but loses exactly the information a half-day
 * leave turns on. Widening the shared CalendarDay contract for one consumer
 * would be the bigger change.
 */
async function loadLeaveByDate(
  employeeId: number,
  minDate: string,
  maxDate: string,
  db: Queryable
): Promise<Map<string, LeaveOnDate[]>> {
  const { rows } = await db.query<{
    start_date: string
    end_date: string
    start_time: string | null
    end_time: string | null
  }>(
    `SELECT start_date, end_date, start_time, end_time
     FROM leave_requests
     WHERE employee_id = $1 AND status = 'approved'
       AND start_date <= $3 AND end_date >= $2`,
    [employeeId, minDate, maxDate]
  )

  const byDate = new Map<string, LeaveOnDate[]>()
  for (const row of rows) {
    const from = row.start_date < minDate ? minDate : row.start_date
    const to = row.end_date > maxDate ? maxDate : row.end_date
    for (let d = parseDateOnlyUtc(from); toDateOnlyString(d) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
      const key = toDateOnlyString(d)
      const list = byDate.get(key) ?? []
      list.push({ startTime: row.start_time, endTime: row.end_time })
      byDate.set(key, list)
    }
  }
  return byDate
}

/** One approved overtime block, resolved to real instants. */
export type OvertimeInterval = { requestId: number; startAt: string; endAt: string }

/**
 * Approved overtime_requests for the given work-dates, grouped by date and
 * resolved to instants.
 *
 * Anchored to its own ot_date, exactly like the shift is anchored to
 * work_date: a 22:00-02:00 block belongs to the evening it started, and
 * computeShiftWindow already encodes that "end <= start means the next
 * calendar day" rule, so it is reused rather than restated.
 *
 * Only 'approved' rows are loaded. A pending request must not widen the
 * matching window or it would change the attendance verdict of a day before
 * anyone decided the OT was allowed at all.
 */
async function loadOvertimeByDate(
  employeeId: number,
  dates: string[],
  db: Queryable
): Promise<Map<string, OvertimeInterval[]>> {
  const { rows } = await db.query<{
    id: string
    ot_date: string
    start_time: string
    end_time: string
  }>(
    `SELECT id, ot_date, start_time, end_time
     FROM overtime_requests
     WHERE employee_id = $1 AND status = 'approved' AND ot_date = ANY($2::date[])
     ORDER BY ot_date, start_time`,
    [employeeId, dates]
  )

  const byDate = new Map<string, OvertimeInterval[]>()
  for (const row of rows) {
    const { checkInAt, checkOutAt } = computeShiftWindow(row.ot_date, row.start_time, row.end_time)
    const list = byDate.get(row.ot_date) ?? []
    list.push({
      requestId: Number(row.id),
      startAt: checkInAt.toISOString(),
      endAt: checkOutAt.toISOString(),
    })
    byDate.set(row.ot_date, list)
  }
  return byDate
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
  /** ISO 8601, UTC. Both null together — null when shiftId is null, and also
   *  when the shift simply has no break configured. */
  expectedBreakStartAt: string | null
  expectedBreakEndAt: string | null
  /**
   * When work was actually owed, once the unpaid break and any approved leave
   * are carved out of the shift window. Empty when nothing was owed at all (a
   * day off, a holiday, full-day leave, or no shift assigned).
   *
   * A list rather than a single range because an hour of leave taken in the
   * middle of a shift leaves work owed on both sides of it.
   */
  expectedWorkIntervals: { startAt: string; endAt: string }[]
  /** Total minutes across expectedWorkIntervals. 0 when nothing was owed. */
  expectedWorkMinutes: number
  /**
   * Approved overtime blocks anchored to this work-date. Deliberately NOT
   * folded into expectedWorkIntervals: those are the hours the shift owed,
   * which lateness, early departure and workedMinutes are all measured
   * against, and OT is paid on a different basis entirely (see
   * overtimeCalculation.ts). Kept separate so neither figure contaminates
   * the other.
   *
   * They do widen the punch-matching window, though — see
   * matchAttendanceForDates.
   */
  overtimeIntervals: OvertimeInterval[]
  /** Working minutes excused by approved leave — i.e. minutes that would have
   *  been owed had the leave not been approved. Break time is never counted
   *  here, since it was never work in the first place. */
  leaveMinutes: number
  /** First/last instant of expectedWorkIntervals: when the employee was
   *  actually due in and due out. Equal to expectedCheckInAt/OutAt on an
   *  ordinary day, later/earlier on a partial-leave day, and both null when
   *  no work was owed. These — not the raw shift window — are what lateness
   *  and early departure are measured against. */
  effectiveCheckInAt: string | null
  effectiveCheckOutAt: string | null
  isOvernight: boolean
  /** Null exactly when shiftId is null. */
  lateGraceMinutes: number | null
  earlyLeaveGraceMinutes: number | null
}

/** The per-shift bits of master_shifts that CalendarDay doesn't carry but
 *  matching and the daily verdict both need. Keyed by shift id. */
type ShiftPolicy = {
  lateGraceMinutes: number
  earlyLeaveGraceMinutes: number
  breakStartTime: string | null
  breakEndTime: string | null
  /** Bitmask over the 7 ISO weekdays — needed to tell a partial leave taken
   *  on a real workday from one stacked on a day the employee was already
   *  off, since CalendarDayStatus collapses both to 'leave'. */
  workdays: number
}

async function loadShiftPolicy(
  shiftIds: number[],
  db: Queryable
): Promise<Map<number, ShiftPolicy>> {
  const result = new Map<number, ShiftPolicy>()
  if (shiftIds.length === 0) return result

  const { rows } = await db.query<{
    id: string
    late_grace_minutes: number
    early_leave_grace_minutes: number
    break_start_time: string | null
    break_end_time: string | null
    workdays: number
  }>(
    `SELECT id, late_grace_minutes, early_leave_grace_minutes,
            break_start_time, break_end_time, workdays
     FROM master_shifts WHERE id = ANY($1)`,
    [shiftIds]
  )
  for (const row of rows) {
    result.set(Number(row.id), {
      lateGraceMinutes: row.late_grace_minutes,
      earlyLeaveGraceMinutes: row.early_leave_grace_minutes,
      breakStartTime: row.break_start_time,
      breakEndTime: row.break_end_time,
      workdays: row.workdays,
    })
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
  const sorted = [...dates].sort()
  // Sequential, not Promise.all: `db` is a pg client inside a transaction
  // whenever the batch job calls this, and one client cannot run two queries
  // at once — pg serialises them and warns, and pg@9 will make it an error.
  // Three small lookups against indexed columns; the parallelism was not
  // buying anything worth that.
  const policyByShiftId = await loadShiftPolicy(shiftIds, db)
  const leaveByDate = await loadLeaveByDate(employeeId, sorted[0]!, sorted[sorted.length - 1]!, db)
  const overtimeByDate = await loadOvertimeByDate(employeeId, dates, db)

  return calendarDays.map((day) => {
    const overtimeIntervals = overtimeByDate.get(day.date) ?? []

    if (day.shiftId === null || day.shiftStartTime === null || day.shiftEndTime === null) {
      return {
        workDate: day.date,
        status: day.status,
        shiftId: null,
        shiftName: null,
        expectedCheckInAt: null,
        expectedCheckOutAt: null,
        expectedBreakStartAt: null,
        expectedBreakEndAt: null,
        expectedWorkIntervals: [],
        expectedWorkMinutes: 0,
        overtimeIntervals,
        leaveMinutes: 0,
        effectiveCheckInAt: null,
        effectiveCheckOutAt: null,
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
    const policy = policyByShiftId.get(day.shiftId)
    const breakWindow =
      policy?.breakStartTime && policy.breakEndTime
        ? computeBreakWindow(day.date, policy.breakStartTime, policy.breakEndTime, checkInAt)
        : null

    // Which days carry a work expectation at all. 'leave' is included because
    // a *partial* leave still owes the rest of the shift — how much survives
    // is decided below by subtracting the leave itself. weekly_off, holiday
    // and swap_dayoff owe nothing regardless of what was punched.
    const scheduled =
      day.status === 'workday' ||
      day.status === 'swap_workday' ||
      // A leave only owes anything if the underlying day was a workday to
      // begin with: CalendarDayStatus ranks leave above weekly_off, so this
      // is the only way to tell "half day off on a Tuesday" from "leave
      // recorded against a Sunday".
      (day.status === 'leave' &&
        policy !== undefined &&
        isWorkday(parseDateOnlyUtc(day.date), policy.workdays))

    const cuts: Interval[] = []
    if (breakWindow) {
      cuts.push({ start: breakWindow.breakStartAt.getTime(), end: breakWindow.breakEndAt.getTime() })
    }
    for (const leave of leaveByDate.get(day.date) ?? []) {
      if (leave.startTime === null || leave.endTime === null) {
        // Full-day leave: no clock range recorded, so it takes the whole shift.
        cuts.push({ start: checkInAt.getTime(), end: checkOutAt.getTime() })
      } else {
        const { startAt, endAt } = anchorRangeToShift(day.date, leave.startTime, leave.endTime, checkInAt)
        cuts.push({ start: startAt.getTime(), end: endAt.getTime() })
      }
    }

    const shiftWindow: Interval[] = scheduled
      ? [{ start: checkInAt.getTime(), end: checkOutAt.getTime() }]
      : []
    const breakOnly = breakWindow
      ? [{ start: breakWindow.breakStartAt.getTime(), end: breakWindow.breakEndAt.getTime() }]
      : []

    const expectedWorkIntervals = subtractIntervals(shiftWindow, cuts)
    const expectedWorkMinutes = totalMinutes(expectedWorkIntervals)
    // What the shift would have owed with no leave at all, minus what it
    // still owes — so break time never counts as leave, having never been
    // work to begin with.
    const leaveMinutes = totalMinutes(subtractIntervals(shiftWindow, breakOnly)) - expectedWorkMinutes

    const first = expectedWorkIntervals[0]
    const last = expectedWorkIntervals[expectedWorkIntervals.length - 1]

    return {
      workDate: day.date,
      status: day.status,
      shiftId: day.shiftId,
      shiftName: day.shiftName,
      expectedCheckInAt: checkInAt.toISOString(),
      expectedCheckOutAt: checkOutAt.toISOString(),
      expectedBreakStartAt: breakWindow ? breakWindow.breakStartAt.toISOString() : null,
      expectedBreakEndAt: breakWindow ? breakWindow.breakEndAt.toISOString() : null,
      expectedWorkIntervals: expectedWorkIntervals.map((i) => ({
        startAt: new Date(i.start).toISOString(),
        endAt: new Date(i.end).toISOString(),
      })),
      expectedWorkMinutes,
      overtimeIntervals,
      leaveMinutes,
      effectiveCheckInAt: first ? new Date(first.start).toISOString() : null,
      effectiveCheckOutAt: last ? new Date(last.end).toISOString() : null,
      isOvernight,
      lateGraceMinutes: policy?.lateGraceMinutes ?? 0,
      earlyLeaveGraceMinutes: policy?.earlyLeaveGraceMinutes ?? 0,
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

/**
 * The span a work-date's punches may fall in, before the buffer: the shift
 * window and every approved OT block on that date, taken together.
 *
 * OT has to be in here or its punches are simply lost. The buffer is 2 hours,
 * so on an 08:30-17:30 shift a check-out at 20:00 for approved 18:00-20:00 OT
 * falls outside the shift's own buffered window and goes unmatched — which
 * does not merely zero the OT, it reports the whole day as 'incomplete'.
 *
 * Returns null for a date with neither, which is a date that can hold no
 * punches at all: no shift assigned and no overtime approved.
 */
function matchSpanOf(window: ExpectedShiftWindow): { start: Date; end: Date } | null {
  const starts: number[] = []
  const ends: number[] = []

  if (window.expectedCheckInAt !== null && window.expectedCheckOutAt !== null) {
    starts.push(Date.parse(window.expectedCheckInAt))
    ends.push(Date.parse(window.expectedCheckOutAt))
  }
  for (const ot of window.overtimeIntervals) {
    starts.push(Date.parse(ot.startAt))
    ends.push(Date.parse(ot.endAt))
  }
  if (starts.length === 0) return null

  return { start: new Date(Math.min(...starts)), end: new Date(Math.max(...ends)) }
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

  // Ordered by when each date's punches could start, which is not always the
  // shift's own start: a date with no shift but approved OT is matchable too
  // (working a rest day the employee has no assignment for), and OT before
  // the shift moves the date's span earlier.
  const matchable = windows
    .map((window) => ({ window, span: matchSpanOf(window) }))
    .filter((entry): entry is { window: ExpectedShiftWindow; span: { start: Date; end: Date } } =>
      entry.span !== null
    )
    .sort((a, b) => a.span.start.getTime() - b.span.start.getTime())

  const matchedByWorkDate = new Map<string, MatchedAttendanceDay>()

  if (matchable.length > 0) {
    const rangeStart = withBufferMinutes(matchable[0]!.span.start, -MATCH_BUFFER_MINUTES)
    const rangeEnd = withBufferMinutes(
      new Date(Math.max(...matchable.map((m) => m.span.end.getTime()))),
      MATCH_BUFFER_MINUTES
    )
    const events = await loadEventsInRange(employeeId, rangeStart, rangeEnd, db)

    const claimed = new Set<number>()
    for (const { window, span } of matchable) {
      const windowStart = withBufferMinutes(span.start, -MATCH_BUFFER_MINUTES)
      const windowEnd = withBufferMinutes(span.end, MATCH_BUFFER_MINUTES)

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
