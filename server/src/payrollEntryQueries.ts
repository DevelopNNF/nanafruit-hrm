// Reading payroll_entries/payroll_entry_lines, and calculatePayrollEntries —
// the "calculate" step that turns one payroll_periods row into a set of
// them. Phase 2 only prices basic wage; see payrollEarnings.ts for the pure
// arithmetic and 055/056's migrations for the shape being written.
//
// The write side lives here rather than in routes/payrollPeriods.ts because
// it is one large unit of work spanning several tables in one transaction,
// the same reasoning payrollPeriodQueries.ts gives for keeping its own writes
// in the route instead — the difference is that a status transition is a
// single decision a route can hold in its head, while this is a batch
// computation that deserves its own file and its own tests-by-reading.

import type pg from 'pg'
import type {
  AuthUser,
  FinanceItemType,
  PayrollEntry,
  PayrollEntryLine,
  PayrollEntryLineCode,
  PayrollEntryReviewReason,
  PayrollEntryReviewReasonCode,
  PayrollEntryWithLines,
} from '@hrm/shared'
import { pool } from './db.js'
import { recordAudit } from './audit.js'
import { hourlyWage } from './wageRate.js'
import { getWageForDate, wageJoinSqlForDate } from './wageAssignmentQueries.js'
import { parseDateOnlyUtc, toDateOnlyString } from './leaveRequestQueries.js'
import {
  employedDayCount,
  isFullPeriodEmployment,
  lateOrEarlyDeductionAmount,
  monthlyAbsenceDeduction,
  monthlyGrossWage,
  round2,
} from './payrollEarnings.js'

type Queryable = Pick<pg.Pool, 'query'>
type Client = pg.PoolClient

/* Reading ------------------------------------------------------------------- */

export type PayrollEntryRow = {
  id: string
  payroll_period_id: string
  employee_id: string
  employee_code: string
  employee_name: string
  wage_type: string
  employed_days: string | null
  is_full_period: boolean | null
  work_days: string | null
  paid_leave_days: string | null
  absent_days: string
  late_minutes_total: number
  late_minutes_deducted: number
  early_leave_minutes_total: number
  early_leave_minutes_deducted: number
  gross_earnings: string
  total_deductions: string
  net_pay: string
  needs_review: boolean
  review_reasons: PayrollEntryReviewReason[]
  calculated_at: string
}

export const SELECT_PAYROLL_ENTRY = `
  SELECT id, payroll_period_id, employee_id, employee_code, employee_name, wage_type,
         employed_days, is_full_period, work_days, paid_leave_days, absent_days,
         late_minutes_total, late_minutes_deducted,
         early_leave_minutes_total, early_leave_minutes_deducted,
         gross_earnings, total_deductions, net_pay, needs_review, review_reasons, calculated_at
  FROM payroll_entries
`

function rowToPayrollEntry(row: PayrollEntryRow): PayrollEntry {
  return {
    id: Number(row.id),
    payrollPeriodId: Number(row.payroll_period_id),
    employeeId: Number(row.employee_id),
    employeeCode: row.employee_code,
    employeeName: row.employee_name,
    wageType: row.wage_type as PayrollEntry['wageType'],
    employedDays: row.employed_days === null ? null : Number(row.employed_days),
    isFullPeriod: row.is_full_period,
    workDays: row.work_days === null ? null : Number(row.work_days),
    paidLeaveDays: row.paid_leave_days === null ? null : Number(row.paid_leave_days),
    absentDays: Number(row.absent_days),
    lateMinutesTotal: row.late_minutes_total,
    lateMinutesDeducted: row.late_minutes_deducted,
    earlyLeaveMinutesTotal: row.early_leave_minutes_total,
    earlyLeaveMinutesDeducted: row.early_leave_minutes_deducted,
    grossEarnings: Number(row.gross_earnings),
    totalDeductions: Number(row.total_deductions),
    netPay: Number(row.net_pay),
    needsReview: row.needs_review,
    reviewReasons: row.review_reasons,
    calculatedAt: new Date(row.calculated_at).toISOString(),
  }
}

