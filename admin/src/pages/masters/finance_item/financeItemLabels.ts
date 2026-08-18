import type { FinanceItemType } from '@hrm/shared'

/** The database stores English slugs so payroll code can branch on them; the
 *  Thai labels live here, shared by the list and the form.
 *
 *  Its own file rather than an export off FinanceItemListPage: a module that
 *  exports both a component and a constant opts out of Fast Refresh. */
export const FINANCE_ITEM_TYPE_LABELS: Record<FinanceItemType, string> = {
  income: 'รายรับ',
  deduction: 'รายจ่าย',
  tax: 'ภาษี',
}
