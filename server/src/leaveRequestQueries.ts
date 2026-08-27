// Reading leave requests out of leave_requests, and the day-counting math
// that turns a leave type's rules + an employee's shift/holiday group into
// LeaveRequest.totalDays. Two row shapes share the same underlying columns,
// same split as timeCorrectionQueries: the plain request (an employee
// looking at their own history) and the list item (admin/, which spans
// every employee and so needs the employee joined in for display).

import type pg from 'pg'
import type { LeaveRequest, LeaveRequestListItem, LeaveRequestStage, LeaveRequestStatus } from '@hrm/shared'
import { pool } from './db.js'
import { currentShiftJoinSql } from './shiftAssignmentQueries.js'

type Queryable = Pick<pg.Pool, 'query'>

// bigint columns: pg hands these back as strings to avoid precision loss.
export type LeaveRequestRow = {
  id: string
  employee_id: string
  leave_type_id: string
  leave_code: string
  leave_name: string
  start_date: string // 'YYYY-MM-DD' — see the DATE type parser in db.ts
  end_date: string
  start_time: string | null // 'HH:MM:SS'
  end_time: string | null
  total_days: string // numeric: pg hands these back as strings too
  reason: string | null
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
  leave_balance_entry_id: string | null
  created_at: string
}

export type LeaveRequestListRow = LeaveRequestRow & {
  employee_code: string
  employee_name: string
}

export const SELECT_LEAVE_REQUEST = `
  SELECT lr.id, lr.employee_id, lr.leave_type_id, mlt.leave_code, mlt.leave_name,
         lr.start_date, lr.end_date, lr.start_time, lr.end_time, lr.total_days,
         lr.reason, lr.status,
         lr.requires_supervisor_approval, lr.supervisor_employee_id,
         (sup.title || sup.first_name_th || ' ' || sup.last_name_th) AS supervisor_employee_name,
         lr.current_stage, lr.supervisor_approved_by_name, lr.supervisor_approved_at,
         lr.decided_by_name, lr.decided_at, lr.decision_reason,
         lr.leave_balance_entry_id, lr.created_at
  FROM leave_requests lr
  JOIN master_leave_types mlt ON mlt.id = lr.leave_type_id
  LEFT JOIN employees sup ON sup.id = lr.supervisor_employee_id
`

export const SELECT_LEAVE_REQUEST_LIST = `
  SELECT lr.id, lr.employee_id, lr.leave_type_id, mlt.leave_code, mlt.leave_name,
         lr.start_date, lr.end_date, lr.start_time, lr.end_time, lr.total_days,
         lr.reason, lr.status,
         lr.requires_supervisor_approval, lr.supervisor_employee_id,
         (sup.title || sup.first_name_th || ' ' || sup.last_name_th) AS supervisor_employee_name,
         lr.current_stage, lr.supervisor_approved_by_name, lr.supervisor_approved_at,
         lr.decided_by_name, lr.decided_at, lr.decision_reason,
         lr.leave_balance_entry_id, lr.created_at,
         e.employee_code, (e.title || e.first_name_th || ' ' || e.last_name_th) AS employee_name
  FROM leave_requests lr
  JOIN master_leave_types mlt ON mlt.id = lr.leave_type_id
  JOIN employees e ON e.id = lr.employee_id
  LEFT JOIN employees sup ON sup.id = lr.supervisor_employee_id
`

export function rowToLeaveRequest(row: LeaveRequestRow): LeaveRequest {
  return {
    id: Number(row.id),
    employeeId: Number(row.employee_id),
    leaveTypeId: Number(row.leave_type_id),
    leaveTypeCode: row.leave_code,
    leaveTypeName: row.leave_name,
    startDate: row.start_date,
    endDate: row.end_date,
    startTime: row.start_time,
    endTime: row.end_time,
    totalDays: Number(row.total_days),
    reason: row.reason,
    status: row.status as LeaveRequestStatus,
    requiresSupervisorApproval: row.requires_supervisor_approval,
    supervisorEmployeeId: row.supervisor_employee_id === null ? null : Number(row.supervisor_employee_id),
    supervisorEmployeeName: row.supervisor_employee_name,
    currentStage: row.current_stage === null ? null : (row.current_stage as LeaveRequestStage),
    supervisorApprovedByName: row.supervisor_approved_by_name,
    supervisorApprovedAt:
      row.supervisor_approved_at === null ? null : new Date(row.supervisor_approved_at).toISOString(),
    decidedByName: row.decided_by_name,
    decidedAt: row.decided_at === null ? null : new Date(row.decided_at).toISOString(),
    decisionReason: row.decision_reason,
    leaveBalanceEntryId:
      row.leave_balance_entry_id === null ? null : Number(row.leave_balance_entry_id),
    createdAt: new Date(row.created_at).toISOString(),
  }
}

