// Reading an uploaded copy of server/templates/employee-finance-template.xlsx
// into rows of plain field values. Pure: bytes in, rows out, no database —
// matching a row's รหัสพนักงาน against an actual employee needs the database
// and lives in routes/employeeFinanceImport.ts instead, same split as
// employeeImportParse.ts (bytes) vs routes/employeeImport.ts (needs a
// connection).
//
// The header row (row 2/3, merged) is read by name, not position — same
// reasoning as employeeImportParse.ts. Row 1 carries the plain-text template
// code 'EMP-FIN-IMP' in cell A1; a file with anything else there is rejected
// outright (unlike employeeImportParse.ts's template detection, there is no
// second template to fall back to). Data starts at row 4.
//
// Columns 2-11 (คำนำหน้า..กลุ่ม OT) are display-only context so HR can see
// which employee a row belongs to while editing — this module reads them as
// plain text for the preview screen and never validates or resolves them.
// รหัสพนักงาน (column 1) is the only column from that group actually used to
// match against the database.

import ExcelJS from 'exceljs'
import type { PaymentMethod, SocialSecurityType, TaxType, WageType } from '@hrm/shared'
import { PAYMENT_METHODS, SOCIAL_SECURITY_TYPES, TAX_TYPES, WAGE_TYPES } from '@hrm/shared'
import {
  paymentMethodFromLabel,
  socialSecurityTypeFromLabel,
  taxTypeFromLabel,
  wageTypeFromLabel,
} from './employeeFinanceLabels.js'

const TEMPLATE_CODE = 'EMP-FIN-IMP'
const TEMPLATE_CODE_CELL_ROW = 1
const TEMPLATE_CODE_CELL_COLUMN = 1
const HEADER_ROW = 2
const SUB_HEADER_ROW = 3
const FIRST_DATA_ROW = 4

/** The one value of each enum that requires its companion amount field —
 *  mirrors SOCIAL_SECURITY_FIXED/TAX_FIXED/TAX_PERCENT in
 *  routes/employees.ts's parseEmployeeFinanceFields. */
const SOCIAL_SECURITY_FIXED: SocialSecurityType = 'fixed_monthly'
const TAX_FIXED: TaxType = 'fixed_monthly'
const TAX_PERCENT: TaxType = 'percent_of_income'

/** Only SCB is supported today — see employee_finance's bank_name column and
 *  EmployeeFinanceTab.tsx's DEFAULT_BANK_NAME. ธนาคาร is a display/sanity
 *  column on this sheet, not a writable one: a row naming any other bank is
 *  rejected rather than silently ignored, so a genuine change of bank
 *  doesn't quietly fail to happen. */
const SUPPORTED_BANK_NAME = 'ไทยพาณิชย์ (SCB)'

/** Thai wording for the one social-security type that needs its companion
 *  amount column filled in — used only in that error message. */
const SOCIAL_SECURITY_TYPE_LABEL_FIXED = 'คิดคงที่ทุกเดือน'

type Column =
  | 'employeeCode'
  | 'title'
  | 'firstNameTh'
  | 'lastNameTh'
  | 'nickname'
  | 'hireDate'
  | 'startWorkingDate'
  | 'employmentType'
  | 'holidayGroupName'
  | 'payrollGroupName'
  | 'overtimeGroupName'
  | 'wageType'
  | 'wageAmount'
  | 'paymentMethod'
  | 'bankName'
  | 'bankBranchCode'
  | 'bankAccountNumber'
  | 'socialSecurityType'
  | 'socialSecurityAmount'
  | 'taxType'
  | 'taxAmount'
  | 'taxStartMonth'

/** Header label (asterisk stripped) -> column. Mirrors
 *  employeeFinanceExport.ts's HEADER_LABELS exactly. รหัสพนักงาน is the only
 *  label shared with employee-template.xlsx that this sheet's header row
 *  also carries verbatim; the rest of columns 2-11 reuse those same labels
 *  too, purely so employeeFinanceExport.ts can fill them for display. */
