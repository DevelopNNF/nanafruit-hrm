// Reading overtime groups out of master_overtime_groups. A single flat table
// with no join, same shape of module as holidayGroupQueries.ts.

import type pg from 'pg'
import type { OvertimeGroup, OvertimeRoundingMinutes } from '@hrm/shared'
import { pool } from './db.js'

type Queryable = Pick<pg.Pool, 'query'>

export type OvertimeGroupRow = {
  id: string // bigint: pg hands these back as strings to avoid precision loss
  group_code: string
  group_name: string
  // numeric columns: pg hands these back as strings too, to avoid precision loss.
  rate_ot_workday: string
  rate_normal_dayoff: string
  rate_ot_dayoff: string
  rate_normal_holiday: string
  rate_ot_holiday: string
  rounding_minutes: number
  is_active: boolean
}

export const SELECT_OVERTIME_GROUP = `
  SELECT id, group_code, group_name,
         rate_ot_workday, rate_normal_dayoff, rate_ot_dayoff,
         rate_normal_holiday, rate_ot_holiday, rounding_minutes, is_active
  FROM master_overtime_groups
`

export function rowToOvertimeGroup(row: OvertimeGroupRow): OvertimeGroup {
  return {
    id: Number(row.id),
    groupCode: row.group_code,
    groupName: row.group_name,
    rateOtWorkday: Number(row.rate_ot_workday),
    rateNormalDayoff: Number(row.rate_normal_dayoff),
    rateOtDayoff: Number(row.rate_ot_dayoff),
    rateNormalHoliday: Number(row.rate_normal_holiday),
    rateOtHoliday: Number(row.rate_ot_holiday),
    roundingMinutes: row.rounding_minutes as OvertimeRoundingMinutes,
    isActive: row.is_active,
  }
}

export async function findOvertimeGroupById(
  id: number,
  db: Queryable = pool
): Promise<OvertimeGroup | null> {
  const { rows } = await db.query<OvertimeGroupRow>(
    `${SELECT_OVERTIME_GROUP} WHERE id = $1`,
    [id]
  )
  const row = rows[0]
  return row ? rowToOvertimeGroup(row) : null
}
