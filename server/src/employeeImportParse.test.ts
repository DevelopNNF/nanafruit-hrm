import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import { parseEmployeeImport } from './employeeImportParse.js'

// Header order and labels match server/templates/employee-template.xlsx's own
// row 2 — see employeeExport.ts's COLUMNS for the same layout on the write
// side. Built in memory rather than kept as a binary fixture so a new test
// case is just another row here, not a new file to maintain.
const HEADERS = [
  'รหัสพนักงาน*',
  'รหัสลายนิ้วมือ',
  'คำนำหน้า*',
  'ชื่อ*',
  'นามสกุล*',
  'ชื่อเล่น',
  'สัญชาติ*',
  'เลขบัตรประชาชน*',
  'เพศ',
  'วันที่จ้าง*',
  'วันที่เริ่มงาน*',
  'สถานที่ปฏิบัติงาน*',
  'ประเภทการจ้าง*',
  'หัวหน้างาน',
  'แผนก*',
  'ตำแหน่ง*',
  'กะงาน*',
  'กลุ่มวันหยุด',
  'กลุ่มเงินเดือน*',
  'กลุ่ม OT',
]

const VALID_ROW = [
  'EMP001',
  'FP001',
  'นาย',
  'ทดสอบ',
  'ระบบ',
  'ทด',
  'ไทย',
  '1234567890121',
  'ชาย',
  '2026-01-01',
  '2026-01-01',
  'เชียงใหม่',
  'ประจำ (รายเดือน)',
  'EMP999',
  'Development',
  'Programmer',
  'Office',
  'Office Holiday',
  'Office',
  'OT Normal',
]

async function buildWorkbook(
  headers: string[],
  rows: (string | number | null)[][],
  templateCodeCell: string | null = null
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Sheet1')
  sheet.addRow([templateCodeCell]) // row 1: title/spacer, or the A1 template-code marker
  sheet.addRow(headers) // row 2: header
  for (const row of rows) sheet.addRow(row)
  const buffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(buffer)
}

async function parse(rows: (string | null)[][], headers: string[] = HEADERS) {
  return parseEmployeeImport(await buildWorkbook(headers, rows))
}

// The temp-worker template's own header row (server/templates/
// employee-temporary-template.xlsx) — no รหัสพนักงาน/เลขบัตรประชาชน/กะงาน
// columns, plus ค่าจ้าง which the standard template doesn't have.
const TEMP_WORKER_HEADERS = [
  'รหัสลายนิ้วมือ*',
  'คำนำหน้า*',
  'ชื่อ*',
  'นามสกุล*',
  'ชื่อเล่น',
  'เพศ',
  'วันที่จ้าง*',
  'วันที่เริ่มงาน*',
  'สถานที่ปฏิบัติงาน*',
  'ประเภทการจ้าง*',
  'หัวหน้างาน',
  'แผนก*',
  'ตำแหน่ง*',
  'กลุ่มวันหยุด',
  'กลุ่มเงินเดือน*',
  'กลุ่ม OT',
  'ค่าจ้าง',
]

const TEMP_WORKER_VALID_ROW: (string | number | null)[] = [
  'FP9999',
  'นาย',
  'ทดสอบ',
  'ระบบ',
  'ทด',
  'ชาย',
  '2026-01-01',
  '2026-01-01',
  'เชียงใหม่',
  'ชั่วคราว',
  'EMP999',
  'Development',
  'Programmer',
  'Office Holiday',
  'Office',
  'OT Normal',
  350,
]

async function parseTempWorker(
  rows: (string | number | null)[][],
  headers: string[] = TEMP_WORKER_HEADERS
) {
  return parseEmployeeImport(await buildWorkbook(headers, rows, 'TEMP-EMP-IMP'))
}

