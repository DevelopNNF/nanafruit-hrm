// Phase 1 of turning attendance_events into a daily verdict: resolving what
// shift-hours were *expected* on an employee's work-date, as real instants —
// nothing here reads attendance_events itself.
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
