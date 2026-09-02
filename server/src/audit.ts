// Recording who changed what.
//
// Always call this with the same client as the change itself, inside the same
// transaction. Writing the audit entry separately would mean a change could
// commit while its record rolls back — the one failure this table exists to
// prevent.

import type pg from 'pg'
import type { AuthUser } from '@hrm/shared'

type Queryable = Pick<pg.Pool, 'query'>

/**
 * Everything worth answering "who did this?" about. A union rather than a
 * string: an action this file has not heard of is a typo, and a typo is an
 * entry nobody will ever find again.
 */
export type AuditAction =
  | 'employee.create'
  | 'employee.basic_update'
  | 'employee.employment_update'
  | 'employee.finance_update'
  | 'employee.finance_item_add'
  | 'employee.finance_item_update'
  | 'employee.shift_change'
  | 'employee.daily_shift_assign'
  | 'employee.wage_change'
  | 'employee.photo_update'
  | 'employee.photo_delete'
  | 'employee.delete'
  | 'employee.link_code_issued'
  | 'employee.line_linked'
  | 'employee.line_unlinked'
  | 'employee.import_create'
  | 'employee.import_update'
  | 'employee.export'
  | 'employee.export_template'
  | 'employee_finance.import_update'
  | 'employee_finance.export'
  | 'employee_finance.export_template'
  | 'job.create'
  | 'job.update'
  | 'department.create'
  | 'department.update'
  | 'shift.create'
  | 'shift.update'
  | 'location.create'
  | 'location.update'
  | 'attendance.import'
  | 'time_correction.create'
  | 'time_correction.supervisor_approve'
  | 'time_correction.approve'
  | 'time_correction.reject'
  | 'leave_type.create'
  | 'leave_type.update'
  | 'holiday_group.create'
  | 'holiday_group.update'
  | 'holiday.create'
  | 'holiday.update'
  | 'holiday.delete'
  | 'overtime_group.create'
  | 'overtime_group.update'
  | 'finance_item.create'
  | 'finance_item.update'
  | 'leave_balance.grant'
  | 'leave_balance.adjust'
  | 'leave_balance.bulk_grant'
  | 'leave_balance.bulk_carry_over'
  | 'leave_request.create'
  | 'leave_request.cancel'
  | 'leave_request.supervisor_approve'
  | 'leave_request.approve'
  | 'leave_request.reject'
  | 'off_site_work_request.create'
  | 'off_site_work_request.cancel'
  | 'off_site_work_request.supervisor_approve'
  | 'off_site_work_request.approve'
  | 'off_site_work_request.reject'
  | 'shift_change_request.create'
  | 'shift_change_request.update'
  | 'shift_change_request.cancel'
  | 'shift_change_request.supervisor_approve'
  | 'shift_change_request.approve'
  | 'shift_change_request.reject'
  | 'day_off_swap_request.create'
  | 'day_off_swap_request.update'
  | 'day_off_swap_request.cancel'
  | 'day_off_swap_request.supervisor_approve'
  | 'day_off_swap_request.approve'
  | 'day_off_swap_request.reject'
  | 'overtime_request.create'
  | 'overtime_request.update'
  | 'overtime_request.cancel'
  | 'overtime_request.bulk_create'
  | 'overtime_request.supervisor_approve'
  | 'overtime_request.approve'
  | 'overtime_request.reject'
  | 'comp_time_off_request.create'
  | 'comp_time_off_request.update'
  | 'comp_time_off_request.cancel'
  | 'comp_time_off_request.supervisor_approve'
  | 'comp_time_off_request.approve'
  | 'comp_time_off_request.reject'
  | 'payroll_group.create'
  | 'payroll_group.update'
  | 'payroll_period.create'
  | 'payroll_period.update'
  | 'payroll_period.void'
  | 'payroll_period.calculate'

type Entry = {
  actor: AuthUser
  action: AuditAction
  /** The row the action happened to. Null for an action with no single
   *  subject — an export of the whole employee list, say. */
  entityId: number | null
  /** Anything not worth a column. Must hold no secrets — see recordAudit. */
  detail?: Record<string, unknown>
}

export async function recordAudit(db: Queryable, entry: Entry): Promise<void> {
  const { actor, action, entityId, detail } = entry

  // The link code itself must never land here: the audit log would then hold a
  // live credential in plaintext, which is exactly what the hash in
  // employee_link_codes exists to avoid.
  const [actorId, actorLabel] =
    actor.kind === 'admin' ? [actor.oid, actor.upn] : [String(actor.employeeId), null]

  await db.query(
    `INSERT INTO audit_log (actor_kind, actor_id, actor_label, action, entity_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [actor.kind, actorId, actorLabel, action, entityId === null ? null : String(entityId), detail ?? null]
  )
}
