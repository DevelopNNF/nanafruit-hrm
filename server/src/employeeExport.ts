// Fills server/templates/employee-template.xlsx with employee rows, or with
// none — the same builder serves both GET /employees/export (real data) and
// GET /employees/export-template (an empty sheet HR fills in by hand), the
// only difference being how many rows get written. See attendanceReportExport.ts
// for the same idea applied to the attendance report.
//
// Unlike that report, this template also carries a dropdown for every column
// backed by master data (or a fixed enum): a hidden "Lists" sheet holds the
// current active departments/jobs/shifts/holiday groups/payroll groups/OT
// groups, and Sheet1's matching columns get an Excel list validation pointing
// at it (the supervisor column is the one exception — see LIST_COLUMNS'
// comment). That
// sheet is rebuilt fresh on every export rather than baked into the template
// file, because it has to match whatever is active in the database *right
// now* — a stale copy would offer (or silently accept) a department that no
// longer exists, or hide one added since the file was checked into the repo.

import { fileURLToPath } from 'node:url'
import ExcelJS from 'exceljs'
import { EMPLOYMENT_TYPES, type Employee } from '@hrm/shared'
import { parseDateOnlyUtc } from './leaveRequestQueries.js'
import { GENDER_LABELS } from './employeeGenderLabels.js'
import { loadEmployeeImportMasterData, type EmployeeImportMasterData } from './employeeMasterDataQueries.js'

const TEMPLATE_PATH = fileURLToPath(new URL('../templates/employee-template.xlsx', import.meta.url))
const TEMP_WORKER_TEMPLATE_PATH = fileURLToPath(
  new URL('../templates/employee-temporary-template.xlsx', import.meta.url)
)

// Row 1 is a title/spacer, row 2 the header — both untouched here except for
// splicing/duplicating around row 3, same layout attendanceReportExport uses.
const SAMPLE_ROW = 3

/** How many rows of Sheet1, starting at SAMPLE_ROW, carry the dropdown data
 *  validation — generous enough that HR can type in a whole new hiring batch
 *  below the exported data without running out. Grown per-call if the
 *  company has more employees than this on its own. */
const MIN_VALIDATION_ROW_COUNT = 1000

/** How many rows of the Lists sheet each dropdown's range covers. Excel's
 *  list validation quietly ignores the blank tail, so overshooting a short
 *  list (a company with eight departments) costs nothing. */
const LIST_ROW_COUNT = 500

const LISTS_SHEET = 'Lists'

/** Column numbers on Sheet1, fixed by employee-template.xlsx's own header
 *  row. employeeImportParse.ts reads an uploaded copy of this sheet by
 *  header label instead of position — this module *is* what controls that
 *  layout, so hardcoding the columns it writes is the same trade
 *  attendanceReportExport.ts makes for its own template.
 *
 *  supervisorEmployeeCode (หัวหน้างาน, col 13) and overtimeGroupName (กลุ่ม
 *  OT, col 19) were added straight into the checked-in .xlsx template files
 *  by hand — this constant mirrors that layout exactly rather than the other
 *  way around. */
const COLUMNS = {
  employeeCode: 1,
  fingerprintCode: 2,
  title: 3,
  firstNameTh: 4,
  lastNameTh: 5,
  nickname: 6,
  idCardNumber: 7,
  gender: 8,
  hireDate: 9,
  startWorkingDate: 10,
  workLocation: 11,
  employmentType: 12,
  supervisorEmployeeCode: 13,
  departmentName: 14,
  jobTitle: 15,
  shiftName: 16,
  holidayGroupName: 17,
  payrollGroupName: 18,
  overtimeGroupName: 19,
} as const

/** Which Sheet1 column reads its dropdown from which Lists-sheet column.
 *  Only the columns the user actually asked to reduce retyping for — title/
 *  gender/work location are small fixed enums validated directly against the
 *  constant list on import instead, per that conversation.
 *
 *  supervisorEmployeeCode is deliberately absent: HR types an employee_code
 *  in by hand with no dropdown backing it, resolved on import the same way
 *  the row's own employeeCode is (see routes/employeeImport.ts) — a
 *  datalist of every employee code would be unwieldy and isn't what was
 *  asked for. */
