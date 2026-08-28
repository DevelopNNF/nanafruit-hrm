// Reading/writing off_site_work_requests. Same row-shape split as
// leaveRequestQueries.ts: the plain request (an employee looking at their own
// history) and the list item (admin/, which spans every employee and so needs
// the employee joined in for display).

import type pg from 'pg'
import type { OffSiteWorkRequest, OffSiteWorkRequestListItem, OffSiteWorkRequestStage, OffSiteWorkRequestStatus } from '@hrm/shared'
import { pool } from './db.js'

type Queryable = Pick<pg.Pool, 'query'>

// bigint columns: pg hands these back as strings to avoid precision loss.
export type OffSiteWorkRequestRow = {
  id: string
  employee_id: string
  place_name: string
  latitude: string // numeric: pg hands these back as strings too
  longitude: string
  start_date: string // 'YYYY-MM-DD' — see the DATE type parser in db.ts
  end_date: string
  reason: string
  status: string
  supervisor_employee_id: string | null
  supervisor_employee_name: string | null
  current_stage: string | null
  supervisor_approved_by_name: string | null
  supervisor_approved_at: string | null
  decided_by_name: string | null
  decided_at: string | null
  decision_reason: string | null
  created_at: string
}

export type OffSiteWorkRequestListRow = OffSiteWorkRequestRow & {
  employee_code: string
  employee_name: string
}

export const SELECT_OFF_SITE_WORK_REQUEST = `
  SELECT r.id, r.employee_id, r.place_name, r.latitude, r.longitude,
         r.start_date, r.end_date, r.reason, r.status,
         r.supervisor_employee_id,
         (sup.title || sup.first_name_th || ' ' || sup.last_name_th) AS supervisor_employee_name,
         r.current_stage, r.supervisor_approved_by_name, r.supervisor_approved_at,
         r.decided_by_name, r.decided_at, r.decision_reason, r.created_at
  FROM off_site_work_requests r
  LEFT JOIN employees sup ON sup.id = r.supervisor_employee_id
`

export const SELECT_OFF_SITE_WORK_REQUEST_LIST = `
  SELECT r.id, r.employee_id, r.place_name, r.latitude, r.longitude,
         r.start_date, r.end_date, r.reason, r.status,
         r.supervisor_employee_id,
         (sup.title || sup.first_name_th || ' ' || sup.last_name_th) AS supervisor_employee_name,
         r.current_stage, r.supervisor_approved_by_name, r.supervisor_approved_at,
         r.decided_by_name, r.decided_at, r.decision_reason, r.created_at,
         e.employee_code, (e.title || e.first_name_th || ' ' || e.last_name_th) AS employee_name
  FROM off_site_work_requests r
  JOIN employees e ON e.id = r.employee_id
  LEFT JOIN employees sup ON sup.id = r.supervisor_employee_id
`

export function rowToOffSiteWorkRequest(row: OffSiteWorkRequestRow): OffSiteWorkRequest {
  return {
    id: Number(row.id),
    employeeId: Number(row.employee_id),
    placeName: row.place_name,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    startDate: row.start_date,
    endDate: row.end_date,
    reason: row.reason,
    status: row.status as OffSiteWorkRequestStatus,
    supervisorEmployeeId: row.supervisor_employee_id === null ? null : Number(row.supervisor_employee_id),
    supervisorEmployeeName: row.supervisor_employee_name,
    currentStage: row.current_stage === null ? null : (row.current_stage as OffSiteWorkRequestStage),
    supervisorApprovedByName: row.supervisor_approved_by_name,
    supervisorApprovedAt:
      row.supervisor_approved_at === null ? null : new Date(row.supervisor_approved_at).toISOString(),
    decidedByName: row.decided_by_name,
    decidedAt: row.decided_at === null ? null : new Date(row.decided_at).toISOString(),
    decisionReason: row.decision_reason,
    createdAt: new Date(row.created_at).toISOString(),
  }
}

export function rowToOffSiteWorkRequestListItem(row: OffSiteWorkRequestListRow): OffSiteWorkRequestListItem {
  return {
    ...rowToOffSiteWorkRequest(row),
    employeeCode: row.employee_code,
    employeeName: row.employee_name,
  }
}

export async function findOffSiteWorkRequestById(
  id: number,
  db: Queryable = pool
): Promise<OffSiteWorkRequestListItem | null> {
  const { rows } = await db.query<OffSiteWorkRequestListRow>(
    `${SELECT_OFF_SITE_WORK_REQUEST_LIST} WHERE r.id = $1`,
    [id]
  )
  const row = rows[0]
  return row ? rowToOffSiteWorkRequestListItem(row) : null
}

/** One employee's own request history, most recent first. */
export async function listOffSiteWorkRequestsForEmployee(
  employeeId: number,
  db: Queryable = pool
): Promise<OffSiteWorkRequest[]> {
  const { rows } = await db.query<OffSiteWorkRequestRow>(
    `${SELECT_OFF_SITE_WORK_REQUEST} WHERE r.employee_id = $1 ORDER BY r.created_at DESC LIMIT 100`,
    [employeeId]
  )
  return rows.map(rowToOffSiteWorkRequest)
}

/** Default and max rows per page — same numbers as listLeaveRequests'. */
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200

export type OffSiteWorkRequestsPagination = {
  /** 1-based. Clamped to >= 1. */
  page?: number
  /** Clamped to [1, MAX_PAGE_SIZE]. */
  pageSize?: number
}

/** Admin's review queue across every employee, most recent first, optionally
 *  filtered to one status. */
