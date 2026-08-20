import type { PayDayRule, PayrollEntryReviewReasonCode, PayrollPeriodStatus } from '@hrm/shared'

/** English slugs live in the database; Thai is what people read. Same split as
 *  employeeFinanceLabels.ts and employmentLabels.ts. */
export const PAY_DAY_RULE_LABELS: Record<PayDayRule, string> = {
  last_day_of_month: 'วันสุดท้ายของเดือน',
  fixed_day: 'วันที่กำหนดเอง',
}

export const PAYROLL_PERIOD_STATUS_LABELS: Record<PayrollPeriodStatus, string> = {
  draft: 'ร่าง',
  calculating: 'กำลังคำนวณ',
  review: 'รอตรวจสอบ',
  approved: 'อนุมัติแล้ว',
  paid: 'จ่ายแล้ว',
  closed: 'ปิดงวดแล้ว',
  voided: 'ยกเลิก',
}

/** Why calculatePayrollEntries flagged an entry — shown on the payslip so
 *  "ต้องตรวจสอบ" is followed by an actual explanation instead of a bare badge. */
export const PAYROLL_ENTRY_REVIEW_REASON_LABELS: Record<PayrollEntryReviewReasonCode, string> = {
  incomplete_day: 'ลงเวลาไม่ครบ (มีแค่เข้าหรือออกอย่างใดอย่างหนึ่ง)',
  unscheduled_work_day: 'มาทำงานในวันที่ไม่มีตารางกะ',
  missing_wage: 'ไม่พบอัตราค่าจ้างของวันนั้น',
  unpriceable_deduction: 'มีนาทีที่ควรหักสาย/ออกก่อน แต่หาชั่วโมงทำงานของกะไม่ได้',
  mixed_wage_type: 'ประเภทค่าจ้าง (รายเดือน/รายวัน) เปลี่ยนกลางงวด ระบบจึงยังไม่คำนวณให้',
}

/** Thai date, e.g. "25 ส.ค. 2569" — the same rendering DatePicker shows, so a
 *  saved date and the picker that produced it read the same way. */
export function formatThaiDate(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00`).toLocaleDateString('th-TH-u-ca-buddhist', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

/** Inclusive day count of a period window. Shown next to the dates because a
 *  26th-to-25th cycle is 28, 30 or 31 days depending on the month, and a
 *  reader who assumes 30 will not notice the difference until it is money. */
export function windowDayCount(periodStart: string, periodEnd: string): number {
  const start = Date.parse(`${periodStart}T00:00:00Z`)
  const end = Date.parse(`${periodEnd}T00:00:00Z`)
  return Math.round((end - start) / 86_400_000) + 1
}
