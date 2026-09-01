// Fills server/templates/employee-finance-template.xlsx with employee-finance
// rows, or with none — same builder serves both GET /employee-finance/export
// (real data) and GET /employee-finance/export-template (an empty sheet HR
// fills in by hand), the same split employeeExport.ts makes for the standard
// employee template.
//
// Columns 1-11 (employeeCode..overtimeGroupName) are the sheet's display-only
// identity/employment context — see employeeFinanceImportParse.ts's own
// comment — filled in here purely so HR can see which employee a row belongs
// to; employeeFinanceImportParse.ts never re-validates them. Only columns
// 12-22 (wage through taxStartMonth) carry a dropdown, one each for the four
// columns whose text actually has to match a fixed enum label on the way back
// in: wageType, paymentMethod, socialSecurityType, taxType. There is no
// master-data dropdown here the way employeeExport.ts has for department/job/
// shift — those columns on this sheet are never resolved against anything,
// so a dropdown for them would only be decoration.

import { fileURLToPath } from 'node:url'
import ExcelJS from 'exceljs'
import type {
  PaymentMethod,
  SocialSecurityType,
  TaxType,
  Title,
  EmploymentType,
  WageType,
} from '@hrm/shared'
import { parseDateOnlyUtc } from './leaveRequestQueries.js'
import {
  PAYMENT_METHOD_LABELS,
  SOCIAL_SECURITY_TYPE_LABELS,
  TAX_TYPE_LABELS,
  WAGE_TYPE_LABELS,
} from './employeeFinanceLabels.js'

const TEMPLATE_PATH = fileURLToPath(new URL('../templates/employee-finance-template.xlsx', import.meta.url))

// Row 1 is the 'EMP-FIN-IMP' template-code marker, rows 2-3 the (merged)
// header — data starts at row 4, one past employee-template.xlsx's row 3,
// because this sheet's header spans two rows (ประกันสังคม/ภาษี's sub-labels
// need the second one). See employeeFinanceImportParse.ts's FIRST_DATA_ROW.
const SAMPLE_ROW = 4

/** Same reasoning as employeeExport.ts's own constant. */
const MIN_VALIDATION_ROW_COUNT = 1000

const LISTS_SHEET = 'Lists'

/** Only SCB is supported today — see employeeFinanceImportParse.ts's
 *  SUPPORTED_BANK_NAME. Always written as-is; there is nothing to choose. */
const BANK_NAME = 'ไทยพาณิชย์ (SCB)'

/** Column numbers on employee-finance-template.xlsx's Sheet1 — fixed by the
 *  checked-in .xlsx's own header row, same trade employeeExport.ts's own
 *  COLUMNS makes: employeeFinanceImportParse.ts reads an uploaded copy of
 *  this sheet by header label instead of position, so hardcoding the columns
 *  written here is safe. */
const COLUMNS = {
  employeeCode: 1,
  title: 2,
  firstNameTh: 3,
  lastNameTh: 4,
  nickname: 5,
  hireDate: 6,
  startWorkingDate: 7,
  employmentType: 8,
  holidayGroupName: 9,
  payrollGroupName: 10,
  overtimeGroupName: 11,
  wageType: 12,
  wageAmount: 13,
  paymentMethod: 14,
  bankName: 15,
  bankBranchCode: 16,
  bankAccountNumber: 17,
  socialSecurityType: 18,
  socialSecurityAmount: 19,
  taxType: 20,
  taxAmount: 21,
  taxStartMonth: 22,
} as const

/** One row of data this workbook writes — the display columns straight off
 *  the employee record, the finance columns from employee_finance (null when
 *  the employee has no finance row yet) and the wage in effect today (null
 *  when none has ever been set — see employeeFinanceImportQueries.ts's
 *  EmployeeFinanceImportMatch, which routes/employeeFinanceExport.ts reads
 *  the same way as the import plan does). */
export type EmployeeFinanceExportRow = {
  employeeCode: string
  title: Title
  firstNameTh: string
  lastNameTh: string
  nickname: string | null
  hireDate: string
  startWorkingDate: string | null
  employmentType: EmploymentType
  holidayGroupName: string | null
  payrollGroupName: string | null
  overtimeGroupName: string | null
  wageType: WageType | null
  wageAmount: number | null
  paymentMethod: PaymentMethod | null
  bankBranchCode: string | null
  bankAccountNumber: string | null
  socialSecurityType: SocialSecurityType | null
  socialSecurityFixedAmount: number | null
  taxType: TaxType | null
  taxFixedAmount: number | null
  taxPercent: number | null
  taxStartMonth: string | null
}

function columnLetter(col: number): string {
  let letter = ''
  let n = col
  while (n > 0) {
    const rem = (n - 1) % 26
    letter = String.fromCharCode(65 + rem) + letter
    n = Math.floor((n - 1) / 26)
  }
  return letter
}

const LIST_COLUMNS: { sheet1Column: number; values: readonly string[] }[] = [
  { sheet1Column: COLUMNS.wageType, values: Object.values(WAGE_TYPE_LABELS) },
  { sheet1Column: COLUMNS.paymentMethod, values: Object.values(PAYMENT_METHOD_LABELS) },
  { sheet1Column: COLUMNS.socialSecurityType, values: Object.values(SOCIAL_SECURITY_TYPE_LABELS) },
  { sheet1Column: COLUMNS.taxType, values: Object.values(TAX_TYPE_LABELS) },
]

