// The daily attendance verdict, and its persistence into attendance_daily.
//
// Consumes matchAttendanceForDates (attendanceMatchingQueries.ts), which has
// already resolved what was expected on each work-date and paired the raw
// punches onto it. What's left is the judgment — was work expected, did it
// happen, how late, how many minutes actually worked — plus writing the
// answer down.
//
// Same split as computeTotalDays in leaveRequestQueries.ts: computeAttendanceDay
// is pure and takes fully-resolved input, so the interesting rules can be
// reasoned about without a database in the picture; recomputeAttendanceDaily
// is the DB half around it.
//
// Everything written here is derived data — see 037_create_attendance_daily.sql.

import type pg from 'pg'
import type {
  AttendanceDailyFilter,
  AttendanceDailyItem,
  AttendanceDailySummary,
  AttendanceDayStatus,
  CalendarDayStatus,
  OvertimeRoundingMinutes,
  WorkLocation,
} from '@hrm/shared'
import { pool } from './db.js'
import { parseDateOnlyUtc, toDateOnlyString } from './leaveRequestQueries.js'
import { matchAttendanceForDates, type MatchedAttendanceDay } from './attendanceMatchingQueries.js'
import { computeOvertimeForDay } from './overtimeCalculation.js'

type Queryable = Pick<pg.Pool, 'query'>

export type AttendanceDayVerdict = {
  status: AttendanceDayStatus
  /** Minutes past the time the employee was due in, or 0 when within grace /
   *  not applicable. See computeAttendanceDay for why this is the full amount
   *  rather than the excess over grace. */
  lateMinutes: number
  earlyLeaveMinutes: number
  /** Minutes of the expected work intervals the employee was actually present
   *  for. Null unless both punches matched — one punch alone can't measure a
   *  duration. */
  workedMinutes: number | null
}

function minutesBetweenInstants(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 60_000)
}

/**
 * The verdict for one already-matched work-date.
 *
 * Work counts as expected when the day owed any working minutes at all —
 * expectedWorkMinutes > 0, which resolveExpectedShiftWindows has already
 * worked out by carving the unpaid break and any approved leave out of the
 * shift window. That single test covers every case uniformly: a day off owes
 * nothing, full-day leave owes nothing, and a half-day leave still owes the
 * half that wasn't taken.
 *
 * Lateness and early departure are measured against effectiveCheckInAt /
 * effectiveCheckOutAt — when the employee was really due in and out — not the
 * raw shift window. Someone on morning leave who arrives at 13:00 for a
 * 13:00 restart is on time, not four hours late.
 *
 * Grace decides *whether* lateness counts, not how much of it: with a
 * 15-minute grace, arriving 20 minutes late records 20, not 5. That matches
 * the usual reading of a grace period (ถ้าสายไม่เกิน X นาที ไม่ถือว่าสาย);
 * recording the excess instead would be a one-line change below.
 */