export type PayrollEntryLineRow = {
  id: string
  item_code: string
  item_name: string
  item_type: string
  quantity: string | null
  rate: string | null
  amount: string
  sort_order: number
}

function rowToPayrollEntryLine(row: PayrollEntryLineRow): PayrollEntryLine {
  return {
    id: Number(row.id),
    itemCode: row.item_code,
    itemName: row.item_name,
    itemType: row.item_type as FinanceItemType,
    quantity: row.quantity === null ? null : Number(row.quantity),
    rate: row.rate === null ? null : Number(row.rate),
    amount: Number(row.amount),
    sortOrder: row.sort_order,
  }
}

/** Every entry for one period, employee code order — the period-detail
 *  screen's table. */
export async function listPayrollEntriesForPeriod(
  periodId: number,
  db: Queryable = pool
): Promise<PayrollEntry[]> {
  const { rows } = await db.query<PayrollEntryRow>(
    `${SELECT_PAYROLL_ENTRY} WHERE payroll_period_id = $1 ORDER BY employee_code`,
    [periodId]
  )
  return rows.map(rowToPayrollEntry)
}

/** One entry with its lines — the payslip screen. */
export async function findPayrollEntryById(
  id: number,
  db: Queryable = pool
): Promise<PayrollEntryWithLines | null> {
  const { rows } = await db.query<PayrollEntryRow>(`${SELECT_PAYROLL_ENTRY} WHERE id = $1`, [id])
  const row = rows[0]
  if (!row) return null

  const { rows: lineRows } = await db.query<PayrollEntryLineRow>(
    `SELECT id, item_code, item_name, item_type, quantity, rate, amount, sort_order
     FROM payroll_entry_lines WHERE payroll_entry_id = $1 ORDER BY sort_order, id`,
    [id]
  )

  return { ...rowToPayrollEntry(row), lines: lineRows.map(rowToPayrollEntryLine) }
}

/* Calculating ----------------------------------------------------------------
 *
 * Phase 2 line item names, in Thai — the vocabulary shown on the slip.
 * PAYROLL_ENTRY_LINE_CODES (shared/src/index.ts) is the set of codes; this is
 * only their display text, kept here rather than in admin/ because a batch
 * job writes them, not a form.
 */
const LINE_NAME: Record<PayrollEntryLineCode, string> = {
  BASIC_WAGE: 'ค่าจ้างพื้นฐาน',
  ABSENCE_DEDUCT: 'หักขาดงาน',
  LATE_DEDUCT: 'หักมาสาย',
  EARLY_LEAVE_DEDUCT: 'หักออกก่อนเวลา',
}
const LINE_TYPE: Record<PayrollEntryLineCode, FinanceItemType> = {
  BASIC_WAGE: 'income',
  ABSENCE_DEDUCT: 'deduction',
  LATE_DEDUCT: 'deduction',
  EARLY_LEAVE_DEDUCT: 'deduction',
}
const LINE_SORT_ORDER: Record<PayrollEntryLineCode, number> = {
  BASIC_WAGE: 10,
  ABSENCE_DEDUCT: 20,
  LATE_DEDUCT: 30,
  EARLY_LEAVE_DEDUCT: 40,
}

type DraftLine = { code: PayrollEntryLineCode; quantity: number | null; rate: number | null; amount: number }

function line(code: PayrollEntryLineCode, quantity: number | null, rate: number | null, amount: number): DraftLine {
  return { code, quantity, rate: rate === null ? null : round2(rate), amount: round2(amount) }
}

