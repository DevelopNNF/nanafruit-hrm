// The employee-finance import/export sheet shows wage type, payment method,
// social security type and tax type in Thai, but employee_finance/
// employee_wage_assignments store the English slugs from
// 044_englishify_employee_finance_enums.sql. One small table per enum so the
// export and import parser can never drift apart on which Thai word means
// which slug — same idea as employeeGenderLabels.ts, and the same wording
// admin/src/components/employeeFinanceLabels.ts uses on screen (kept as a
// separate copy rather than a shared import: server code doesn't reach into
// admin/, same as every other *Labels.ts pair in this codebase).

import type { PaymentMethod, SocialSecurityType, TaxType, WageType } from '@hrm/shared'

export const WAGE_TYPE_LABELS: Record<WageType, string> = {
  monthly: 'รายเดือน',
  daily: 'รายวัน',
}

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'เงินสด',
  transfer: 'โอน',
  cheque: 'เช็ค',
}

export const SOCIAL_SECURITY_TYPE_LABELS: Record<SocialSecurityType, string> = {
  none: 'ไม่คิดประกันสังคม',
  actual_wage_employee_paid: 'คิดตามฐานเงินเดือนจริงที่ได้รับ (หักจากค่าจ้าง)',
  actual_wage_company_paid: 'คิดตามฐานเงินเดือนจริงที่ได้รับ (บริษัทจ่ายให้)',
  section_39: 'คิดตามมาตรา 39',
  fixed_monthly: 'คิดคงที่ทุกเดือน',
}

export const TAX_TYPE_LABELS: Record<TaxType, string> = {
  none: 'ไม่คิดภาษี',
  monthly_recalc_employee_paid: 'คิดภาษี ภงด.1 ใหม่ทุกเดือน (หักจากค่าจ้าง)',
  monthly_recalc_company_paid: 'คิดภาษี ภงด.1 ใหม่ทุกเดือน (บริษัทจ่ายให้)',
  fixed_monthly: 'คิดภาษี ภงด.1 คงที่ทุกเดือน',
  percent_of_income: 'คิดภาษี ภงด.1 เป็น % ของรายได้',
}

function fromLabel<T extends string>(labels: Record<T, string>, label: string): T | null {
  const entry = (Object.entries(labels) as [T, string][]).find(([, text]) => text === label)
  return entry ? entry[0] : null
}

export function wageTypeFromLabel(label: string): WageType | null {
  return fromLabel(WAGE_TYPE_LABELS, label)
}

export function paymentMethodFromLabel(label: string): PaymentMethod | null {
  return fromLabel(PAYMENT_METHOD_LABELS, label)
}

export function socialSecurityTypeFromLabel(label: string): SocialSecurityType | null {
  return fromLabel(SOCIAL_SECURITY_TYPE_LABELS, label)
}

export function taxTypeFromLabel(label: string): TaxType | null {
  return fromLabel(TAX_TYPE_LABELS, label)
}
