// Reading employee_finance_items with the master row it points at resolved.
//
// Kept out of employeeFinanceQueries.ts even though both feed the same tab:
// that one is a 1:1 row of settings, this one is a list of dated lines with a
// join, and they share no column.

import type pg from 'pg'
import type { EmployeeFinanceItem, FinanceItemType } from '@hrm/shared'
import { pool } from './db.js'

type Queryable = Pick<pg.Pool, 'query'>

export type EmployeeFinanceItemRow = {
  id: string // bigint: pg hands these back as strings to avoid precision loss
  finance_item_id: string
  item_code: string
  item_name: string
  item_type: string
  amount: string // numeric: string too, same reason
  effective_from: string // 'YYYY-MM-DD' — see the DATE type parser in db.ts
  effective_to: string | null
  note: string | null
}

export const SELECT_EMPLOYEE_FINANCE_ITEM = `
  SELECT efi.id, efi.finance_item_id, efi.amount, efi.effective_from,
         efi.effective_to, efi.note,
         mfi.item_code, mfi.item_name, mfi.item_type
  FROM employee_finance_items efi
  JOIN master_finance_items mfi ON mfi.id = efi.finance_item_id
`

/** Income first, then deductions, then tax — the order a payslip reads in,
 *  which alphabetical item_type ('deduction' before 'income') is not. */
export const ORDER_EMPLOYEE_FINANCE_ITEM = `
  ORDER BY CASE mfi.item_type
             WHEN 'income' THEN 1
             WHEN 'deduction' THEN 2
             ELSE 3
           END,
           mfi.sort_order, mfi.item_code, efi.effective_from
`

export function rowToEmployeeFinanceItem(row: EmployeeFinanceItemRow): EmployeeFinanceItem {
  return {
    id: Number(row.id),
    financeItemId: Number(row.finance_item_id),
    itemCode: row.item_code,
    itemName: row.item_name,
    itemType: row.item_type as FinanceItemType,
    amount: Number(row.amount),
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    note: row.note,
  }
}

export async function listEmployeeFinanceItems(
  employeeId: number,
  db: Queryable = pool
): Promise<EmployeeFinanceItem[]> {
  const { rows } = await db.query<EmployeeFinanceItemRow>(
    `${SELECT_EMPLOYEE_FINANCE_ITEM} WHERE efi.employee_id = $1 ${ORDER_EMPLOYEE_FINANCE_ITEM}`,
    [employeeId]
  )
  return rows.map(rowToEmployeeFinanceItem)
}

/** Scoped by employee as well as id: a line id from another employee's record
 *  must read as "not found" here, not as someone else's row. */
export async function findEmployeeFinanceItem(
  employeeId: number,
  lineId: number,
  db: Queryable = pool
): Promise<EmployeeFinanceItem | null> {
  const { rows } = await db.query<EmployeeFinanceItemRow>(
    `${SELECT_EMPLOYEE_FINANCE_ITEM} WHERE efi.employee_id = $1 AND efi.id = $2`,
    [employeeId, lineId]
  )
  const row = rows[0]
  return row ? rowToEmployeeFinanceItem(row) : null
}
