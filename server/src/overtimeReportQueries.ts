// The overtime report: attendance_daily's four OT columns, aggregated three
// ways over a date range and priced.
//
// Read-only, like listAttendanceDaily. attendance_daily is derived, so there
// is nothing here to correct: a wrong figure is corrected by fixing an
// approved overtime_requests row or a punch and letting the job recompute.
//
// One SQL pass fetches the day rows; the three views are folded out of them
// in TypeScript rather than in three more queries. That is not a performance
// choice — it is so that the per-day amount, which is the only figure with
// any arithmetic in it, is computed exactly once and the employee and week
// totals are provably sums of the same numbers the day tab shows.

import type pg from 'pg'
import {
  OVERTIME_WEEKLY_CAP_MINUTES,
  type CalendarDayStatus,
  type OvertimeGroup,
  type OvertimeReportDay,
  type OvertimeReportEmployee,
  type OvertimeReportResponse,
  type OvertimeReportWeek,
  type OvertimeRoundingMinutes,
  type WageType,
} from '@hrm/shared'
import { pool } from './db.js'
import { overtimeAmount, overtimeRatesFor } from './overtimeCalculation.js'
import { hourlyWage } from './wageRate.js'

type Queryable = Pick<pg.Pool, 'query'>

export type OvertimeReportFilter = {
  /** Inclusive, 'YYYY-MM-DD'. Both required — an unbounded overtime report is
   *  never what anyone means, and payroll always asks about a period. */
  fromDate: string
  toDate: string
  employeeId?: number
  departmentId?: number
}

type ReportRow = {
  employee_id: string
  employee_code: string
  employee_name: string
  department_name: string | null
  work_date: string
  day_status: string
  approved_ot_minutes: number
  actual_ot_minutes: number
  ot_normal_minutes: number
  ot_extra_minutes: number
  shift_start_time: string | null
  shift_end_time: string | null
  break_start_time: string | null
  break_end_time: string | null
  group_id: string | null
  group_code: string | null
  group_name: string | null
  rate_ot_workday: string | null
  rate_normal_dayoff: string | null
  rate_ot_dayoff: string | null
  rate_normal_holiday: string | null
  rate_ot_holiday: string | null
  rounding_minutes: number | null
  wage_type: string | null
  wage_amount: string | null
  computed_at: string
}

/**
 * The overtime group is taken from the request that was approved on that
 * date, not from the employee's current assignment — that snapshot is the
 * whole reason overtime_requests.overtime_group_id exists (see its
 * migration), so that moving someone between groups in June does not reprice
 * work they did in May. COALESCE back to the current group only covers a row
 * whose request has since been deleted by hand, which no route can do.
 */
const SELECT_REPORT_ROWS = `
  SELECT d.employee_id, e.employee_code,
         (e.title || e.first_name_th || ' ' || e.last_name_th) AS employee_name,
         dept.dept_name AS department_name,
         d.work_date, d.day_status,
         d.approved_ot_minutes, d.actual_ot_minutes,
         d.ot_normal_minutes, d.ot_extra_minutes,
         ms.shift_start_time, ms.shift_end_time, ms.break_start_time, ms.break_end_time,
         mog.id AS group_id, mog.group_code, mog.group_name,
         mog.rate_ot_workday, mog.rate_normal_dayoff, mog.rate_ot_dayoff,
         mog.rate_normal_holiday, mog.rate_ot_holiday, mog.rounding_minutes,
         ef.wage_type, ef.wage_amount,
         d.computed_at
  FROM attendance_daily d
  JOIN employees e ON e.id = d.employee_id
  JOIN employment_details ed ON ed.employee_id = d.employee_id
  LEFT JOIN master_departments dept ON dept.id = ed.department_id
  LEFT JOIN master_shifts ms ON ms.id = d.shift_id
  LEFT JOIN LATERAL (
    SELECT otr.overtime_group_id FROM overtime_requests otr
    WHERE otr.employee_id = d.employee_id AND otr.ot_date = d.work_date
      AND otr.status = 'approved'
    ORDER BY otr.start_time LIMIT 1
  ) snap ON true
  LEFT JOIN master_overtime_groups mog
    ON mog.id = COALESCE(snap.overtime_group_id, ed.overtime_group_id)
  LEFT JOIN employee_finance ef ON ef.employee_id = d.employee_id
`

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

/** The normal working day the hourly wage divides by: the shift on that date,
 *  net of its unpaid break. Null when no shift applied. Same arithmetic as
 *  shiftWorkingMinutes in leaveRequestQueries.ts and computeWorkMinutes in
 *  admin/. */
