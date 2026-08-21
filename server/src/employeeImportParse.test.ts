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
  'เลขบัตรประชาชน*',
  'เพศ',
  'วันที่จ้าง*',
  'วันที่เริ่มงาน*',
  'สถานที่ปฏิบัติงาน*',
  'ประเภทการจ้าง*',
  'แผนก*',
  'ตำแหน่ง*',
  'กะงาน*',
  'กลุ่มวันหยุด',
  'กลุ่มเงินเดือน*',
]

const VALID_ROW = [
  'EMP001',
  'FP001',
  'นาย',
  'ทดสอบ',
  'ระบบ',
  'ทด',
  '1234567890121',
  'ชาย',
  '2026-01-01',
  '2026-01-01',
  'เชียงใหม่',
  'ประจำ (รายเดือน)',
  'Development',
  'Programmer',
  'Office',
  'Office Holiday',
  'Office',
]

async function buildWorkbook(headers: string[], rows: (string | null)[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Sheet1')
  sheet.addRow([]) // row 1: title/spacer, untouched by the parser
  sheet.addRow(headers) // row 2: header
  for (const row of rows) sheet.addRow(row)
  const buffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(buffer)
}

async function parse(rows: (string | null)[][], headers: string[] = HEADERS) {
  return parseEmployeeImport(await buildWorkbook(headers, rows))
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
    assert.equal(row.gender, 'male')
    assert.equal(row.hireDate, '2026-01-01')
    assert.equal(row.departmentName, 'Development')
    assert.equal(row.payrollGroupName, 'Office')
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
})
