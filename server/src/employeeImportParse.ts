// Reading an uploaded copy of server/templates/employee-template.xlsx (or
// employee-temporary-template.xlsx, for temporary daily workers) into rows of
// plain field values. Pure: bytes in, rows out, no database — matching
// values against departments/jobs/shifts/holiday/payroll/OT groups (and the
// supervisor column against another employee's code) needs the database and
// lives in routes/employeeImport.ts instead, same split as
// attendanceImportParse.ts (bytes) vs attendanceImportClassify.ts (needs
// shift windows) vs the route (needs a connection).
//
// The header row (row 2) is read by name, not position: employeeExport.ts
// writes the same labels this file's HEADER_FIELDS maps back from, but HR is
// free to reorder columns in their own copy without breaking the read. Row 1
// is a title/spacer in most workbooks, but both templates now also carry a
// plain-text "template code" in cell A1 (EMP-IMP / TEMP-EMP-IMP) that
// detectTemplate reads to pick which set of columns/required-fields applies —
// a file with no recognizable code there (an older download, predating this
// marker) falls back to the standard template rather than erroring, so
// nothing already in HR's hands breaks. Data starts at row 3.

import ExcelJS from 'exceljs'
import {
  EMPLOYMENT_TYPES,
  FINGERPRINT_CODE_MAX_LENGTH,
  NATIONALITIES,
  TITLES,
  WORK_LOCATIONS,
  type EmploymentType,
  type Gender,
  type Nationality,
  type Title,
  type WorkLocation,
} from '@hrm/shared'
import { genderFromLabel } from './employeeGenderLabels.js'

const TEMPLATE_CODE_CELL_ROW = 1
const TEMPLATE_CODE_CELL_COLUMN = 1
const HEADER_ROW = 2
const FIRST_DATA_ROW = 3

export type TemplateCode = 'EMP-IMP' | 'TEMP-EMP-IMP'

type Field =
  | 'employeeCode'
  | 'fingerprintCode'
  | 'title'
  | 'firstNameTh'
  | 'lastNameTh'
  | 'nickname'
  | 'nationality'
  | 'idCardNumber'
  | 'gender'
  | 'hireDate'
  | 'startWorkingDate'
  | 'workLocation'
  | 'employmentType'
  | 'supervisorEmployeeCode'
  | 'departmentName'
  | 'jobTitle'
  | 'shiftName'
  | 'holidayGroupName'
  | 'payrollGroupName'
  | 'overtimeGroupName'
  | 'wageAmount'

/** Header label (asterisk stripped) -> field this column feeds. Mirrors
 *  employeeExport.ts's HEADER_LABELS exactly — a label added to one and not
 *  the other is a column either export can't fill or import can't read. */
const STANDARD_HEADER_FIELDS: Record<string, Field> = {
  รหัสพนักงาน: 'employeeCode',
  รหัสลายนิ้วมือ: 'fingerprintCode',
  คำนำหน้า: 'title',
  ชื่อ: 'firstNameTh',
  นามสกุล: 'lastNameTh',
  ชื่อเล่น: 'nickname',
  สัญชาติ: 'nationality',
  เลขบัตรประชาชน: 'idCardNumber',
  เพศ: 'gender',
  วันที่จ้าง: 'hireDate',
  วันที่เริ่มงาน: 'startWorkingDate',
  สถานที่ปฏิบัติงาน: 'workLocation',
  ประเภทการจ้าง: 'employmentType',
  หัวหน้างาน: 'supervisorEmployeeCode',
  แผนก: 'departmentName',
  ตำแหน่ง: 'jobTitle',
  กะงาน: 'shiftName',
  กลุ่มวันหยุด: 'holidayGroupName',
  กลุ่มเงินเดือน: 'payrollGroupName',
  'กลุ่ม OT': 'overtimeGroupName',
}