const HEADER_COLUMNS: Record<string, Column> = {
  รหัสพนักงาน: 'employeeCode',
  คำนำหน้า: 'title',
  ชื่อ: 'firstNameTh',
  นามสกุล: 'lastNameTh',
  ชื่อเล่น: 'nickname',
  วันที่จ้าง: 'hireDate',
  วันที่เริ่มงาน: 'startWorkingDate',
  ประเภทการจ้าง: 'employmentType',
  กลุ่มวันหยุด: 'holidayGroupName',
  กลุ่มเงินเดือน: 'payrollGroupName',
  'กลุ่ม OT': 'overtimeGroupName',
  ประเภทค่าจ้าง: 'wageType',
  ค่าจ้าง: 'wageAmount',
  ช่องทางการจ่ายเงิน: 'paymentMethod',
  ธนาคาร: 'bankName',
  รหัสสาขา: 'bankBranchCode',
  เลขที่บัญชี: 'bankAccountNumber',
  // ประกันสังคม (2 columns) and ภาษี (3 columns, including เริ่มคำนวณภาษี)
  // each share one merged row-2 super-label across their whole group —
  // ExcelJS reports that same text for every column under the merge, so
  // resolveColumns disambiguates those columns by row 3's own sub-label
  // instead (see GROUPED_SUB_COLUMNS below), never through this map.
}

/** row-2 super-label -> (row-3 sub-label -> column), for the two column
 *  groups whose row-2 header cell is one merged label shared across several
 *  columns (ประกันสังคม: 2 columns, ภาษี: 3, the last being เริ่มคำนวณภาษี —
 *  see the merge ranges on server/templates/employee-finance-template.xlsx).
 *  Every other column's row-3 cell just repeats its row-2 label (a vertical
 *  merge, one column tall), so only these two groups need this. */
const GROUPED_SUB_COLUMNS: Record<string, Record<string, Column>> = {
  ประกันสังคม: { ประเภท: 'socialSecurityType', จำนวน: 'socialSecurityAmount' },
  ภาษี: { ประเภท: 'taxType', จำนวน: 'taxAmount', เริ่มคำนวณภาษี: 'taxStartMonth' },
}

/** Every column this sheet's rows are read from — used to detect a template
 *  whose header row doesn't match at all (an unrelated file, or a version
 *  predating a column this parser expects). Unlike employeeImportParse.ts,
 *  there is no optional/required split at the structural level: every column
 *  must exist, since there is no older template version to stay compatible
 *  with yet. */
const REQUIRED_COLUMNS: readonly Column[] = [
  'employeeCode',
  'wageType',
  'wageAmount',
  'paymentMethod',
  'bankName',
  'bankBranchCode',
  'bankAccountNumber',
  'socialSecurityType',
  'socialSecurityAmount',
  'taxType',
  'taxAmount',
  'taxStartMonth',
]

const COLUMN_LABELS: Record<Column, string> = {
  employeeCode: 'รหัสพนักงาน',
  title: 'คำนำหน้า',
  firstNameTh: 'ชื่อ',
  lastNameTh: 'นามสกุล',
  nickname: 'ชื่อเล่น',
  hireDate: 'วันที่จ้าง',
  startWorkingDate: 'วันที่เริ่มงาน',
  employmentType: 'ประเภทการจ้าง',
  holidayGroupName: 'กลุ่มวันหยุด',
  payrollGroupName: 'กลุ่มเงินเดือน',
  overtimeGroupName: 'กลุ่ม OT',
  wageType: 'ประเภทค่าจ้าง',
  wageAmount: 'ค่าจ้าง',
  paymentMethod: 'ช่องทางการจ่ายเงิน',
  bankName: 'ธนาคาร',
  bankBranchCode: 'รหัสสาขา',
  bankAccountNumber: 'เลขที่บัญชี',
  socialSecurityType: 'ประกันสังคม (ประเภท)',
  socialSecurityAmount: 'ประกันสังคม (จำนวน)',
  taxType: 'ภาษี (ประเภท)',
  taxAmount: 'ภาษี (จำนวน)',
  taxStartMonth: 'เริ่มคำนวณภาษี',
}

export type ParsedFinanceImportRow = {
  /** 1-based row number in the sheet, so a warning can point HR at it. */
  rowNumber: number
  /** The only column from 1-11 this module actually uses to match against
   *  the database. */
  employeeCode: string | null
  /** title + firstNameTh + lastNameTh as read from the sheet, for display
   *  only — never validated or compared against the database. */
  displayName: string | null
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
  /** 'YYYY-MM-01', or null if the cell was blank. */
  taxStartMonth: string | null
  /** Format/required-field/consistency problems this module alone can
   *  already see. A row with any of these can never become 'update' — the
   *  route skips straight past database resolution for it. */
  errors: string[]
}

export type ParseEmployeeFinanceImportResult =
  | { ok: true; rows: ParsedFinanceImportRow[] }
  | { ok: false; message: string }

