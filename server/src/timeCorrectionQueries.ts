// Reading time correction requests out of time_correction_requests. Two
// shapes share the same underlying columns, same split as attendanceQueries:
// the plain request (an employee looking at their own history) and the list
// item (admin/, which spans every employee and so needs the employee joined
// in for display) — see rowToTimeCorrection vs rowToTimeCorrectionListItem.

import type pg from 'pg'
import type {
  AttendanceEventType,
  TimeCorrectionListItem,
  TimeCorrectionRequest,
  TimeCorrectionStage,
  TimeCorrectionStatus,
} from '@hrm/shared'
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
  requires_supervisor_approval: boolean
  supervisor_employee_id: string | null
  supervisor_employee_name: string | null
  current_stage: string | null
  supervisor_approved_by_name: string | null
  supervisor_approved_at: string | null
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
  SELECT t.id, t.employee_id, t.event_type, t.requested_event_time, t.reason, t.status,
         t.requires_supervisor_approval, t.supervisor_employee_id,
         (sup.title || sup.first_name_th || ' ' || sup.last_name_th) AS supervisor_employee_name,
         t.current_stage, t.supervisor_approved_by_name, t.supervisor_approved_at,
         t.decided_by_name, t.decided_at, t.decision_reason, t.resulting_event_id, t.created_at
  FROM time_correction_requests t
  LEFT JOIN employees sup ON sup.id = t.supervisor_employee_id
`

export const SELECT_TIME_CORRECTION_LIST = `
  SELECT t.id, t.employee_id, t.event_type, t.requested_event_time, t.reason, t.status,
         t.requires_supervisor_approval, t.supervisor_employee_id,
         (sup.title || sup.first_name_th || ' ' || sup.last_name_th) AS supervisor_employee_name,
         t.current_stage, t.supervisor_approved_by_name, t.supervisor_approved_at,
         t.decided_by_name, t.decided_at, t.decision_reason, t.resulting_event_id, t.created_at,
         e.employee_code, (e.title || e.first_name_th || ' ' || e.last_name_th) AS employee_name
  FROM time_correction_requests t
  LEFT JOIN employees sup ON sup.id = t.supervisor_employee_id
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
    requiresSupervisorApproval: row.requires_supervisor_approval,
    supervisorEmployeeId: row.supervisor_employee_id === null ? null : Number(row.supervisor_employee_id),
    supervisorEmployeeName: row.supervisor_employee_name,
    currentStage: row.current_stage === null ? null : (row.current_stage as TimeCorrectionStage),
    supervisorApprovedByName: row.supervisor_approved_by_name,
    supervisorApprovedAt:
      row.supervisor_approved_at === null ? null : new Date(row.supervisor_approved_at).toISOString(),
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
    `${SELECT_TIME_CORRECTION} WHERE t.employee_id = $1 ORDER BY t.created_at DESC LIMIT 100`,
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

/** A supervisor's inbox, mirroring listLeaveRequestsPendingApproval — see its
 *  comment. */
export async function listTimeCorrectionsPendingApproval(
  supervisorEmployeeId: number | null,
  db: Queryable = pool
): Promise<TimeCorrectionListItem[]> {
  const where =
    supervisorEmployeeId !== null
      ? `WHERE t.current_stage = 'supervisor' AND t.supervisor_employee_id = $1`
      : `WHERE t.current_stage = 'supervisor'`
  const params = supervisorEmployeeId !== null ? [supervisorEmployeeId] : []
  const { rows } = await db.query<TimeCorrectionListRow>(
    `${SELECT_TIME_CORRECTION_LIST} ${where} ORDER BY t.created_at DESC LIMIT 500`,
    params
  )
  return rows.map(rowToTimeCorrectionListItem)
}
