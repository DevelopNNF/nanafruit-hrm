// Reading employee_finance, split out from employeeQueries.ts because it's a
// separate table with its own access rules (HR/Admin only, see
// routes/employees.ts) rather than something joined onto every Employee read.

import type pg from 'pg'
import type { EmployeeFinance } from '@hrm/shared'
import { pool } from './db.js'

type Queryable = Pick<pg.Pool, 'query'>

export type EmployeeFinanceRow = {
  wage_type: string
  wage_amount: string // numeric: pg hands these back as strings to avoid precision loss
  payment_method: string
  bank_name: string
  bank_branch_code: string | null
  bank_account_number: string
  social_security_type: string
  social_security_fixed_amount: string | null
  tax_type: string
  tax_fixed_amount: string | null
  tax_start_month: string | null // 'YYYY-MM-DD' — see the DATE type parser in db.ts
}

export const SELECT_EMPLOYEE_FINANCE = `
  SELECT wage_type, wage_amount, payment_method, bank_name, bank_branch_code,
         bank_account_number, social_security_type, social_security_fixed_amount,
         tax_type, tax_fixed_amount, tax_start_month
  FROM employee_finance
`

export function rowToEmployeeFinance(row: EmployeeFinanceRow): EmployeeFinance {
  return {
    wageType: row.wage_type as EmployeeFinance['wageType'],
    wageAmount: Number(row.wage_amount),
    paymentMethod: row.payment_method as EmployeeFinance['paymentMethod'],
    bankName: row.bank_name,
    bankBranchCode: row.bank_branch_code,
    bankAccountNumber: row.bank_account_number,
    socialSecurityType: row.social_security_type as EmployeeFinance['socialSecurityType'],
    socialSecurityFixedAmount:
      row.social_security_fixed_amount === null ? null : Number(row.social_security_fixed_amount),
    taxType: row.tax_type as EmployeeFinance['taxType'],
    taxFixedAmount: row.tax_fixed_amount === null ? null : Number(row.tax_fixed_amount),
    taxStartMonth: row.tax_start_month,
  }
}

export async function findEmployeeFinanceById(
  employeeId: number,
  db: Queryable = pool
): Promise<EmployeeFinance | null> {
  const { rows } = await db.query<EmployeeFinanceRow>(
    `${SELECT_EMPLOYEE_FINANCE} WHERE employee_id = $1`,
    [employeeId]
  )
  const row = rows[0]
  return row ? rowToEmployeeFinance(row) : null
}