type Cell = ExcelJS.CellValue

function cellText(value: Cell): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') {
    if (value instanceof Date) return toDateString(value)
    if ('richText' in value) return value.richText.map((run) => run.text).join('')
    if ('text' in value && typeof value.text === 'string') return value.text
    return ''
  }
  return String(value).trim()
}

/** Local calendar date of a Date as 'YYYY-MM-DD' — ExcelJS hands back
 *  UTC-midnight Dates for date-formatted cells, same reasoning as
 *  employeeImportParse.ts's toDateString. */
function toDateString(value: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}/

function dateText(value: Cell): string {
  const text = cellText(value)
  const match = DATE_RE.exec(text)
  return match ? match[0] : text
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number) as [number, number, number]
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  )
}

function isRowEmpty(row: ExcelJS.Row): boolean {
  let empty = true
  row.eachCell({ includeEmpty: false }, (cell) => {
    if (cellText(cell.value) !== '') empty = false
  })
  return empty
}

/** Cell A1's text, trimmed. */
function readTemplateCode(worksheet: ExcelJS.Worksheet): string {
  const cell = worksheet.getRow(TEMPLATE_CODE_CELL_ROW).getCell(TEMPLATE_CODE_CELL_COLUMN)
  return cellText(cell.value)
}

/** Builds the column -> field map from the header rows, by label rather than
 *  position, same reasoning as employeeImportParse.ts's resolveColumns.
 *  ประกันสังคม/ภาษี's row-2 cell reads the same merged super-label across
 *  every column in the group (see GROUPED_SUB_COLUMNS' own comment), so those
 *  columns are disambiguated by row 3's sub-label instead of row 2's. */
function resolveColumns(
  headerRow: ExcelJS.Row,
  subHeaderRow: ExcelJS.Row
): { ok: true; columns: Map<Column, number> } | { ok: false; message: string } {
  const columns = new Map<Column, number>()

  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const label = cellText(cell.value).replace(/\*\s*$/, '').trim()
    const subLabels = GROUPED_SUB_COLUMNS[label]
    if (subLabels) {
      const subLabel = cellText(subHeaderRow.getCell(colNumber).value).replace(/\*\s*$/, '').trim()
      const field = subLabels[subLabel]
      if (field) columns.set(field, colNumber)
      return
    }
    const field = HEADER_COLUMNS[label]
    if (field) columns.set(field, colNumber)
  })

  const missing = REQUIRED_COLUMNS.filter((field) => !columns.has(field))
  if (missing.length > 0) {
    const labels = missing.map((field) => COLUMN_LABELS[field]).join(', ')
    return {
      ok: false,
      message: `เทมเพลตไม่ถูกต้อง: ไม่พบคอลัมน์ ${labels} ในแถวที่ ${HEADER_ROW} — กรุณาใช้เทมเพลตล่าสุด`,
    }
  }
  return { ok: true, columns }
}

function textOf(row: ExcelJS.Row, columns: Map<Column, number>, field: Column): string {
  const col = columns.get(field)
  if (col === undefined) return ''
  return field === 'taxStartMonth' ? dateText(row.getCell(col).value) : cellText(row.getCell(col).value)
}

function requiredText(text: string, field: Column, errors: string[]): string | null {
  if (text !== '') return text
  errors.push(`ไม่ระบุ${COLUMN_LABELS[field]}`)
  return null
}

function optionalText(text: string): string | null {
  return text === '' ? null : text
}

/** A positive number, or null if blank — pushes to `errors` when non-blank
 *  text doesn't parse. A blank cell is never an error here: ค่าจ้าง is always
 *  optional, and the two amount columns' required-ness depends on their own
 *  type column, checked separately by the caller. */
function optionalPositiveNumber(text: string, field: Column, errors: string[]): number | null {
  if (text === '') return null
  const value = Number(text)
  if (!Number.isFinite(value) || value <= 0) {
    errors.push(`${COLUMN_LABELS[field]}ไม่ถูกต้อง: "${text}" (ต้องเป็นตัวเลขมากกว่า 0)`)
    return null
  }
  return value
}