/** A hidden sheet holding one fixed-enum list per column, purely for Sheet1's
 *  four dropdowns to point at — same idea as employeeExport.ts's Lists
 *  sheet, but fixed wording instead of master data, so it's rebuilt fresh
 *  every export mostly for consistency with that pattern rather than any
 *  actual staleness risk. */
function addListsSheet(workbook: ExcelJS.Workbook): void {
  const sheet = workbook.addWorksheet(LISTS_SHEET, { state: 'hidden' })
  LIST_COLUMNS.forEach(({ values }, i) => {
    const col = i + 1
    values.forEach((value, r) => {
      sheet.getCell(r + 1, col).value = value
    })
  })
}

function applyDropdowns(worksheet: ExcelJS.Worksheet, validationRowCount: number): void {
  LIST_COLUMNS.forEach(({ sheet1Column, values }, i) => {
    const listColumn = i + 1
    const letter = columnLetter(listColumn)
    const ref = `'${LISTS_SHEET}'!$${letter}$1:$${letter}$${values.length}`
    for (let r = SAMPLE_ROW; r < SAMPLE_ROW + validationRowCount; r++) {
      worksheet.getCell(r, sheet1Column).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: [ref],
      }
    }
  })
}

function writeRow(worksheet: ExcelJS.Worksheet, rowNumber: number, data: EmployeeFinanceExportRow): void {
  const row = worksheet.getRow(rowNumber)
  row.getCell(COLUMNS.employeeCode).value = data.employeeCode
  row.getCell(COLUMNS.title).value = data.title
  row.getCell(COLUMNS.firstNameTh).value = data.firstNameTh
  row.getCell(COLUMNS.lastNameTh).value = data.lastNameTh
  row.getCell(COLUMNS.nickname).value = data.nickname
  row.getCell(COLUMNS.hireDate).value = parseDateOnlyUtc(data.hireDate)
  row.getCell(COLUMNS.startWorkingDate).value =
    data.startWorkingDate === null ? null : parseDateOnlyUtc(data.startWorkingDate)
  row.getCell(COLUMNS.employmentType).value = data.employmentType
  row.getCell(COLUMNS.holidayGroupName).value = data.holidayGroupName
  row.getCell(COLUMNS.payrollGroupName).value = data.payrollGroupName
  row.getCell(COLUMNS.overtimeGroupName).value = data.overtimeGroupName
  row.getCell(COLUMNS.wageType).value = data.wageType === null ? null : WAGE_TYPE_LABELS[data.wageType]
  row.getCell(COLUMNS.wageAmount).value = data.wageAmount
  row.getCell(COLUMNS.paymentMethod).value =
    data.paymentMethod === null ? null : PAYMENT_METHOD_LABELS[data.paymentMethod]
  row.getCell(COLUMNS.bankName).value = data.paymentMethod === null ? null : BANK_NAME
  row.getCell(COLUMNS.bankBranchCode).value = data.bankBranchCode
  row.getCell(COLUMNS.bankAccountNumber).value = data.bankAccountNumber
  row.getCell(COLUMNS.socialSecurityType).value =
    data.socialSecurityType === null ? null : SOCIAL_SECURITY_TYPE_LABELS[data.socialSecurityType]
  row.getCell(COLUMNS.socialSecurityAmount).value = data.socialSecurityFixedAmount
  row.getCell(COLUMNS.taxType).value = data.taxType === null ? null : TAX_TYPE_LABELS[data.taxType]
  // จำนวนภาษี: fixedAmount และ percent ไม่มีทางไม่เป็น null พร้อมกันทั้งคู่ (ดู
  // tax_*_consistency CHECK บน employee_finance) จึงเขียนคอลัมน์เดียวกันได้ปลอดภัย
  row.getCell(COLUMNS.taxAmount).value = data.taxFixedAmount ?? data.taxPercent
  row.getCell(COLUMNS.taxStartMonth).value =
    data.taxStartMonth === null ? null : parseDateOnlyUtc(data.taxStartMonth)
  row.commit()
}

/**
 * The generated workbook as a buffer, ready to send as
 * application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.
 *
 * `rows` empty produces the blank-template download: headers and fresh
 * dropdowns, no data rows. Non-empty produces the data export, with the same
 * fresh dropdowns so a re-import of the exact file that just came out still
 * validates cleanly.
 */
export async function buildEmployeeFinanceWorkbook(
  rows: EmployeeFinanceExportRow[] = []
): Promise<ExcelJS.Buffer> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(TEMPLATE_PATH)
  const worksheet = workbook.worksheets[0]
  if (!worksheet) throw new Error('employee finance template has no worksheet')

  addListsSheet(workbook)

  if (rows.length === 0) {
    // Nothing to clone the sample row into — drop it so the template doesn't
    // ship its placeholder employee as if it were real data.
    worksheet.spliceRows(SAMPLE_ROW, 1)
  } else {
    worksheet.duplicateRow(SAMPLE_ROW, rows.length - 1, true)
    rows.forEach((data, i) => writeRow(worksheet, SAMPLE_ROW + i, data))
  }

  const validationRowCount = Math.max(MIN_VALIDATION_ROW_COUNT, rows.length + 200)
  applyDropdowns(worksheet, validationRowCount)

  return workbook.xlsx.writeBuffer()
}
