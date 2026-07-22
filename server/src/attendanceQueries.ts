// Reading clock events out of attendance_events. Two shapes share the same
// underlying columns: the plain event (for an employee looking at their own
// history) and the list item (for admin/, which spans every employee and so
// needs the employee joined in for display) — see rowToAttendanceEvent vs
// rowToAttendanceListItem.

import type pg from 'pg'
import type { AttendanceEvent, AttendanceEventType, AttendanceListItem, AttendanceSource } from '@hrm/shared'
import { pool } from './db.js'

type Queryable = Pick<pg.Pool, 'query'>

// numeric columns: pg hands these back as strings to avoid precision loss on
// values too big for a JS number. Six decimal places of lat/lng is nowhere
// near that boundary, so Number() below is safe.
export type AttendanceRow = {
  id: string // bigint: pg hands these back as strings to avoid precision loss
  employee_id: string
  event_type: string
  event_time: string
  source: string
  latitude: string | null
  longitude: string | null
  accuracy_meters: string | null
  shift_id: string | null
  shift_name: string | null
  device_info: string | null
}

export type AttendanceListRow = AttendanceRow & {
  employee_code: string
  employee_name: string
}

export const SELECT_ATTENDANCE_EVENT = `
  SELECT a.id, a.employee_id, a.event_type, a.event_time, a.source,
         a.latitude, a.longitude, a.accuracy_meters,
         a.shift_id, ms.shift_name, a.device_info
  FROM attendance_events a
  LEFT JOIN master_shifts ms ON ms.id = a.shift_id
`

export const SELECT_ATTENDANCE_LIST = `
  SELECT a.id, a.employee_id, a.event_type, a.event_time, a.source,
         a.latitude, a.longitude, a.accuracy_meters,
         a.shift_id, ms.shift_name, a.device_info,
         e.employee_code, (e.title || e.first_name_th || ' ' || e.last_name_th) AS employee_name
  FROM attendance_events a
  LEFT JOIN master_shifts ms ON ms.id = a.shift_id
  JOIN employees e ON e.id = a.employee_id
`

export function rowToAttendanceEvent(row: AttendanceRow): AttendanceEvent {
  return {
    id: Number(row.id),
    employeeId: Number(row.employee_id),
    eventType: row.event_type as AttendanceEventType,
    eventTime: new Date(row.event_time).toISOString(),
    source: row.source as AttendanceSource,
    latitude: row.latitude === null ? null : Number(row.latitude),
    longitude: row.longitude === null ? null : Number(row.longitude),
    accuracyMeters: row.accuracy_meters === null ? null : Number(row.accuracy_meters),
    shiftId: row.shift_id === null ? null : Number(row.shift_id),
    shiftName: row.shift_name,
    deviceInfo: row.device_info,
  }
}

export function rowToAttendanceListItem(row: AttendanceListRow): AttendanceListItem {
  return {
    ...rowToAttendanceEvent(row),
    employeeCode: row.employee_code,
    employeeName: row.employee_name,
  }
}

/**
 * The most recent event for one employee, regardless of type — used both to
 * answer "what's my status" and to enforce clock order (no check_in on top of
 * an open check_in) before inserting a new one.
 */
export async function findLastAttendanceEvent(
  employeeId: number,
  db: Queryable = pool
): Promise<AttendanceEvent | null> {
  const { rows } = await db.query<AttendanceRow>(
    `${SELECT_ATTENDANCE_EVENT} WHERE a.employee_id = $1 ORDER BY a.event_time DESC LIMIT 1`,
    [employeeId]
  )
  const row = rows[0]
  return row ? rowToAttendanceEvent(row) : null
}

export type AttendanceListFilter = {
  employeeId?: number
  /** Inclusive, 'YYYY-MM-DD'. */
  fromDate?: string
  /** Inclusive, 'YYYY-MM-DD'. */
  toDate?: string
}

/** Admin listing across employees, most recent first, filtered in SQL rather
 *  than fetched-then-filtered so a wide date range doesn't ship every row to
 *  the browser just to throw most of them away. */
export async function listAttendanceEvents(
  filter: AttendanceListFilter,
  db: Queryable = pool
): Promise<AttendanceListItem[]> {
  const conditions: string[] = []
  const params: unknown[] = []

  if (filter.employeeId !== undefined) {
    params.push(filter.employeeId)
    conditions.push(`a.employee_id = $${params.length}`)
  }
  if (filter.fromDate !== undefined) {
    params.push(filter.fromDate)
    conditions.push(`a.event_time >= $${params.length}::date`)
  }
  if (filter.toDate !== undefined) {
    // Exclusive upper bound on the next day, so a 'YYYY-MM-DD' toDate reads as
    // "through the end of that calendar day" rather than midnight at its start.
    params.push(filter.toDate)
    conditions.push(`a.event_time < ($${params.length}::date + interval '1 day')`)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const { rows } = await db.query<AttendanceListRow>(
    `${SELECT_ATTENDANCE_LIST} ${where} ORDER BY a.event_time DESC LIMIT 500`,
    params
  )
  return rows.map(rowToAttendanceListItem)
}