describe('parseEmployeeImport', () => {
  it('reads a fully valid row', async () => {
    const result = await parse([VALID_ROW])
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    if (!result.ok) return
    assert.equal(result.value.rows.length, 1)
    const row = result.value.rows[0]!
    assert.deepEqual(row.errors, [])
    assert.equal(row.employeeCode, 'EMP001')
    assert.equal(row.title, 'นาย')
    assert.equal(row.nationality, 'ไทย')
    assert.equal(row.idCardNumber, '1234567890121')
    assert.equal(row.gender, 'male')
    assert.equal(row.hireDate, '2026-01-01')
    assert.equal(row.departmentName, 'Development')
    assert.equal(row.payrollGroupName, 'Office')
    assert.equal(row.supervisorEmployeeCode, 'EMP999')
    assert.equal(row.overtimeGroupName, 'OT Normal')
  })

  it('reads column order by header label, not position', async () => {
    // แผนก and ตำแหน่ง swapped relative to HEADERS/VALID_ROW.
    const headers = [...HEADERS]
    const idxDept = headers.indexOf('แผนก*')
    const idxJob = headers.indexOf('ตำแหน่ง*')
    ;[headers[idxDept], headers[idxJob]] = [headers[idxJob]!, headers[idxDept]!]

    const row = [...VALID_ROW]
    ;[row[idxDept], row[idxJob]] = [row[idxJob]!, row[idxDept]!]

    const result = await parse([row], headers)
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    if (!result.ok) return
    const parsed = result.value.rows[0]!
    assert.equal(parsed.departmentName, 'Development')
    assert.equal(parsed.jobTitle, 'Programmer')
  })

  it('skips a blank optional column without an error', async () => {
    const row = [...VALID_ROW]
    const idx = HEADERS.indexOf('กลุ่มวันหยุด')
    row[idx] = ''
    const result = await parse([row])
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    if (!result.ok) return
    const parsed = result.value.rows[0]!
    assert.equal(parsed.holidayGroupName, null)
    assert.deepEqual(parsed.errors, [])
  })

  it('skips blank หัวหน้างาน/กลุ่ม OT columns without an error — both optional', async () => {
    const row = [...VALID_ROW]
    row[HEADERS.indexOf('หัวหน้างาน')] = ''
    row[HEADERS.indexOf('กลุ่ม OT')] = ''
    const result = await parse([row])
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    if (!result.ok) return
    const parsed = result.value.rows[0]!
    assert.equal(parsed.supervisorEmployeeCode, null)
    assert.equal(parsed.overtimeGroupName, null)
    assert.deepEqual(parsed.errors, [])
  })

  it('flags every missing required column on the row at once', async () => {
    const row = [...VALID_ROW]
    row[HEADERS.indexOf('รหัสพนักงาน*')] = ''
    row[HEADERS.indexOf('เลขบัตรประชาชน*')] = ''
    const result = await parse([row])
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    if (!result.ok) return
    const parsed = result.value.rows[0]!
    assert.equal(parsed.employeeCode, null)
    assert.equal(parsed.idCardNumber, null)
    assert.ok(parsed.errors.some((e) => e.includes('รหัสพนักงาน')))
    assert.ok(parsed.errors.some((e) => e.includes('เลขบัตรประชาชน')))
    // Both problems surface together — HR fixes the row in one pass.
    assert.equal(parsed.errors.length, 2)
  })

  it('rejects an id card number that fails the checksum', async () => {
    const row = [...VALID_ROW]
    row[HEADERS.indexOf('เลขบัตรประชาชน*')] = '1234567890120'
    const result = await parse([row])
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    if (!result.ok) return
    const parsed = result.value.rows[0]!
    assert.equal(parsed.idCardNumber, null)
    assert.ok(parsed.errors.some((e) => e.includes('เลขบัตรประชาชน')))
  })

  it('does not require idCardNumber when nationality is ต่างชาติ', async () => {
    const row = [...VALID_ROW]
    row[HEADERS.indexOf('สัญชาติ*')] = 'ต่างชาติ'
    row[HEADERS.indexOf('เลขบัตรประชาชน*')] = ''
    const result = await parse([row])
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    if (!result.ok) return
    const parsed = result.value.rows[0]!
    assert.equal(parsed.nationality, 'ต่างชาติ')
    assert.equal(parsed.idCardNumber, null)
    assert.deepEqual(parsed.errors, [])
  })

  it('still requires idCardNumber when nationality is ไทย, regardless of template', async () => {
    const row = [...VALID_ROW]
    row[HEADERS.indexOf('เลขบัตรประชาชน*')] = ''
    const result = await parse([row])
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    if (!result.ok) return
    const parsed = result.value.rows[0]!
    assert.equal(parsed.idCardNumber, null)
    assert.ok(parsed.errors.some((e) => e.includes('เลขบัตรประชาชน')))
  })

  it('rejects a nationality outside the fixed picker list', async () => {
    const row = [...VALID_ROW]
    row[HEADERS.indexOf('สัญชาติ*')] = 'อเมริกัน'
    const result = await parse([row])
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    if (!result.ok) return
    const parsed = result.value.rows[0]!
    assert.equal(parsed.nationality, null)
    assert.ok(parsed.errors.some((e) => e.includes('สัญชาติ')))
  })

  it('requires a สัญชาติ column value on the standard template', async () => {
    const row = [...VALID_ROW]
    row[HEADERS.indexOf('สัญชาติ*')] = ''
    const result = await parse([row])
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    if (!result.ok) return
    const parsed = result.value.rows[0]!
    assert.equal(parsed.nationality, null)
    assert.ok(parsed.errors.some((e) => e.includes('สัญชาติ')))
  })

  it('fails the whole file when the สัญชาติ column is missing from the header', async () => {
    const headers = HEADERS.filter((h) => h !== 'สัญชาติ*')
    const row = VALID_ROW.filter((_, i) => HEADERS[i] !== 'สัญชาติ*')
    const result = await parse([row], headers)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.ok(result.message.includes('สัญชาติ'))
  })

  it('rejects a title outside the fixed picker list', async () => {
    const row = [...VALID_ROW]
    row[HEADERS.indexOf('คำนำหน้า*')] = 'ด็อกเตอร์'
    const result = await parse([row])
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    if (!result.ok) return
    assert.ok(result.value.rows[0]!.errors.some((e) => e.includes('คำนำหน้า')))
  })

  it('maps the Thai gender label to the stored enum value', async () => {
    const row = [...VALID_ROW]
    row[HEADERS.indexOf('เพศ')] = 'หญิง'
    const result = await parse([row])
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    if (!result.ok) return
    assert.equal(result.value.rows[0]!.gender, 'female')
  })

  it('rejects a gender label that is neither ชาย nor หญิง', async () => {
    const row = [...VALID_ROW]
    row[HEADERS.indexOf('เพศ')] = 'Male'
    const result = await parse([row])
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    if (!result.ok) return
    assert.ok(result.value.rows[0]!.errors.some((e) => e.includes('เพศ')))
  })

  it('leaves department/job/shift/holiday-group/payroll-group names unresolved for the caller', async () => {
    // These need the database, so parseEmployeeImport hands the raw text
    // straight through — resolution is routes/employeeImport.ts's job.
    const result = await parse([VALID_ROW])
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    if (!result.ok) return
    const row = result.value.rows[0]!
    assert.equal(row.departmentName, 'Development')
    assert.equal(row.jobTitle, 'Programmer')
    assert.equal(row.shiftName, 'Office')
    assert.equal(row.payrollGroupName, 'Office')
  })

  it('skips a blank row in the middle of the sheet rather than reporting it', async () => {
    const secondRow = [...VALID_ROW]
    secondRow[HEADERS.indexOf('รหัสพนักงาน*')] = 'EMP002'
    secondRow[HEADERS.indexOf('เลขบัตรประชาชน*')] = '1101200123457'
    const result = await parse([VALID_ROW, HEADERS.map(() => null), secondRow])
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    if (!result.ok) return
    assert.equal(result.value.rows.length, 2)
    assert.equal(result.value.rows[0]!.employeeCode, 'EMP001')
    assert.equal(result.value.rows[1]!.employeeCode, 'EMP002')
  })

  it('fails the whole file when a required column is missing from the header', async () => {
    const headers = HEADERS.filter((h) => h !== 'แผนก*')
    const row = VALID_ROW.filter((_, i) => HEADERS[i] !== 'แผนก*')
    const result = await parse([row], headers)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.ok(result.message.includes('แผนก'))
  })

  it('fails the whole file when there is no data at all', async () => {
    const result = await parse([])
    assert.equal(result.ok, false)
  })

  it('tags the sheet with the standard template code when A1 is blank', async () => {
    const result = await parse([VALID_ROW])
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    if (!result.ok) return
    assert.equal(result.value.templateCode, 'EMP-IMP')
  })

  it('falls back to the standard template when A1 holds an unrecognized code', async () => {
    const buffer = await buildWorkbook(HEADERS, [VALID_ROW], 'SOME-OLD-CODE')
    const result = await parseEmployeeImport(buffer)
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    if (!result.ok) return
    assert.equal(result.value.templateCode, 'EMP-IMP')
  })
})

