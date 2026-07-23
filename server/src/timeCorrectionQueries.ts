// Reading time correction requests out of time_correction_requests. Two
// shapes share the same underlying columns, same split as attendanceQueries:
// the plain request (an employee looking at their own history) and the list
// item (admin/, which spans every employee and so needs the employee joined
// in for display) — see rowToTimeCorrection vs rowToTimeCorrectionListItem.

import type pg from 'pg'
import type { AttendanceEventType, TimeCorrectionListItem, TimeCorrectionRequest, TimeCorrectionStatus } from '@hrm/shared'
import { pool } from './db.js'

type Queryable = Pick<pg.Pool, 'query'>

// bigint columns: pg hands these back as strings to avoid precision loss.
export type TimeCorrectionRow = {
  id: string
  employee_id: string
  event_type: string
  requested_event_time: string
  reason: string
  status: string
  decided_by_name: string | null
  decided_at: string | null
  decision_reason: string | null
  resulting_event_id: string | null
  created_at: string
}

export type TimeCorrectionListRow = TimeCorrectionRow & {
  employee_code: string
  employee_name: string
}

export const SELECT_TIME_CORRECTION = `
  SELECT id, employee_id, event_type, requested_event_time, reason, status,
         decided_by_name, decided_at, decision_reason, resulting_event_id, created_at
  FROM time_correction_requests
`

export const SELECT_TIME_CORRECTION_LIST = `
  SELECT t.id, t.employee_id, t.event_type, t.requested_event_time, t.reason, t.status,
         t.decided_by_name, t.decided_at, t.decision_reason, t.resulting_event_id, t.created_at,
         e.employee_code, (e.title || e.first_name_th || ' ' || e.last_name_th) AS employee_name
  FROM time_correction_requests t
  JOIN employees e ON e.id = t.employee_id
`

export function rowToTimeCorrection(row: TimeCorrectionRow): TimeCorrectionRequest {
  return {
    id: Number(row.id),
    employeeId: Number(row.employee_id),
    eventType: row.event_type as AttendanceEventType,
    requestedEventTime: new Date(row.requested_event_time).toISOString(),
    reason: row.reason,
    status: row.status as TimeCorrectionStatus,
    decidedByName: row.decided_by_name,
    decidedAt: row.decided_at === null ? null : new Date(row.decided_at).toISOString(),
    decisionReason: row.decision_reason,
    resultingEventId: row.resulting_event_id === null ? null : Number(row.resulting_event_id),
    createdAt: new Date(row.created_at).toISOString(),
  }
}

export function rowToTimeCorrectionListItem(row: TimeCorrectionListRow): TimeCorrectionListItem {
  return {
    ...rowToTimeCorrection(row),
    employeeCode: row.employee_code,
    employeeName: row.employee_name,
  }
}

export async function findTimeCorrectionById(
  id: number,
  db: Queryable = pool
): Promise<TimeCorrectionListItem | null> {
  const { rows } = await db.query<TimeCorrectionListRow>(
    `${SELECT_TIME_CORRECTION_LIST} WHERE t.id = $1`,
    [id]
  )
  const row = rows[0]
  return row ? rowToTimeCorrectionListItem(row) : null
}

/** One employee's own request history, most recent first. */
export async function listTimeCorrectionsForEmployee(
  employeeId: number,
  db: Queryable = pool
): Promise<TimeCorrectionRequest[]> {
  const { rows } = await db.query<TimeCorrectionRow>(
    `${SELECT_TIME_CORRECTION} WHERE employee_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [employeeId]
  )
  return rows.map(rowToTimeCorrection)
}

/** Admin's review queue across every employee, most recent first, optionally
 *  filtered to one status. */
export async function listTimeCorrections(
  filter: { status?: TimeCorrectionStatus },
  db: Queryable = pool
): Promise<TimeCorrectionListItem[]> {
  const where = filter.status !== undefined ? 'WHERE t.status = $1' : ''
  const params = filter.status !== undefined ? [filter.status] : []
  const { rows } = await db.query<TimeCorrectionListRow>(
    `${SELECT_TIME_CORRECTION_LIST} ${where} ORDER BY t.created_at DESC LIMIT 500`,
    params
  )
  return rows.map(rowToTimeCorrectionListItem)
}