function parseRow(row: ExcelJS.Row, columns: Map<Column, number>): ParsedFinanceImportRow {
  const errors: string[] = []
  const get = (field: Column) => textOf(row, columns, field)

  const employeeCode = requiredText(get('employeeCode'), 'employeeCode', errors)

  const titleText = optionalText(get('title'))
  const firstNameText = optionalText(get('firstNameTh'))
  const lastNameText = optionalText(get('lastNameTh'))
  const displayName =
    firstNameText === null && lastNameText === null
      ? null
      : `${titleText ?? ''}${firstNameText ?? ''} ${lastNameText ?? ''}`.trim()

  // ประเภทค่าจ้าง/ค่าจ้าง เป็นคอลัมน์บังคับทั้งคู่ (เทมเพลตใส่ * ไว้ที่ทั้งสอง) — ทุกแถวต้องระบุ
  // ค่าจ้างปัจจุบันเสมอ ไม่ใช่ค่า optional ที่ปล่อยว่างแล้วไปตั้งทีหลังผ่านแท็บการเงินได้อีกต่อไป
  const wageAmount = optionalPositiveNumber(get('wageAmount'), 'wageAmount', errors)
  if (wageAmount === null && get('wageAmount') === '') {
    errors.push(`ไม่ระบุ${COLUMN_LABELS.wageAmount}`)
  }
  const wageTypeLabel = requiredText(get('wageType'), 'wageType', errors)
  let wageType: WageType | null = null
  if (wageTypeLabel !== null) {
    wageType = wageTypeFromLabel(wageTypeLabel)
    if (wageType === null) {
      errors.push(
        `ประเภทค่าจ้างไม่ถูกต้อง: "${wageTypeLabel}" (ต้องเป็น ${WAGE_TYPES.join(' / ')})`
      )
    }
  }

  const paymentMethodLabel = requiredText(get('paymentMethod'), 'paymentMethod', errors)
  let paymentMethod: PaymentMethod | null = null
  if (paymentMethodLabel !== null) {
    paymentMethod = paymentMethodFromLabel(paymentMethodLabel)
    if (paymentMethod === null) {
      errors.push(
        `ช่องทางการจ่ายเงินไม่ถูกต้อง: "${paymentMethodLabel}" (ต้องเป็น ${PAYMENT_METHODS.join(' / ')})`
      )
    }
  }

  const bankNameText = get('bankName')
  if (bankNameText !== '' && bankNameText !== SUPPORTED_BANK_NAME) {
    errors.push(`ธนาคารไม่ถูกต้อง: "${bankNameText}" (ระบบรองรับเฉพาะ "${SUPPORTED_BANK_NAME}")`)
  }

  const bankBranchCode = optionalText(get('bankBranchCode'))
  const bankAccountNumberText = get('bankAccountNumber')
  // เงินสดไม่ต้องมีเลขบัญชี — เช่นเดียวกับ parseEmployeeFinanceFields ใน routes/employees.ts
  const isCashPayment = paymentMethod === 'cash'
  const bankAccountNumber =
    bankAccountNumberText === ''
      ? isCashPayment
        ? null
        : requiredText(bankAccountNumberText, 'bankAccountNumber', errors)
      : bankAccountNumberText

  const socialSecurityTypeLabel = requiredText(get('socialSecurityType'), 'socialSecurityType', errors)
  let socialSecurityType: SocialSecurityType | null = null
  if (socialSecurityTypeLabel !== null) {
    socialSecurityType = socialSecurityTypeFromLabel(socialSecurityTypeLabel)
    if (socialSecurityType === null) {
      errors.push(
        `ประเภทประกันสังคมไม่ถูกต้อง: "${socialSecurityTypeLabel}" (ต้องเป็น ${SOCIAL_SECURITY_TYPES.join(' / ')})`
      )
    }
  }
  const socialSecurityAmountText = get('socialSecurityAmount')
  const socialSecurityFixedAmount = optionalPositiveNumber(
    socialSecurityAmountText,
    'socialSecurityAmount',
    errors
  )
  const socialSecurityNeedsFixedAmount = socialSecurityType === SOCIAL_SECURITY_FIXED
  if (socialSecurityNeedsFixedAmount && socialSecurityFixedAmount === null) {
    errors.push(`ต้องระบุจำนวนประกันสังคมเมื่อประเภทเป็น "${SOCIAL_SECURITY_TYPE_LABEL_FIXED}"`)
  }
  if (!socialSecurityNeedsFixedAmount && socialSecurityFixedAmount !== null) {
    errors.push(`ต้องเว้นว่างจำนวนประกันสังคม เมื่อประเภทไม่ใช่ "${SOCIAL_SECURITY_TYPE_LABEL_FIXED}"`)
  }

  const taxTypeLabel = requiredText(get('taxType'), 'taxType', errors)
  let taxType: TaxType | null = null
  if (taxTypeLabel !== null) {
    taxType = taxTypeFromLabel(taxTypeLabel)
    if (taxType === null) {
      errors.push(
        `ประเภทภาษีไม่ถูกต้อง: "${taxTypeLabel}" (ต้องเป็น ${TAX_TYPES.join(' / ')})`
      )
    }
  }
  const taxAmountText = get('taxAmount')
  const taxAmountNumber = optionalPositiveNumber(taxAmountText, 'taxAmount', errors)
  const taxNeedsFixedAmount = taxType === TAX_FIXED
  const taxNeedsPercent = taxType === TAX_PERCENT
  const taxFixedAmount = taxNeedsFixedAmount ? taxAmountNumber : null
  const taxPercent = taxNeedsPercent ? taxAmountNumber : null
  if ((taxNeedsFixedAmount || taxNeedsPercent) && taxAmountNumber === null) {
    errors.push(`ต้องระบุจำนวนภาษีเมื่อประเภทเป็น "${taxTypeLabel}"`)
  }
  if (!taxNeedsFixedAmount && !taxNeedsPercent && taxAmountNumber !== null) {
    errors.push('ต้องเว้นว่างจำนวนภาษี เมื่อประเภทไม่ใช่แบบคงที่หรือแบบ % ของรายได้')
  }
  if (taxPercent !== null && taxPercent > 100) {
    errors.push(`จำนวนภาษีเป็น % ต้องไม่เกิน 100: "${taxAmountText}"`)
  }

  const taxStartMonthText = get('taxStartMonth')
  let taxStartMonth: string | null = null
  if (taxStartMonthText !== '') {
    if (isCalendarDate(taxStartMonthText) && taxStartMonthText.endsWith('-01')) {
      taxStartMonth = taxStartMonthText
    } else {
      errors.push(`เริ่มคำนวณภาษีไม่ถูกต้อง: "${taxStartMonthText}" (ต้องเป็นวันที่ 1 ของเดือน YYYY-MM-01)`)
    }
  }

  return {
    rowNumber: row.number,
    employeeCode,
    displayName,
    wageType,
    wageAmount,
    paymentMethod,
    bankBranchCode,
    bankAccountNumber,
    socialSecurityType,
    socialSecurityFixedAmount,
    taxType,
    taxFixedAmount,
    taxPercent,
    taxStartMonth,
    errors,
  }
}

