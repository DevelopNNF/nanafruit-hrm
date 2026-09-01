// Lookups the employee-finance import plan needs but no id-keyed *Queries.ts
// module provides: matching a sheet row's รหัสพนักงาน against an employee, and
// reading what that employee's finance settings and current wage already are
// so the plan can tell HR what's about to change. Same split as
// employeeMasterDataQueries.ts's findEmployeesByCodes, but richer per row —
// this import writes to employee_finance/employee_wage_assignments, not just
// employment_details, so the "did anything actually change" diff needs both.

import type pg from 'pg'
import type { EmployeeFinance } from '@hrm/shared'
import { pool } from './db.js'
import { rowToEmployeeFinance, type EmployeeFinanceRow } from './employeeFinanceQueries.js'

type Queryable = Pick<pg.Pool, 'query'>

export type EmployeeFinanceImportMatch = {
  employeeId: number
  employeeCode: string
  employeeName: string
  /** null means this employee has no employee_finance row yet — the same
   *  "may be the first save" case routes/employees.ts's PATCH upserts
   *  through. */
  finance: EmployeeFinance | null
  /** The wage in effect today, if any — read the same way
   *  findEmployeesByFingerprintCodesForImport does for the temp-worker
   *  employee template. */
  currentWageAmount: number | null
}

/** Every employee whose code is in `codes` — regardless of status. Unlike
 *  employeeMasterDataQueries.ts's findEmployeesByCodes there is no leaver
 *  rule here (a leaver's finance settings can still be corrected after the
 *  fact, e.g. a final pay run), so endWorkingDate is deliberately not read. */
export async function findEmployeesForFinanceImport(
  codes: string[],
  db: Queryable = pool
): Promise<Map<string, EmployeeFinanceImportMatch>> {
  const result = new Map<string, EmployeeFinanceImportMatch>()
  if (codes.length === 0) return result

  // Every employee_finance column is nullable here despite EmployeeFinanceRow
  // declaring most of them NOT NULL — this is a LEFT JOIN, and an employee
  // with no employee_finance row yet (see EmployeeFinanceImportMatch.finance)
  // comes back with every one of those columns null.
  const { rows } = await db.query<{
    id: string
    employee_code: string
    employee_name: string
    payment_method: string | null
    bank_name: string | null
    bank_branch_code: string | null
    bank_account_number: string | null
    social_security_type: string | null
    social_security_fixed_amount: string | null
    tax_type: string | null
    tax_fixed_amount: string | null
    tax_percent: string | null
    tax_start_month: string | null
    current_wage_amount: string | null
  }>(
    `SELECT e.id, e.employee_code,
            (e.title || e.first_name_th || ' ' || e.last_name_th) AS employee_name,
            f.payment_method, f.bank_name, f.bank_branch_code, f.bank_account_number,
            f.social_security_type, f.social_security_fixed_amount,
            f.tax_type, f.tax_fixed_amount, f.tax_percent, f.tax_start_month,
            current_wage.wage_amount AS current_wage_amount
     FROM employees e
     LEFT JOIN employee_finance f ON f.employee_id = e.id
     LEFT JOIN LATERAL (
       SELECT wage_amount FROM employee_wage_assignments ewa
       WHERE ewa.employee_id = e.id
         AND ewa.effective_from <= (now() AT TIME ZONE 'Asia/Bangkok')::date
         AND (ewa.effective_to IS NULL OR ewa.effective_to >= (now() AT TIME ZONE 'Asia/Bangkok')::date)
     ) current_wage ON true
     WHERE e.employee_code = ANY($1::text[])`,
    [codes]
  )

  for (const row of rows) {
    result.set(row.employee_code, {
      employeeId: Number(row.id),
      employeeCode: row.employee_code,
      employeeName: row.employee_name,
      // The null check is only ever true/false in lockstep across every
      // employee_finance column (one row per employee, or none) — the cast
      // reflects that a LEFT JOIN's per-column type can't.
      finance: row.payment_method === null ? null : rowToEmployeeFinance(row as EmployeeFinanceRow),
      currentWageAmount: row.current_wage_amount === null ? null : Number(row.current_wage_amount),
    })
  }
  return result
}