const LIST_COLUMNS: { sheet1Column: number; listColumn: number }[] = [
  { sheet1Column: COLUMNS.employmentType, listColumn: 1 },
  { sheet1Column: COLUMNS.departmentName, listColumn: 2 },
  { sheet1Column: COLUMNS.jobTitle, listColumn: 3 },
  { sheet1Column: COLUMNS.shiftName, listColumn: 4 },
  { sheet1Column: COLUMNS.holidayGroupName, listColumn: 5 },
  { sheet1Column: COLUMNS.payrollGroupName, listColumn: 6 },
  { sheet1Column: COLUMNS.overtimeGroupName, listColumn: 7 },
]

/** Column numbers on employee-temporary-template.xlsx's Sheet1 — no
 *  employeeCode/idCardNumber/shiftName columns (temporary daily workers have
 *  neither an employee code nor an ID card, and their shift is assigned
 *  day-by-day through the "มอบหมายกะรายวัน" screen, not this sheet), plus a
 *  ค่าจ้าง column the standard template doesn't have. supervisorEmployeeCode
 *  and overtimeGroupName were added by hand into the checked-in .xlsx the
 *  same way as the standard template above. */
const TEMP_WORKER_COLUMNS = {
  fingerprintCode: 1,
  title: 2,
  firstNameTh: 3,
  lastNameTh: 4,
  nickname: 5,
  gender: 6,
  hireDate: 7,
  startWorkingDate: 8,
  workLocation: 9,
  employmentType: 10,
  supervisorEmployeeCode: 11,
  departmentName: 12,
  jobTitle: 13,
  holidayGroupName: 14,
  payrollGroupName: 15,
  overtimeGroupName: 16,
  wageAmount: 17,
} as const

/** Same Lists-sheet columns as LIST_COLUMNS, minus shifts (listColumn 4 —
 *  this template has no shiftName column to point it at). */
const TEMP_WORKER_LIST_COLUMNS: { sheet1Column: number; listColumn: number }[] = [
  { sheet1Column: TEMP_WORKER_COLUMNS.employmentType, listColumn: 1 },
  { sheet1Column: TEMP_WORKER_COLUMNS.departmentName, listColumn: 2 },
  { sheet1Column: TEMP_WORKER_COLUMNS.jobTitle, listColumn: 3 },
  { sheet1Column: TEMP_WORKER_COLUMNS.holidayGroupName, listColumn: 5 },
  { sheet1Column: TEMP_WORKER_COLUMNS.payrollGroupName, listColumn: 6 },
  { sheet1Column: TEMP_WORKER_COLUMNS.overtimeGroupName, listColumn: 7 },
]

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

/** A hidden sheet holding one master-data list per column — nothing here is
 *  meant for HR to see or edit directly, only for Sheet1's dropdowns to point
 *  at. No header row: every row from 1 down is a value, which keeps the list
 *  ranges below simple. */
function addListsSheet(workbook: ExcelJS.Workbook, masterData: EmployeeImportMasterData): void {
  const sheet = workbook.addWorksheet(LISTS_SHEET, { state: 'hidden' })
  const columns: string[][] = [
    [...EMPLOYMENT_TYPES],
    masterData.departments.map((d) => d.name),
    masterData.jobs.map((j) => j.name),
    masterData.shifts.map((s) => s.name),
    masterData.holidayGroups.map((g) => g.name),
    masterData.payrollGroups.map((g) => g.name),
    masterData.overtimeGroups.map((g) => g.name),
  ]
  columns.forEach((values, i) => {
    const col = i + 1
    values.forEach((value, r) => {
      sheet.getCell(r + 1, col).value = value
    })
  })
}

