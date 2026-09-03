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
  CalendarDayStatus,
  EmployeeFinance,
  FinanceItemType,
  OvertimeGroup,
  OvertimeRoundingMinutes,
  PayrollEntry,
  PayrollEntryLine,
  PayrollEntryLineCode,
  PayrollEntryReviewReason,
  PayrollEntryReviewReasonCode,
  PayrollEntryWithLines,
  WageType,
} from '@hrm/shared'
import { pool } from './db.js'
import { recordAudit } from './audit.js'
import { bucketOvertimeDay, type OvertimeBucketCode } from './overtimeCalculation.js'
import { hourlyWage } from './wageRate.js'
import { getWageForDate, wageJoinSqlForDate } from './wageAssignmentQueries.js'
import { parseDateOnlyUtc, toDateOnlyString } from './leaveRequestQueries.js'
import { findEmployeeFinanceById } from './employeeFinanceQueries.js'
import { socialSecurityContribution, SOCIAL_SECURITY_RATE } from './socialSecurityCalculation.js'
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
  fingerprint_code: string | null
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
  reviewed_at: string | null
  calculated_at: string
}

export const SELECT_PAYROLL_ENTRY = `
  SELECT pe.id, pe.payroll_period_id, pe.employee_id, pe.employee_code, pe.employee_name,
         e.fingerprint_code, pe.wage_type,
         pe.employed_days, pe.is_full_period, pe.work_days, pe.paid_leave_days, pe.absent_days,
         pe.late_minutes_total, pe.late_minutes_deducted,
         pe.early_leave_minutes_total, pe.early_leave_minutes_deducted,
         pe.gross_earnings, pe.total_deductions, pe.net_pay, pe.needs_review, pe.review_reasons,
         pe.reviewed_at, pe.calculated_at
  FROM payroll_entries pe
  LEFT JOIN employees e ON e.id = pe.employee_id
`

function rowToPayrollEntry(row: PayrollEntryRow): PayrollEntry {
  return {
    id: Number(row.id),
    payrollPeriodId: Number(row.payroll_period_id),
    employeeId: Number(row.employee_id),
    employeeCode: row.employee_code,
    employeeName: row.employee_name,
    fingerprintCode: row.fingerprint_code,
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
    reviewedAt: row.reviewed_at === null ? null : new Date(row.reviewed_at).toISOString(),
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
  finance_item_id: string | null
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
    financeItemId: row.finance_item_id === null ? null : Number(row.finance_item_id),
  }
}

/** Every entry for one period, employee code order — the period-detail
 *  screen's table. */
export async function listPayrollEntriesForPeriod(
  periodId: number,
  db: Queryable = pool
): Promise<PayrollEntry[]> {
  const { rows } = await db.query<PayrollEntryRow>(
    `${SELECT_PAYROLL_ENTRY} WHERE pe.payroll_period_id = $1 ORDER BY pe.employee_code`,
    [periodId]
  )
  return rows.map(rowToPayrollEntry)
}

/** One entry with its lines — the payslip screen. */
export async function findPayrollEntryById(
  id: number,
  db: Queryable = pool
): Promise<PayrollEntryWithLines | null> {
  const { rows } = await db.query<PayrollEntryRow>(`${SELECT_PAYROLL_ENTRY} WHERE pe.id = $1`, [id])
  const row = rows[0]
  if (!row) return null

  const { rows: lineRows } = await db.query<PayrollEntryLineRow>(
    `SELECT id, item_code, item_name, item_type, quantity, rate, amount, sort_order, finance_item_id
     FROM payroll_entry_lines WHERE payroll_entry_id = $1 ORDER BY sort_order, id`,
    [id]
  )

  return { ...rowToPayrollEntry(row), lines: lineRows.map(rowToPayrollEntryLine) }
}

export type SetReviewedResult =
  | { kind: 'not_found' }
  | { kind: 'conflict'; message: string }
  | { kind: 'ok' }

/**
 * Marks (or unmarks) one entry as looked-at by HR, ahead of approving the
 * whole period. Only legal while the period is 'review' — before that there
 * is nothing frozen yet to review, and once approved the review step is over.
 *
 * Also only legal when needs_review is true: an entry the system did not
 * flag has nothing HR needs to individually confirm, so there is deliberately
 * no way to check one that calculatePayrollEntries considers unremarkable —
 * the review step scales with what actually needs a look, not headcount.
 *
 * Must run inside a transaction the caller controls, same reasoning as
 * calculatePayrollEntries: the FOR UPDATE lock and the write have to commit
 * or roll back together.
 */
