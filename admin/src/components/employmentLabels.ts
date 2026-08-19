import type { TerminationReason } from '@hrm/shared'

/**
 * Thai wording for employment_details' termination_reason, kept apart from the
 * stored English slugs for the reason employeeFinanceLabels.ts explains at
 * length: the database branches on a stable identifier, and rewording what HR
 * reads should not be a migration.
 *
 * Typed as `Record<TerminationReason, string>` so that adding a reason to
 * shared/ is a compile error here until it has wording — nothing else in the
 * build would catch a dropdown showing `contract_ended` to HR.
 */
export const TERMINATION_REASON_LABELS: Record<TerminationReason, string> = {
  resigned: 'ลาออก',
  terminated: 'เลิกจ้าง',
  retired: 'เกษียณอายุ',
  contract_ended: 'สิ้นสุดสัญญาจ้าง',
  deceased: 'เสียชีวิต',
  other: 'อื่นๆ',
}