// idCardNumber is deliberately absent here even though the column itself must
// exist (see below) — its per-row requiredness now depends on the row's own
// nationality value ('ไทย' needs one, 'ต่างชาติ' doesn't), so it's resolved
// by resolveIdCardNumber in parseRow instead of the generic fieldText()
// required/optional switch every other field here uses.
const STANDARD_REQUIRED_FIELDS: readonly Field[] = [
  'employeeCode',
  'title',
  'firstNameTh',
  'lastNameTh',
  'nationality',
  'hireDate',
  'startWorkingDate',
  'workLocation',
  'employmentType',
  'departmentName',
  'jobTitle',
  'shiftName',
  'payrollGroupName',
]

/** idCardNumber's column must still exist on the standard template — this is
 *  checked independently of STANDARD_REQUIRED_FIELDS (which only gates
 *  per-row blank-cell errors via fieldText) because resolveColumns' "missing
 *  column" check reads requiredFields directly, and idCardNumber can't sit in
 *  that list without every row being forced non-blank regardless of
 *  nationality. */
const STANDARD_STRUCTURAL_COLUMNS: readonly Field[] = [...STANDARD_REQUIRED_FIELDS, 'idCardNumber']

/** No รหัสพนักงาน/กะงาน columns — temporary daily workers have no employee
 *  code, and their shift is assigned day-by-day (see the "มอบหมายกะรายวัน"
 *  screen), not through this sheet. รหัสลายนิ้วมือ is required here
 *  specifically, unlike the standard template, because it's this employee
 *  type's only real identity — the key routes/employeeImport.ts's
 *  dedup/update logic matches on for this template. ค่าจ้าง (wageAmount) is
 *  optional: a daily wage rate can be set here or, same as any other
 *  employee, later via the Finance tab.
 *
 *  เลขบัตรประชาชน IS present here, unlike before nationality existed — a
 *  temporary daily worker can be a Thai national too, and nationality alone
 *  decides whether it's required (see resolveIdCardNumber), not employee
 *  type. Absent from TEMP_WORKER_REQUIRED_FIELDS/structuralColumns below on
 *  purpose: an older downloaded copy of this template predating the column
 *  should keep working (every row just reads null for it) rather than
 *  hard-failing the whole upload. */
const TEMP_WORKER_HEADER_FIELDS: Record<string, Field> = {
  รหัสลายนิ้วมือ: 'fingerprintCode',
  คำนำหน้า: 'title',
  ชื่อ: 'firstNameTh',
  นามสกุล: 'lastNameTh',
  ชื่อเล่น: 'nickname',
  สัญชาติ: 'nationality',
  เลขบัตรประชาชน: 'idCardNumber',
  เพศ: 'gender',
  วันที่จ้าง: 'hireDate',
  วันที่เริ่มงาน: 'startWorkingDate',
  สถานที่ปฏิบัติงาน: 'workLocation',
  ประเภทการจ้าง: 'employmentType',
  หัวหน้างาน: 'supervisorEmployeeCode',
  แผนก: 'departmentName',
  ตำแหน่ง: 'jobTitle',
  กลุ่มวันหยุด: 'holidayGroupName',
  กลุ่มเงินเดือน: 'payrollGroupName',
  'กลุ่ม OT': 'overtimeGroupName',
  ค่าจ้าง: 'wageAmount',
}

const TEMP_WORKER_REQUIRED_FIELDS: readonly Field[] = [
  'fingerprintCode',
  'title',
  'firstNameTh',
  'lastNameTh',
  'hireDate',
  'startWorkingDate',
  'workLocation',
  'employmentType',
  'departmentName',
  'jobTitle',
  'payrollGroupName',
]

type TemplateConfig = {
  code: TemplateCode
  headerFields: Record<string, Field>
  /** Drives fieldText()'s per-row required/optional switch. */
  requiredFields: readonly Field[]
  /** Drives resolveColumns' "column missing from the header row" structural
   *  check. A superset of requiredFields for the standard template only —
   *  see STANDARD_STRUCTURAL_COLUMNS' own comment for why idCardNumber sits
   *  here but not in requiredFields. */
  structuralColumns: readonly Field[]
}

const STANDARD_TEMPLATE: TemplateConfig = {
  code: 'EMP-IMP',
  headerFields: STANDARD_HEADER_FIELDS,
  requiredFields: STANDARD_REQUIRED_FIELDS,
  structuralColumns: STANDARD_STRUCTURAL_COLUMNS,
}