function shiftWorkMinutesOf(row: ReportRow): number | null {
  if (row.shift_start_time === null || row.shift_end_time === null) return null
  let total = minutesBetween(row.shift_start_time, row.shift_end_time)
  if (row.break_start_time !== null && row.break_end_time !== null) {
    total -= minutesBetween(row.break_start_time, row.break_end_time)
  }
  return total > 0 ? total : null
}

function groupOf(row: ReportRow): OvertimeGroup | null {
  if (row.group_id === null) return null
  return {
    id: Number(row.group_id),
    groupCode: row.group_code ?? '',
    groupName: row.group_name ?? '',
    rateOtWorkday: Number(row.rate_ot_workday),
    rateNormalDayoff: Number(row.rate_normal_dayoff),
    rateOtDayoff: Number(row.rate_ot_dayoff),
    rateNormalHoliday: Number(row.rate_normal_holiday),
    rateOtHoliday: Number(row.rate_ot_holiday),
    roundingMinutes: (row.rounding_minutes ?? 0) as OvertimeRoundingMinutes,
    isActive: true,
  }
}

/** The Monday of the week a date falls in, 'YYYY-MM-DD'. Monday-based to
 *  match master_shifts.workdays, which numbers Monday as bit 0. */
export function weekStartOf(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  const isoWeekday = (d.getUTCDay() + 6) % 7 // Mon = 0 ... Sun = 6
  d.setUTCDate(d.getUTCDate() - isoWeekday)
  return d.toISOString().slice(0, 10)
}

