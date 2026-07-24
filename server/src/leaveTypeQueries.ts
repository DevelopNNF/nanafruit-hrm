// Reading leave types out of master_leave_types. A single flat table with no
// join, same shape of module as jobQueries.ts.

import type pg from 'pg'
import type { LeaveType } from '@hrm/shared'
import { pool } from './db.js'

type Queryable = Pick<pg.Pool, 'query'>

export type LeaveTypeRow = {
  id: string // bigint: pg hands these back as strings to avoid precision loss
  leave_code: string
  leave_name: string
  is_paid: boolean
  allow_half_day: boolean
  allow_hourly: boolean
  min_leave_days: string // numeric: pg hands these back as strings too
  max_leave_days: string | null
  advance_notice_days: number
  gender: string
  is_count_holiday: boolean
  is_count_weekend: boolean
  default_days_per_year: string | null // numeric: pg hands these back as strings too
  sort_order: number
  is_active: boolean
}

export const SELECT_LEAVE_TYPE = `
  SELECT id, leave_code, leave_name, is_paid, allow_half_day, allow_hourly,
         min_leave_days, max_leave_days, advance_notice_days, gender,
         is_count_holiday, is_count_weekend, default_days_per_year, sort_order, is_active
  FROM master_leave_types
`

export function rowToLeaveType(row: LeaveTypeRow): LeaveType {
  return {
    id: Number(row.id),
    leaveCode: row.leave_code,
    leaveName: row.leave_name,
    isPaid: row.is_paid,
    allowHalfDay: row.allow_half_day,
    allowHourly: row.allow_hourly,
    minLeaveDays: Number(row.min_leave_days),
    maxLeaveDays: row.max_leave_days === null ? null : Number(row.max_leave_days),
    advanceNoticeDays: row.advance_notice_days,
    gender: row.gender as LeaveType['gender'],
    isCountHoliday: row.is_count_holiday,
    isCountWeekend: row.is_count_weekend,
    defaultDaysPerYear:
      row.default_days_per_year === null ? null : Number(row.default_days_per_year),
    sortOrder: row.sort_order,
    isActive: row.is_active,
  }
}

export async function findLeaveTypeById(
  id: number,
  db: Queryable = pool
): Promise<LeaveType | null> {
  const { rows } = await db.query<LeaveTypeRow>(`${SELECT_LEAVE_TYPE} WHERE id = $1`, [id])
  const row = rows[0]
  return row ? rowToLeaveType(row) : null
}
