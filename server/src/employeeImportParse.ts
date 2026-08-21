// Reading an uploaded copy of server/templates/employee-template.xlsx into
// rows of plain field values. Pure: bytes in, rows out, no database — matching
// values against departments/jobs/shifts/holiday and payroll groups needs the
// database and lives in routes/employeeImport.ts instead, same split as
// attendanceImportParse.ts (bytes) vs attendanceImportClassify.ts (needs
// shift windows) vs the route (needs a connection).
//
// The header row (row 2) is read by name, not position: employeeExport.ts
// writes the same labels this file's HEADER_FIELDS maps back from, but HR is
// free to reorder columns in their own copy without breaking the read. Row 1
// is a title/spacer, data starts at row 3, same layout attendanceReportExport
// and employeeExport share.

import ExcelJS from 'exceljs'
import {
  EMPLOYMENT_TYPES,
  FINGERPRINT_CODE_MAX_LENGTH,
  TITLES,
  WORK_LOCATIONS,
  type EmploymentType,
  type Gender,
  type Title,
  type WorkLocation,
} from '@hrm/shared'
import { genderFromLabel } from './employeeGenderLabels.js'

const HEADER_ROW = 2
const FIRST_DATA_ROW = 3

/** Header label (asterisk stripped) -> field this column feeds. Mirrors
 *  employeeExport.ts's HEADER_LABELS exactly — a label added to one and not
 *  the other is a column either export can't fill or import can't read. */
const HEADER_FIELDS = {
  รหัสพนักงาน: 'employeeCode',
  รหัสลายนิ้วมือ: 'fingerprintCode',
  คำนำหน้า: 'title',
  ชื่อ: 'firstNameTh',
  นามสกุล: 'lastNameTh',
  ชื่อเล่น: 'nickname',
  เลขบัตรประชาชน: 'idCardNumber',
  เพศ: 'gender',
  วันที่จ้าง: 'hireDate',
  วันที่เริ่มงาน: 'startWorkingDate',
  สถานที่ปฏิบัติงาน: 'workLocation',
  ประเภทการจ้าง: 'employmentType',
  แผนก: 'departmentName',
  ตำแหน่ง: 'jobTitle',
  กะงาน: 'shiftName',
  กลุ่มวันหยุด: 'holidayGroupName',
  กลุ่มเงินเดือน: 'payrollGroupName',
} as const

type Field = (typeof HEADER_FIELDS)[keyof typeof HEADER_FIELDS]

const REQUIRED_FIELDS: readonly Field[] = [
  'employeeCode',
  'title',
  'firstNameTh',
  'lastNameTh',
  'idCardNumber',
  'hireDate',
  'startWorkingDate',
  'workLocation',
  'employmentType',
  'departmentName',
  'jobTitle',
  'shiftName',
  'payrollGroupName',
]

/** Thai label shown for each field's required-column error, and in the
 *  "missing from the template" structural failure. */
const FIELD_LABELS: Record<Field, string> = {
  employeeCode: 'รหัสพนักงาน',
  fingerprintCode: 'รหัสลายนิ้วมือ',
  title: 'คำนำหน้า',
  firstNameTh: 'ชื่อ',
  lastNameTh: 'นามสกุล',
  nickname: 'ชื่อเล่น',
  idCardNumber: 'เลขบัตรประชาชน',
  gender: 'เพศ',
  hireDate: 'วันที่จ้าง',
  startWorkingDate: 'วันที่เริ่มงาน',
  workLocation: 'สถานที่ปฏิบัติงาน',
  employmentType: 'ประเภทการจ้าง',
  departmentName: 'แผนก',
  jobTitle: 'ตำแหน่ง',
  shiftName: 'กะงาน',
  holidayGroupName: 'กลุ่มวันหยุด',
  payrollGroupName: 'กลุ่มเงินเดือน',
}

export type ParsedImportRow = {
  /** 1-based row number in the sheet, so a warning can point HR at it. */
  rowNumber: number
  employeeCode: string | null
  fingerprintCode: string | null
  title: Title | null
  firstNameTh: string | null
  lastNameTh: string | null
  nickname: string | null
  idCardNumber: string | null
  gender: Gender | null
  hireDate: string | null
  startWorkingDate: string | null
  workLocation: WorkLocation | null
  employmentType: EmploymentType | null
  /** Raw text — resolved against master_departments by the route, which is
   *  the only place with a database connection. */
  departmentName: string | null
  jobTitle: string | null
  shiftName: string | null
  holidayGroupName: string | null
  payrollGroupName: string | null
  /** Format/required-field problems this module alone can already see. A row
   *  with any of these can never become create/update — the route skips
   *  straight past database resolution for it, but still resolves what it
   *  can so HR sees every problem in the row at once, not one per re-upload. */
  errors: string[]
}

export type ParsedImportSheet = { rows: ParsedImportRow[] }

export type ParseEmployeeImportResult =
  | { ok: true; value: ParsedImportSheet }
  | { ok: false; message: string }