export function computeAttendanceDay(day: MatchedAttendanceDay): AttendanceDayVerdict {
  const hasCheckIn = day.actualCheckInAt !== null
  const hasCheckOut = day.actualCheckOutAt !== null
  const workExpected = day.expectedWorkMinutes > 0

  if (!workExpected) {
    return {
      status: hasCheckIn || hasCheckOut ? 'unscheduled_work' : 'day_off',
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
      workedMinutes: null,
    }
  }

  if (!hasCheckIn && !hasCheckOut) {
    return { status: 'absent', lateMinutes: 0, earlyLeaveMinutes: 0, workedMinutes: null }
  }

  // workExpected means at least one work interval survived, so the effective
  // bounds are set — see ExpectedShiftWindow, where they're null exactly when
  // nothing was owed.
  const dueIn = new Date(day.effectiveCheckInAt!)
  const dueOut = new Date(day.effectiveCheckOutAt!)
  const lateGrace = day.lateGraceMinutes ?? 0
  const earlyGrace = day.earlyLeaveGraceMinutes ?? 0

  // An approved off-site day is exempt from the shift's own start/end
  // enforcement (the confirmed "flexible check-in/out" rule) — grace is
  // simply never checked, rather than widened, so this stays a flat skip
  // instead of another branch inside the grace math below.
  let lateMinutes = 0
  if (!day.isOffSiteDay && day.actualCheckInAt !== null) {
    const actual = new Date(day.actualCheckInAt)
    const allowedUntil = new Date(dueIn.getTime() + lateGrace * 60_000)
    if (actual > allowedUntil) lateMinutes = minutesBetweenInstants(dueIn, actual)
  }

  let earlyLeaveMinutes = 0
  if (!day.isOffSiteDay && day.actualCheckOutAt !== null) {
    const actual = new Date(day.actualCheckOutAt)
    const allowedFrom = new Date(dueOut.getTime() - earlyGrace * 60_000)
    if (actual < allowedFrom) earlyLeaveMinutes = minutesBetweenInstants(actual, dueOut)
  }

  if (!hasCheckIn || !hasCheckOut) {
    return { status: 'incomplete', lateMinutes, earlyLeaveMinutes, workedMinutes: null }
  }

  // How much of what was owed the employee was actually there for: intersect
  // their presence with the expected work intervals. Intersecting rather than
  // clamping is what makes the break, a mid-shift hour of leave, and arriving
  // early all fall out of the same line — none of them are inside an expected
  // interval, so none of them count.
  const presentFrom = new Date(day.actualCheckInAt!).getTime()
  const presentTo = new Date(day.actualCheckOutAt!).getTime()
  let workedMs = 0
  for (const interval of day.expectedWorkIntervals) {
    const start = Math.max(presentFrom, new Date(interval.startAt).getTime())
    const end = Math.min(presentTo, new Date(interval.endAt).getTime())
    if (end > start) workedMs += end - start
  }

  return {
    status: 'present',
    lateMinutes,
    earlyLeaveMinutes,
    workedMinutes: Math.round(workedMs / 60_000),
  }
}

/**
 * The rounding granularity from the employee's overtime group, or 0 when they
 * have not been assigned one.
 *
 * Falling back to 0 (no rounding) rather than refusing is deliberate: an
 * employee with no group cannot have an approved OT request in the first
 * place (POST /overtime-requests requires one), so there is nothing to round,
 * and the batch job must not fail over a group that is missing from a day
 * with no overtime on it.
 */
async function getOvertimeRoundingMinutes(
  employeeId: number,
  db: Queryable
): Promise<OvertimeRoundingMinutes> {
  const { rows } = await db.query<{ rounding_minutes: number }>(
    `SELECT mog.rounding_minutes
     FROM employment_details ed
     JOIN master_overtime_groups mog ON mog.id = ed.overtime_group_id
     WHERE ed.employee_id = $1`,
    [employeeId]
  )
  return (rows[0]?.rounding_minutes ?? 0) as OvertimeRoundingMinutes
}

/** Every 'YYYY-MM-DD' from fromDate through toDate, inclusive. */
function expandDateRange(fromDate: string, toDate: string): string[] {
  const dates: string[] = []
  const end = parseDateOnlyUtc(toDate)
  for (let d = parseDateOnlyUtc(fromDate); d.getTime() <= end.getTime(); d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(toDateOnlyString(d))
  }
  return dates
}

/**
 * Recomputes and upserts one employee's attendance_daily rows across
 * [fromDate, toDate], returning how many rows were written.
 *
 * Idempotent by construction: the verdict is a pure function of data this
 * reads fresh every time, and the write is keyed on (employee_id, work_date),
 * so re-running over the same range converges rather than accumulating. That
 * is what lets the batch job simply recompute a rolling window instead of
 * tracking which days have been invalidated by a backdated approval.
 */