const TEMP_WORKER_TEMPLATE: TemplateConfig = {
  code: 'TEMP-EMP-IMP',
  headerFields: TEMP_WORKER_HEADER_FIELDS,
  requiredFields: TEMP_WORKER_REQUIRED_FIELDS,
  structuralColumns: TEMP_WORKER_REQUIRED_FIELDS,
}

/** Thai label shown for each field's required-column error, and in the
 *  "missing from the template" structural failure. */
const FIELD_LABELS: Record<Field, string> = {
  employeeCode: 'รหัสพนักงาน',
  fingerprintCode: 'รหัสลายนิ้วมือ',
  title: 'คำนำหน้า',
  firstNameTh: 'ชื่อ',
  lastNameTh: 'นามสกุล',
  nickname: 'ชื่อเล่น',
  nationality: 'สัญชาติ',
  idCardNumber: 'เลขบัตรประชาชน',
  gender: 'เพศ',
  hireDate: 'วันที่จ้าง',
  startWorkingDate: 'วันที่เริ่มงาน',
  workLocation: 'สถานที่ปฏิบัติงาน',
  employmentType: 'ประเภทการจ้าง',
  supervisorEmployeeCode: 'หัวหน้างาน',
  departmentName: 'แผนก',
  jobTitle: 'ตำแหน่ง',
  shiftName: 'กะงาน',
  holidayGroupName: 'กลุ่มวันหยุด',
  payrollGroupName: 'กลุ่มเงินเดือน',
  overtimeGroupName: 'กลุ่ม OT',
  wageAmount: 'ค่าจ้าง',
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
  /** Gates whether idCardNumber is required — see resolveIdCardNumber. */
  nationality: Nationality | null
  idCardNumber: string | null
  gender: Gender | null
  hireDate: string | null
  startWorkingDate: string | null
  workLocation: WorkLocation | null
  employmentType: EmploymentType | null
  /** Raw text — an employee_code, not a name, and resolved against the
   *  employees table by the route (not a master table, so not through
   *  resolveMasterName) — see routes/employeeImport.ts. No dropdown backs
   *  this column in the sheet; HR types it in manually. */
  supervisorEmployeeCode: string | null
  /** Raw text — resolved against master_departments by the route, which is
   *  the only place with a database connection. */
  departmentName: string | null
  jobTitle: string | null
  shiftName: string | null
  holidayGroupName: string | null
  payrollGroupName: string | null
  /** Raw text — resolved against master_overtime_groups by the route, same
   *  as departmentName above. */
  overtimeGroupName: string | null
  /** Daily wage rate — only ever present from the temp-worker template.
   *  Written to employee_wage_assignments by the route, same reasoning as
   *  departmentName above. */
  wageAmount: number | null
  /** Format/required-field problems this module alone can already see. A row
   *  with any of these can never become create/update — the route skips
   *  straight past database resolution for it, but still resolves what it
   *  can so HR sees every problem in the row at once, not one per re-upload. */
  errors: string[]
}

export type ParsedImportSheet = { rows: ParsedImportRow[]; templateCode: TemplateCode }

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

/** idCardNumber's required-ness depends on the row's own nationality, not on
 *  which template is in use — a Thai national needs one whether they're on
 *  the standard sheet or the temp-worker one, and a foreign national needs
 *  neither. This is why idCardNumber is absent from both templates'
 *  requiredFields and resolved here directly instead of through fieldText(). */
function resolveIdCardNumber(
  text: string,
  nationality: Nationality | null,
  errors: string[]
): string | null {
  if (text === '') {
    if (nationality === 'ไทย') errors.push(`ไม่ระบุ${FIELD_LABELS.idCardNumber}`)
    return null
  }
  if (isValidThaiIdCardNumber(text)) return text
  errors.push(`เลขบัตรประชาชนไม่ถูกต้อง: "${text}"`)
  return null
}

function isRowEmpty(row: ExcelJS.Row): boolean {
  let empty = true
  row.eachCell({ includeEmpty: false }, (cell) => {
    if (cellText(cell.value) !== '') empty = false
  })
  return empty
}