export async function setEntryReviewed(
  entryId: number,
  reviewed: boolean,
  actor: AuthUser,
  client: Client
): Promise<SetReviewedResult> {
  const { rows } = await client.query<{
    payroll_period_id: string
    status: string
    needs_review: boolean
  }>(
    `SELECT pe.payroll_period_id, pp.status, pe.needs_review
     FROM payroll_entries pe
     JOIN payroll_periods pp ON pp.id = pe.payroll_period_id
     WHERE pe.id = $1
     FOR UPDATE OF pe`,
    [entryId]
  )
  const row = rows[0]
  if (!row) return { kind: 'not_found' }
  if (row.status !== 'review') {
    return {
      kind: 'conflict',
      message: 'ทำเครื่องหมายตรวจสอบได้เฉพาะตอนงวดอยู่ในขั้นตอนตรวจสอบเท่านั้น',
    }
  }
  if (!row.needs_review) {
    return {
      kind: 'conflict',
      message: 'รายการนี้ไม่ได้ถูกระบบตีเป็นรายการที่ต้องตรวจสอบ',
    }
  }

  await client.query(
    `UPDATE payroll_entries SET reviewed_at = $2, updated_at = now() WHERE id = $1`,
    [entryId, reviewed ? new Date() : null]
  )

  await recordAudit(client, {
    actor,
    action: reviewed ? 'payroll_entry.review' : 'payroll_entry.unreview',
    entityId: entryId,
    detail: { payrollPeriodId: Number(row.payroll_period_id) },
  })

  return { kind: 'ok' }
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
  OT_WORKDAY: 'ค่าล่วงเวลาวันทำงาน',
  OT_NORMAL_DAYOFF: 'ค่าล่วงเวลาวันหยุด (8 ชม.แรก)',
  OT_EXTRA_DAYOFF: 'ค่าล่วงเวลาวันหยุด (เกิน 8 ชม.)',
  OT_NORMAL_HOLIDAY: 'ค่าล่วงเวลาวันหยุดนักขัตฤกษ์ (8 ชม.แรก)',
  OT_EXTRA_HOLIDAY: 'ค่าล่วงเวลาวันหยุดนักขัตฤกษ์ (เกิน 8 ชม.)',
  SOCIAL_SECURITY_DEDUCT: 'ประกันสังคม',
}
const LINE_TYPE: Record<PayrollEntryLineCode, FinanceItemType> = {
  BASIC_WAGE: 'income',
  ABSENCE_DEDUCT: 'deduction',
  LATE_DEDUCT: 'deduction',
  EARLY_LEAVE_DEDUCT: 'deduction',
  OT_WORKDAY: 'income',
  OT_NORMAL_DAYOFF: 'income',
  OT_EXTRA_DAYOFF: 'income',
  OT_NORMAL_HOLIDAY: 'income',
  OT_EXTRA_HOLIDAY: 'income',
  SOCIAL_SECURITY_DEDUCT: 'deduction',
}
const LINE_SORT_ORDER: Record<PayrollEntryLineCode, number> = {
  BASIC_WAGE: 10,
  ABSENCE_DEDUCT: 20,
  LATE_DEDUCT: 30,
  EARLY_LEAVE_DEDUCT: 40,
  // 50-59: the five OT buckets, grouped together between Phase 2's core
  // lines and Phase 3's finance-item lines (which start at 100 — see
  // financeItemLine below), ordered least-to-most-premium so a slip reads
  // "ordinary OT, then day-off OT, then holiday OT".
  OT_WORKDAY: 50,
  OT_NORMAL_DAYOFF: 51,
  OT_EXTRA_DAYOFF: 52,
  OT_NORMAL_HOLIDAY: 53,
  OT_EXTRA_HOLIDAY: 54,
  // 60: statutory deductions — the system computes this one automatically,
  // same as OT, so it sits right after OT and before the 100+ block of
  // finance items HR configures by hand.
  SOCIAL_SECURITY_DEDUCT: 60,
}

/** name/itemType/sortOrder travel with the line itself rather than being
 *  looked up from the tables above at insert time — a finance-item line's
 *  code is whatever HR typed into master_finance_items, not a key those
 *  Records can index. */
type DraftLine = {
  code: string
  name: string
  itemType: FinanceItemType
  sortOrder: number
  financeItemId: number | null
  quantity: number | null
  rate: number | null
  amount: number
}

