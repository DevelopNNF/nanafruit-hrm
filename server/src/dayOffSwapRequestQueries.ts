// Reading day_off_swap_requests, the employee-initiated "สลับวันหยุด"
// request/approval workflow. Unlike shiftChangeRequestQueries.ts, approval
// never writes into a separate ledger — once a row is 'approved',
// calendarQueries.ts' buildCalendarDaysForDates reads this table directly,
// so there is no "resulting assignment" to join in here. workShiftId/
// workShiftName/etc are resolved live off employee_shift_assignments (the
// employee's standing shift on workDate, whatever it is at query time), the
// same lateral-join pattern currentShiftJoinSql uses.

import type pg from 'pg'
import type {
  DayOffSwapRequest,
  DayOffSwapRequestListItem,
  DayOffSwapRequestStatus,
} from '@hrm/shared'
import { pool } from './db.js'

type Queryable = Pick<pg.Pool, 'query'>

// bigint columns: pg hands these back as strings to avoid precision loss.
export type DayOffSwapRequestRow = {
  id: string
  employee_id: string
  work_date: string // 'YYYY-MM-DD' — see the DATE type parser in db.ts
  off_date: string
  work_date_original_status: string
  work_date_original_label: string | null
  work_shift_id: string | null
  work_shift_name: string | null
  work_shift_start_time: string | null
  work_shift_end_time: string | null
  reason: string
  status: string
  decided_by_name: string | null
  decided_at: string | null
  decision_reason: string | null
  created_at: string
  updated_at: string
}

export type DayOffSwapRequestListRow = DayOffSwapRequestRow & {
  employee_code: string
  employee_name: string
}

export const SELECT_DAY_OFF_SWAP_REQUEST = `
  SELECT dosr.id, dosr.employee_id, dosr.work_date, dosr.off_date,
         dosr.work_date_original_status, dosr.work_date_original_label,
         work_shift.shift_id AS work_shift_id, ws.shift_name AS work_shift_name,
         ws.shift_start_time AS work_shift_start_time, ws.shift_end_time AS work_shift_end_time,
         dosr.reason, dosr.status,
         dosr.decided_by_name, dosr.decided_at, dosr.decision_reason,
         dosr.created_at, dosr.updated_at
  FROM day_off_swap_requests dosr
  LEFT JOIN LATERAL (
    SELECT shift_id FROM employee_shift_assignments esa
    WHERE esa.employee_id = dosr.employee_id AND esa.effective_from <= dosr.work_date
      AND (esa.effective_to IS NULL OR esa.effective_to >= dosr.work_date)
  ) work_shift ON true
  LEFT JOIN master_shifts ws ON ws.id = work_shift.shift_id
`

export const SELECT_DAY_OFF_SWAP_REQUEST_LIST = `
  SELECT dosr.id, dosr.employee_id, dosr.work_date, dosr.off_date,
         dosr.work_date_original_status, dosr.work_date_original_label,
         work_shift.shift_id AS work_shift_id, ws.shift_name AS work_shift_name,
         ws.shift_start_time AS work_shift_start_time, ws.shift_end_time AS work_shift_end_time,
         dosr.reason, dosr.status,
         dosr.decided_by_name, dosr.decided_at, dosr.decision_reason,
         dosr.created_at, dosr.updated_at,
         e.employee_code, (e.title || e.first_name_th || ' ' || e.last_name_th) AS employee_name
  FROM day_off_swap_requests dosr
  LEFT JOIN LATERAL (
    SELECT shift_id FROM employee_shift_assignments esa
    WHERE esa.employee_id = dosr.employee_id AND esa.effective_from <= dosr.work_date
      AND (esa.effective_to IS NULL OR esa.effective_to >= dosr.work_date)
  ) work_shift ON true
  LEFT JOIN master_shifts ws ON ws.id = work_shift.shift_id
  JOIN employees e ON e.id = dosr.employee_id
`

export function rowToDayOffSwapRequest(row: DayOffSwapRequestRow): DayOffSwapRequest {
  return {
    id: Number(row.id),
    employeeId: Number(row.employee_id),
    workDate: row.work_date,
    offDate: row.off_date,
    workDateOriginalStatus: row.work_date_original_status as 'holiday' | 'weekly_off',
    workDateOriginalLabel: row.work_date_original_label,
    workShiftId: row.work_shift_id === null ? null : Number(row.work_shift_id),
    workShiftName: row.work_shift_name,
    workShiftStartTime: row.work_shift_start_time,
    workShiftEndTime: row.work_shift_end_time,
    reason: row.reason,
    status: row.status as DayOffSwapRequestStatus,
    decidedByName: row.decided_by_name,
    decidedAt: row.decided_at === null ? null : new Date(row.decided_at).toISOString(),
    decisionReason: row.decision_reason,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

export function rowToDayOffSwapRequestListItem(
  row: DayOffSwapRequestListRow
): DayOffSwapRequestListItem {
  return {
    ...rowToDayOffSwapRequest(row),
    employeeCode: row.employee_code,
    employeeName: row.employee_name,
  }
}

export async function findDayOffSwapRequestById(
  id: number,
  db: Queryable = pool
): Promise<DayOffSwapRequestListItem | null> {
  const { rows } = await db.query<DayOffSwapRequestListRow>(
    `${SELECT_DAY_OFF_SWAP_REQUEST_LIST} WHERE dosr.id = $1`,
    [id]
  )
  const row = rows[0]
  return row ? rowToDayOffSwapRequestListItem(row) : null
}

/** One employee's own request history, most recent first. */
export async function listDayOffSwapRequestsForEmployee(
  employeeId: number,
  db: Queryable = pool
): Promise<DayOffSwapRequest[]> {
  const { rows } = await db.query<DayOffSwapRequestRow>(
    `${SELECT_DAY_OFF_SWAP_REQUEST} WHERE dosr.employee_id = $1 ORDER BY dosr.created_at DESC LIMIT 100`,
    [employeeId]
  )
  return rows.map(rowToDayOffSwapRequest)
}

/** Admin's review queue across every employee, most recent first, optionally
 *  filtered to one status. */
export async function listDayOffSwapRequests(
  filter: { status?: DayOffSwapRequestStatus },
  db: Queryable = pool
): Promise<DayOffSwapRequestListItem[]> {
  const where = filter.status !== undefined ? 'WHERE dosr.status = $1' : ''
  const params = filter.status !== undefined ? [filter.status] : []
  const { rows } = await db.query<DayOffSwapRequestListRow>(
    `${SELECT_DAY_OFF_SWAP_REQUEST_LIST} ${where} ORDER BY dosr.created_at DESC LIMIT 500`,
    params
  )
  return rows.map(rowToDayOffSwapRequestListItem)
}

/** Does this employee already have another pending/approved swap request
 *  touching either date, in either role? Cancelled/rejected never block —
 *  they never held a real claim on that day. excludeId lets an edit check
 *  against every *other* request of its own, not itself. */
export async function hasConflictingDayOffSwapRequest(
  employeeId: number,
  workDate: string,
  offDate: string,
  excludeId: number | null,
  db: Queryable = pool
): Promise<boolean> {
  const { rows } = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM day_off_swap_requests
       WHERE employee_id = $1 AND status IN ('pending', 'approved')
         AND (work_date IN ($2, $3) OR off_date IN ($2, $3))
         AND ($4::bigint IS NULL OR id != $4)
     ) AS exists`,
    [employeeId, workDate, offDate, excludeId]
  )
  return rows[0]?.exists ?? false
}
