// Everything a payslip PDF needs beyond what payrollEntryQueries.ts already
// returns: the employee's ID card number, department and job title (live —
// not snapshotted the way employee_name/wage_type are, since a payslip header
// isn't the kind of legal record that has to freeze if HR later corrects a
// typo in a department name), and the period's own dates. Kept separate from
// PayrollEntryWithLines rather than folding these fields into it, the same
// reasoning bucketOvertimeDay() lives next to overtimeAmount() instead of
// inside it — this is a rendering concern, not a shape every caller of
// findPayrollEntryById needs to carry.

import type pg from 'pg'
import type { PayrollEntryWithLines, PayrollPeriodStatus } from '@hrm/shared'
import { pool } from './db.js'
import { findPayrollEntryById } from './payrollEntryQueries.js'

type Queryable = Pick<pg.Pool, 'query'>

export type PayslipData = {
  entry: PayrollEntryWithLines
  idCardNumber: string | null
  departmentName: string | null
  jobTitle: string | null
  periodCode: string
  periodStart: string
  periodEnd: string
  payDate: string
  periodStatus: PayrollPeriodStatus
}

type HeaderRow = {
  id_card_number: string | null
  department_name: string | null
  job_title: string | null
  period_code: string
  period_start: string
  period_end: string
  pay_date: string
  status: string
}

/** One entry's full payslip data, or null if the entry itself doesn't exist.
 *  No status gate here — that's the caller's job, since the HR-facing route
 *  and the employee-facing route apply different rules on top of the same data. */
export async function findPayslipData(
  entryId: number,
  db: Queryable = pool
): Promise<PayslipData | null> {
  const entry = await findPayrollEntryById(entryId, db)
  if (!entry) return null

  const { rows } = await db.query<HeaderRow>(
    `SELECT e.id_card_number, md.dept_name AS department_name, mj.job_title,
            p.period_code, p.period_start, p.period_end, p.pay_date, p.status
     FROM payroll_entries pe
     JOIN employees e ON e.id = pe.employee_id
     LEFT JOIN employment_details ed ON ed.employee_id = e.id
     LEFT JOIN master_departments md ON md.id = ed.department_id
     LEFT JOIN master_jobs mj ON mj.id = ed.job_id
     JOIN payroll_periods p ON p.id = pe.payroll_period_id
     WHERE pe.id = $1`,
    [entryId]
  )
  const header = rows[0]
  // Not expected in practice (the entry we just read has to have both an
  // employee and a period row, both ON DELETE RESTRICT) — only reachable if
  // the entry was deleted between the two queries, which nothing in this
  // codebase does outside calculatePayrollEntries's own delete-then-reinsert.
  if (!header) return null

  return {
    entry,
    idCardNumber: header.id_card_number,
    departmentName: header.department_name,
    jobTitle: header.job_title,
    periodCode: header.period_code,
    periodStart: header.period_start,
    periodEnd: header.period_end,
    payDate: header.pay_date,
    periodStatus: header.status as PayrollPeriodStatus,
  }
}

/** Period statuses an employee may see their own slip for. Not 'closed' only,
 *  as the plan's original Phase 7 wording assumed — paid/closed don't exist
 *  yet (Phase 8's job), and HR has already signed off by 'approved'. Tighten
 *  this to ['closed'] once Phase 8 makes that status reachable. */
const EMPLOYEE_VISIBLE_STATUSES: readonly PayrollPeriodStatus[] = ['approved', 'paid', 'closed']

export type PayrollSlipSummaryRow = {
  entry_id: string
  payroll_period_id: string
  period_code: string
  pay_date: string
  net_pay: string
}

/** This employee's own slips, newest period first, restricted to periods
 *  they're allowed to see. Used by both the LIFF list screen and (indirectly)
 *  as the existence+visibility check before generating one PDF. */
export async function listMyPayrollSlips(
  employeeId: number,
  db: Queryable = pool
): Promise<PayrollSlipSummaryRow[]> {
  const { rows } = await db.query<PayrollSlipSummaryRow>(
    `SELECT pe.id AS entry_id, pe.payroll_period_id, p.period_code, p.pay_date, pe.net_pay
     FROM payroll_entries pe
     JOIN payroll_periods p ON p.id = pe.payroll_period_id
     WHERE pe.employee_id = $1 AND p.status = ANY($2::text[])
     ORDER BY p.period_start DESC`,
    [employeeId, EMPLOYEE_VISIBLE_STATUSES]
  )
  return rows
}

/** The entry id for one employee's slip in one period, only if that period's
 *  status is currently visible to employees. Null either way an unauthorized
 *  request should see — no entry, and an entry the employee isn't allowed to
 *  see yet — on purpose: the 404 this backs must not distinguish the two. */
export async function findMyVisibleEntryId(
  employeeId: number,
  periodId: number,
  db: Queryable = pool
): Promise<number | null> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT pe.id
     FROM payroll_entries pe
     JOIN payroll_periods p ON p.id = pe.payroll_period_id
     WHERE pe.employee_id = $1 AND pe.payroll_period_id = $2 AND p.status = ANY($3::text[])`,
    [employeeId, periodId, EMPLOYEE_VISIBLE_STATUSES]
  )
  const row = rows[0]
  return row ? Number(row.id) : null
}