export async function recomputeAttendanceDaily(
  employeeId: number,
  fromDate: string,
  toDate: string,
  db: Queryable = pool
): Promise<number> {
  const dates = expandDateRange(fromDate, toDate)
  if (dates.length === 0) return 0

  const matched = await matchAttendanceForDates(employeeId, dates, db)

  // One lookup for the whole range rather than per day: an employee belongs
  // to exactly one overtime group, and only its rounding rule is needed here
  // (the rates are applied on read — see overtimeAmount).
  const roundingMinutes = await getOvertimeRoundingMinutes(employeeId, db)

  for (const day of matched) {
    const verdict = computeAttendanceDay(day)
    const overtime = computeOvertimeForDay({
      dayStatus: day.status,
      overtimeIntervals: day.overtimeIntervals,
      actualCheckInAt: day.actualCheckInAt,
      actualCheckOutAt: day.actualCheckOutAt,
      roundingMinutes,
    })
    await db.query(
      `INSERT INTO attendance_daily
         (employee_id, work_date, shift_id, day_status, attendance_status,
          expected_check_in_at, expected_check_out_at,
          effective_check_in_at, effective_check_out_at,
          actual_check_in_at, actual_check_out_at,
          actual_check_in_event_id, actual_check_out_event_id,
          late_minutes, early_leave_minutes, worked_minutes,
          expected_work_minutes, leave_minutes, is_overnight,
          approved_ot_minutes, actual_ot_minutes, ot_normal_minutes, ot_extra_minutes,
          late_grace_minutes, early_leave_grace_minutes, off_site_request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
               $20, $21, $22, $23, $24, $25, $26)
       ON CONFLICT (employee_id, work_date) DO UPDATE SET
         shift_id = EXCLUDED.shift_id,
         day_status = EXCLUDED.day_status,
         attendance_status = EXCLUDED.attendance_status,
         expected_check_in_at = EXCLUDED.expected_check_in_at,
         expected_check_out_at = EXCLUDED.expected_check_out_at,
         effective_check_in_at = EXCLUDED.effective_check_in_at,
         effective_check_out_at = EXCLUDED.effective_check_out_at,
         actual_check_in_at = EXCLUDED.actual_check_in_at,
         actual_check_out_at = EXCLUDED.actual_check_out_at,
         actual_check_in_event_id = EXCLUDED.actual_check_in_event_id,
         actual_check_out_event_id = EXCLUDED.actual_check_out_event_id,
         late_minutes = EXCLUDED.late_minutes,
         early_leave_minutes = EXCLUDED.early_leave_minutes,
         worked_minutes = EXCLUDED.worked_minutes,
         expected_work_minutes = EXCLUDED.expected_work_minutes,
         leave_minutes = EXCLUDED.leave_minutes,
         is_overnight = EXCLUDED.is_overnight,
         approved_ot_minutes = EXCLUDED.approved_ot_minutes,
         actual_ot_minutes = EXCLUDED.actual_ot_minutes,
         ot_normal_minutes = EXCLUDED.ot_normal_minutes,
         ot_extra_minutes = EXCLUDED.ot_extra_minutes,
         late_grace_minutes = EXCLUDED.late_grace_minutes,
         early_leave_grace_minutes = EXCLUDED.early_leave_grace_minutes,
         off_site_request_id = EXCLUDED.off_site_request_id,
         computed_at = now(),
         updated_at = now()`,
      [
        employeeId,
        day.workDate,
        day.shiftId,
        day.status,
        verdict.status,
        day.expectedCheckInAt,
        day.expectedCheckOutAt,
        day.effectiveCheckInAt,
        day.effectiveCheckOutAt,
        day.actualCheckInAt,
        day.actualCheckOutAt,
        day.actualCheckInEventId,
        day.actualCheckOutEventId,
        verdict.lateMinutes,
        verdict.earlyLeaveMinutes,
        verdict.workedMinutes,
        day.shiftId === null ? null : day.expectedWorkMinutes,
        day.leaveMinutes,
        day.isOvernight,
        overtime.approvedMinutes,
        overtime.actualMinutes,
        overtime.normalMinutes,
        overtime.extraMinutes,
        day.lateGraceMinutes ?? 0,
        day.earlyLeaveGraceMinutes ?? 0,
        day.offSiteRequestId,
      ]
    )
  }

  return matched.length
}

/* Reading it back -----------------------------------------------------------
 * The admin report. Read-only by design: attendance_daily is derived, so there
 * is no update path here — correcting a day means correcting what it derives
 * from (a time correction, a shift change, an approved leave) and letting the
 * job recompute.
 */

type AttendanceDailyRow = {
  id: string
  employee_id: string
  employee_code: string
  employee_name: string
  fingerprint_code: string | null
  work_date: string
  shift_id: string | null
  shift_code: string | null
  shift_name: string | null
  day_status: string
  attendance_status: string
  expected_check_in_at: string | null
  expected_check_out_at: string | null
  effective_check_in_at: string | null
  effective_check_out_at: string | null
  actual_check_in_at: string | null
  actual_check_out_at: string | null
  late_minutes: number
  early_leave_minutes: number
  worked_minutes: number | null
  expected_work_minutes: number | null
  leave_minutes: number
  is_overnight: boolean
  off_site_request_id: string | null
  computed_at: string
}

const iso = (value: string | null): string | null => (value === null ? null : new Date(value).toISOString())

