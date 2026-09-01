import { Router } from 'express'
import type { Request, Response } from 'express'
import type ExcelJS from 'exceljs'
import type { AuthUser, EmployeeFinance } from '@hrm/shared'
import { pool } from '../db.js'
import { requireRole } from '../auth/middleware.js'
import { recordAudit } from '../audit.js'
import { fail, handleUnexpected } from '../http.js'
import { SELECT_EMPLOYEE, rowToEmployee, type EmployeeRow } from '../employeeQueries.js'
import { rowToEmployeeFinance, type EmployeeFinanceRow } from '../employeeFinanceQueries.js'
import { buildEmployeeFinanceWorkbook, type EmployeeFinanceExportRow } from '../employeeFinanceExport.js'

export const employeeFinanceExportRouter = Router()

// HRM.Payroll/HRM.Admin only — narrower than GET /employees/export (any HRM
// role), same scoping reason as employeeFinanceImport.ts: this hands out
// bank account numbers and tax settings for every employee at once.
const canRead = requireRole('HRM.Payroll', 'HRM.Admin')

const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

function actorOf(req: Request): AuthUser | null {
  return req.auth ?? null
}

function sendWorkbook(res: Response, buffer: ExcelJS.Buffer, filename: string): void {
  res.setHeader('Content-Type', XLSX_CONTENT_TYPE)
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
  )
  res.send(Buffer.from(buffer))
}

/** employee_finance + the wage in effect today, by employee id — a second
 *  round trip after SELECT_EMPLOYEE rather than one bigger join, same
 *  trade-off employeeMasterDataQueries.ts's loadEmployeeImportMasterData
 *  makes for its own six lists. */
async function loadFinanceByEmployeeId(
  employeeIds: number[]
): Promise<Map<number, { finance: EmployeeFinance | null; wageType: string | null; wageAmount: number | null }>> {
  const result = new Map<
    number,
    { finance: EmployeeFinance | null; wageType: string | null; wageAmount: number | null }
  >()
  if (employeeIds.length === 0) return result

  const { rows } = await pool.query<
    { employee_id: string; wage_type: string | null; wage_amount: string | null } & EmployeeFinanceRow
  >(
    `SELECT e.id AS employee_id,
            f.payment_method, f.bank_name, f.bank_branch_code, f.bank_account_number,
            f.social_security_type, f.social_security_fixed_amount,
            f.tax_type, f.tax_fixed_amount, f.tax_percent, f.tax_start_month,
            current_wage.wage_type, current_wage.wage_amount
     FROM employees e
     LEFT JOIN employee_finance f ON f.employee_id = e.id
     LEFT JOIN LATERAL (
       SELECT wage_type, wage_amount FROM employee_wage_assignments ewa
       WHERE ewa.employee_id = e.id
         AND ewa.effective_from <= (now() AT TIME ZONE 'Asia/Bangkok')::date
         AND (ewa.effective_to IS NULL OR ewa.effective_to >= (now() AT TIME ZONE 'Asia/Bangkok')::date)
     ) current_wage ON true
     WHERE e.id = ANY($1::bigint[])`,
    [employeeIds]
  )

  for (const row of rows) {
    result.set(Number(row.employee_id), {
      // Same "all-or-nothing across the row" cast as
      // employeeFinanceImportQueries.ts — see its own comment.
      finance: row.payment_method === null ? null : rowToEmployeeFinance(row as EmployeeFinanceRow),
      wageType: row.wage_type,
      wageAmount: row.wage_amount === null ? null : Number(row.wage_amount),
    })
  }
  return result
}

async function loadExportRows(): Promise<EmployeeFinanceExportRow[]> {
  const { rows: employeeRows } = await pool.query<EmployeeRow>(
    `${SELECT_EMPLOYEE} ORDER BY e.employee_code`
  )
  const employees = employeeRows.map(rowToEmployee)
  const financeByEmployeeId = await loadFinanceByEmployeeId(employees.map((e) => e.id))

  return employees.map((employee) => {
    const entry = financeByEmployeeId.get(employee.id) ?? null
    return {
      employeeCode: employee.employeeCode,
      title: employee.title,
      firstNameTh: employee.firstNameTh,
      lastNameTh: employee.lastNameTh,
      nickname: employee.nickname,
      hireDate: employee.employment.hireDate,
      startWorkingDate: employee.employment.startWorkingDate,
      employmentType: employee.employment.employmentType,
      holidayGroupName: employee.employment.holidayGroupName,
      payrollGroupName: employee.employment.payrollGroupName,
      overtimeGroupName: employee.employment.overtimeGroupName,
      wageType: (entry?.wageType as EmployeeFinanceExportRow['wageType']) ?? null,
      wageAmount: entry?.wageAmount ?? null,
      paymentMethod: entry?.finance?.paymentMethod ?? null,
      bankBranchCode: entry?.finance?.bankBranchCode ?? null,
      bankAccountNumber: entry?.finance?.bankAccountNumber ?? null,
      socialSecurityType: entry?.finance?.socialSecurityType ?? null,
      socialSecurityFixedAmount: entry?.finance?.socialSecurityFixedAmount ?? null,
      taxType: entry?.finance?.taxType ?? null,
      taxFixedAmount: entry?.finance?.taxFixedAmount ?? null,
      taxPercent: entry?.finance?.taxPercent ?? null,
      taxStartMonth: entry?.finance?.taxStartMonth ?? null,
    }
  })
}

// Logged separately from the blank template below (employee_finance.export
// vs employee_finance.export_template), same reasoning as employeeExport.ts:
// this one hands out every employee's bank/tax data, the other an empty
// sheet.
employeeFinanceExportRouter.get(
  '/employee-finance/export',
  canRead,
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor) return fail(res, 500, 'server misconfigured')

    try {
      const rows = await loadExportRows()
      const buffer = await buildEmployeeFinanceWorkbook(rows)

      await recordAudit(pool, {
        actor,
        action: 'employee_finance.export',
        entityId: null,
        detail: { employeeCount: rows.length },
      })

      const today = new Date().toISOString().slice(0, 10)
      sendWorkbook(res, buffer, `employee-finance-${today}.xlsx`)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

// A blank copy of the template, with the fixed-enum dropdowns rebuilt fresh
// — see employeeFinanceExport.ts's own comment on why there's nothing here
// that can actually go stale, unlike employeeExport.ts's master-data lists.
employeeFinanceExportRouter.get(
  '/employee-finance/export-template',
  canRead,
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor) return fail(res, 500, 'server misconfigured')

    try {
      const buffer = await buildEmployeeFinanceWorkbook([])

      await recordAudit(pool, {
        actor,
        action: 'employee_finance.export_template',
        entityId: null,
      })

      sendWorkbook(res, buffer, 'employee-finance-import-template.xlsx')
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)