export function rowToLeaveRequestListItem(row: LeaveRequestListRow): LeaveRequestListItem {
  return {
    ...rowToLeaveRequest(row),
    employeeCode: row.employee_code,
    employeeName: row.employee_name,
  }
}

export async function findLeaveRequestById(
  id: number,
  db: Queryable = pool
): Promise<LeaveRequestListItem | null> {
  const { rows } = await db.query<LeaveRequestListRow>(
    `${SELECT_LEAVE_REQUEST_LIST} WHERE lr.id = $1`,
    [id]
  )
  const row = rows[0]
  return row ? rowToLeaveRequestListItem(row) : null
}

/** One employee's own request history, most recent first. */
export async function listLeaveRequestsForEmployee(
  employeeId: number,
  db: Queryable = pool
): Promise<LeaveRequest[]> {
  const { rows } = await db.query<LeaveRequestRow>(
    `${SELECT_LEAVE_REQUEST} WHERE lr.employee_id = $1 ORDER BY lr.created_at DESC LIMIT 100`,
    [employeeId]
  )
  return rows.map(rowToLeaveRequest)
}

/** Default and max rows per page for listLeaveRequests — same numbers as
 *  listAttendanceDaily's. */
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200

export type LeaveRequestsPagination = {
  /** 1-based. Clamped to >= 1. */
  page?: number
  /** Clamped to [1, MAX_PAGE_SIZE]. */
  pageSize?: number
}

/** Admin's review queue across every employee, most recent first, optionally
 *  filtered to one status. */