function rowToAttendanceDailyItem(row: AttendanceDailyRow): AttendanceDailyItem {
  return {
    id: Number(row.id),
    employeeId: Number(row.employee_id),
    employeeCode: row.employee_code,
    employeeName: row.employee_name,
    employeeFingerprintCode: row.fingerprint_code,
    workDate: row.work_date,
    shiftId: row.shift_id === null ? null : Number(row.shift_id),
    shiftCode: row.shift_code,
    shiftName: row.shift_name,
    dayStatus: row.day_status as CalendarDayStatus,
    attendanceStatus: row.attendance_status as AttendanceDayStatus,
    expectedCheckInAt: iso(row.expected_check_in_at),
    expectedCheckOutAt: iso(row.expected_check_out_at),
    effectiveCheckInAt: iso(row.effective_check_in_at),
    effectiveCheckOutAt: iso(row.effective_check_out_at),
    actualCheckInAt: iso(row.actual_check_in_at),
    actualCheckOutAt: iso(row.actual_check_out_at),
    lateMinutes: row.late_minutes,
    earlyLeaveMinutes: row.early_leave_minutes,
    workedMinutes: row.worked_minutes,
    expectedWorkMinutes: row.expected_work_minutes,
    leaveMinutes: row.leave_minutes,
    isOvernight: row.is_overnight,
    offSiteRequestId: row.off_site_request_id === null ? null : Number(row.off_site_request_id),
    computedAt: new Date(row.computed_at).toISOString(),
  }
}

/** SQL for one filter value. 'late'/'early_leave'/'leave' are minute-count
 *  tests rather than statuses — see ATTENDANCE_DAILY_FILTERS. */
const FILTER_SQL: Record<AttendanceDailyFilter, string> = {
  present: `d.attendance_status = 'present'`,
  late: `d.late_minutes > 0`,
  early_leave: `d.early_leave_minutes > 0`,
  leave: `d.leave_minutes > 0`,
  absent: `d.attendance_status = 'absent'`,
  incomplete: `d.attendance_status = 'incomplete'`,
  day_off: `d.attendance_status = 'day_off'`,
  unscheduled_work: `d.attendance_status = 'unscheduled_work'`,
}

export type AttendanceDailyFilterInput = {
  /** Inclusive, 'YYYY-MM-DD'. */
  fromDate?: string
  toDate?: string
  employeeId?: number
  departmentId?: number
  status?: AttendanceDailyFilter
  workLocation?: WorkLocation
  /** Matched against employee_code, the Thai full name, and nickname — same
   *  fields as searchEmployees' query, minus the English name and job title
   *  this report has no columns for. */
  search?: string
}

/** The WHERE conditions shared by the on-screen list and the unlimited export
 *  query, so the two can't drift apart on what a filter means. Both callers
 *  build their own FROM clause on top — the export query joins in a couple
 *  more master tables the list has no use for. */
function buildAttendanceDailyConditions(filter: AttendanceDailyFilterInput): {
  conditions: string[]
  params: unknown[]
} {
  const conditions: string[] = []
  const params: unknown[] = []

  if (filter.fromDate !== undefined) {
    params.push(filter.fromDate)
    conditions.push(`d.work_date >= $${params.length}::date`)
  }
  if (filter.toDate !== undefined) {
    params.push(filter.toDate)
    conditions.push(`d.work_date <= $${params.length}::date`)
  }
  if (filter.employeeId !== undefined) {
    params.push(filter.employeeId)
    conditions.push(`d.employee_id = $${params.length}`)
  }
  if (filter.departmentId !== undefined) {
    params.push(filter.departmentId)
    conditions.push(`ed.department_id = $${params.length}`)
  }
  if (filter.workLocation !== undefined) {
    params.push(filter.workLocation)
    conditions.push(`ed.work_location = $${params.length}`)
  }
  if (filter.status !== undefined) {
    conditions.push(FILTER_SQL[filter.status])
  }
  const search = filter.search?.trim()
  if (search) {
    params.push(`%${search}%`)
    const n = params.length
    conditions.push(
      `(e.employee_code ILIKE $${n} OR (e.first_name_th || ' ' || e.last_name_th) ILIKE $${n} OR e.nickname ILIKE $${n})`
    )
  }
  return { conditions, params }
}

/** Default and max rows per page. The summary is computed over the whole
 *  filtered range regardless of page, so its figures never skew with paging.
 *  The export endpoint has no such cap — see listAttendanceDailyForExport. */
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200