describe('parseEmployeeImport — temp-worker template (TEMP-EMP-IMP)', () => {
  it('tags the sheet with the temp-worker template code from A1', async () => {
    const result = await parseTempWorker([TEMP_WORKER_VALID_ROW])
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    if (!result.ok) return
    assert.equal(result.value.templateCode, 'TEMP-EMP-IMP')
  })

  it('reads a fully valid row — no employeeCode/shiftName, with wageAmount', async () => {
    const result = await parseTempWorker([TEMP_WORKER_VALID_ROW])
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    if (!result.ok) return
    const row = result.value.rows[0]!
    assert.deepEqual(row.errors, [])
    assert.equal(row.employeeCode, null)
    // Neither สัญชาติ nor เลขบัตรประชาชน is in TEMP_WORKER_HEADERS at all —
    // an older download of this template predating those columns should keep
    // working rather than hard-failing (see TEMP_WORKER_HEADER_FIELDS' comment).
    assert.equal(row.nationality, null)
    assert.equal(row.idCardNumber, null)
    assert.equal(row.shiftName, null)
    assert.equal(row.fingerprintCode, 'FP9999')
    assert.equal(row.wageAmount, 350)
    assert.equal(row.supervisorEmployeeCode, 'EMP999')
    assert.equal(row.overtimeGroupName, 'OT Normal')
  })

  it('accepts สัญชาติ/เลขบัตรประชาชน columns when present, same rule as the standard template', async () => {
    const headers = [...TEMP_WORKER_HEADERS, 'สัญชาติ', 'เลขบัตรประชาชน']
    const row = [...TEMP_WORKER_VALID_ROW, 'ไทย', '1234567890121']
    const result = await parseTempWorker([row], headers)
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    if (!result.ok) return
    const parsed = result.value.rows[0]!
    assert.deepEqual(parsed.errors, [])
    assert.equal(parsed.nationality, 'ไทย')
    assert.equal(parsed.idCardNumber, '1234567890121')
  })

  it('requires idCardNumber for the temp-worker template too when nationality is ไทย', async () => {
    const headers = [...TEMP_WORKER_HEADERS, 'สัญชาติ', 'เลขบัตรประชาชน']
    const row = [...TEMP_WORKER_VALID_ROW, 'ไทย', '']
    const result = await parseTempWorker([row], headers)
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    if (!result.ok) return
    const parsed = result.value.rows[0]!
    assert.equal(parsed.idCardNumber, null)
    assert.ok(parsed.errors.some((e) => e.includes('เลขบัตรประชาชน')))
  })

  it('leaves nationality/idCardNumber optional on the temp-worker template even when the columns are present', async () => {
    const headers = [...TEMP_WORKER_HEADERS, 'สัญชาติ', 'เลขบัตรประชาชน']
    const row = [...TEMP_WORKER_VALID_ROW, '', '']
    const result = await parseTempWorker([row], headers)
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    if (!result.ok) return
    const parsed = result.value.rows[0]!
    assert.equal(parsed.nationality, null)
    assert.equal(parsed.idCardNumber, null)
    assert.deepEqual(parsed.errors, [])
  })

  it('skips blank หัวหน้างาน/กลุ่ม OT columns without an error — both optional', async () => {
    const row = [...TEMP_WORKER_VALID_ROW]
    row[TEMP_WORKER_HEADERS.indexOf('หัวหน้างาน')] = ''
    row[TEMP_WORKER_HEADERS.indexOf('กลุ่ม OT')] = ''
    const result = await parseTempWorker([row])
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    if (!result.ok) return
    const parsed = result.value.rows[0]!
    assert.equal(parsed.supervisorEmployeeCode, null)
    assert.equal(parsed.overtimeGroupName, null)
    assert.deepEqual(parsed.errors, [])
  })

  it('requires fingerprintCode, unlike the standard template where it is optional', async () => {
    const row = [...TEMP_WORKER_VALID_ROW]
    row[TEMP_WORKER_HEADERS.indexOf('รหัสลายนิ้วมือ*')] = ''
    const result = await parseTempWorker([row])
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    if (!result.ok) return
    const parsed = result.value.rows[0]!
    assert.equal(parsed.fingerprintCode, null)
    assert.ok(parsed.errors.some((e) => e.includes('รหัสลายนิ้วมือ')))
  })

  it('treats ค่าจ้าง as optional — blank parses to null with no error', async () => {
    const row = [...TEMP_WORKER_VALID_ROW]
    row[TEMP_WORKER_HEADERS.indexOf('ค่าจ้าง')] = ''
    const result = await parseTempWorker([row])
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    if (!result.ok) return
    const parsed = result.value.rows[0]!
    assert.equal(parsed.wageAmount, null)
    assert.deepEqual(parsed.errors, [])
  })

  it('rejects a ค่าจ้าง that is not a positive number', async () => {
    const row = [...TEMP_WORKER_VALID_ROW]
    row[TEMP_WORKER_HEADERS.indexOf('ค่าจ้าง')] = '-50'
    const result = await parseTempWorker([row])
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    if (!result.ok) return
    const parsed = result.value.rows[0]!
    assert.equal(parsed.wageAmount, null)
    assert.ok(parsed.errors.some((e) => e.includes('ค่าจ้าง')))
  })

  it('fails the whole file when a temp-worker-required column is missing from the header', async () => {
    const headers = TEMP_WORKER_HEADERS.filter((h) => h !== 'แผนก*')
    const row = TEMP_WORKER_VALID_ROW.filter((_, i) => TEMP_WORKER_HEADERS[i] !== 'แผนก*')
    const buffer = await buildWorkbook(headers, [row], 'TEMP-EMP-IMP')
    const result = await parseEmployeeImport(buffer)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.ok(result.message.includes('แผนก'))
  })
})
