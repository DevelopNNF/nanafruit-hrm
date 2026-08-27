// Reading overtime_requests, the employee-initiated "ขอทำงานล่วงเวลา"
// request/approval workflow. Same split as dayOffSwapRequestQueries.ts: the
// plain request (an employee looking at their own history) and the list item
// (admin/, which spans every employee and so needs the employee joined in for
// display). Approval writes into no other ledger, so there is no "resulting
// row" to join in here either.
//
// The shift and overtime-group columns are snapshots on the row itself, not
// live lookups — only the two *names* are joined, and only for display. See
// the migration's comment for why the values are frozen at submission time.

import type pg from 'pg'
import {
  computeOvertimeMinutes,
  overtimeCrossesMidnight,
  parseWallClockMinutes,
  type CalendarDayStatus,
  type OvertimeRequest,
  type OvertimeRequestListItem,
  type OvertimeRequestStage,
  type OvertimeRequestStatus,
} from '@hrm/shared'
import { pool } from './db.js'
import { addDays } from './shiftAssignmentQueries.js'

type Queryable = Pick<pg.Pool, 'query'>

// bigint columns: pg hands these back as strings to avoid precision loss.
export type OvertimeRequestRow = {
  id: string
  employee_id: string
  ot_date: string // 'YYYY-MM-DD' — see the DATE type parser in db.ts
  start_time: string // 'HH:MM:SS' — likewise the TIME parser
  end_time: string
  requested_minutes: number
  day_status: string
  day_label: string | null
  shift_id: string | null
  shift_name: string | null
  shift_start_time: string | null
  shift_end_time: string | null
  overtime_group_id: string
  overtime_group_name: string
  reason: string
  status: string
  batch_id: string | null
  created_by_name: string | null
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

export type OvertimeRequestListRow = OvertimeRequestRow & {
  employee_code: string
  employee_name: string
}

export const SELECT_OVERTIME_REQUEST = `
  SELECT otr.id, otr.employee_id, otr.ot_date, otr.start_time, otr.end_time,
         otr.requested_minutes, otr.day_status, otr.day_label,
         otr.shift_id, ms.shift_name, otr.shift_start_time, otr.shift_end_time,
         otr.overtime_group_id, mog.group_name AS overtime_group_name,
         otr.reason, otr.status, otr.batch_id, otr.created_by_name,
         otr.requires_supervisor_approval, otr.supervisor_employee_id,
         (sup.title || sup.first_name_th || ' ' || sup.last_name_th) AS supervisor_employee_name,
         otr.current_stage, otr.supervisor_approved_by_name, otr.supervisor_approved_at,
         otr.decided_by_name, otr.decided_at, otr.decision_reason,
         otr.created_at, otr.updated_at
  FROM overtime_requests otr
  LEFT JOIN master_shifts ms ON ms.id = otr.shift_id
  JOIN master_overtime_groups mog ON mog.id = otr.overtime_group_id
  LEFT JOIN employees sup ON sup.id = otr.supervisor_employee_id
`

export const SELECT_OVERTIME_REQUEST_LIST = `
  SELECT otr.id, otr.employee_id, otr.ot_date, otr.start_time, otr.end_time,
         otr.requested_minutes, otr.day_status, otr.day_label,
         otr.shift_id, ms.shift_name, otr.shift_start_time, otr.shift_end_time,
         otr.overtime_group_id, mog.group_name AS overtime_group_name,
         otr.reason, otr.status, otr.batch_id, otr.created_by_name,
         otr.requires_supervisor_approval, otr.supervisor_employee_id,
         (sup.title || sup.first_name_th || ' ' || sup.last_name_th) AS supervisor_employee_name,
         otr.current_stage, otr.supervisor_approved_by_name, otr.supervisor_approved_at,
         otr.decided_by_name, otr.decided_at, otr.decision_reason,
         otr.created_at, otr.updated_at,
         e.employee_code, (e.title || e.first_name_th || ' ' || e.last_name_th) AS employee_name
  FROM overtime_requests otr
  LEFT JOIN master_shifts ms ON ms.id = otr.shift_id
  JOIN master_overtime_groups mog ON mog.id = otr.overtime_group_id
  JOIN employees e ON e.id = otr.employee_id
  LEFT JOIN employees sup ON sup.id = otr.supervisor_employee_id
`

export function rowToOvertimeRequest(row: OvertimeRequestRow): OvertimeRequest {
  return {
    id: Number(row.id),
    employeeId: Number(row.employee_id),
    otDate: row.ot_date,
    startTime: row.start_time,
    endTime: row.end_time,
    requestedMinutes: row.requested_minutes,
    crossesMidnight: overtimeCrossesMidnight(row.start_time, row.end_time),
    dayStatus: row.day_status as CalendarDayStatus,
    dayLabel: row.day_label,
    shiftId: row.shift_id === null ? null : Number(row.shift_id),
    shiftName: row.shift_name,
    shiftStartTime: row.shift_start_time,
    shiftEndTime: row.shift_end_time,
    overtimeGroupId: Number(row.overtime_group_id),
    overtimeGroupName: row.overtime_group_name,
    reason: row.reason,
    status: row.status as OvertimeRequestStatus,
    batchId: row.batch_id,
    createdByName: row.created_by_name,
    requiresSupervisorApproval: row.requires_supervisor_approval,
    supervisorEmployeeId: row.supervisor_employee_id === null ? null : Number(row.supervisor_employee_id),
    supervisorEmployeeName: row.supervisor_employee_name,
    currentStage: row.current_stage === null ? null : (row.current_stage as OvertimeRequestStage),
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

export function rowToOvertimeRequestListItem(row: OvertimeRequestListRow): OvertimeRequestListItem {
  return {
    ...rowToOvertimeRequest(row),
    employeeCode: row.employee_code,
    employeeName: row.employee_name,
  }
}

export async function findOvertimeRequestById(
  id: number,
  db: Queryable = pool
): Promise<OvertimeRequestListItem | null> {
  const { rows } = await db.query<OvertimeRequestListRow>(
    `${SELECT_OVERTIME_REQUEST_LIST} WHERE otr.id = $1`,
    [id]
  )
  const row = rows[0]
  return row ? rowToOvertimeRequestListItem(row) : null
}

/** One employee's own request history, most recent first. */
export async function listOvertimeRequestsForEmployee(
  employeeId: number,
  db: Queryable = pool
): Promise<OvertimeRequest[]> {
  const { rows } = await db.query<OvertimeRequestRow>(
    `${SELECT_OVERTIME_REQUEST} WHERE otr.employee_id = $1 ORDER BY otr.created_at DESC LIMIT 100`,
    [employeeId]
  )
  return rows.map(rowToOvertimeRequest)
}

/** Default and max rows per page for listOvertimeRequests — same numbers as
 *  listAttendanceDaily's. */
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200

export type OvertimeRequestsPagination = {
  /** 1-based. Clamped to >= 1. */
  page?: number
  /** Clamped to [1, MAX_PAGE_SIZE]. */
  pageSize?: number
}

/** Admin's review queue across every employee, most recent first, optionally
 *  filtered to one status. */
export async function listOvertimeRequests(
  filter: { status?: OvertimeRequestStatus },
  pagination: OvertimeRequestsPagination = {},
  db: Queryable = pool
): Promise<{ requests: OvertimeRequestListItem[]; page: number; pageSize: number; total: number }> {
  const page = pagination.page !== undefined && pagination.page > 1 ? Math.floor(pagination.page) : 1
  const pageSize =
    pagination.pageSize !== undefined && pagination.pageSize > 0
      ? Math.min(Math.floor(pagination.pageSize), MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE
  const offset = (page - 1) * pageSize

  const where = filter.status !== undefined ? 'WHERE otr.status = $1' : ''
  const params = filter.status !== undefined ? [filter.status] : []

  const [listResult, countResult] = await Promise.all([
    db.query<OvertimeRequestListRow>(
      `${SELECT_OVERTIME_REQUEST_LIST} ${where} ORDER BY otr.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset]
    ),
    db.query<{ total: string }>(`SELECT count(*) AS total FROM overtime_requests otr ${where}`, params),
  ])

  return {
    requests: listResult.rows.map(rowToOvertimeRequestListItem),
    page,
    pageSize,
    total: Number(countResult.rows[0]?.total ?? 0),
  }
}

/** A supervisor's inbox, mirroring listLeaveRequestsPendingApproval — see its
 *  comment. supervisorEmployeeId = null gives HR/Admin's company-wide
 *  overview of every request currently waiting on any supervisor. */
export async function listOvertimeRequestsPendingApproval(
  supervisorEmployeeId: number | null,
  db: Queryable = pool
): Promise<OvertimeRequestListItem[]> {
  const where =
    supervisorEmployeeId !== null
      ? `WHERE otr.current_stage = 'supervisor' AND otr.supervisor_employee_id = $1`
      : `WHERE otr.current_stage = 'supervisor'`
  const params = supervisorEmployeeId !== null ? [supervisorEmployeeId] : []
  const { rows } = await db.query<OvertimeRequestListRow>(
    `${SELECT_OVERTIME_REQUEST_LIST} ${where} ORDER BY otr.created_at DESC LIMIT 500`,
    params
  )
  return rows.map(rowToOvertimeRequestListItem)
}

/** Requests this specific supervisor has already decided themselves, via
 *  LIFF — scoped by the synthetic `employee:<id>` oid (see describeActor in
 *  employeeQueries.ts) rather than just supervisor_employee_id, so a request
 *  HR/Admin overrode without this supervisor ever acting, or one this same
 *  person decided through admin/ under their real Entra oid, does not show
 *  up here with no attributable reason. Used by the LIFF approval inbox's
 *  "ตัดสินใจแล้ว" tab. */
export async function listOvertimeRequestsDecidedBySupervisor(
  supervisorEmployeeId: number,
  db: Queryable = pool
): Promise<OvertimeRequestListItem[]> {
  const { rows } = await db.query<OvertimeRequestListRow>(
    `${SELECT_OVERTIME_REQUEST_LIST}
     WHERE otr.supervisor_employee_id = $1 AND otr.status <> 'pending'
       AND (otr.supervisor_approved_by_oid = $2 OR otr.decided_by_oid = $2)
     ORDER BY otr.decided_at DESC NULLS LAST, otr.created_at DESC
     LIMIT 200`,
    [supervisorEmployeeId, `employee:${supervisorEmployeeId}`]
  )
  return rows.map(rowToOvertimeRequestListItem)
}

/** Every row one Bulk OT Request submission created, employee code order —
 *  the batch detail screen's member table. */
export async function listOvertimeRequestsByBatchId(
  batchId: string,
  db: Queryable = pool
): Promise<OvertimeRequestListItem[]> {
  const { rows } = await db.query<OvertimeRequestListRow>(
    `${SELECT_OVERTIME_REQUEST_LIST} WHERE otr.batch_id = $1 ORDER BY e.employee_code`,
    [batchId]
  )
  return rows.map(rowToOvertimeRequestListItem)
}

/** Whole days from `from` to `to`, both 'YYYY-MM-DD'. */
function dayOffsetBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`)
  const b = Date.parse(`${to}T00:00:00Z`)
  return Math.round((b - a) / 86_400_000)
}

/**
 * Does this employee already hold a pending/approved request whose time range
 * overlaps the one being submitted? Unlike its siblings this is not a date
 * equality test: several OT blocks a day are legitimate (before the shift and
 * after it), so only an actual overlap conflicts.
 *
 * Candidates are read over ot_date ± 1 rather than the one date, because a
 * request that crosses midnight occupies part of the following day — an
 * existing 22:00-02:00 request dated the 14th is what a new 01:00-03:00
 * request dated the 15th collides with. Every interval is then translated
 * onto one minute axis anchored at the candidate's own ot_date 00:00 so the
 * comparison is between plain numbers.
 *
 * Cancelled/rejected requests never block — they never held a real claim on
 * that time. excludeId lets an edit check against every *other* request of
 * its own, not itself.
 */
export async function hasOverlappingOvertimeRequest(
  employeeId: number,
  otDate: string,
  startTime: string,
  endTime: string,
  excludeId: number | null,
  db: Queryable = pool
): Promise<boolean> {
  const start = parseWallClockMinutes(startTime)
  const minutes = computeOvertimeMinutes(startTime, endTime)
  if (start === null || minutes === null) return false
  const end = start + minutes

  const { rows } = await db.query<{ ot_date: string; start_time: string; end_time: string }>(
    `SELECT ot_date, start_time, end_time
     FROM overtime_requests
     WHERE employee_id = $1 AND status IN ('pending', 'approved')
       AND ot_date BETWEEN $2 AND $3
       AND ($4::bigint IS NULL OR id != $4)`,
    [employeeId, addDays(otDate, -1), addDays(otDate, 1), excludeId]
  )

  return rows.some((row) => {
    const rowStart = parseWallClockMinutes(row.start_time)
    const rowLength = computeOvertimeMinutes(row.start_time, row.end_time)
    if (rowStart === null || rowLength === null) return false
    const otherStart = dayOffsetBetween(otDate, row.ot_date) * 1440 + rowStart
    return start < otherStart + rowLength && otherStart < end
  })
}