export type AttendanceDailyPagination = {
  /** 1-based. Clamped to >= 1. */
  page?: number
  /** Clamped to [1, MAX_PAGE_SIZE]. */
  pageSize?: number
}

export async function listAttendanceDaily(
  filter: AttendanceDailyFilterInput,
  pagination: AttendanceDailyPagination = {},
  db: Queryable = pool
): Promise<{ days: AttendanceDailyItem[]; summary: AttendanceDailySummary; page: number; pageSize: number }> {
  const page = pagination.page !== undefined && pagination.page > 1 ? Math.floor(pagination.page) : 1
  const pageSize =
    pagination.pageSize !== undefined && pagination.pageSize > 0
      ? Math.min(Math.floor(pagination.pageSize), MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE
  const offset = (page - 1) * pageSize

  const { conditions, params } = buildAttendanceDailyConditions(filter)
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  // employment_details is joined unconditionally rather than only when
  // filtering by department: it's a 1:1 table on employee_id, so it costs
  // nothing, and branching the FROM clause on a filter is how the two shapes
  // drift apart later.
  const from = `
    FROM attendance_daily d
    JOIN employees e ON e.id = d.employee_id
    JOIN employment_details ed ON ed.employee_id = d.employee_id
    LEFT JOIN master_shifts ms ON ms.id = d.shift_id
    ${where}`

  const [listResult, summaryResult] = await Promise.all([
    db.query<AttendanceDailyRow>(
      `SELECT d.id, d.employee_id, e.employee_code, e.fingerprint_code,
              (e.title || e.first_name_th || ' ' || e.last_name_th) AS employee_name,
              d.work_date, d.shift_id, ms.shift_code, ms.shift_name,
              d.day_status, d.attendance_status,
              d.expected_check_in_at, d.expected_check_out_at,
              d.effective_check_in_at, d.effective_check_out_at,
              d.actual_check_in_at, d.actual_check_out_at,
              d.late_minutes, d.early_leave_minutes, d.worked_minutes,
              d.expected_work_minutes, d.leave_minutes, d.is_overnight, d.off_site_request_id, d.computed_at
       ${from}
       ORDER BY e.employee_code, d.work_date
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset]
    ),
    db.query<{
      total: string
      present: string
      late: string
      early_leave: string
      absent: string
      incomplete: string
      last_computed_at: string | null
    }>(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE d.attendance_status = 'present')     AS present,
              count(*) FILTER (WHERE d.late_minutes > 0)                  AS late,
              count(*) FILTER (WHERE d.early_leave_minutes > 0)           AS early_leave,
              count(*) FILTER (WHERE d.attendance_status = 'absent')      AS absent,
              count(*) FILTER (WHERE d.attendance_status = 'incomplete')  AS incomplete,
              max(d.computed_at) AS last_computed_at
       ${from}`,
      params
    ),
  ])

  const s = summaryResult.rows[0]

  return {
    days: listResult.rows.map(rowToAttendanceDailyItem),
    summary: {
      total: Number(s?.total ?? 0),
      present: Number(s?.present ?? 0),
      late: Number(s?.late ?? 0),
      earlyLeave: Number(s?.early_leave ?? 0),
      absent: Number(s?.absent ?? 0),
      incomplete: Number(s?.incomplete ?? 0),
      lastComputedAt: s?.last_computed_at ? new Date(s.last_computed_at).toISOString() : null,
    },
    page,
    pageSize,
  }
}

/* The Excel export ----------------------------------------------------------
 * Unlike listAttendanceDaily, this has no LIST_LIMIT — the on-screen table
 * exists to be skimmed, the export exists to be handed to HR whole, so a
 * range with more than 1000 rows must not come back truncated.
 */

export type AttendanceDailyExportRow = AttendanceDailyItem & {
  departmentName: string | null
  jobTitle: string | null
  workLocation: string | null
  /** 'YYYY-MM-DD'. From employment_details — one value per employee, repeated
   *  across every one of their rows, same as departmentName/jobTitle. */
  startWorkingDate: string | null
  /** 'YYYY-MM-DD', or null while still employed. */
  endWorkingDate: string | null
}

type AttendanceDailyExportDbRow = AttendanceDailyRow & {
  department_name: string | null
  job_title: string | null
  work_location: string | null
  start_working_date: string | null
  end_working_date: string | null
}

export async function listAttendanceDailyForExport(
  filter: AttendanceDailyFilterInput,
  db: Queryable = pool
): Promise<AttendanceDailyExportRow[]> {
  const { conditions, params } = buildAttendanceDailyConditions(filter)
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const from = `
    FROM attendance_daily d
    JOIN employees e ON e.id = d.employee_id
    JOIN employment_details ed ON ed.employee_id = d.employee_id
    LEFT JOIN master_shifts ms ON ms.id = d.shift_id
    LEFT JOIN master_departments md ON md.id = ed.department_id
    LEFT JOIN master_jobs mj ON mj.id = ed.job_id
    ${where}`

  const { rows } = await db.query<AttendanceDailyExportDbRow>(
    `SELECT d.id, d.employee_id, e.employee_code, e.fingerprint_code,
            (e.title || e.first_name_th || ' ' || e.last_name_th) AS employee_name,
            d.work_date, d.shift_id, ms.shift_code, ms.shift_name,
            d.day_status, d.attendance_status,
            d.expected_check_in_at, d.expected_check_out_at,
            d.effective_check_in_at, d.effective_check_out_at,
            d.actual_check_in_at, d.actual_check_out_at,
            d.late_minutes, d.early_leave_minutes, d.worked_minutes,
            d.expected_work_minutes, d.leave_minutes, d.is_overnight, d.off_site_request_id, d.computed_at,
            md.dept_name AS department_name, mj.job_title, ed.work_location,
            ed.start_working_date, ed.end_working_date
     ${from}
     ORDER BY e.employee_code, d.work_date`,
    params
  )

  return rows.map((row) => ({
    ...rowToAttendanceDailyItem(row),
    departmentName: row.department_name,
    jobTitle: row.job_title,
    workLocation: row.work_location,
    startWorkingDate: row.start_working_date,
    endWorkingDate: row.end_working_date,
  }))
}

/* The daily notification digest ---------------------------------------------
 * One row per employee whose day is worth flagging — absent, or present/
 * incomplete but late or left early past grace. Deliberately narrower than
 * FILTER_SQL's 'absent'/'late'/'early_leave': this feeds a notification, not
 * an admin report, so it only reads attendance_daily's own columns (no join
 * for department/job that a report would want) and skips 'incomplete' as its
 * own status — an incomplete day already surfaces here whenever it's also
 * late or early, and one still mid-shift with neither is not yet actionable.
 */

export type AttendanceIssue = {
  employeeId: number
  employeeName: string
  /** Null when the employee has no supervisor set on employment_details —
   *  notifications/attendanceDigest.ts still includes them in the HR-wide
   *  digest, just not in any supervisor's. */
  supervisorEmployeeId: number | null
  attendanceStatus: AttendanceDayStatus
  lateMinutes: number
  earlyLeaveMinutes: number
}

type AttendanceIssueRow = {
  employee_id: string
  employee_name: string
  supervisor_employee_id: string | null
  attendance_status: string
  late_minutes: number
  early_leave_minutes: number
}

/** Every attendance_daily row for one work_date worth flagging in the daily
 *  digest: absent outright, or late/left-early past grace (computeAttendanceDay
 *  already nets grace out of late_minutes/early_leave_minutes, so a plain
 *  "> 0" here is exactly "past grace", not "any lateness at all"). */
export async function listAttendanceIssuesForDate(
  workDate: string,
  db: Queryable = pool
): Promise<AttendanceIssue[]> {
  const { rows } = await db.query<AttendanceIssueRow>(
    `SELECT d.employee_id, (e.title || e.first_name_th || ' ' || e.last_name_th) AS employee_name,
            ed.supervisor_employee_id, d.attendance_status, d.late_minutes, d.early_leave_minutes
     FROM attendance_daily d
     JOIN employees e ON e.id = d.employee_id
     JOIN employment_details ed ON ed.employee_id = d.employee_id
     WHERE d.work_date = $1
       AND (d.attendance_status = 'absent' OR d.late_minutes > 0 OR d.early_leave_minutes > 0)
     ORDER BY ed.supervisor_employee_id NULLS LAST, e.employee_code`,
    [workDate]
  )
  return rows.map((row) => ({
    employeeId: Number(row.employee_id),
    employeeName: row.employee_name,
    supervisorEmployeeId: row.supervisor_employee_id === null ? null : Number(row.supervisor_employee_id),
    attendanceStatus: row.attendance_status as AttendanceDayStatus,
    lateMinutes: row.late_minutes,
    earlyLeaveMinutes: row.early_leave_minutes,
  }))
}