export async function parseEmployeeFinanceImport(file: Buffer): Promise<ParseEmployeeFinanceImportResult> {
  const workbook = new ExcelJS.Workbook()
  try {
    // See employeeImportParse.ts's own comment on this cast — exceljs's .d.ts
    // resolves Buffer against a different @types/node copy than this
    // package's.
    await workbook.xlsx.load(file as unknown as Parameters<typeof workbook.xlsx.load>[0])
  } catch (err) {
    return {
      ok: false,
      message: `อ่านไฟล์ Excel ไม่สำเร็จ: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  const worksheet = workbook.worksheets[0]
  if (!worksheet) return { ok: false, message: 'ไฟล์ไม่มีชีตข้อมูล' }

  const code = readTemplateCode(worksheet)
  if (code !== TEMPLATE_CODE) {
    return {
      ok: false,
      message: `ไฟล์นี้ไม่ใช่เทมเพลตข้อมูลการเงินพนักงาน (${TEMPLATE_CODE}) — กรุณาดาวน์โหลดเทมเพลตล่าสุด`,
    }
  }

  const headerRow = worksheet.getRow(HEADER_ROW)
  const subHeaderRow = worksheet.getRow(SUB_HEADER_ROW)
  const columns = resolveColumns(headerRow, subHeaderRow)
  if (!columns.ok) return { ok: false, message: columns.message }

  const rows: ParsedFinanceImportRow[] = []
  for (let r = FIRST_DATA_ROW; r <= worksheet.rowCount; r++) {
    const row = worksheet.getRow(r)
    if (isRowEmpty(row)) continue
    rows.push(parseRow(row, columns.columns))
  }

  if (rows.length === 0) {
    return {
      ok: false,
      message: `ไม่พบข้อมูลพนักงานในไฟล์ (ไม่มีข้อมูลตั้งแต่แถวที่ ${FIRST_DATA_ROW} เป็นต้นไป)`,
    }
  }

  return { ok: true, rows }
}
