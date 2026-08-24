// The admin "ตารางการทำงาน" grid: every Active employee's month at once.
// Reuses buildMonthCalendar (the same per-employee cascade GET /calendar/me
// answers with) rather than re-deriving the workday/weekly_off/holiday/leave/
// swap classification, so the grid can never disagree with an employee's own
// calendar view. This costs one buildMonthCalendar call per employee instead
// of a single batched query, but the codebase has no pagination anywhere in
// its employee endpoints (small headcount), so that is not a real concern —
// see employees.ts's GET /employees, which already fetches everyone unfiltered.

import type pg from 'pg'
import type { EmployeeWorkSchedule, WorkScheduleDay } from '@hrm/shared'
import { pool } from './db.js'
import { buildMonthCalendar } from './calendarQueries.js'

type Queryable = Pick<pg.Pool, 'query'>

type ActiveEmployeeRow = {
  id: string // bigint: pg hands these back as strings to avoid precision loss
  employee_code: string
  title: string
  first_name_th: string
  last_name_th: string
}

type ShiftCodeRow = {
  id: string
  shift_code: string
}

export async function buildMonthScheduleForAllEmployees(
  year: number,
  month: number,
  db: Queryable = pool
): Promise<EmployeeWorkSchedule[]> {
  // Sequential, not Promise.all: db may be a single transaction client (the
  // pattern this codebase verifies queries with — a client, not the pool,
  // cannot run overlapping queries), and a handful of employees does not
  // make this a real cost either way.
  const { rows: employeeRows } = await db.query<ActiveEmployeeRow>(
    `SELECT e.id, e.employee_code, e.title, e.first_name_th, e.last_name_th
     FROM employees e
     JOIN employment_details d ON d.employee_id = e.id
     WHERE d.status = 'Active'
     ORDER BY e.employee_code`
  )
  // Fetched once for every employee's cells, rather than re-joined per
  // buildMonthCalendar call — CalendarDay carries shiftId/shiftName but not
  // the short shift_code a grid cell needs to show.
  const { rows: shiftRows } = await db.query<ShiftCodeRow>(`SELECT id, shift_code FROM master_shifts`)
  const shiftCodeById = new Map(shiftRows.map((row) => [Number(row.id), row.shift_code]))

  const schedules: EmployeeWorkSchedule[] = []
  for (const row of employeeRows) {
    const calendarDays = await buildMonthCalendar(Number(row.id), year, month, db)
    const days: WorkScheduleDay[] = calendarDays.map((d) => ({
      date: d.date,
      status: d.status,
      label: d.label,
      shiftCode: d.shiftId === null ? null : (shiftCodeById.get(d.shiftId) ?? null),
    }))
    schedules.push({
      employeeId: Number(row.id),
      employeeCode: row.employee_code,
      fullName: `${row.title}${row.first_name_th} ${row.last_name_th}`,
      days,
    })
  }
  return schedules
}