/** A core line — one of PAYROLL_ENTRY_LINE_CODES. name/type/sort resolved
 *  from the static tables above, same as Phase 2 always did. */
function line(code: PayrollEntryLineCode, quantity: number | null, rate: number | null, amount: number): DraftLine {
  return {
    code,
    name: LINE_NAME[code],
    itemType: LINE_TYPE[code],
    sortOrder: LINE_SORT_ORDER[code],
    financeItemId: null,
    quantity,
    rate: rate === null ? null : round2(rate),
    amount: round2(amount),
  }
}

/** A finance-item-backed line — name/type/sort/financeItemId come from the
 *  master_finance_items row itself (see buildFinanceItemLines), never from
 *  the static tables above, because HR configures this item's vocabulary,
 *  not this file. sortOrder starts at 100 + the item's own
 *  master_finance_items.sort_order so HR's configured relative order between
 *  finance items is preserved, and the whole block sorts after every core
 *  line (Phase 2's 10-40, Phase 3's OT 50-54). */
function financeItemLine(args: {
  financeItemId: number
  itemCode: string
  itemName: string
  itemType: FinanceItemType
  masterSortOrder: number
  amount: number
}): DraftLine {
  return {
    code: args.itemCode,
    name: args.itemName,
    itemType: args.itemType,
    sortOrder: 100 + args.masterSortOrder,
    financeItemId: args.financeItemId,
    quantity: null,
    rate: null,
    amount: round2(args.amount),
  }
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

type OvertimeRequestPriceRow = {
  ot_date: string
  day_status: string
  comp_time_requested: boolean
  comp_time_allocated_normal_minutes: number
  comp_time_allocated_extra_minutes: number
  comp_time_money_source_minutes: number
  group_id: string
  group_code: string
  group_name: string
  rate_ot_workday: string
  rate_normal_dayoff: string
  rate_ot_dayoff: string
  rate_normal_holiday: string
  rate_ot_holiday: string
  rounding_minutes: number
  shift_start_time: string | null
  shift_end_time: string | null
  break_start_time: string | null
  break_end_time: string | null
  wage_type: string | null
  wage_amount: string | null
}

/** Splits a request's still-money-payable total (comp_time_money_source_minutes)
 *  back into normal/extra shares, proportional to how the day's allocation
 *  (comp_time_allocated_normal/extra_minutes) split between them — the same
 *  ratio the request's own comp-time conversion used, so the money side and
 *  the comp-time side never disagree about which minutes were "normal" vs
 *  "extra". The remainder (not a second rounded share) is what makes the two
 *  always sum to exactly moneyTotal, avoiding a stray minute lost to
 *  independent rounding on each side. */
function splitMoneyMinutes(
  allocatedNormal: number,
  allocatedExtra: number,
  moneyTotal: number
): { normal: number; extra: number } {
  const allocatedTotal = allocatedNormal + allocatedExtra
  if (allocatedTotal === 0 || moneyTotal === 0) return { normal: 0, extra: 0 }
  const normal = Math.round((moneyTotal * allocatedNormal) / allocatedTotal)
  return { normal, extra: moneyTotal - normal }
}

/**
 * One employee's overtime lines for the period — the five buckets
 * master_overtime_groups' five rates define, each summed across every
 * APPROVED overtime_requests row in [periodStart, periodEnd].
 *
 * Reads overtime_requests directly, one row per request, rather than
 * attendance_daily's day-level aggregate: since Phase 4/5 let a request be
 * taken as comp-time-off instead of money, the day-level total can no longer
 * be priced as a whole — a day carrying two requests, one money and one
 * comp-time, must only pay the money one. comp_time_allocated_normal/extra_minutes
 * and comp_time_money_source_minutes (frozen at approval time by
 * postCompTimeAccrualForApprovedRange, see compTimeQueries.ts) are exactly
 * "this request's share of its day" and "how much of that share is still
 * payable" — reading them here means payroll never has to re-run the
 * allocator itself, and always agrees with whatever was posted to the
 * comp-time ledger.
 *
 * overtime_group_id is NOT NULL on overtime_requests (a request cannot be
 * submitted without one — see migration 039), so master_overtime_groups joins
 * unconditionally here; there is no "day has approved OT but no group"
 * fallback to fall back to any more, since attendance_daily.approved_ot_minutes
 * was itself always derived from at least one such request in the first place.
 *
 * Deliberately its own step, called once per employee regardless of
 * wage_type: OT pricing (overtimeAmount/overtimeRatesFor, imported unchanged
 * from overtimeCalculation.ts — never reimplemented here) does not depend on
 * whether the employee is paid daily or monthly.
 *
 * Per-request bucket routing (which of the five payslip codes a request's
 * money-payable minutes belong to, and their amount) is still
 * bucketOvertimeDay() in overtimeCalculation.ts, fed the money-only share
 * rather than the full allocated share — it has no idea comp-time exists,
 * and doesn't need to. rate on each line is the bucket's multiplier (e.g.
 * group.rateOtWorkday), not the hourly wage: a raise mid-period prices
 * different requests' minutes at different hourly wages, so no single rate
 * reads correctly for the bucket as a whole — only quantity (minutes) and
 * amount (baht) are exact sums.
 */
async function buildOvertimeLines(
  employeeId: number,
  periodStart: string,
  periodEnd: string,
  db: Queryable
): Promise<{ lines: DraftLine[]; reviewReasons: PayrollEntryReviewReason[] }> {
  const { rows } = await db.query<OvertimeRequestPriceRow>(
    `SELECT otr.ot_date, otr.day_status, otr.comp_time_requested,
            otr.comp_time_allocated_normal_minutes, otr.comp_time_allocated_extra_minutes,
            otr.comp_time_money_source_minutes,
            mog.id AS group_id, mog.group_code, mog.group_name,
            mog.rate_ot_workday, mog.rate_normal_dayoff, mog.rate_ot_dayoff,
            mog.rate_normal_holiday, mog.rate_ot_holiday, mog.rounding_minutes,
            ms.shift_start_time, ms.shift_end_time, ms.break_start_time, ms.break_end_time,
            wage_on_date.wage_type, wage_on_date.wage_amount
     FROM overtime_requests otr
     JOIN master_overtime_groups mog ON mog.id = otr.overtime_group_id
     LEFT JOIN master_shifts ms ON ms.id = otr.shift_id
     ${wageJoinSqlForDate('otr.employee_id', 'otr.ot_date')}
     WHERE otr.employee_id = $1 AND otr.ot_date BETWEEN $2 AND $3 AND otr.status = 'approved'
     ORDER BY otr.ot_date, otr.start_time`,
    [employeeId, periodStart, periodEnd]
  )

  const totals: Record<OvertimeBucketCode, { minutes: number; amount: number; rate: number }> = {
    OT_WORKDAY: { minutes: 0, amount: 0, rate: 0 },
    OT_NORMAL_DAYOFF: { minutes: 0, amount: 0, rate: 0 },
    OT_EXTRA_DAYOFF: { minutes: 0, amount: 0, rate: 0 },
    OT_NORMAL_HOLIDAY: { minutes: 0, amount: 0, rate: 0 },
    OT_EXTRA_HOLIDAY: { minutes: 0, amount: 0, rate: 0 },
  }
  const reviewReasons = new ReviewReasons()

  for (const row of rows) {
    const group: OvertimeGroup = {
      id: Number(row.group_id),
      groupCode: row.group_code,
      groupName: row.group_name,
      rateOtWorkday: Number(row.rate_ot_workday),
      rateNormalDayoff: Number(row.rate_normal_dayoff),
      rateOtDayoff: Number(row.rate_ot_dayoff),
      rateNormalHoliday: Number(row.rate_normal_holiday),
      rateOtHoliday: Number(row.rate_ot_holiday),
      roundingMinutes: (row.rounding_minutes ?? 0) as OvertimeRoundingMinutes,
      isActive: true,
      // Only rate*/roundingMinutes feed bucketOvertimeDay() below — the split
      // between money and comp-time already happened at approval time
      // (postCompTimeAccrualForApprovedRange), so this function only ever
      // prices the money share, and never needs the group's comp_* fields.
      compTimeEnabled: false,
      compRateOtWorkday: null,
      compRateNormalDayoff: null,
      compRateOtDayoff: null,
      compRateNormalHoliday: null,
      compRateOtHoliday: null,
      compAnnualCapEnabled: false,
      compAnnualCapMinutes: null,
      compRoundingMinutes: 0,
    }
    const status = row.day_status as CalendarDayStatus
    const workMinutes = shiftWorkMinutes(
      row.shift_start_time,
      row.shift_end_time,
      row.break_start_time,
      row.break_end_time
    )
    const wage =
      row.wage_type === null || row.wage_amount === null
        ? null
        : hourlyWage({
            wageType: row.wage_type as WageType,
            wageAmount: Number(row.wage_amount),
            shiftWorkMinutes: workMinutes,
          })

    const moneyMinutes = row.comp_time_requested
      ? splitMoneyMinutes(
          row.comp_time_allocated_normal_minutes,
          row.comp_time_allocated_extra_minutes,
          row.comp_time_money_source_minutes
        )
      : { normal: row.comp_time_allocated_normal_minutes, extra: row.comp_time_allocated_extra_minutes }

    const shares = bucketOvertimeDay({
      status,
      normalMinutes: moneyMinutes.normal,
      extraMinutes: moneyMinutes.extra,
      group,
      hourlyWage: wage,
    })
    for (const share of shares) {
      // A share with 0 minutes (e.g. entirely converted to comp-time, or a
      // holiday whose OT was entirely "extra") has nothing to price — skip
      // before the null check below, or an unresolvable wage on an empty
      // share would flag a review reason for a bucket that owes nothing.
      if (share.minutes === 0) continue
      if (share.amount === null) {
        reviewReasons.flag('unpriceable_overtime', row.ot_date)
        continue
      }
      const total = totals[share.code]
      total.minutes += share.minutes
      total.amount += share.amount
      total.rate = share.rate
    }
  }

  const lines: DraftLine[] = []
  for (const code of Object.keys(totals) as OvertimeBucketCode[]) {
    const total = totals[code]
    if (total.minutes > 0) lines.push(line(code, total.minutes, total.rate, total.amount))
  }

  return { lines, reviewReasons: reviewReasons.toArray() }
}

type FinanceItemOverlapRow = {
  finance_item_id: string
  item_code: string
  item_name: string
  item_type: string
  amount: string
  master_sort_order: number
}

/**
 * One employee's HR-configured allowances/deductions for the period — every
 * employee_finance_items row overlapping [periodStart, periodEnd], snapshot
 * onto its own line (item_code/item_name/item_type/amount copied, not
 * joined) per 045's instruction to whoever built this: a join here would let
 * HR renaming an item in the master silently rewrite an already-run payslip.
 *
 * Full amount, not prorated, when the item's own [effective_from,
 * effective_to] only partly overlaps the period — amount on
 * employee_finance_items reads as a configured-per-period figure ("2,000
 * บาท"), not a per-diem rate with an implicit daily equivalent, and there is
 * no column anywhere recording what that daily equivalent would even be.
 * Flagged as an open question for HR to confirm before this runs in
 * production (see the phase plan).
 */
async function buildFinanceItemLines(
  employeeId: number,
  periodStart: string,
  periodEnd: string,
  db: Queryable
): Promise<DraftLine[]> {
  const { rows } = await db.query<FinanceItemOverlapRow>(
    `SELECT efi.finance_item_id, mfi.item_code, mfi.item_name, mfi.item_type,
            efi.amount, mfi.sort_order AS master_sort_order
     FROM employee_finance_items efi
     JOIN master_finance_items mfi ON mfi.id = efi.finance_item_id
     WHERE efi.employee_id = $1
       AND efi.effective_from <= $3 AND (efi.effective_to IS NULL OR efi.effective_to >= $2)
     ORDER BY mfi.sort_order, mfi.item_code`,
    [employeeId, periodStart, periodEnd]
  )

  return rows.map((row) =>
    financeItemLine({
      financeItemId: Number(row.finance_item_id),
      itemCode: row.item_code,
      itemName: row.item_name,
      itemType: row.item_type as FinanceItemType,
      masterSortOrder: row.master_sort_order,
      amount: Number(row.amount),
    })
  )
}

/**
 * The social-security deduction line, if any, for one employee — driven by
 * employee_finance.socialSecurityType, not something payroll decides on its
 * own. Only two of the six types produce a line here:
 *
 * - actual_wage_employee_paid: 5% of wageReceived (the same grossWage
 *   buildDailyEntry/buildMonthlyEntry already computed — NOT including OT,
 *   per HR), clamped to [1,650, 17,500] and rounded to a whole baht by
 *   socialSecurityContribution().
 * - fixed_monthly: employee_finance.socialSecurityFixedAmount verbatim, no
 *   clamp or 5% involved — HR set this figure directly.
 *
 * Every other type (none, actual_wage_company_paid, section_39, formula)
 * produces no line at all: none/section_39 mean this employee's contribution
 * genuinely does not run through payroll, actual_wage_company_paid means the
 * company absorbs it outside this system (out of scope for Phase 4 — see the
 * phase plan), and formula is the legacy config value this company never
 * used. finance === null (no employee_finance row at all, which the
 * employee-finance form should prevent but this function does not assume)
 * is treated the same as 'none' rather than guessed at.
 */
function buildSocialSecurityLine(finance: EmployeeFinance | null, wageReceived: number): DraftLine | null {
  if (finance === null) return null

  if (finance.socialSecurityType === 'actual_wage_employee_paid') {
    const amount = socialSecurityContribution(wageReceived)
    if (amount <= 0) return null
    return line('SOCIAL_SECURITY_DEDUCT', null, SOCIAL_SECURITY_RATE, amount)
  }

  if (finance.socialSecurityType === 'fixed_monthly') {
    const amount = finance.socialSecurityFixedAmount ?? 0
    if (amount <= 0) return null
    return line('SOCIAL_SECURITY_DEDUCT', null, null, amount)
  }

  return null
}

/** Merges review-reason lists from separate sources (e.g. buildDailyEntry's
 *  own reasons and buildOvertimeLines' reasons) by code, unioning workDates
 *  rather than concatenating the lists — so if two sources ever flag the same
 *  code, the entry gets one reason with every date, not two duplicate
 *  reasons. Not expected to collide today (unpriceable_overtime doesn't
 *  overlap any code the daily/monthly builders flag), but cheap enough to do
 *  correctly rather than assume it stays that way. */
function mergeReviewReasons(...lists: PayrollEntryReviewReason[][]): PayrollEntryReviewReason[] {
  const byCode = new Map<PayrollEntryReviewReasonCode, Set<string>>()
  for (const list of lists) {
    for (const reason of list) {
      const dates = byCode.get(reason.code) ?? new Set<string>()
      for (const d of reason.workDates) dates.add(d)
      byCode.set(reason.code, dates)
    }
  }
  return [...byCode.entries()].map(([code, dates]) => ({ code, workDates: [...dates].sort() }))
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
    args.lines.filter((l) => l.itemType === 'income').reduce((sum, l) => sum + l.amount, 0)
  )
  const totalDeductions = round2(
    args.lines
      .filter((l) => l.itemType === 'deduction' || l.itemType === 'tax')
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
         (payroll_entry_id, item_code, item_name, item_type, quantity, rate, amount, sort_order, finance_item_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [entryId, l.code, l.name, l.itemType, l.quantity, l.rate, l.amount, l.sortOrder, l.financeItemId]
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

    let reviewReasons: PayrollEntryReviewReason[]
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

    // Called once per employee, independent of the daily/monthly branch
    // below — OT pricing and HR-configured finance items follow the same
    // rule for both wage types, so duplicating either query into both
    // branches would be one calculation read from two places that can drift.
    const overtime = await buildOvertimeLines(employeeId, period.period_start, period.period_end, client)
    const financeLines = await buildFinanceItemLines(employeeId, period.period_start, period.period_end, client)
    const finance = await findEmployeeFinanceById(employeeId, client)
    const lines: DraftLine[] = [...overtime.lines, ...financeLines]

    if (wage.wageType === 'daily') {
      const daily = await buildDailyEntry(employeeId, period.period_start, period.period_end, client)
      reviewReasons = mergeReviewReasons(daily.reviewReasons, overtime.reviewReasons)
      if (daily.grossWage > 0) {
        lines.push(line('BASIC_WAGE', daily.workDays, wage.wageAmount, daily.grossWage))
      }
      if (daily.lateDeductAmount > 0) {
        lines.push(line('LATE_DEDUCT', daily.lateMinutesDeducted, null, daily.lateDeductAmount))
      }
      if (daily.earlyLeaveDeductAmount > 0) {
        lines.push(line('EARLY_LEAVE_DEDUCT', daily.earlyLeaveMinutesDeducted, null, daily.earlyLeaveDeductAmount))
      }
      const ssLine = buildSocialSecurityLine(finance, daily.grossWage)
      if (ssLine) lines.push(ssLine)
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
      reviewReasons = mergeReviewReasons(monthly.reviewReasons, overtime.reviewReasons)
      if (monthly.grossWage > 0) {
        lines.push(line('BASIC_WAGE', monthly.employedDays, wage.wageAmount, monthly.grossWage))
      }
      const absenceDeduct = monthlyAbsenceDeduction(wage.wageAmount, monthly.absentDays)
      if (absenceDeduct > 0) {
        lines.push(line('ABSENCE_DEDUCT', monthly.absentDays, round2(wage.wageAmount / 30), absenceDeduct))
      }
      const ssLine = buildSocialSecurityLine(finance, monthly.grossWage)
      if (ssLine) lines.push(ssLine)
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