/** Same arithmetic as shiftWorkMinutesOf in overtimeReportQueries.ts and
 *  shiftWorkingMinutes in leaveRequestQueries.ts — the normal working day net
 *  of its unpaid break, which hourlyWage() divides a daily wage by. Repeated
 *  here rather than imported because none of those three modules export it;
 *  this is the fourth copy of a four-line calculation the codebase has
 *  already decided is cheaper to repeat than to thread through an import. */
function shiftWorkMinutes(
  startTime: string | null,
  endTime: string | null,
  breakStart: string | null,
  breakEnd: string | null
): number | null {
  if (startTime === null || endTime === null) return null
  const toMinutes = (t: string): number => {
    const parts = t.split(':').map(Number)
    return (parts[0] ?? 0) * 60 + (parts[1] ?? 0)
  }
  const start = toMinutes(startTime)
  let end = toMinutes(endTime)
  if (end <= start) end += 24 * 60
  let total = end - start
  if (breakStart !== null && breakEnd !== null) {
    const bStart = toMinutes(breakStart)
    let bEnd = toMinutes(breakEnd)
    if (bEnd <= bStart) bEnd += 24 * 60
    total -= bEnd - bStart
  }
  return total > 0 ? total : null
}

/**
 * Approved leave overlapping [periodStart, periodEnd] for one employee,
 * split into paid/unpaid calendar days (clipped to the period) — not
 * leave_requests.total_days, which describes the whole request and may run
 * outside the period's own window.
 *
 * priceDaily true also resolves each paid day's wage (getWageForDate) and
 * sums it, for a daily employee's paid-leave pay — HR's confirmed default of
 * paying it at the normal daily rate (see the phase plan's open question #1).
 * Monthly employees don't need that sum: a paid leave day is already covered
 * by the monthly wage, so paidAmount is only meaningful for a daily entry.
 */
async function leaveDaysInPeriod(
  employeeId: number,
  periodStart: string,
  periodEnd: string,
  priceDaily: boolean,
  db: Queryable,
  // Dates already paid by some other route — a daily employee's own attendance
  // rows, most commonly. A leave request can overlap a date the employee was
  // separately marked 'present' on (a half-day leave taken alongside actual
  // work, or fixture data that is not perfectly self-consistent), and without
  // this a daily employee would be paid twice for that one day: once as a
  // worked day, once as a paid leave day.
  excludeDates: ReadonlySet<string> = new Set()
): Promise<{ paidDays: number; unpaidDays: number; paidAmount: number }> {
  const { rows } = await db.query<{ start_date: string; end_date: string; is_paid: boolean }>(
    `SELECT lr.start_date, lr.end_date, mlt.is_paid
     FROM leave_requests lr
     JOIN master_leave_types mlt ON mlt.id = lr.leave_type_id
     WHERE lr.employee_id = $1 AND lr.status = 'approved'
       AND lr.start_date <= $3 AND lr.end_date >= $2`,
    [employeeId, periodStart, periodEnd]
  )

  let paidDays = 0
  let unpaidDays = 0
  let paidAmount = 0

  for (const row of rows) {
    const from = row.start_date < periodStart ? periodStart : row.start_date
    const to = row.end_date > periodEnd ? periodEnd : row.end_date
    for (let d = parseDateOnlyUtc(from); toDateOnlyString(d) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
      const dateStr = toDateOnlyString(d)
      if (excludeDates.has(dateStr)) continue

      if (row.is_paid) {
        paidDays += 1
        if (priceDaily) {
          const wage = await getWageForDate(employeeId, dateStr, db)
          if (wage !== null) paidAmount += wage.wageAmount
        }
      } else {
        unpaidDays += 1
      }
    }
  }

  return { paidDays, unpaidDays, paidAmount: round2(paidAmount) }
}

/** Accumulates review reasons as {code -> dates it was seen on}, so the same
 *  code triggered on three separate days becomes one PayrollEntryReviewReason
 *  with three workDates rather than three separate entries. */
class ReviewReasons {
  private byCode = new Map<PayrollEntryReviewReasonCode, Set<string>>()