function applyDropdowns(
  worksheet: ExcelJS.Worksheet,
  validationRowCount: number,
  listColumns: { sheet1Column: number; listColumn: number }[] = LIST_COLUMNS
): void {
  for (const { sheet1Column, listColumn } of listColumns) {
    const letter = columnLetter(listColumn)
    const ref = `'${LISTS_SHEET}'!$${letter}$1:$${letter}$${LIST_ROW_COUNT}`
    for (let r = SAMPLE_ROW; r < SAMPLE_ROW + validationRowCount; r++) {
      worksheet.getCell(r, sheet1Column).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: [ref],
      }
    }
  }
}

/** Same shape as writeRow, but for employee-temporary-template.xlsx's columns
 *  — no employeeCode/idCardNumber/shiftName, and ค่าจ้าง is deliberately left
 *  blank (this is a data export of what's already on the employee record, and
 *  the current wage rate isn't part of that record — see wageAssignmentQueries.ts
 *  if that ever needs to change). */
function writeTempWorkerRow(worksheet: ExcelJS.Worksheet, rowNumber: number, employee: Employee): void {
  const row = worksheet.getRow(rowNumber)
  row.getCell(TEMP_WORKER_COLUMNS.fingerprintCode).value = employee.fingerprintCode
  row.getCell(TEMP_WORKER_COLUMNS.title).value = employee.title
  row.getCell(TEMP_WORKER_COLUMNS.firstNameTh).value = employee.firstNameTh
  row.getCell(TEMP_WORKER_COLUMNS.lastNameTh).value = employee.lastNameTh
  row.getCell(TEMP_WORKER_COLUMNS.nickname).value = employee.nickname
  row.getCell(TEMP_WORKER_COLUMNS.gender).value =
    employee.gender === null ? null : GENDER_LABELS[employee.gender]
  row.getCell(TEMP_WORKER_COLUMNS.hireDate).value = parseDateOnlyUtc(employee.employment.hireDate)
  row.getCell(TEMP_WORKER_COLUMNS.startWorkingDate).value =
    employee.employment.startWorkingDate === null
      ? null
      : parseDateOnlyUtc(employee.employment.startWorkingDate)
  row.getCell(TEMP_WORKER_COLUMNS.workLocation).value = employee.employment.workLocation
  row.getCell(TEMP_WORKER_COLUMNS.employmentType).value = employee.employment.employmentType
  row.getCell(TEMP_WORKER_COLUMNS.supervisorEmployeeCode).value =
    employee.employment.supervisorEmployeeCode
  row.getCell(TEMP_WORKER_COLUMNS.departmentName).value = employee.employment.departmentName
  row.getCell(TEMP_WORKER_COLUMNS.jobTitle).value = employee.employment.jobTitle
  row.getCell(TEMP_WORKER_COLUMNS.holidayGroupName).value = employee.employment.holidayGroupName
  row.getCell(TEMP_WORKER_COLUMNS.payrollGroupName).value = employee.employment.payrollGroupName
  row.getCell(TEMP_WORKER_COLUMNS.overtimeGroupName).value = employee.employment.overtimeGroupName
  row.commit()
}