export async function listLeaveRequests(
  filter: { status?: LeaveRequestStatus },
  pagination: LeaveRequestsPagination = {},
  db: Queryable = pool
): Promise<{ requests: LeaveRequestListItem[]; page: number; pageSize: number; total: number }> {
  const page = pagination.page !== undefined && pagination.page > 1 ? Math.floor(pagination.page) : 1
  const pageSize =
    pagination.pageSize !== undefined && pagination.pageSize > 0
      ? Math.min(Math.floor(pagination.pageSize), MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE
  const offset = (page - 1) * pageSize

  const where = filter.status !== undefined ? 'WHERE lr.status = $1' : ''
  const params = filter.status !== undefined ? [filter.status] : []

  const [listResult, countResult] = await Promise.all([
    db.query<LeaveRequestListRow>(
      `${SELECT_LEAVE_REQUEST_LIST} ${where} ORDER BY lr.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset]
    ),
    db.query<{ total: string }>(`SELECT count(*) AS total FROM leave_requests lr ${where}`, params),
  ])

  return {
    requests: listResult.rows.map(rowToLeaveRequestListItem),
    page,
    pageSize,
    total: Number(countResult.rows[0]?.total ?? 0),
  }
}

/** A supervisor's inbox: requests currently waiting on them specifically, or
 *  — for the HR/Admin overview, supervisorEmployeeId = null — every request
 *  currently waiting on ANY supervisor, most recent first. Only rows with
 *  current_stage = 'supervisor' ever show up here; a request that never
 *  needed one, or whose supervisor already forwarded it, is at the 'hr'
 *  stage and found through the ordinary listLeaveRequests instead. */
export async function listLeaveRequestsPendingApproval(
  supervisorEmployeeId: number | null,
  db: Queryable = pool
): Promise<LeaveRequestListItem[]> {
  const where =
    supervisorEmployeeId !== null
      ? `WHERE lr.current_stage = 'supervisor' AND lr.supervisor_employee_id = $1`
      : `WHERE lr.current_stage = 'supervisor'`
  const params = supervisorEmployeeId !== null ? [supervisorEmployeeId] : []
  const { rows } = await db.query<LeaveRequestListRow>(
    `${SELECT_LEAVE_REQUEST_LIST} ${where} ORDER BY lr.created_at DESC LIMIT 500`,
    params
  )
  return rows.map(rowToLeaveRequestListItem)
}

/** Requests this specific supervisor has already decided themselves, via
 *  LIFF — scoped by the synthetic `employee:<id>` oid (see describeActor in
 *  employeeQueries.ts) rather than just supervisor_employee_id, so a request
 *  HR/Admin overrode without this supervisor ever acting, or one this same
 *  person decided through admin/ under their real Entra oid, does not show
 *  up here with no attributable reason. Used by the LIFF approval inbox's
 *  "ตัดสินใจแล้ว" tab. */
export async function listLeaveRequestsDecidedBySupervisor(
  supervisorEmployeeId: number,
  db: Queryable = pool
): Promise<LeaveRequestListItem[]> {
  const { rows } = await db.query<LeaveRequestListRow>(
    `${SELECT_LEAVE_REQUEST_LIST}
     WHERE lr.supervisor_employee_id = $1 AND lr.status <> 'pending'
       AND (lr.supervisor_approved_by_oid = $2 OR lr.decided_by_oid = $2)
     ORDER BY lr.decided_at DESC NULLS LAST, lr.created_at DESC
     LIMIT 200`,
    [supervisorEmployeeId, `employee:${supervisorEmployeeId}`]
  )
  return rows.map(rowToLeaveRequestListItem)
}

/** Does this employee already have a pending/approved request whose date
 *  range intersects [startDate, endDate]? Cancelled/rejected requests never
 *  block — they never held a real claim on the calendar. */
export async function hasOverlappingLeaveRequest(
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

/* Day-counting ---------------------------------------------------------------
 *
 * total_days is computed here, once, at submission time (see the migration's
 * comment on why it is then frozen rather than redone at approval). The
 * shift and holiday-group lookups below happen only server-side — never
 * trust a client-supplied day count.
 */

export type ShiftDayInfo = {
  /** Bitmask over the 7 ISO weekdays, Monday = bit 0 ... Sunday = bit 6 —
   *  same encoding as master_shifts.workdays. */
  workdays: number
  shiftStartTime: string // 'HH:MM:SS'
  shiftEndTime: string
  breakStartTime: string | null
  breakEndTime: string | null
}

/** Minutes in a date's clock range, treating end <= start as crossing
 *  midnight — same interpretation master_shifts' comment gives
 *  shift_end_time < shift_start_time. */
function minutesBetween(startTime: string, endTime: string): number {
  const toMinutes = (t: string): number => {
    const parts = t.split(':').map(Number)
    return (parts[0] ?? 0) * 60 + (parts[1] ?? 0)
  }
  const start = toMinutes(startTime)
  let end = toMinutes(endTime)
  if (end <= start) end += 24 * 60
  return end - start
}

function shiftWorkingMinutes(shift: ShiftDayInfo): number {
  let total = minutesBetween(shift.shiftStartTime, shift.shiftEndTime)
  if (shift.breakStartTime !== null && shift.breakEndTime !== null) {
    total -= minutesBetween(shift.breakStartTime, shift.breakEndTime)
  }
  return total
}

/** ISO weekday of a UTC-midnight date, as a bit position: Monday = 0 ...
 *  Sunday = 6, matching master_shifts.workdays' encoding. Exported for
 *  calendarQueries.ts, which classifies a whole month the same way. */
export function isoWeekdayBit(date: Date): number {
  return (date.getUTCDay() + 6) % 7
}

export function isWorkday(date: Date, workdays: number): boolean {
  return (workdays & (1 << isoWeekdayBit(date))) !== 0
}

export function parseDateOnlyUtc(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00Z`)
}

export function toDateOnlyString(date: Date): string {
  const iso = date.toISOString()
  return iso.slice(0, 10)
}

export type ComputeTotalDaysInput = {
  startDate: string
  endDate: string
  /** Non-null only for a single-day request that specifies a clock range
   *  (an hourly leave type, or a half day taken as a custom time). */
  startTime: string | null
  endTime: string | null
  isCountHoliday: boolean
  isCountWeekend: boolean
  /** Null when the employee has no shift assigned — every day is then
   *  treated as a workday, since there is no workdays bitmask to check, and
   *  a partial-day request can't be turned into a fraction without a shift
   *  to measure it against. */
  shift: ShiftDayInfo | null
  /** 'YYYY-MM-DD' dates from the employee's holiday group, already narrowed
   *  to [startDate, endDate] by the caller. */
  holidayDates: ReadonlySet<string>
}

/** Sums countable days across [startDate, endDate], excluding holidays
 *  and/or non-workdays per the leave type's flags, and applying the
 *  startTime/endTime fraction on a single countable day when given. Rounded
 *  to 2 decimal places to match total_days' numeric(5,2) column. */
export function computeTotalDays(input: ComputeTotalDaysInput): number {
  const start = parseDateOnlyUtc(input.startDate)
  const end = parseDateOnlyUtc(input.endDate)
  const isPartialDay = input.startTime !== null && input.endTime !== null

  let total = 0
  for (let d = start; d.getTime() <= end.getTime(); d.setUTCDate(d.getUTCDate() + 1)) {
    const dateStr = toDateOnlyString(d)
    const isHoliday = input.holidayDates.has(dateStr)
    const isNonWorkday = input.shift !== null && !isWorkday(d, input.shift.workdays)

    if (isHoliday && !input.isCountHoliday) continue
    if (isNonWorkday && !input.isCountWeekend) continue

    if (isPartialDay && input.shift !== null && input.startTime !== null && input.endTime !== null) {
      const requestedMinutes = minutesBetween(input.startTime, input.endTime)
      const workingMinutes = shiftWorkingMinutes(input.shift)
      total += workingMinutes > 0 ? Math.min(1, requestedMinutes / workingMinutes) : 0
    } else {
      total += 1
    }
  }

  return Math.round(total * 100) / 100
}

/** The shift + holiday-group context computeTotalDays needs for one
 *  employee's request, narrowed to the request's own date range. */
export async function loadLeaveDayContext(
  employeeId: number,
  startDate: string,
  endDate: string,
  db: Queryable = pool
): Promise<{ shift: ShiftDayInfo | null; holidayDates: ReadonlySet<string> }> {
  // Shift comes from employee_shift_assignments (the shift in effect today),
  // not employment_details.shift_id — see that migration's comment. This
  // still runs once, at submission time, and total_days is frozen from
  // there (see this file's header comment); a later shift change does not
  // retroactively change it, same as before.
  const { rows: shiftRows } = await db.query<{
    workdays: number | null
    shift_start_time: string | null
    shift_end_time: string | null
    break_start_time: string | null
    break_end_time: string | null
    holiday_group_id: string | null
  }>(
    `SELECT ms.workdays, ms.shift_start_time, ms.shift_end_time,
            ms.break_start_time, ms.break_end_time, d.holiday_group_id
     FROM employment_details d
     ${currentShiftJoinSql('d.employee_id')}
     LEFT JOIN master_shifts ms ON ms.id = current_shift.shift_id
     WHERE d.employee_id = $1`,
    [employeeId]
  )
  const shiftRow = shiftRows[0]

  const shift: ShiftDayInfo | null =
    shiftRow?.shift_start_time && shiftRow.shift_end_time && shiftRow.workdays !== null
      ? {
          workdays: shiftRow.workdays,
          shiftStartTime: shiftRow.shift_start_time,
          shiftEndTime: shiftRow.shift_end_time,
          breakStartTime: shiftRow.break_start_time,
          breakEndTime: shiftRow.break_end_time,
        }
      : null

  const holidayGroupId = shiftRow?.holiday_group_id ?? null
  if (holidayGroupId === null) {
    return { shift, holidayDates: new Set() }
  }

  const { rows: holidayRows } = await db.query<{ holiday_date: string }>(
    `SELECT holiday_date FROM master_holidays
     WHERE group_id = $1 AND holiday_date BETWEEN $2 AND $3`,
    [holidayGroupId, startDate, endDate]
  )
  return { shift, holidayDates: new Set(holidayRows.map((r) => r.holiday_date)) }
}