function addDaysUtc(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** Rounds to satang. Every amount crosses the wire already rounded so the
 *  report, its CSV and whatever adds them up later cannot disagree in the
 *  third decimal place. */
function money(value: number): number {
  return Math.round(value * 100) / 100
}

export async function buildOvertimeReport(
  filter: OvertimeReportFilter,
  db: Queryable = pool
): Promise<OvertimeReportResponse> {
  const conditions = ['d.approved_ot_minutes > 0', 'd.work_date >= $1::date', 'd.work_date <= $2::date']
  const params: unknown[] = [filter.fromDate, filter.toDate]

  if (filter.employeeId !== undefined) {
    params.push(filter.employeeId)
    conditions.push(`d.employee_id = $${params.length}`)
  }
  if (filter.departmentId !== undefined) {
    params.push(filter.departmentId)
    conditions.push(`ed.department_id = $${params.length}`)
  }

  const { rows } = await db.query<ReportRow>(
    `${SELECT_REPORT_ROWS} WHERE ${conditions.join(' AND ')}
     ORDER BY e.employee_code, d.work_date`,
    params
  )

  const byDay: OvertimeReportDay[] = []
  const employees = new Map<number, OvertimeReportEmployee>()
  const weeks = new Map<string, OvertimeReportWeek>()
  // Per employee: every distinct hourly wage seen across the range. More than
  // one means a shift change moved their normal working day mid-range, so no
  // single rate can honestly be printed on the summary row.
  const wagesSeen = new Map<number, Set<number>>()
  const missingWage = new Set<number>()

  let totalMinutes = 0
  let pricedTotal = 0
  let anyPriced = false
  let daysUnderApproved = 0
  let lastComputedAt: string | null = null

  for (const row of rows) {
    const employeeId = Number(row.employee_id)
    const status = row.day_status as CalendarDayStatus
    const group = groupOf(row)
    const normalMinutes = row.ot_normal_minutes
    const extraMinutes = row.ot_extra_minutes
    const dayMinutes = normalMinutes + extraMinutes

    const wage =
      row.wage_type === null || row.wage_amount === null
        ? null
        : hourlyWage({
            wageType: row.wage_type as WageType,
            wageAmount: Number(row.wage_amount),
            shiftWorkMinutes: shiftWorkMinutesOf(row),
          })

    const rates = group ? overtimeRatesFor(status, group) : { normalRate: 0, extraRate: 0 }
    const amount =
      group === null
        ? null
        : overtimeAmount({ normalMinutes, extraMinutes, status, group, hourlyWage: wage })

    byDay.push({
      employeeId,
      employeeCode: row.employee_code,
      employeeName: row.employee_name,
      workDate: row.work_date,
      dayStatus: status,
      approvedMinutes: row.approved_ot_minutes,
      actualMinutes: row.actual_ot_minutes,
      normalMinutes,
      extraMinutes,
      normalRate: rates.normalRate,
      extraRate: rates.extraRate,
      amount: amount === null ? null : money(amount),
    })

    if (row.actual_ot_minutes < row.approved_ot_minutes) daysUnderApproved += 1
    if (wage === null) missingWage.add(employeeId)
    else {
      const seen = wagesSeen.get(employeeId) ?? new Set<number>()
      seen.add(wage)
      wagesSeen.set(employeeId, seen)
    }

    totalMinutes += dayMinutes
    if (amount !== null) {
      pricedTotal += amount
      anyPriced = true
    }
    if (lastComputedAt === null || row.computed_at > lastComputedAt) lastComputedAt = row.computed_at

    // --- per employee ---
    const summary =
      employees.get(employeeId) ??
      ({
        employeeId,
        employeeCode: row.employee_code,
        employeeName: row.employee_name,
        departmentName: row.department_name,
        overtimeGroupName: group?.groupName ?? null,
        otWorkdayMinutes: 0,
        normalDayoffMinutes: 0,
        otDayoffMinutes: 0,
        normalHolidayMinutes: 0,
        otHolidayMinutes: 0,
        totalMinutes: 0,
        shortfallMinutes: 0,
        hourlyWage: null,
        amount: null,
      } satisfies OvertimeReportEmployee)

    if (status === 'workday' || status === 'swap_workday') {
      summary.otWorkdayMinutes += extraMinutes
    } else if (status === 'holiday') {
      summary.normalHolidayMinutes += normalMinutes
      summary.otHolidayMinutes += extraMinutes
    } else {
      summary.normalDayoffMinutes += normalMinutes
      summary.otDayoffMinutes += extraMinutes
    }
    summary.totalMinutes += dayMinutes
    summary.shortfallMinutes += Math.max(row.approved_ot_minutes - row.actual_ot_minutes, 0)
    if (amount !== null) summary.amount = money((summary.amount ?? 0) + amount)
    employees.set(employeeId, summary)

    // --- per week ---
    const weekStart = weekStartOf(row.work_date)
    const key = `${employeeId}:${weekStart}`
    const week =
      weeks.get(key) ??
      ({
        employeeId,
        employeeCode: row.employee_code,
        employeeName: row.employee_name,
        weekStart,
        weekEnd: addDaysUtc(weekStart, 6),
        totalMinutes: 0,
        overCap: false,
      } satisfies OvertimeReportWeek)
    week.totalMinutes += dayMinutes
    week.overCap = week.totalMinutes > OVERTIME_WEEKLY_CAP_MINUTES
    weeks.set(key, week)
  }

  for (const [employeeId, wages] of wagesSeen) {
    const summary = employees.get(employeeId)
    if (summary && wages.size === 1) summary.hourlyWage = money([...wages][0]!)
  }

  const byWeek = [...weeks.values()].sort(
    (a, b) => a.employeeCode.localeCompare(b.employeeCode) || a.weekStart.localeCompare(b.weekStart)
  )

  return {
    byEmployee: [...employees.values()],
    byDay,
    byWeek,
    summary: {
      employees: employees.size,
      totalMinutes,
      totalAmount: anyPriced ? money(pricedTotal) : null,
      employeesMissingWage: missingWage.size,
      daysUnderApproved,
      weeksOverCap: byWeek.filter((w) => w.overCap).length,
      lastComputedAt: lastComputedAt === null ? null : new Date(lastComputedAt).toISOString(),
    },
  }
}

/**
 * Approved overtime minutes in the Monday-to-Sunday week containing `date`,
 * for the weekly-cap warning shown before a decision is made.
 *
 * Counts what has been *approved*, not what was worked, and that is the whole
 * point: the report looks backwards at hours that happened, but an approver
 * is deciding about hours that have not happened yet, and the cap has to be
 * checked against the commitment rather than the outcome. excludeId leaves
 * the request under review out of its own "already approved" figure.
 */
export async function approvedOvertimeMinutesInWeek(
  employeeId: number,
  date: string,
  excludeId: number | null,
  db: Queryable = pool
): Promise<{ weekStart: string; weekEnd: string; minutes: number }> {
  const weekStart = weekStartOf(date)
  const weekEnd = addDaysUtc(weekStart, 6)

  const { rows } = await db.query<{ minutes: string | null }>(
    `SELECT sum(requested_minutes) AS minutes
     FROM overtime_requests
     WHERE employee_id = $1 AND status = 'approved'
       AND ot_date BETWEEN $2::date AND $3::date
       AND ($4::bigint IS NULL OR id != $4)`,
    [employeeId, weekStart, weekEnd, excludeId]
  )
  return { weekStart, weekEnd, minutes: Number(rows[0]?.minutes ?? 0) }
}