function writeRow(worksheet: ExcelJS.Worksheet, rowNumber: number, employee: Employee): void {
  const row = worksheet.getRow(rowNumber)
  row.getCell(COLUMNS.employeeCode).value = employee.employeeCode
  row.getCell(COLUMNS.fingerprintCode).value = employee.fingerprintCode
  row.getCell(COLUMNS.title).value = employee.title
  row.getCell(COLUMNS.firstNameTh).value = employee.firstNameTh
  row.getCell(COLUMNS.lastNameTh).value = employee.lastNameTh
  row.getCell(COLUMNS.nickname).value = employee.nickname
  row.getCell(COLUMNS.idCardNumber).value = employee.idCardNumber
  row.getCell(COLUMNS.gender).value = employee.gender === null ? null : GENDER_LABELS[employee.gender]
  row.getCell(COLUMNS.hireDate).value = parseDateOnlyUtc(employee.employment.hireDate)
  row.getCell(COLUMNS.startWorkingDate).value =
    employee.employment.startWorkingDate === null
      ? null
      : parseDateOnlyUtc(employee.employment.startWorkingDate)
  row.getCell(COLUMNS.workLocation).value = employee.employment.workLocation
  row.getCell(COLUMNS.employmentType).value = employee.employment.employmentType
  // Round-trips as the supervisor's employee_code, not their name — matching
  // what import resolves it back against (see routes/employeeImport.ts). No
  // dropdown backs this cell; see LIST_COLUMNS' comment for why.
  row.getCell(COLUMNS.supervisorEmployeeCode).value = employee.employment.supervisorEmployeeCode
  row.getCell(COLUMNS.departmentName).value = employee.employment.departmentName
  row.getCell(COLUMNS.jobTitle).value = employee.employment.jobTitle
  row.getCell(COLUMNS.shiftName).value = employee.employment.shiftName
  row.getCell(COLUMNS.holidayGroupName).value = employee.employment.holidayGroupName
  row.getCell(COLUMNS.payrollGroupName).value = employee.employment.payrollGroupName
  row.getCell(COLUMNS.overtimeGroupName).value = employee.employment.overtimeGroupName
  row.commit()
}

/**
 * The generated workbook as a buffer, ready to send as
 * application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.
 *
 * `employees` empty produces the blank-template download: headers and fresh
 * dropdowns, no data rows. Non-empty produces the data export, with the same
 * fresh dropdowns so a re-import of the exact file that just came out still
 * validates cleanly.
 */
export async function buildEmployeeWorkbook(employees: Employee[]): Promise<ExcelJS.Buffer> {
  const masterData = await loadEmployeeImportMasterData()

  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(TEMPLATE_PATH)
  const worksheet = workbook.worksheets[0]
  if (!worksheet) throw new Error('employee template has no worksheet')

  addListsSheet(workbook, masterData)

  if (employees.length === 0) {
    // Nothing to clone the sample row into — drop it so the template doesn't
    // ship its placeholder employee as if it were real data.
    worksheet.spliceRows(SAMPLE_ROW, 1)
  } else {
    // Clones the sample row's style onto count new rows inserted after it;
    // the sample row itself becomes the first data row below.
    worksheet.duplicateRow(SAMPLE_ROW, employees.length - 1, true)
    employees.forEach((employee, i) => writeRow(worksheet, SAMPLE_ROW + i, employee))
  }

  const validationRowCount = Math.max(MIN_VALIDATION_ROW_COUNT, employees.length + 200)
  applyDropdowns(worksheet, validationRowCount)

  return workbook.xlsx.writeBuffer()
}

/**
 * The temp-worker template's counterpart to buildEmployeeWorkbook above —
 * same `employees` empty/non-empty convention, but against
 * employee-temporary-template.xlsx's columns (no employeeCode/idCardNumber/
 * shiftName, ค่าจ้าง left blank — see writeTempWorkerRow's comment).
 */
export async function buildTempWorkerEmployeeWorkbook(employees: Employee[] = []): Promise<ExcelJS.Buffer> {
  const masterData = await loadEmployeeImportMasterData()

  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(TEMP_WORKER_TEMPLATE_PATH)
  const worksheet = workbook.worksheets[0]
  if (!worksheet) throw new Error('temp-worker employee template has no worksheet')

  addListsSheet(workbook, masterData)

  if (employees.length === 0) {
    // Nothing to clone the sample row into — drop it so the template doesn't
    // ship its placeholder worker as if it were real data.
    worksheet.spliceRows(SAMPLE_ROW, 1)
  } else {
    worksheet.duplicateRow(SAMPLE_ROW, employees.length - 1, true)
    employees.forEach((employee, i) => writeTempWorkerRow(worksheet, SAMPLE_ROW + i, employee))
  }

  const validationRowCount = Math.max(MIN_VALIDATION_ROW_COUNT, employees.length + 200)
  applyDropdowns(worksheet, validationRowCount, TEMP_WORKER_LIST_COLUMNS)

  return workbook.xlsx.writeBuffer()
}
