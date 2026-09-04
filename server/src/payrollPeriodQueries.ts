// Reading payroll periods out of payroll_periods, joined to the group they
// belong to so a screen can name it without a second request.
//
// Writes live in routes/payrollPeriods.ts rather than here: every one of them
// is a status decision that needs the caller's identity and a transaction, and
// splitting "check the transition" from "write it" across two files is how the
// two end up disagreeing.

import type pg from 'pg'
import type { PayrollPeriod, PayrollPeriodStatus } from '@hrm/shared'
import { pool } from './db.js'

type Queryable = Pick<pg.Pool, 'query'>

export type PayrollPeriodRow = {
  id: string // bigint: pg hands these back as strings to avoid precision loss
  payroll_group_id: string
  payroll_group_name: string
  period_code: string
  period_start: string // 'YYYY-MM-DD' — see the DATE type parser in db.ts
  period_end: string
  pay_date: string
  status: string
  note: string | null
  closed_at: string | null
  voided_at: string | null
  void_reason: string | null
  created_at: string
  net_total: string
}

export const SELECT_PAYROLL_PERIOD = `
  SELECT p.id, p.payroll_group_id, g.group_name AS payroll_group_name,
         p.period_code, p.period_start, p.period_end, p.pay_date,
         p.status, p.note, p.closed_at, p.voided_at, p.void_reason, p.created_at,
         (SELECT COALESCE(SUM(e.net_pay), 0) FROM payroll_entries e
          WHERE e.payroll_period_id = p.id) AS net_total
  FROM payroll_periods p
  JOIN master_payroll_groups g ON g.id = p.payroll_group_id
`

export function rowToPayrollPeriod(row: PayrollPeriodRow): PayrollPeriod {
  return {
    id: Number(row.id),
    payrollGroupId: Number(row.payroll_group_id),
    payrollGroupName: row.payroll_group_name,
    periodCode: row.period_code,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    payDate: row.pay_date,
    status: row.status as PayrollPeriodStatus,
    note: row.note,
    closedAt: row.closed_at === null ? null : new Date(row.closed_at).toISOString(),
    voidedAt: row.voided_at === null ? null : new Date(row.voided_at).toISOString(),
    voidReason: row.void_reason,
    createdAt: new Date(row.created_at).toISOString(),
    netTotal: Number(row.net_total),
  }
}

export async function findPayrollPeriodById(
  id: number,
  db: Queryable = pool
): Promise<PayrollPeriod | null> {
  const { rows } = await db.query<PayrollPeriodRow>(`${SELECT_PAYROLL_PERIOD} WHERE p.id = $1`, [
    id,
  ])
  const row = rows[0]
  return row ? rowToPayrollPeriod(row) : null
}

/** Newest period first, optionally narrowed to one group or one status —
 *  the two filters the period list screen offers. */
export async function listPayrollPeriods(
  filter: { groupId?: number; status?: PayrollPeriodStatus },
  db: Queryable = pool
): Promise<PayrollPeriod[]> {
  const conditions: string[] = []
  const params: unknown[] = []

  if (filter.groupId !== undefined) {
    params.push(filter.groupId)
    conditions.push(`p.payroll_group_id = $${params.length}`)
  }
  if (filter.status !== undefined) {
    params.push(filter.status)
    conditions.push(`p.status = $${params.length}`)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const { rows } = await db.query<PayrollPeriodRow>(
    `${SELECT_PAYROLL_PERIOD} ${where} ORDER BY p.period_start DESC, p.id DESC`,
    params
  )
  return rows.map(rowToPayrollPeriod)
}
