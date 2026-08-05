// Building one employee's monthly calendar: a CalendarDay per date in
// [year, month], classified by the same shift-workdays/holiday-group inputs
// leaveRequestQueries.ts uses for day-counting, plus approved leave_requests
// overlaid on top. Read-only — nothing here writes.

import type pg from 'pg'
import type { CalendarDay, CalendarDayStatus } from '@hrm/shared'
import { pool } from './db.js'
import { isWorkday, parseDateOnlyUtc, toDateOnlyString } from './leaveRequestQueries.js'

type Queryable = Pick<pg.Pool, 'query'>

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** First and last calendar date of a year/month (month is 1-12), as
 *  'YYYY-MM-DD' strings. */
function monthRange(year: number, month: number): { startDate: string; endDate: string } {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return {
    startDate: `${year}-${pad2(month)}-01`,
    endDate: `${year}-${pad2(month)}-${pad2(lastDay)}`,
  }
}

/** Builds a CalendarDay for exactly the given dates (any order, any spread —
 *  not necessarily contiguous or the same month), for one employee. This is
 *  the shared classification core behind buildMonthCalendar (which just
 *  expands a month into its list of dates) and day-off-swap-request
 *  validation (which classifies exactly the two dates being submitted,
 *  possibly in different months) — both need the exact same cascade so a
 *  date always classifies the same way regardless of which caller asks.
 *
 *  Priority when more than one thing is true of a date — same reasoning
 *  order as documented on CalendarDayStatus: an approved day-off-swap wins
 *  over everything (it's an explicit, individually-approved override), then
 *  an approved leave, then the company holiday calendar, then their regular
 *  weekly off, then everything else counts as a workday (including every
 *  day when they have no shift assigned, since there is then no workdays
 *  bitmask to exclude a date with). */