export async function listOffSiteWorkRequests(
  filter: { status?: OffSiteWorkRequestStatus },
  pagination: OffSiteWorkRequestsPagination = {},
  db: Queryable = pool
): Promise<{ requests: OffSiteWorkRequestListItem[]; page: number; pageSize: number; total: number }> {
  const page = pagination.page !== undefined && pagination.page > 1 ? Math.floor(pagination.page) : 1
  const pageSize =
    pagination.pageSize !== undefined && pagination.pageSize > 0
      ? Math.min(Math.floor(pagination.pageSize), MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE
  const offset = (page - 1) * pageSize

  const where = filter.status !== undefined ? 'WHERE r.status = $1' : ''
  const params = filter.status !== undefined ? [filter.status] : []

  const [listResult, countResult] = await Promise.all([
    db.query<OffSiteWorkRequestListRow>(
      `${SELECT_OFF_SITE_WORK_REQUEST_LIST} ${where} ORDER BY r.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset]
    ),
    db.query<{ total: string }>(`SELECT count(*) AS total FROM off_site_work_requests r ${where}`, params),
  ])

  return {
    requests: listResult.rows.map(rowToOffSiteWorkRequestListItem),
    page,
    pageSize,
    total: Number(countResult.rows[0]?.total ?? 0),
  }
}

/** A supervisor's inbox — same shape as listLeaveRequestsPendingApproval. */
export async function listOffSiteWorkRequestsPendingApproval(
  supervisorEmployeeId: number | null,
  db: Queryable = pool
): Promise<OffSiteWorkRequestListItem[]> {
  const where =
    supervisorEmployeeId !== null
      ? `WHERE r.current_stage = 'supervisor' AND r.supervisor_employee_id = $1`
      : `WHERE r.current_stage = 'supervisor'`
  const params = supervisorEmployeeId !== null ? [supervisorEmployeeId] : []
  const { rows } = await db.query<OffSiteWorkRequestListRow>(
    `${SELECT_OFF_SITE_WORK_REQUEST_LIST} ${where} ORDER BY r.created_at DESC LIMIT 500`,
    params
  )
  return rows.map(rowToOffSiteWorkRequestListItem)
}

export type ApprovedOffSitePoint = {
  id: number
  placeName: string
  latitude: number
  longitude: number
}

/** The approved off-site request, if any, covering this employee on this
 *  calendar date — what POST /attendance/clock checks before falling back to
 *  master_locations. hasOverlappingOffSiteWorkRequest keeps at most one
 *  approved request per employee per date, so this can only ever match one
 *  row. */
export async function findApprovedOffSiteRequestForDate(
  employeeId: number,
  date: string,
  db: Queryable = pool
): Promise<ApprovedOffSitePoint | null> {
  const { rows } = await db.query<{ id: string; place_name: string; latitude: string; longitude: string }>(
    `SELECT id, place_name, latitude, longitude
     FROM off_site_work_requests
     WHERE employee_id = $1 AND status = 'approved' AND start_date <= $2 AND end_date >= $2
     LIMIT 1`,
    [employeeId, date]
  )
  const row = rows[0]
  if (!row) return null
  return { id: Number(row.id), placeName: row.place_name, latitude: Number(row.latitude), longitude: Number(row.longitude) }
}

/** Requests this specific supervisor has already decided themselves, via
 *  LIFF — same scoping as listLeaveRequestsDecidedBySupervisor, used by the
 *  LIFF approval inbox's "ตัดสินใจแล้ว" tab. */
export async function listOffSiteWorkRequestsDecidedBySupervisor(
  supervisorEmployeeId: number,
  db: Queryable = pool
): Promise<OffSiteWorkRequestListItem[]> {
  const { rows } = await db.query<OffSiteWorkRequestListRow>(
    `${SELECT_OFF_SITE_WORK_REQUEST_LIST}
     WHERE r.supervisor_employee_id = $1 AND r.status <> 'pending'
       AND (r.supervisor_approved_by_oid = $2 OR r.decided_by_oid = $2)
     ORDER BY r.decided_at DESC NULLS LAST, r.created_at DESC
     LIMIT 200`,
    [supervisorEmployeeId, `employee:${supervisorEmployeeId}`]
  )
  return rows.map(rowToOffSiteWorkRequestListItem)
}

/** Does this employee already have a pending/approved off-site request whose
 *  date range intersects [startDate, endDate]? Same cancelled/rejected-never-
 *  blocks reasoning as hasOverlappingLeaveRequest. */
export async function hasOverlappingOffSiteWorkRequest(
  employeeId: number,
  startDate: string,
  endDate: string,
  db: Queryable = pool
): Promise<boolean> {
  const { rows } = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM off_site_work_requests
       WHERE employee_id = $1
         AND status IN ('pending', 'approved')
         AND start_date <= $3 AND end_date >= $2
     ) AS exists`,
    [employeeId, startDate, endDate]
  )
  return rows[0]?.exists ?? false
}

/** Does this employee have a pending/approved leave_requests row overlapping
 *  [startDate, endDate]? HR's confirmed rule: an off-site request may never
 *  be filed against a date already claimed by a leave request, in either
 *  direction — routes/leaveRequests.ts's own overlap check does not need the
 *  mirror image, since off-site requests carry no balance and can't compete
 *  for the same "which one actually happened" ambiguity leave vs. leave does. */
export async function hasOverlappingLeaveOnDates(
  employeeId: number,
  startDate: string,
  endDate: string,
  db: Queryable = pool
): Promise<boolean> {
  const { rows } = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM leave_requests
       WHERE employee_id = $1
         AND status IN ('pending', 'approved')
         AND start_date <= $3 AND end_date >= $2
     ) AS exists`,
    [employeeId, startDate, endDate]
  )
  return rows[0]?.exists ?? false
}