type Cell = ExcelJS.CellValue

function cellText(value: Cell): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') {
    if (value instanceof Date) return toDateString(value)
    if ('richText' in value) {
      return value.richText.map((run) => run.text).join('')
    }
    if ('text' in value && typeof value.text === 'string') return value.text
    return ''
  }
  return String(value).trim()
}

/** Local calendar date of a Date as 'YYYY-MM-DD'. ExcelJS hands back
 *  UTC-midnight Dates for date-formatted cells, so this reads one back the way
 *  it was written rather than shifting a day west — same reasoning as
 *  attendanceImportParse.ts's toDateString. */
function toDateString(value: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}/

/** A date cell's text, truncated to the calendar-date part — HR may have
 *  typed a plain 'YYYY-MM-DD' string instead of using a real date cell. */
function dateText(value: Cell): string {
  const text = cellText(value)
  const match = DATE_RE.exec(text)
  return match ? match[0] : text
}

/** Rejects both bad formats and real-looking-but-impossible dates like
 *  2024-02-31 — same check as employees.ts's isCalendarDate. */
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number) as [number, number, number]
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  )
}

/** Standard Thai national ID checksum — same check as employees.ts's
 *  isValidThaiIdCardNumber, duplicated rather than imported so this module
 *  stays free of any route/DB dependency. */
function isValidThaiIdCardNumber(value: string): boolean {
  if (!/^\d{13}$/.test(value)) return false
  const digits = value.split('').map(Number)
  let sum = 0
  for (let i = 0; i < 12; i++) sum += (digits[i] as number) * (13 - i)
  const check = (11 - (sum % 11)) % 10
  return check === digits[12]
}

function isRowEmpty(row: ExcelJS.Row): boolean {
  let empty = true
  row.eachCell({ includeEmpty: false }, (cell) => {
    if (cellText(cell.value) !== '') empty = false
  })
  return empty
}

/** Builds the column -> field map from the header row, by label rather than
 *  position. Fails only when a *required* column's label can't be found —
 *  an optional column missing entirely just means every row reads null for
 *  it, which is already what a blank cell would mean. */
function resolveColumns(
  headerRow: ExcelJS.Row
): { ok: true; columns: Map<Field, number> } | { ok: false; message: string } {
  const columns = new Map<Field, number>()
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const label = cellText(cell.value).replace(/\*\s*$/, '').trim()
    const field = (HEADER_FIELDS as Record<string, Field | undefined>)[label]
    if (field) columns.set(field, colNumber)
  })

  const missing = REQUIRED_FIELDS.filter((field) => !columns.has(field))
  if (missing.length > 0) {
    const labels = missing.map((field) => FIELD_LABELS[field]).join(', ')
    return {
      ok: false,
      message: `เทมเพลตไม่ถูกต้อง: ไม่พบคอลัมน์ ${labels} ในแถวที่ ${HEADER_ROW} — กรุณาใช้เทมเพลตล่าสุด`,
    }
  }
  return { ok: true, columns }
}

function textOf(row: ExcelJS.Row, columns: Map<Field, number>, field: Field): string {
  const col = columns.get(field)
  if (col === undefined) return ''
  return field === 'hireDate' || field === 'startWorkingDate'
    ? dateText(row.getCell(col).value)
    : cellText(row.getCell(col).value)
}

/** `text` if non-blank, else null — with `errors` gaining a message when a
 *  required field is blank. */
function requiredText(text: string, field: Field, errors: string[]): string | null {
  if (text !== '') return text
  errors.push(`ไม่ระบุ${FIELD_LABELS[field]}`)
  return null
}

function optionalText(text: string): string | null {
  return text === '' ? null : text
}