  flag(code: PayrollEntryReviewReasonCode, workDate?: string): void {
    const dates = this.byCode.get(code) ?? new Set<string>()
    if (workDate !== undefined) dates.add(workDate)
    this.byCode.set(code, dates)
  }

  get isEmpty(): boolean {
    return this.byCode.size === 0
  }

  toArray(): PayrollEntryReviewReason[] {
    return [...this.byCode.entries()].map(([code, dates]) => ({
      code,
      workDates: [...dates].sort(),
    }))
  }
}

type DailyAttendanceRow = {
  work_date: string
  attendance_status: string
  late_minutes: number
  late_grace_minutes: number
  early_leave_minutes: number
  early_leave_grace_minutes: number
  shift_start_time: string | null
  shift_end_time: string | null
  break_start_time: string | null
  break_end_time: string | null
  wage_amount: string | null
}

/** One daily-wage employee's entry for the period: which days paid, priced on
 *  that day's own wage (a raise mid-period prices only the days after it),
 *  plus the late/early deduction each present day earned past its own
 *  snapshotted grace. */
async function buildDailyEntry(
  employeeId: number,
  periodStart: string,
  periodEnd: string,
  db: Queryable
): Promise<{
  workDays: number
  grossWage: number
  lateMinutesTotal: number
  lateMinutesDeducted: number
  lateDeductAmount: number
  earlyLeaveMinutesTotal: number
  earlyLeaveMinutesDeducted: number
  earlyLeaveDeductAmount: number
  absentDays: number
  reviewReasons: PayrollEntryReviewReason[]
}> {
  const { rows } = await db.query<DailyAttendanceRow>(
    `SELECT d.work_date, d.attendance_status,
            d.late_minutes, d.late_grace_minutes,
            d.early_leave_minutes, d.early_leave_grace_minutes,
            ms.shift_start_time, ms.shift_end_time, ms.break_start_time, ms.break_end_time,
            wage_on_date.wage_amount
     FROM attendance_daily d
     LEFT JOIN master_shifts ms ON ms.id = d.shift_id
     ${wageJoinSqlForDate('d.employee_id', 'd.work_date')}
     WHERE d.employee_id = $1 AND d.work_date BETWEEN $2 AND $3
     ORDER BY d.work_date`,
    [employeeId, periodStart, periodEnd]
  )

  let workDays = 0
  let grossWage = 0
  let absentDays = 0
  let lateMinutesTotal = 0
  let lateMinutesDeducted = 0
  let lateDeductAmount = 0
  let earlyLeaveMinutesTotal = 0
  let earlyLeaveMinutesDeducted = 0
  let earlyLeaveDeductAmount = 0
  const reviewReasons = new ReviewReasons()
  // Every date already counted as a worked day below — excluded from the
  // paid-leave pass after the loop so a half-day leave taken alongside actual
  // attendance (or fixture data recording both) is never paid twice.
  const workedDates = new Set<string>()

  for (const row of rows) {
    if (row.attendance_status === 'absent') absentDays += 1
    // Phase 2 only prices a plain 'present' day — see the phase plan's open
    // question #2. incomplete/unscheduled_work are surfaced for HR rather
    // than guessed at.
    if (row.attendance_status === 'incomplete') {
      reviewReasons.flag('incomplete_day', row.work_date)
      continue
    }
    if (row.attendance_status === 'unscheduled_work') {
      reviewReasons.flag('unscheduled_work_day', row.work_date)
      continue
    }
    if (row.attendance_status !== 'present') continue

    const wageAmount = row.wage_amount === null ? null : Number(row.wage_amount)
    if (wageAmount === null) {
      reviewReasons.flag('missing_wage', row.work_date)
      continue
    }

    workDays += 1
    grossWage += wageAmount
    workedDates.add(row.work_date)

    const workMinutes = shiftWorkMinutes(
      row.shift_start_time,
      row.shift_end_time,
      row.break_start_time,
      row.break_end_time
    )
    const wage = hourlyWage({ wageType: 'daily', wageAmount, shiftWorkMinutes: workMinutes })

    lateMinutesTotal += row.late_minutes
    earlyLeaveMinutesTotal += row.early_leave_minutes

    const latePastGrace = Math.max(0, row.late_minutes - row.late_grace_minutes)
    const earlyPastGrace = Math.max(0, row.early_leave_minutes - row.early_leave_grace_minutes)

    if (wage !== null) {
      lateMinutesDeducted += latePastGrace
      lateDeductAmount += lateOrEarlyDeductionAmount(latePastGrace, wage)
      earlyLeaveMinutesDeducted += earlyPastGrace
      earlyLeaveDeductAmount += lateOrEarlyDeductionAmount(earlyPastGrace, wage)
    } else if (latePastGrace > 0 || earlyPastGrace > 0) {
      // Owed a deduction but the shift's minutes could not price it (no shift
      // assigned) — surfaced rather than silently skipped.
      reviewReasons.flag('unpriceable_deduction', row.work_date)
    }
  }

  const leave = await leaveDaysInPeriod(employeeId, periodStart, periodEnd, true, db, workedDates)
  workDays += leave.paidDays
  grossWage += leave.paidAmount

  return {
    workDays: round2(workDays),
    grossWage: round2(grossWage),
    lateMinutesTotal,
    lateMinutesDeducted,
    lateDeductAmount: round2(lateDeductAmount),
    earlyLeaveMinutesTotal,
    earlyLeaveMinutesDeducted,
    earlyLeaveDeductAmount: round2(earlyLeaveDeductAmount),
    absentDays: round2(absentDays + leave.unpaidDays),
    reviewReasons: reviewReasons.toArray(),
  }
}

