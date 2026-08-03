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

/** Builds every CalendarDay in [year, month] for one employee.
 *
 *  Priority when more than one thing is true of a date — same reasoning
 *  order as documented on CalendarDayStatus: an approved leave is the most
 *  specific fact about the employee's day, then the company holiday
 *  calendar, then their regular weekly off, then everything else counts as
 *  a workday (including every day when they have no shift assigned, since
 *  there is then no workdays bitmask to exclude a date with). */
export async function buildMonthCalendar(
  employeeId: number,
  year: number,
  month: number,
  db: Queryable = pool
): Promise<CalendarDay[]> {
  const { startDate, endDate } = monthRange(year, month)

  const { rows: detailsRows } = await db.query<{ holiday_group_id: string | null }>(
    `SELECT holiday_group_id FROM employment_details WHERE employee_id = $1`,
    [employeeId]
  )
  const holidayGroupId = detailsRows[0]?.holiday_group_id ?? null

  // Every assignment interval touching [startDate, endDate], not just
  // "today's" shift: a past or future month can straddle a shift change, and
  // each day in it must be classified by whichever shift actually applied
  // *that* day, not by employment_details.shift_id's one current value.
  const { rows: shiftRows } = await db.query<{
    effective_from: string
    effective_to: string | null
    workdays: number | null
  }>(
    `SELECT esa.effective_from, esa.effective_to, ms.workdays
     FROM employee_shift_assignments esa
     LEFT JOIN master_shifts ms ON ms.id = esa.shift_id
     WHERE esa.employee_id = $1 AND esa.effective_from <= $3
       AND (esa.effective_to IS NULL OR esa.effective_to >= $2)
     ORDER BY esa.effective_from`,
    [employeeId, startDate, endDate]
  )
  const workdaysOn = (dateStr: string): number | null => {
    const row = shiftRows.find(
      (r) => r.effective_from <= dateStr && (r.effective_to === null || r.effective_to >= dateStr)
    )
    return row?.workdays ?? null
  }

  const holidays = new Map<string, string>()
  if (holidayGroupId !== null) {
    const { rows } = await db.query<{ holiday_date: string; holiday_name: string }>(
      `SELECT holiday_date, holiday_name FROM master_holidays
       WHERE group_id = $1 AND holiday_date BETWEEN $2 AND $3`,
      [holidayGroupId, startDate, endDate]
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
    [employeeId, startDate, endDate]
  )
  const leaveDays = new Map<string, string>()
  for (const row of leaveRows) {
    const from = parseDateOnlyUtc(row.start_date < startDate ? startDate : row.start_date)
    const to = parseDateOnlyUtc(row.end_date > endDate ? endDate : row.end_date)
    for (let d = from; d.getTime() <= to.getTime(); d.setUTCDate(d.getUTCDate() + 1)) {
      leaveDays.set(toDateOnlyString(d), row.leave_name)
    }
  }

  const days: CalendarDay[] = []
  const start = parseDateOnlyUtc(startDate)
  const end = parseDateOnlyUtc(endDate)
  for (let d = start; d.getTime() <= end.getTime(); d.setUTCDate(d.getUTCDate() + 1)) {
    const dateStr = toDateOnlyString(d)

    let status: CalendarDayStatus
    let label: string | null
    const workdays = workdaysOn(dateStr)

    if (leaveDays.has(dateStr)) {
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

    days.push({ date: dateStr, status, label })
  }

  return days
}
