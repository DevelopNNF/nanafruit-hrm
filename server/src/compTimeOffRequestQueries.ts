// Reading comp_time_off_requests — the redemption side of the comp-time-off
// feature (spending accrued balance, see compTimeQueries.ts for the accrual
// side). Same plain-request / list-item split as leaveRequestQueries.ts.

import type pg from 'pg'
import type {
  CompTimeOffRequest,
  CompTimeOffRequestListItem,
  CompTimeOffRequestStage,
  CompTimeOffRequestStatus,
} from '@hrm/shared'
import { pool } from './db.js'

type Queryable = Pick<pg.Pool, 'query'>

// bigint columns: pg hands these back as strings to avoid precision loss.
export type CompTimeOffRequestRow = {
  id: string
  employee_id: string
  off_date: string // 'YYYY-MM-DD'
  start_time: string // 'HH:MM:SS'
  end_time: string
  requested_minutes: number
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
  created_at: string
  updated_at: string
}

export type CompTimeOffRequestListRow = CompTimeOffRequestRow & {
  employee_code: string
  employee_name: string
}

export const SELECT_COMP_TIME_OFF_REQUEST = `
  SELECT ctr.id, ctr.employee_id, ctr.off_date, ctr.start_time, ctr.end_time,
         ctr.requested_minutes, ctr.reason, ctr.status,
         ctr.requires_supervisor_approval, ctr.supervisor_employee_id,
         (sup.title || sup.first_name_th || ' ' || sup.last_name_th) AS supervisor_employee_name,
         ctr.current_stage, ctr.supervisor_approved_by_name, ctr.supervisor_approved_at,
         ctr.decided_by_name, ctr.decided_at, ctr.decision_reason,
         ctr.created_at, ctr.updated_at
  FROM comp_time_off_requests ctr
  LEFT JOIN employees sup ON sup.id = ctr.supervisor_employee_id
`

export const SELECT_COMP_TIME_OFF_REQUEST_LIST = `
  SELECT ctr.id, ctr.employee_id, ctr.off_date, ctr.start_time, ctr.end_time,
         ctr.requested_minutes, ctr.reason, ctr.status,
         ctr.requires_supervisor_approval, ctr.supervisor_employee_id,
         (sup.title || sup.first_name_th || ' ' || sup.last_name_th) AS supervisor_employee_name,
         ctr.current_stage, ctr.supervisor_approved_by_name, ctr.supervisor_approved_at,
         ctr.decided_by_name, ctr.decided_at, ctr.decision_reason,
         ctr.created_at, ctr.updated_at,
         e.employee_code, (e.title || e.first_name_th || ' ' || e.last_name_th) AS employee_name
  FROM comp_time_off_requests ctr
  JOIN employees e ON e.id = ctr.employee_id
  LEFT JOIN employees sup ON sup.id = ctr.supervisor_employee_id
`