type EmploymentRow = {
  id: string
  employee_code: string
  employee_name: string
  start_working_date: string | null
  hire_date: string
  end_working_date: string | null
}

/** One monthly-wage employee's entry: full period pays the wage exactly,
 *  otherwise prorated by employedDayCount — see payrollEarnings.ts for why
 *  30 stays fixed regardless of the window's own length. */
async function buildMonthlyEntry(
  employeeId: number,
  employmentStart: string,
  employmentEnd: string | null,
  periodStart: string,
  periodEnd: string,
  wageAmount: number,
  db: Queryable
): Promise<{
  employedDays: number
  isFullPeriod: boolean
  grossWage: number
  absentDays: number
  lateMinutesTotal: number
  earlyLeaveMinutesTotal: number
  reviewReasons: PayrollEntryReviewReason[]
  paidLeaveDays: number
}> {
  const employedDays = employedDayCount(periodStart, periodEnd, employmentStart, employmentEnd)
  const isFullPeriod = isFullPeriodEmployment(periodStart, periodEnd, employmentStart, employmentEnd)
  const grossWage = monthlyGrossWage(wageAmount, isFullPeriod, employedDays)

  const { rows } = await db.query<{
    absent_count: string
    late_minutes_total: string
    early_leave_minutes_total: string
    incomplete_dates: string[]
    unscheduled_work_dates: string[]
  }>(
    `SELECT
       count(*) FILTER (WHERE attendance_status = 'absent') AS absent_count,
       COALESCE(SUM(late_minutes), 0) AS late_minutes_total,
       COALESCE(SUM(early_leave_minutes), 0) AS early_leave_minutes_total,
       COALESCE(array_agg(work_date::text) FILTER (WHERE attendance_status = 'incomplete'), '{}') AS incomplete_dates,
       COALESCE(array_agg(work_date::text) FILTER (WHERE attendance_status = 'unscheduled_work'), '{}') AS unscheduled_work_dates
     FROM attendance_daily
     WHERE employee_id = $1 AND work_date BETWEEN $2 AND $3`,
    [employeeId, periodStart, periodEnd]
  )
  const agg = rows[0]!

  const leave = await leaveDaysInPeriod(employeeId, periodStart, periodEnd, false, db)

  const reviewReasons = new ReviewReasons()
  for (const d of agg.incomplete_dates) reviewReasons.flag('incomplete_day', d)
  for (const d of agg.unscheduled_work_dates) reviewReasons.flag('unscheduled_work_day', d)

  return {
    employedDays: round2(employedDays),
    isFullPeriod,
    grossWage,
    absentDays: round2(Number(agg.absent_count) + leave.unpaidDays),
    lateMinutesTotal: Number(agg.late_minutes_total),
    earlyLeaveMinutesTotal: Number(agg.early_leave_minutes_total),
    reviewReasons: reviewReasons.toArray(),
    paidLeaveDays: round2(leave.paidDays),
  }
}

