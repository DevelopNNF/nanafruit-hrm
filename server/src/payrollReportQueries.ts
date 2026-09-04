// Data for the payroll period Excel export — a per-period pivot of
// payroll_entry_lines (one column per item_code that actually occurs that
// period, decided by the caller) joined with employment info the payslip
// never needs (department, job, employment type). Kept separate from
// payrollEntryQueries.ts for the same reason payslipData.ts is: this is a
// rendering-shaped read, not something every caller of the entry queries
// needs to carry.

import type pg from 'pg'
import type { PaymentMethod } from '@hrm/shared'
import { pool } from './db.js'

type Queryable = Pick<pg.Pool, 'query'>

export type PayrollLineColumnDef = {
  itemCode: string
  itemName: string
  sortOrder: number
}

type LineColumnRow = {
  item_code: string
  item_name: string
  item_type: string
  sort_order: number
}

/**
 * Every distinct line item that appears at least once among this period's
 * entries, split income vs deduction/tax — the column layout the export
 * workbook builds itself around. BASIC_WAGE is excluded: it always gets its
 * own fixed "เงินเดือน" column, never a dynamic one.
 *
 * Ordered by sort_order (the same order a payslip already lines its items up
 * in — OT buckets before HR's finance items), so a reader who knows the
 * slip reads this report the same way.
 */
export async function listPayrollLineItemColumns(
  periodId: number,
  db: Queryable = pool
): Promise<{ income: PayrollLineColumnDef[]; deduction: PayrollLineColumnDef[] }> {
  const { rows } = await db.query<LineColumnRow>(
    // DISTINCT ON (item_code) picks one arbitrary row per code — fine since a
    // system code's item_name (LINE_NAME) never varies, and a finance item
    // renamed mid-period is a rare enough edge case that "whichever row
    // postgres returns first" is an acceptable answer, not a silent-
    // corruption one.
    `SELECT DISTINCT ON (pel.item_code) pel.item_code, pel.item_name, pel.item_type, pel.sort_order
     FROM payroll_entry_lines pel
     JOIN payroll_entries pe ON pe.id = pel.payroll_entry_id
     WHERE pe.payroll_period_id = $1 AND pel.item_code <> 'BASIC_WAGE'
     ORDER BY pel.item_code, pel.sort_order`,
    [periodId]
  )

  const sorted = rows
    .map((r) => ({
      itemCode: r.item_code,
      itemName: r.item_name,
      itemType: r.item_type,
      sortOrder: r.sort_order,
    }))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.itemCode.localeCompare(b.itemCode))

  return {
    income: sorted
      .filter((r) => r.itemType === 'income')
      .map(({ itemCode, itemName, sortOrder }) => ({ itemCode, itemName, sortOrder })),
    deduction: sorted
      .filter((r) => r.itemType === 'deduction' || r.itemType === 'tax')
      .map(({ itemCode, itemName, sortOrder }) => ({ itemCode, itemName, sortOrder })),
  }
}

export type PayrollExportRow = {
  employeeCode: string
  employeeName: string
  departmentName: string | null
  jobTitle: string | null
  startWorkingDate: string | null
  employmentType: string | null
  /** The BASIC_WAGE line's own rate — a per-day or per-month figure, not
   *  additive across employees on different wage types, so the export's
   *  totals row leaves this column blank rather than summing it. */
  wageRate: number | null
  basicWage: number
  /** work_days for a daily entry, employed_days for a monthly one — the two
   *  wage types don't share one "days" concept, but the template has one
   *  column for it. */
  workDaysDisplay: number | null
  grossEarnings: number
  totalDeductions: number
  netPay: number
  lineAmounts: Map<string, number>
}

type ExportHeaderRow = {
  id: string
  employee_code: string
  employee_name: string
  department_name: string | null
  job_title: string | null
  start_working_date: string | null
  hire_date: string
  employment_type: string | null
  work_days: string | null
  employed_days: string | null
  gross_earnings: string
  total_deductions: string
  net_pay: string
}

type LineAmountRow = {
  payroll_entry_id: string
  item_code: string
  rate: string | null
  amount: string
}

/**
 * One row per entry, employee_code order (same as listPayrollEntriesForPeriod)
 * — department/job/employment type read live off employment_details, same
 * reasoning payslipData.ts gives for its own header query: a report header
 * isn't the kind of legal record that has to freeze if HR later corrects a
 * typo in a department name.
 */