export function rowToCompTimeOffRequest(row: CompTimeOffRequestRow): CompTimeOffRequest {
  return {
    id: Number(row.id),
    employeeId: Number(row.employee_id),
    offDate: row.off_date,
    startTime: row.start_time,
    endTime: row.end_time,
    requestedMinutes: row.requested_minutes,
    reason: row.reason,
    status: row.status as CompTimeOffRequestStatus,
    requiresSupervisorApproval: row.requires_supervisor_approval,
    supervisorEmployeeId: row.supervisor_employee_id === null ? null : Number(row.supervisor_employee_id),
    supervisorEmployeeName: row.supervisor_employee_name,
    currentStage: row.current_stage === null ? null : (row.current_stage as CompTimeOffRequestStage),
    supervisorApprovedByName: row.supervisor_approved_by_name,
    supervisorApprovedAt:
      row.supervisor_approved_at === null ? null : new Date(row.supervisor_approved_at).toISOString(),
    decidedByName: row.decided_by_name,
    decidedAt: row.decided_at === null ? null : new Date(row.decided_at).toISOString(),
    decisionReason: row.decision_reason,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

export function rowToCompTimeOffRequestListItem(row: CompTimeOffRequestListRow): CompTimeOffRequestListItem {
  return {
    ...rowToCompTimeOffRequest(row),
    employeeCode: row.employee_code,
    employeeName: row.employee_name,
  }
}

export async function findCompTimeOffRequestById(
  id: number,
  db: Queryable = pool
): Promise<CompTimeOffRequestListItem | null> {
  const { rows } = await db.query<CompTimeOffRequestListRow>(
    `${SELECT_COMP_TIME_OFF_REQUEST_LIST} WHERE ctr.id = $1`,
    [id]
  )
  const row = rows[0]
  return row ? rowToCompTimeOffRequestListItem(row) : null
}

/** One employee's own request history, most recent first. */
export async function listCompTimeOffRequestsForEmployee(
  employeeId: number,
  db: Queryable = pool
): Promise<CompTimeOffRequest[]> {
  const { rows } = await db.query<CompTimeOffRequestRow>(
    `${SELECT_COMP_TIME_OFF_REQUEST} WHERE ctr.employee_id = $1 ORDER BY ctr.created_at DESC LIMIT 100`,
    [employeeId]
  )
  return rows.map(rowToCompTimeOffRequest)
}

const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200

export type CompTimeOffRequestsPagination = {
  /** 1-based. Clamped to >= 1. */
  page?: number
  /** Clamped to [1, MAX_PAGE_SIZE]. */
  pageSize?: number
}

/** Admin's review queue across every employee, most recent first, optionally
 *  filtered to one status. */
export async function listCompTimeOffRequests(
  filter: { status?: CompTimeOffRequestStatus },
  pagination: CompTimeOffRequestsPagination = {},
  db: Queryable = pool
): Promise<{ requests: CompTimeOffRequestListItem[]; page: number; pageSize: number; total: number }> {
  const page = pagination.page !== undefined && pagination.page > 1 ? Math.floor(pagination.page) : 1
  const pageSize =
    pagination.pageSize !== undefined && pagination.pageSize > 0
      ? Math.min(Math.floor(pagination.pageSize), MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE
  const offset = (page - 1) * pageSize

  const where = filter.status !== undefined ? 'WHERE ctr.status = $1' : ''
  const params = filter.status !== undefined ? [filter.status] : []

  const [listResult, countResult] = await Promise.all([
    db.query<CompTimeOffRequestListRow>(
      `${SELECT_COMP_TIME_OFF_REQUEST_LIST} ${where} ORDER BY ctr.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset]
    ),
    db.query<{ total: string }>(`SELECT count(*) AS total FROM comp_time_off_requests ctr ${where}`, params),
  ])

  return {
    requests: listResult.rows.map(rowToCompTimeOffRequestListItem),
    page,
    pageSize,
    total: Number(countResult.rows[0]?.total ?? 0),
  }
}

/** A supervisor's inbox, same shape as listLeaveRequestsPendingApproval —
 *  supervisorEmployeeId = null gives HR/Admin's company-wide overview of
 *  every request currently waiting on any supervisor. */
export async function listCompTimeOffRequestsPendingApproval(
  supervisorEmployeeId: number | null,
  db: Queryable = pool
): Promise<CompTimeOffRequestListItem[]> {
  const where =
    supervisorEmployeeId !== null
      ? `WHERE ctr.current_stage = 'supervisor' AND ctr.supervisor_employee_id = $1`
      : `WHERE ctr.current_stage = 'supervisor'`
  const params = supervisorEmployeeId !== null ? [supervisorEmployeeId] : []
  const { rows } = await db.query<CompTimeOffRequestListRow>(
    `${SELECT_COMP_TIME_OFF_REQUEST_LIST} ${where} ORDER BY ctr.created_at DESC LIMIT 500`,
    params
  )
  return rows.map(rowToCompTimeOffRequestListItem)
}