/** Whether more than one wage_type applied to this employee at any point
 *  inside the period — a monthly-to-daily reclassification mid-run, not just
 *  a raise. Neither buildDailyEntry nor buildMonthlyEntry can price this
 *  correctly: the daily branch would sum a monthly figure as if it were a
 *  day's wage (and vice versa) for whichever days fell on the other
 *  assignment. Phase 2 does not attempt a split calculation — that is a
 *  policy question for HR (see the phase plan's open question #3), not an
 *  engineering one — so this is caught before either branch runs. */
async function hasMixedWageType(
  employeeId: number,
  periodStart: string,
  periodEnd: string,
  db: Queryable
): Promise<boolean> {
  const { rows } = await db.query<{ wage_type: string }>(
    `SELECT DISTINCT wage_type FROM employee_wage_assignments
     WHERE employee_id = $1 AND effective_from <= $3 AND (effective_to IS NULL OR effective_to >= $2)`,
    [employeeId, periodStart, periodEnd]
  )
  return rows.length > 1
}

async function insertEntry(
  client: Client,
  args: {
    periodId: number
    employeeId: number
    employeeCode: string
    employeeName: string
    wageType: 'monthly' | 'daily'
    employedDays: number | null
    isFullPeriod: boolean | null
    workDays: number | null
    paidLeaveDays: number | null
    absentDays: number
    lateMinutesTotal: number
    lateMinutesDeducted: number
    earlyLeaveMinutesTotal: number
    earlyLeaveMinutesDeducted: number
    reviewReasons: PayrollEntryReviewReason[]
    lines: DraftLine[]
  }
): Promise<void> {
  const grossEarnings = round2(
    args.lines.filter((l) => LINE_TYPE[l.code] === 'income').reduce((sum, l) => sum + l.amount, 0)
  )
  const totalDeductions = round2(
    args.lines
      .filter((l) => LINE_TYPE[l.code] === 'deduction' || LINE_TYPE[l.code] === 'tax')
      .reduce((sum, l) => sum + l.amount, 0)
  )
  const netPay = round2(grossEarnings - totalDeductions)

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO payroll_entries
       (payroll_period_id, employee_id, employee_code, employee_name, wage_type,
        employed_days, is_full_period, work_days, paid_leave_days, absent_days,
        late_minutes_total, late_minutes_deducted,
        early_leave_minutes_total, early_leave_minutes_deducted,
        gross_earnings, total_deductions, net_pay, needs_review, review_reasons)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
     RETURNING id`,
    [
      args.periodId,
      args.employeeId,
      args.employeeCode,
      args.employeeName,
      args.wageType,
      args.employedDays,
      args.isFullPeriod,
      args.workDays,
      args.paidLeaveDays,
      args.absentDays,
      args.lateMinutesTotal,
      args.lateMinutesDeducted,
      args.earlyLeaveMinutesTotal,
      args.earlyLeaveMinutesDeducted,
      grossEarnings,
      totalDeductions,
      netPay,
      args.reviewReasons.length > 0,
      JSON.stringify(args.reviewReasons),
    ]
  )
  const entryId = Number(rows[0]!.id)

  for (const l of args.lines) {
    await client.query(
      `INSERT INTO payroll_entry_lines
         (payroll_entry_id, item_code, item_name, item_type, quantity, rate, amount, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [entryId, l.code, LINE_NAME[l.code], LINE_TYPE[l.code], l.quantity, l.rate, l.amount, LINE_SORT_ORDER[l.code]]
    )
  }
}

