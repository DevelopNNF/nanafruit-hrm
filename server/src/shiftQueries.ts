// Reading shifts out of master_shifts. A single flat table, like master_jobs —
// the row-mapper alone, no SELECT-join helper needed.

import type pg from 'pg'
import type { Shift } from '@hrm/shared'
import { pool } from './db.js'

type Queryable = Pick<pg.Pool, 'query'>

export type ShiftRow = {
  id: string // bigint: pg hands these back as strings to avoid precision loss
  shift_code: string
  shift_name: string
  shift_start_time: string
  shift_end_time: string
  break_start_time: string | null
  break_end_time: string | null
  workdays: number
  is_active: boolean
}

export const SELECT_SHIFT = `
  SELECT id, shift_code, shift_name, shift_start_time, shift_end_time,
         break_start_time, break_end_time, workdays, is_active
  FROM master_shifts
`

export function rowToShift(row: ShiftRow): Shift {
  return {
    id: Number(row.id),
    shiftCode: row.shift_code,
    shiftName: row.shift_name,
    shiftStartTime: row.shift_start_time,
    shiftEndTime: row.shift_end_time,
    breakStartTime: row.break_start_time,
    breakEndTime: row.break_end_time,
    workdays: row.workdays,
    isActive: row.is_active,
  }
}

export async function findShiftById(id: number, db: Queryable = pool): Promise<Shift | null> {
  const { rows } = await db.query<ShiftRow>(`${SELECT_SHIFT} WHERE id = $1`, [id])
  const row = rows[0]
  return row ? rowToShift(row) : null
}