export async function listPayrollEntriesForExport(
  periodId: number,
  db: Queryable = pool
): Promise<PayrollExportRow[]> {
  const { rows: headerRows } = await db.query<ExportHeaderRow>(
    `SELECT pe.id, pe.employee_code, pe.employee_name,
            md.dept_name AS department_name, mj.job_title,
            ed.start_working_date, ed.hire_date, ed.employment_type,
            pe.work_days, pe.employed_days,
            pe.gross_earnings, pe.total_deductions, pe.net_pay
     FROM payroll_entries pe
     JOIN employees e ON e.id = pe.employee_id
     LEFT JOIN employment_details ed ON ed.employee_id = e.id
     LEFT JOIN master_departments md ON md.id = ed.department_id
     LEFT JOIN master_jobs mj ON mj.id = ed.job_id
     WHERE pe.payroll_period_id = $1
     ORDER BY pe.employee_code`,
    [periodId]
  )
  if (headerRows.length === 0) return []

  const entryIds = headerRows.map((r) => Number(r.id))
  const { rows: lineRows } = await db.query<LineAmountRow>(
    `SELECT payroll_entry_id, item_code, rate, amount
     FROM payroll_entry_lines WHERE payroll_entry_id = ANY($1::int[])`,
    [entryIds]
  )

  const linesByEntry = new Map<number, LineAmountRow[]>()
  for (const row of lineRows) {
    const entryId = Number(row.payroll_entry_id)
    const list = linesByEntry.get(entryId) ?? []
    list.push(row)
    linesByEntry.set(entryId, list)
  }

  return headerRows.map((row) => {
    const entryId = Number(row.id)
    const lines = linesByEntry.get(entryId) ?? []
    const basicWageLine = lines.find((l) => l.item_code === 'BASIC_WAGE')
    const lineAmounts = new Map<string, number>()
    for (const line of lines) {
      if (line.item_code === 'BASIC_WAGE') continue
      lineAmounts.set(line.item_code, Number(line.amount))
    }

    return {
      employeeCode: row.employee_code,
      employeeName: row.employee_name,
      departmentName: row.department_name,
      jobTitle: row.job_title,
      startWorkingDate: row.start_working_date ?? row.hire_date,
      employmentType: row.employment_type,
      wageRate: basicWageLine?.rate == null ? null : Number(basicWageLine.rate),
      basicWage: basicWageLine ? Number(basicWageLine.amount) : 0,
      workDaysDisplay:
        row.work_days !== null
          ? Number(row.work_days)
          : row.employed_days !== null
            ? Number(row.employed_days)
            : null,
      grossEarnings: Number(row.gross_earnings),
      totalDeductions: Number(row.total_deductions),
      netPay: Number(row.net_pay),
      lineAmounts,
    }
  })
}

export type PayrollPaymentFileRow = {
  employeeCode: string
  employeeName: string
  /** null when the employee has no employee_finance row at all — shouldn't
   *  happen (calculatePayrollEntries already needs one to price the wage),
   *  but the export falls back to listing them under "needs a manual check"
   *  rather than dropping them silently. The English slug from
   *  044_englishify_employee_finance_enums.sql — see employeeFinanceLabels.ts
   *  for the Thai the export shows. */
  paymentMethod: PaymentMethod | null
  bankName: string | null
  bankAccountNumber: string | null
  bankBranchCode: string | null
  netPay: number
}

type PaymentFileRow = {
  employee_code: string
  employee_name: string
  payment_method: string | null
  bank_name: string | null
  bank_account_number: string | null
  bank_branch_code: string | null
  net_pay: string
}

/**
 * How to pay every entry in this period — employee_finance read live (payment
 * method and bank details are current-state facts, not figures the slip has
 * to freeze), ordered by employee_code same as the management export above.
 */
export async function listPayrollEntriesForPaymentFile(
  periodId: number,
  db: Queryable = pool
): Promise<PayrollPaymentFileRow[]> {
  const { rows } = await db.query<PaymentFileRow>(
    `SELECT pe.employee_code, pe.employee_name, pe.net_pay,
            ef.payment_method, ef.bank_name, ef.bank_account_number, ef.bank_branch_code
     FROM payroll_entries pe
     LEFT JOIN employee_finance ef ON ef.employee_id = pe.employee_id
     WHERE pe.payroll_period_id = $1
     ORDER BY pe.employee_code`,
    [periodId]
  )
  return rows.map((row) => ({
    employeeCode: row.employee_code,
    employeeName: row.employee_name,
    paymentMethod: row.payment_method as PaymentMethod | null,
    bankName: row.bank_name,
    bankAccountNumber: row.bank_account_number,
    bankBranchCode: row.bank_branch_code,
    netPay: Number(row.net_pay),
  }))
}
