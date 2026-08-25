// Reading shift_change_requests, the employee-initiated request/approval
// workflow that precedes a write into employee_shift_assignments. Same split
// as leaveRequestQueries.ts: the plain request (an employee looking at their
// own history) and the list item (admin/, which spans every employee and so
// needs the employee joined in for display).

import type pg from 'pg'
import type {
  ShiftChangeRequest,
  ShiftChangeRequestListItem,
  ShiftChangeRequestStage,
  ShiftChangeRequestStatus,
} from '@hrm/shared'
import { pool } from './db.js'

type Queryable = Pick<pg.Pool, 'query'>

// bigint columns: pg hands these back as strings to avoid precision loss.
export type ShiftChangeRequestRow = {
  id: string
  employee_id: string
  requested_date: string // 'YYYY-MM-DD' — see the DATE type parser in db.ts
  current_shift_id: string | null
  current_shift_name: string | null
  new_shift_id: string
  new_shift_name: string
  reason: string
  attachment_key: string | null
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
  resulting_assignment_id: string | null
  created_at: string
  updated_at: string
}

export type ShiftChangeRequestListRow = ShiftChangeRequestRow & {
  employee_code: string
  employee_name: string
}

export const SELECT_SHIFT_CHANGE_REQUEST = `
  SELECT scr.id, scr.employee_id, scr.requested_date,
         scr.current_shift_id, cs.shift_name AS current_shift_name,
         scr.new_shift_id, ns.shift_name AS new_shift_name,
         scr.reason, scr.attachment_key, scr.status,
         scr.requires_supervisor_approval, scr.supervisor_employee_id,
         (sup.title || sup.first_name_th || ' ' || sup.last_name_th) AS supervisor_employee_name,
         scr.current_stage, scr.supervisor_approved_by_name, scr.supervisor_approved_at,
         scr.decided_by_name, scr.decided_at, scr.decision_reason,
         scr.resulting_assignment_id, scr.created_at, scr.updated_at
  FROM shift_change_requests scr
  LEFT JOIN master_shifts cs ON cs.id = scr.current_shift_id
  JOIN master_shifts ns ON ns.id = scr.new_shift_id
  LEFT JOIN employees sup ON sup.id = scr.supervisor_employee_id
`

export const SELECT_SHIFT_CHANGE_REQUEST_LIST = `
  SELECT scr.id, scr.employee_id, scr.requested_date,
         scr.current_shift_id, cs.shift_name AS current_shift_name,
         scr.new_shift_id, ns.shift_name AS new_shift_name,
         scr.reason, scr.attachment_key, scr.status,
         scr.requires_supervisor_approval, scr.supervisor_employee_id,
         (sup.title || sup.first_name_th || ' ' || sup.last_name_th) AS supervisor_employee_name,
         scr.current_stage, scr.supervisor_approved_by_name, scr.supervisor_approved_at,
         scr.decided_by_name, scr.decided_at, scr.decision_reason,
         scr.resulting_assignment_id, scr.created_at, scr.updated_at,
         e.employee_code, (e.title || e.first_name_th || ' ' || e.last_name_th) AS employee_name
  FROM shift_change_requests scr
  LEFT JOIN master_shifts cs ON cs.id = scr.current_shift_id
  JOIN master_shifts ns ON ns.id = scr.new_shift_id
  LEFT JOIN employees sup ON sup.id = scr.supervisor_employee_id
  JOIN employees e ON e.id = scr.employee_id
`