export type CalculateResult =
  | { kind: 'not_found' }
  | { kind: 'conflict'; message: string }
  | { kind: 'ok'; entryCount: number; needsReviewCount: number }

/**
 * Runs "calculate" for every employee in periodId's group: deletes and
 * rebuilds payroll_entries/payroll_entry_lines for the period, so calling
 * this twice on a still-draft period converges rather than duplicating — the
 * same idempotency recomputeAttendanceDaily's upsert gives for free via its
 * unique key, done here by delete-then-reinsert since an entry's shape can
 * change entirely between two calculations (a wage correction, a newly
 * approved leave).
 *
 * Must run inside a transaction the caller controls — it takes `client`
 * rather than defaulting to `pool` because the FOR UPDATE lock on the period
 * row and every insert below have to commit or roll back together.
 */
export async function calculatePayrollEntries(
  periodId: number,
  actor: AuthUser,
  client: Client
): Promise<CalculateResult> {
  const { rows: periodRows } = await client.query<{
    id: string
    payroll_group_id: string
    period_start: string
    period_end: string
    status: string
  }>(
    `SELECT id, payroll_group_id, period_start, period_end, status
     FROM payroll_periods WHERE id = $1 FOR UPDATE`,
    [periodId]
  )
  const period = periodRows[0]
  if (!period) return { kind: 'not_found' }
  if (period.status !== 'draft' && period.status !== 'calculating') {
    return {
      kind: 'conflict',
      message:
        period.status === 'voided'
          ? 'งวดนี้ถูกยกเลิกไปแล้ว คำนวณไม่ได้'
          : 'งวดนี้พ้นขั้นตอนคำนวณไปแล้ว — ต้องย้อนกลับไปสถานะรอตรวจสอบก่อนคำนวณใหม่',
    }
  }

  await client.query(`DELETE FROM payroll_entries WHERE payroll_period_id = $1`, [periodId])

  const { rows: employees } = await client.query<EmploymentRow>(
    `SELECT e.id, e.employee_code,
            (e.title || e.first_name_th || ' ' || e.last_name_th) AS employee_name,
            ed.start_working_date, ed.hire_date, ed.end_working_date
     FROM employment_details ed
     JOIN employees e ON e.id = ed.employee_id
     WHERE ed.payroll_group_id = $1
     ORDER BY e.employee_code`,
    [period.payroll_group_id]
  )

  let entryCount = 0
  let needsReviewCount = 0

  for (const emp of employees) {
    const employeeId = Number(emp.id)
    const wage = await getWageForDate(employeeId, period.period_end, client)
    // No wage on file at all: nothing to price. Skipped rather than entered
    // at zero — a missing finance tab is a data gap for HR to fill in, not a
    // ฿0 payslip to review. See the phase plan's open questions.
    if (wage === null) continue

    let reviewReasons: PayrollEntryReviewReason[] = []
    const lines: DraftLine[] = []
    let entryFields: Omit<Parameters<typeof insertEntry>[1], 'periodId' | 'employeeId' | 'employeeCode' | 'employeeName' | 'wageType' | 'lines' | 'reviewReasons'>

    if (await hasMixedWageType(employeeId, period.period_start, period.period_end, client)) {
      // Recorded rather than skipped, unlike the no-wage-at-all case: there IS
      // wage data, it just cannot be priced automatically, and an employee
      // silently missing from the list reads as "nothing owed" rather than
      // "needs a human". reviewReasons surfaces it instead.
      await insertEntry(client, {
        periodId,
        employeeId,
        employeeCode: emp.employee_code,
        employeeName: emp.employee_name,
        wageType: wage.wageType,
        reviewReasons: [{ code: 'mixed_wage_type', workDates: [] }],
        lines: [],
        employedDays: null,
        isFullPeriod: null,
        workDays: null,
        paidLeaveDays: null,
        absentDays: 0,
        lateMinutesTotal: 0,
        lateMinutesDeducted: 0,
        earlyLeaveMinutesTotal: 0,
        earlyLeaveMinutesDeducted: 0,
      })
      entryCount += 1
      needsReviewCount += 1
      continue
    }

    if (wage.wageType === 'daily') {
      const daily = await buildDailyEntry(employeeId, period.period_start, period.period_end, client)
      reviewReasons = daily.reviewReasons
      if (daily.grossWage > 0) {
        lines.push(line('BASIC_WAGE', daily.workDays, wage.wageAmount, daily.grossWage))
      }
      if (daily.lateDeductAmount > 0) {
        lines.push(line('LATE_DEDUCT', daily.lateMinutesDeducted, null, daily.lateDeductAmount))
      }
      if (daily.earlyLeaveDeductAmount > 0) {
        lines.push(line('EARLY_LEAVE_DEDUCT', daily.earlyLeaveMinutesDeducted, null, daily.earlyLeaveDeductAmount))
      }
      entryFields = {
        employedDays: null,
        isFullPeriod: null,
        workDays: daily.workDays,
        paidLeaveDays: null,
        absentDays: daily.absentDays,
        lateMinutesTotal: daily.lateMinutesTotal,
        lateMinutesDeducted: daily.lateMinutesDeducted,
        earlyLeaveMinutesTotal: daily.earlyLeaveMinutesTotal,
        earlyLeaveMinutesDeducted: daily.earlyLeaveMinutesDeducted,
      }
    } else {
      const employmentStart = emp.start_working_date ?? emp.hire_date
      const monthly = await buildMonthlyEntry(
        employeeId,
        employmentStart,
        emp.end_working_date,
        period.period_start,
        period.period_end,
        wage.wageAmount,
        client
      )
      reviewReasons = monthly.reviewReasons
      if (monthly.grossWage > 0) {
        lines.push(line('BASIC_WAGE', monthly.employedDays, wage.wageAmount, monthly.grossWage))
      }
      const absenceDeduct = monthlyAbsenceDeduction(wage.wageAmount, monthly.absentDays)
      if (absenceDeduct > 0) {
        lines.push(line('ABSENCE_DEDUCT', monthly.absentDays, round2(wage.wageAmount / 30), absenceDeduct))
      }
      entryFields = {
        employedDays: monthly.employedDays,
        isFullPeriod: monthly.isFullPeriod,
        workDays: null,
        paidLeaveDays: monthly.paidLeaveDays,
        absentDays: monthly.absentDays,
        lateMinutesTotal: monthly.lateMinutesTotal,
        lateMinutesDeducted: 0,
        earlyLeaveMinutesTotal: monthly.earlyLeaveMinutesTotal,
        earlyLeaveMinutesDeducted: 0,
      }
    }

    await insertEntry(client, {
      periodId,
      employeeId,
      employeeCode: emp.employee_code,
      employeeName: emp.employee_name,
      wageType: wage.wageType,
      reviewReasons,
      lines,
      ...entryFields,
    })

    entryCount += 1
    if (reviewReasons.length > 0) needsReviewCount += 1
  }

  if (period.status === 'draft') {
    await client.query(
      `UPDATE payroll_periods SET status = 'calculating', updated_at = now() WHERE id = $1`,
      [periodId]
    )
  }

  await recordAudit(client, {
    actor,
    action: 'payroll_period.calculate',
    entityId: periodId,
    detail: { entryCount, needsReviewCount },
  })

  return { kind: 'ok', entryCount, needsReviewCount }
}
