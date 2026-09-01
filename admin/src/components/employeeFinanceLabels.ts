import type { PaymentMethod, SocialSecurityType, TaxType, WageType } from '@hrm/shared'

/**
 * Thai wording for employee_finance's four enum columns.
 *
 * These values used to *be* the Thai strings, stored in the database. 044
 * moved the stored values to English slugs so the server could branch on a
 * stable identifier, which left the wording without a home — this is it.
 *
 * Typed as `Record<Union, string>` on purpose: adding a value to any of the
 * four lists in shared/ turns into a compile error here until it has wording,
 * which is the only thing standing between a new option and a dropdown that
 * shows `actual_wage_company_paid` to HR. Nothing else in the build catches
 * that — the selects render whatever string they are handed.
 */

/** Belongs to the wage-history card rather than the settings form since 046,
 *  but stays here with the rest of the finance tab's wording. */
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
  // formula: 'คิดตามสูตรคำนวณ',
}

export const TAX_TYPE_LABELS: Record<TaxType, string> = {
  none: 'ไม่คิดภาษี',
  monthly_recalc_employee_paid: 'คิดภาษี ภงด.1 ใหม่ทุกเดือน (หักจากค่าจ้าง)',
  monthly_recalc_company_paid: 'คิดภาษี ภงด.1 ใหม่ทุกเดือน (บริษัทจ่ายให้)',
  fixed_monthly: 'คิดภาษี ภงด.1 คงที่ทุกเดือน',
  percent_of_income: 'คิดภาษี ภงด.1 เป็น % ของรายได้',
}