function parseRow(row: ExcelJS.Row, columns: Map<Field, number>): ParsedImportRow {
  const errors: string[] = []
  const get = (field: Field) => textOf(row, columns, field)

  const employeeCode = requiredText(get('employeeCode'), 'employeeCode', errors)

  const titleText = requiredText(get('title'), 'title', errors)
  let title: Title | null = null
  if (titleText !== null) {
    if ((TITLES as readonly string[]).includes(titleText)) title = titleText as Title
    else errors.push(`คำนำหน้าไม่ถูกต้อง: "${titleText}" (ต้องเป็น ${TITLES.join(' / ')})`)
  }

  const firstNameTh = requiredText(get('firstNameTh'), 'firstNameTh', errors)
  const lastNameTh = requiredText(get('lastNameTh'), 'lastNameTh', errors)
  const nickname = optionalText(get('nickname'))

  const fingerprintText = optionalText(get('fingerprintCode'))
  let fingerprintCode: string | null = fingerprintText
  if (fingerprintText !== null && fingerprintText.length > FINGERPRINT_CODE_MAX_LENGTH) {
    errors.push(`รหัสลายนิ้วมือยาวเกินไป (ไม่เกิน ${FINGERPRINT_CODE_MAX_LENGTH} ตัวอักษร)`)
    fingerprintCode = null
  }

  const idCardText = requiredText(get('idCardNumber'), 'idCardNumber', errors)
  let idCardNumber: string | null = null
  if (idCardText !== null) {
    if (isValidThaiIdCardNumber(idCardText)) idCardNumber = idCardText
    else errors.push(`เลขบัตรประชาชนไม่ถูกต้อง: "${idCardText}"`)
  }

  const genderText = optionalText(get('gender'))
  let gender: Gender | null = null
  if (genderText !== null) {
    gender = genderFromLabel(genderText)
    if (gender === null) errors.push(`เพศไม่ถูกต้อง: "${genderText}" (ต้องเป็น ชาย / หญิง)`)
  }

  const hireDateText = requiredText(get('hireDate'), 'hireDate', errors)
  let hireDate: string | null = null
  if (hireDateText !== null) {
    if (isCalendarDate(hireDateText)) hireDate = hireDateText
    else errors.push(`วันที่จ้างไม่ถูกต้อง: "${hireDateText}" (ต้องเป็น YYYY-MM-DD)`)
  }

  const startWorkingDateText = requiredText(get('startWorkingDate'), 'startWorkingDate', errors)
  let startWorkingDate: string | null = null
  if (startWorkingDateText !== null) {
    if (isCalendarDate(startWorkingDateText)) startWorkingDate = startWorkingDateText
    else errors.push(`วันที่เริ่มงานไม่ถูกต้อง: "${startWorkingDateText}" (ต้องเป็น YYYY-MM-DD)`)
  }

  const workLocationText = requiredText(get('workLocation'), 'workLocation', errors)
  let workLocation: WorkLocation | null = null
  if (workLocationText !== null) {
    if ((WORK_LOCATIONS as readonly string[]).includes(workLocationText)) {
      workLocation = workLocationText as WorkLocation
    } else {
      errors.push(`สถานที่ปฏิบัติงานไม่ถูกต้อง: "${workLocationText}" (ต้องเป็น ${WORK_LOCATIONS.join(' / ')})`)
    }
  }

  const employmentTypeText = requiredText(get('employmentType'), 'employmentType', errors)
  let employmentType: EmploymentType | null = null
  if (employmentTypeText !== null) {
    if ((EMPLOYMENT_TYPES as readonly string[]).includes(employmentTypeText)) {
      employmentType = employmentTypeText as EmploymentType
    } else {
      errors.push(
        `ประเภทการจ้างไม่ถูกต้อง: "${employmentTypeText}" (ต้องเป็น ${EMPLOYMENT_TYPES.join(' / ')})`
      )
    }
  }

  const departmentName = requiredText(get('departmentName'), 'departmentName', errors)
  const jobTitle = requiredText(get('jobTitle'), 'jobTitle', errors)
  const shiftName = requiredText(get('shiftName'), 'shiftName', errors)
  const holidayGroupName = optionalText(get('holidayGroupName'))
  const payrollGroupName = requiredText(get('payrollGroupName'), 'payrollGroupName', errors)

  return {
    rowNumber: row.number,
    employeeCode,
    fingerprintCode,
    title,
    firstNameTh,
    lastNameTh,
    nickname,
    idCardNumber,
    gender,
    hireDate,
    startWorkingDate,
    workLocation,
    employmentType,
    departmentName,
    jobTitle,
    shiftName,
    holidayGroupName,
    payrollGroupName,
    errors,
  }
}

export async function parseEmployeeImport(file: Buffer): Promise<ParseEmployeeImportResult> {
  const workbook = new ExcelJS.Workbook()
  try {
    // exceljs's own .d.ts resolves `Buffer` against a different @types/node
    // copy than this package's, so the two structurally-identical Buffer
    // types don't unify under the newer generic Buffer<T> — cast through
    // unknown rather than pin a version-specific type argument here.
    await workbook.xlsx.load(file as unknown as Parameters<typeof workbook.xlsx.load>[0])
  } catch (err) {
    return {
      ok: false,
      message: `อ่านไฟล์ Excel ไม่สำเร็จ: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  const worksheet = workbook.worksheets[0]
  if (!worksheet) return { ok: false, message: 'ไฟล์ไม่มีชีตข้อมูล' }

  const headerRow = worksheet.getRow(HEADER_ROW)
  const columns = resolveColumns(headerRow)
  if (!columns.ok) return { ok: false, message: columns.message }

  const rows: ParsedImportRow[] = []
  for (let r = FIRST_DATA_ROW; r <= worksheet.rowCount; r++) {
    const row = worksheet.getRow(r)
    if (isRowEmpty(row)) continue
    rows.push(parseRow(row, columns.columns))
  }

  if (rows.length === 0) {
    return { ok: false, message: 'ไม่พบข้อมูลพนักงานในไฟล์ (ไม่มีข้อมูลตั้งแต่แถวที่ 3 เป็นต้นไป)' }
  }

  return { ok: true, value: { rows } }
}