/** Cell A1's text, trimmed — the plain-text template-code marker. Row 1 is
 *  otherwise never read (it's a title/spacer everywhere else in this file). */
function readTemplateCode(worksheet: ExcelJS.Worksheet): string {
  const cell = worksheet.getRow(TEMPLATE_CODE_CELL_ROW).getCell(TEMPLATE_CODE_CELL_COLUMN)
  return cellText(cell.value)
}

/** Picks which template's columns/required-fields apply, by A1. Anything
 *  other than the temp-worker code — including blank, or an older download
 *  from before this marker existed — falls back to the standard template
 *  rather than failing the upload. */
function detectTemplate(worksheet: ExcelJS.Worksheet): TemplateConfig {
  const code = readTemplateCode(worksheet)
  return code === TEMP_WORKER_TEMPLATE.code ? TEMP_WORKER_TEMPLATE : STANDARD_TEMPLATE
}

/** Builds the column -> field map from the header row, by label rather than
 *  position. Fails only when a *required* column's label can't be found —
 *  an optional column missing entirely just means every row reads null for
 *  it, which is already what a blank cell would mean. */
function resolveColumns(
  headerRow: ExcelJS.Row,
  template: TemplateConfig
): { ok: true; columns: Map<Field, number> } | { ok: false; message: string } {
  const columns = new Map<Field, number>()
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const label = cellText(cell.value).replace(/\*\s*$/, '').trim()
    const field = template.headerFields[label]
    if (field) columns.set(field, colNumber)
  })

  const missing = template.structuralColumns.filter((field) => !columns.has(field))
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

/** `requiredText`/`optionalText`, picked per-field by whether the detected
 *  template actually requires that column — the one thing that differs
 *  between templates for most fields (the format-specific checks below stay
 *  the same either way). */
function fieldText(
  text: string,
  field: Field,
  template: TemplateConfig,
  errors: string[]
): string | null {
  return template.requiredFields.includes(field)
    ? requiredText(text, field, errors)
    : optionalText(text)
}

/** ค่าจ้าง — a positive number, or null if blank. Never required (see
 *  TEMP_WORKER_REQUIRED_FIELDS' own comment on why a wage rate can be set
 *  here or later via the Finance tab). */
function optionalWageAmount(text: string, errors: string[]): number | null {
  if (text === '') return null
  const value = Number(text)
  if (!Number.isFinite(value) || value <= 0) {
    errors.push(`ค่าจ้างไม่ถูกต้อง: "${text}" (ต้องเป็นตัวเลขมากกว่า 0)`)
    return null
  }
  return value
}