export function rowToShiftChangeRequest(row: ShiftChangeRequestRow): ShiftChangeRequest {
  return {
    id: Number(row.id),
    employeeId: Number(row.employee_id),
    requestedDate: row.requested_date,
    currentShiftId: row.current_shift_id === null ? null : Number(row.current_shift_id),
    currentShiftName: row.current_shift_name,
    newShiftId: Number(row.new_shift_id),
    newShiftName: row.new_shift_name,
    reason: row.reason,
    attachmentKey: row.attachment_key,
    status: row.status as ShiftChangeRequestStatus,
    requiresSupervisorApproval: row.requires_supervisor_approval,
    supervisorEmployeeId: row.supervisor_employee_id === null ? null : Number(row.supervisor_employee_id),
    supervisorEmployeeName: row.supervisor_employee_name,
    currentStage: row.current_stage === null ? null : (row.current_stage as ShiftChangeRequestStage),
    supervisorApprovedByName: row.supervisor_approved_by_name,
    supervisorApprovedAt:
      row.supervisor_approved_at === null ? null : new Date(row.supervisor_approved_at).toISOString(),
    decidedByName: row.decided_by_name,
    decidedAt: row.decided_at === null ? null : new Date(row.decided_at).toISOString(),
    decisionReason: row.decision_reason,
    resultingAssignmentId:
      row.resulting_assignment_id === null ? null : Number(row.resulting_assignment_id),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

export function rowToShiftChangeRequestListItem(
  row: ShiftChangeRequestListRow
): ShiftChangeRequestListItem {
  return {
    ...rowToShiftChangeRequest(row),
    employeeCode: row.employee_code,
    employeeName: row.employee_name,
  }
}

export async function findShiftChangeRequestById(
  id: number,
  db: Queryable = pool
): Promise<ShiftChangeRequestListItem | null> {
  const { rows } = await db.query<ShiftChangeRequestListRow>(
    `${SELECT_SHIFT_CHANGE_REQUEST_LIST} WHERE scr.id = $1`,
    [id]
  )
  const row = rows[0]
  return row ? rowToShiftChangeRequestListItem(row) : null
}

/** One employee's own request history, most recent first. */
export async function listShiftChangeRequestsForEmployee(
  employeeId: number,
  db: Queryable = pool
): Promise<ShiftChangeRequest[]> {
  const { rows } = await db.query<ShiftChangeRequestRow>(
    `${SELECT_SHIFT_CHANGE_REQUEST} WHERE scr.employee_id = $1 ORDER BY scr.created_at DESC LIMIT 100`,
    [employeeId]
  )
  return rows.map(rowToShiftChangeRequest)
}

/** Admin's review queue across every employee, most recent first, optionally
 *  filtered to one status. */
export async function listShiftChangeRequests(
  filter: { status?: ShiftChangeRequestStatus },
  db: Queryable = pool
): Promise<ShiftChangeRequestListItem[]> {
  const where = filter.status !== undefined ? 'WHERE scr.status = $1' : ''
  const params = filter.status !== undefined ? [filter.status] : []
  const { rows } = await db.query<ShiftChangeRequestListRow>(
    `${SELECT_SHIFT_CHANGE_REQUEST_LIST} ${where} ORDER BY scr.created_at DESC LIMIT 500`,
    params
  )
  return rows.map(rowToShiftChangeRequestListItem)
}

/** A supervisor's inbox, mirroring listLeaveRequestsPendingApproval — see its
 *  comment. */
export async function listShiftChangeRequestsPendingApproval(
  supervisorEmployeeId: number | null,
  db: Queryable = pool
): Promise<ShiftChangeRequestListItem[]> {
  const where =
    supervisorEmployeeId !== null
      ? `WHERE scr.current_stage = 'supervisor' AND scr.supervisor_employee_id = $1`
      : `WHERE scr.current_stage = 'supervisor'`
  const params = supervisorEmployeeId !== null ? [supervisorEmployeeId] : []
  const { rows } = await db.query<ShiftChangeRequestListRow>(
    `${SELECT_SHIFT_CHANGE_REQUEST_LIST} ${where} ORDER BY scr.created_at DESC LIMIT 500`,
    params
  )
  return rows.map(rowToShiftChangeRequestListItem)
}

/** Does this employee already have another pending/approved request for the
 *  same date? Cancelled/rejected requests never block — they never held a
 *  real claim on that day. excludeId lets an edit check against every *other*
 *  request of its own, not itself. */
export async function hasConflictingShiftChangeRequest(
  employeeId: number,
  requestedDate: string,
  excludeId: number | null,
  db: Queryable = pool
): Promise<boolean> {
  const { rows } = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM shift_change_requests
       WHERE employee_id = $1 AND requested_date = $2 AND status IN ('pending', 'approved')
         AND ($3::bigint IS NULL OR id != $3)
     ) AS exists`,
    [employeeId, requestedDate, excludeId]
  )
  return rows[0]?.exists ?? false
}
