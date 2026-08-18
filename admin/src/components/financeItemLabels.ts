import type { FinanceItemType } from '@hrm/shared'

/**
 * Thai wording for master_finance_items.item_type, and the badge tone that
 * goes with it.
 *
 * Lives next to employeeFinanceLabels.ts rather than under pages/, because
 * both the Master screens and the employee finance tab render these — and a
 * component reaching into pages/ for a constant has the dependency backwards.
 *
 * Typed as `Record<FinanceItemType, …>` on purpose: adding a fourth type in
 * shared/ becomes a compile error here until it has wording and a colour,
 * which is the only thing standing between a new type and a badge that shows
 * `allowance` to HR.
 */

export const FINANCE_ITEM_TYPE_LABELS: Record<FinanceItemType, string> = {
  income: 'รายรับ',
  deduction: 'รายจ่าย',
  tax: 'ภาษี',
}

/** Green adds to the payslip, amber takes off it, navy is a tax line — not
 *  red, which on this palette means "something went wrong". */
export const FINANCE_ITEM_TYPE_TONE: Record<FinanceItemType, 'active' | 'pending' | 'role'> = {
  income: 'active',
  deduction: 'pending',
  tax: 'role',
}