function parseRow(row: ExcelJS.Row, columns: Map<Field, number>, template: TemplateConfig): ParsedImportRow {
  const errors: string[] = []
  const get = (field: Field) => textOf(row, columns, field)

  const employeeCode = fieldText(get('employeeCode'), 'employeeCode', template, errors)

  const titleText = fieldText(get('title'), 'title', template, errors)
  let title: Title | null = null
  if (titleText !== null) {
    if ((TITLES as readonly string[]).includes(titleText)) title = titleText as Title
    else errors.push(`คำนำหน้าไม่ถูกต้อง: "${titleText}" (ต้องเป็น ${TITLES.join(' / ')})`)
  }

  const firstNameTh = fieldText(get('firstNameTh'), 'firstNameTh', template, errors)
  const lastNameTh = fieldText(get('lastNameTh'), 'lastNameTh', template, errors)
  const nickname = optionalText(get('nickname'))

  const fingerprintText = fieldText(get('fingerprintCode'), 'fingerprintCode', template, errors)
  let fingerprintCode: string | null = fingerprintText
  if (fingerprintText !== null && fingerprintText.length > FINGERPRINT_CODE_MAX_LENGTH) {
    errors.push(`รหัสลายนิ้วมือยาวเกินไป (ไม่เกิน ${FINGERPRINT_CODE_MAX_LENGTH} ตัวอักษร)`)
    fingerprintCode = null
  }

  const nationalityText = fieldText(get('nationality'), 'nationality', template, errors)
  let nationality: Nationality | null = null
  if (nationalityText !== null) {
    if ((NATIONALITIES as readonly string[]).includes(nationalityText)) {
      nationality = nationalityText as Nationality
    } else {
      errors.push(`สัญชาติไม่ถูกต้อง: "${nationalityText}" (ต้องเป็น ${NATIONALITIES.join(' / ')})`)
    }
  }

  const idCardNumber = resolveIdCardNumber(get('idCardNumber'), nationality, errors)

  const genderText = optionalText(get('gender'))
  let gender: Gender | null = null
  if (genderText !== null) {
    gender = genderFromLabel(genderText)
    if (gender === null) errors.push(`เพศไม่ถูกต้อง: "${genderText}" (ต้องเป็น ชาย / หญิง)`)
  }

  const hireDateText = fieldText(get('hireDate'), 'hireDate', template, errors)
  let hireDate: string | null = null
  if (hireDateText !== null) {
    if (isCalendarDate(hireDateText)) hireDate = hireDateText
    else errors.push(`วันที่จ้างไม่ถูกต้อง: "${hireDateText}" (ต้องเป็น YYYY-MM-DD)`)
  }

  const startWorkingDateText = fieldText(get('startWorkingDate'), 'startWorkingDate', template, errors)
  let startWorkingDate: string | null = null
  if (startWorkingDateText !== null) {
    if (isCalendarDate(startWorkingDateText)) startWorkingDate = startWorkingDateText
    else errors.push(`วันที่เริ่มงานไม่ถูกต้อง: "${startWorkingDateText}" (ต้องเป็น YYYY-MM-DD)`)
  }

  const workLocationText = fieldText(get('workLocation'), 'workLocation', template, errors)
  let workLocation: WorkLocation | null = null
  if (workLocationText !== null) {
    if ((WORK_LOCATIONS as readonly string[]).includes(workLocationText)) {
      workLocation = workLocationText as WorkLocation
    } else {
      errors.push(`สถานที่ปฏิบัติงานไม่ถูกต้อง: "${workLocationText}" (ต้องเป็น ${WORK_LOCATIONS.join(' / ')})`)
    }
  }

  const employmentTypeText = fieldText(get('employmentType'), 'employmentType', template, errors)
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

  const supervisorEmployeeCode = optionalText(get('supervisorEmployeeCode'))
  const departmentName = fieldText(get('departmentName'), 'departmentName', template, errors)
  const jobTitle = fieldText(get('jobTitle'), 'jobTitle', template, errors)
  const shiftName = fieldText(get('shiftName'), 'shiftName', template, errors)
  const holidayGroupName = optionalText(get('holidayGroupName'))
  const payrollGroupName = fieldText(get('payrollGroupName'), 'payrollGroupName', template, errors)
  const overtimeGroupName = optionalText(get('overtimeGroupName'))
  const wageAmount = optionalWageAmount(get('wageAmount'), errors)

  return {
    rowNumber: row.number,
    employeeCode,
    fingerprintCode,
    title,
    firstNameTh,
    lastNameTh,
    nickname,
    nationality,
    idCardNumber,
    gender,
    hireDate,
    startWorkingDate,
    workLocation,
    employmentType,
    supervisorEmployeeCode,
    departmentName,
    jobTitle,
    shiftName,
    holidayGroupName,
    payrollGroupName,
    overtimeGroupName,
    wageAmount,
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

  const template = detectTemplate(worksheet)

  const headerRow = worksheet.getRow(HEADER_ROW)
  const columns = resolveColumns(headerRow, template)
  if (!columns.ok) return { ok: false, message: columns.message }

  const rows: ParsedImportRow[] = []
  for (let r = FIRST_DATA_ROW; r <= worksheet.rowCount; r++) {
    const row = worksheet.getRow(r)
    if (isRowEmpty(row)) continue
    rows.push(parseRow(row, columns.columns, template))
  }

  if (rows.length === 0) {
    return { ok: false, message: 'ไม่พบข้อมูลพนักงานในไฟล์ (ไม่มีข้อมูลตั้งแต่แถวที่ 3 เป็นต้นไป)' }
  }

  return { ok: true, value: { rows, templateCode: template.code } }
}
