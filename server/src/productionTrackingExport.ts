// Builds the .txt file HR hands to the Production Tracking System: one line
// per active employee, `รหัสพนักงาน,ชื่อ-นามสกุล,ประเภทการจ้าง,ค่าจ้าง` — that
// system's own import format, not one of ours, hence plain CSV-in-a-.txt
// rather than the xlsx templates employeeExport.ts/employeeFinanceExport.ts
// produce.

import type { EmploymentType } from '@hrm/shared'

/** Production Tracking's own labels for each employment type — distinct from
 *  the EMPLOYMENT_TYPES values themselves, which are this system's wording. */
const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
  'ประจำ (รายเดือน)': 'พนักงานรายเดือน',
  'ประจำ (รายวัน)': 'พนักงานรายวันประจำ',
  สัญญาจ้าง: 'พนักงานชุดเหมา',
  ชั่วคราว: 'พนักงานรายวันชั่วคราว',
}

export type ProductionTrackingExportRow = {
  employeeCode: string
  firstNameTh: string
  lastNameTh: string
  employmentType: EmploymentType
  /** The wage in effect today, or null when the employee has none set yet —
   *  written out as 0 rather than left blank, since the target system reads
   *  this column as a number. */
  wageAmount: number | null
}

function formatWage(wageAmount: number | null): string {
  return wageAmount === null ? '0' : String(wageAmount)
}

/** One line per row, CRLF-free (`\n` only) — plain text, UTF-8, no header. */
export function buildProductionTrackingFile(rows: ProductionTrackingExportRow[]): string {
  return rows
    .map((row) =>
      [
        row.employeeCode,
        `${row.firstNameTh} ${row.lastNameTh}`,
        EMPLOYMENT_TYPE_LABELS[row.employmentType],
        formatWage(row.wageAmount),
      ].join(',')
    )
    .join('\n')
}
