// Reading payroll groups out of master_payroll_groups. A single flat table
// with no join, same shape of module as overtimeGroupQueries.ts.

import type pg from 'pg'
import type { PayDayRule, PayrollGroup } from '@hrm/shared'
import { pool } from './db.js'
import type { PeriodCycle } from './payrollPeriod.js'

type Queryable = Pick<pg.Pool, 'query'>

export type PayrollGroupRow = {
  id: string // bigint: pg hands these back as strings to avoid precision loss
  group_code: string
  group_name: string
  cutoff_day: number
  pay_day_rule: string
  pay_day_of_month: number | null
  is_active: boolean
}

export const SELECT_PAYROLL_GROUP = `
  SELECT id, group_code, group_name, cutoff_day, pay_day_rule, pay_day_of_month, is_active
  FROM master_payroll_groups
`

export function rowToPayrollGroup(row: PayrollGroupRow): PayrollGroup {
  return {
    id: Number(row.id),
    groupCode: row.group_code,
    groupName: row.group_name,
    cutoffDay: row.cutoff_day,
    payDayRule: row.pay_day_rule as PayDayRule,
    payDayOfMonth: row.pay_day_of_month,
    isActive: row.is_active,
  }
}

/** The half of a group that derivePeriodWindow needs. Its own function so the
 *  pure module never has to know what a PayrollGroup is. */
export function cycleOf(group: PayrollGroup): PeriodCycle {
  return {
    cutoffDay: group.cutoffDay,
    payDayRule: group.payDayRule,
    payDayOfMonth: group.payDayOfMonth,
  }
}

export async function findPayrollGroupById(
  id: number,
  db: Queryable = pool
): Promise<PayrollGroup | null> {
  const { rows } = await db.query<PayrollGroupRow>(`${SELECT_PAYROLL_GROUP} WHERE id = $1`, [id])
  const row = rows[0]
  return row ? rowToPayrollGroup(row) : null
}