export async function buildCalendarDaysForDates(
  employeeId: number,
  dates: string[],
  db: Queryable = pool
): Promise<CalendarDay[]> {
  if (dates.length === 0) return []
  const sorted = [...dates].sort()
  const minDate = sorted[0]!
  const maxDate = sorted[sorted.length - 1]!

  const { rows: detailsRows } = await db.query<{ holiday_group_id: string | null }>(
    `SELECT holiday_group_id FROM employment_details WHERE employee_id = $1`,
    [employeeId]
  )
  const holidayGroupId = detailsRows[0]?.holiday_group_id ?? null

  // Every assignment interval touching [minDate, maxDate], not just
  // "today's" shift: a past or future date can straddle a shift change, and
  // each day must be classified by whichever shift actually applied *that*
  // day, not by employment_details.shift_id's one current value. This is
  // also where an approved shift_change_requests swap shows up — approval
  // writes it into this same ledger (see createShiftChange), so a day it
  // covers resolves here exactly like any other assignment, with no separate
  // join against shift_change_requests needed.
  const { rows: shiftRows } = await db.query<{
    effective_from: string
    effective_to: string | null
    shift_id: string | null
    shift_name: string | null
    shift_start_time: string | null
    shift_end_time: string | null
    workdays: number | null
  }>(
    `SELECT esa.effective_from, esa.effective_to, esa.shift_id,
            ms.shift_name, ms.shift_start_time, ms.shift_end_time, ms.workdays
     FROM employee_shift_assignments esa
     LEFT JOIN master_shifts ms ON ms.id = esa.shift_id
     WHERE esa.employee_id = $1 AND esa.effective_from <= $3
       AND (esa.effective_to IS NULL OR esa.effective_to >= $2)
     ORDER BY esa.effective_from`,
    [employeeId, minDate, maxDate]
  )
  const shiftOn = (dateStr: string) =>
    shiftRows.find(
      (r) => r.effective_from <= dateStr && (r.effective_to === null || r.effective_to >= dateStr)
    ) ?? null

  const holidays = new Map<string, string>()
  if (holidayGroupId !== null) {
    const { rows } = await db.query<{ holiday_date: string; holiday_name: string }>(
      `SELECT holiday_date, holiday_name FROM master_holidays
       WHERE group_id = $1 AND holiday_date BETWEEN $2 AND $3`,
      [holidayGroupId, minDate, maxDate]
    )
    for (const row of rows) holidays.set(row.holiday_date, row.holiday_name)
  }

  const { rows: leaveRows } = await db.query<{
    start_date: string
    end_date: string
    leave_name: string
  }>(
    `SELECT lr.start_date, lr.end_date, mlt.leave_name
     FROM leave_requests lr
     JOIN master_leave_types mlt ON mlt.id = lr.leave_type_id
     WHERE lr.employee_id = $1 AND lr.status = 'approved'
       AND lr.start_date <= $3 AND lr.end_date >= $2`,
    [employeeId, minDate, maxDate]
  )
  const leaveDays = new Map<string, string>()
  for (const row of leaveRows) {
    const from = parseDateOnlyUtc(row.start_date < minDate ? minDate : row.start_date)
    const to = parseDateOnlyUtc(row.end_date > maxDate ? maxDate : row.end_date)
    for (let d = from; d.getTime() <= to.getTime(); d.setUTCDate(d.getUTCDate() + 1)) {
      leaveDays.set(toDateOnlyString(d), row.leave_name)
    }
  }

  // Approved day-off swaps touching this window. work_date becomes a
  // workday (overriding holiday/weekly_off), off_date becomes a day off
  // (overriding workday) — see day_off_swap_requests' migration comment for
  // why this needs no employee_shift_assignments write to take effect.
  const { rows: swapRows } = await db.query<{
    work_date: string
    off_date: string
    work_date_original_label: string | null
  }>(
    `SELECT work_date, off_date, work_date_original_label
     FROM day_off_swap_requests
     WHERE employee_id = $1 AND status = 'approved'
       AND (work_date BETWEEN $2 AND $3 OR off_date BETWEEN $2 AND $3)`,
    [employeeId, minDate, maxDate]
  )
  const swapWorkDates = new Map<string, string | null>()
  const swapOffDates = new Set<string>()
  for (const row of swapRows) {
    swapWorkDates.set(row.work_date, row.work_date_original_label)
    swapOffDates.add(row.off_date)
  }

  const days: CalendarDay[] = []
  for (const dateStr of dates) {
    const d = parseDateOnlyUtc(dateStr)

    let status: CalendarDayStatus
    let label: string | null
    const shiftRow = shiftOn(dateStr)
    const workdays = shiftRow?.workdays ?? null

    if (swapWorkDates.has(dateStr)) {
      status = 'swap_workday'
      label = swapWorkDates.get(dateStr) ?? null
    } else if (swapOffDates.has(dateStr)) {
      status = 'swap_dayoff'
      label = null
    } else if (leaveDays.has(dateStr)) {
      status = 'leave'
      label = leaveDays.get(dateStr) ?? null
    } else if (holidays.has(dateStr)) {
      status = 'holiday'
      label = holidays.get(dateStr) ?? null
    } else if (workdays !== null && !isWorkday(d, workdays)) {
      status = 'weekly_off'
      label = null
    } else {
      status = 'workday'
      label = null
    }

    days.push({
      date: dateStr,
      status,
      label,
      shiftId: shiftRow?.shift_id == null ? null : Number(shiftRow.shift_id),
      shiftName: shiftRow?.shift_name ?? null,
      shiftStartTime: shiftRow?.shift_start_time ?? null,
      shiftEndTime: shiftRow?.shift_end_time ?? null,
    })
  }

  return days
}

/** Builds every CalendarDay in [year, month] for one employee — see
 *  buildCalendarDaysForDates for the classification cascade itself. */
export async function buildMonthCalendar(
  employeeId: number,
  year: number,
  month: number,
  db: Queryable = pool
): Promise<CalendarDay[]> {
  const { startDate, endDate } = monthRange(year, month)
  const dates: string[] = []
  const start = parseDateOnlyUtc(startDate)
  const end = parseDateOnlyUtc(endDate)
  for (let d = start; d.getTime() <= end.getTime(); d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(toDateOnlyString(d))
  }
  return buildCalendarDaysForDates(employeeId, dates, db)
}
