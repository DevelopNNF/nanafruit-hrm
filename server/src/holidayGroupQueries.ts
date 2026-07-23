// Reading holiday groups out of master_holiday_groups. A single flat table
// with no join, same shape of module as jobQueries.ts.

import type pg from 'pg'
import type { HolidayGroup } from '@hrm/shared'
import { pool } from './db.js'

type Queryable = Pick<pg.Pool, 'query'>

export type HolidayGroupRow = {
  id: string // bigint: pg hands these back as strings to avoid precision loss
  group_code: string
  group_name: string
  is_active: boolean
}

export const SELECT_HOLIDAY_GROUP = `
  SELECT id, group_code, group_name, is_active
  FROM master_holiday_groups
`

export function rowToHolidayGroup(row: HolidayGroupRow): HolidayGroup {
  return {
    id: Number(row.id),
    groupCode: row.group_code,
    groupName: row.group_name,
    isActive: row.is_active,
  }
}

export async function findHolidayGroupById(
  id: number,
  db: Queryable = pool
): Promise<HolidayGroup | null> {
  const { rows } = await db.query<HolidayGroupRow>(
    `${SELECT_HOLIDAY_GROUP} WHERE id = $1`,
    [id]
  )
  const row = rows[0]
  return row ? rowToHolidayGroup(row) : null
}
