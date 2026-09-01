import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import { parseEmployeeFinanceImport } from './employeeFinanceImportParse.js'

// Row-2 header labels, in the layout server/templates/employee-finance-
// template.xlsx actually uses — see employeeFinanceExport.ts's COLUMNS for
// the same layout on the write side. Columns 18/19 and 20/21/22 repeat their
// group's label ("ประกันสังคม"/"ภาษี") across every column in the group, same
// as the real merged cells; row 3 (SUB_HEADERS) is what disambiguates them.
const HEADERS = [
  'รหัสพนักงาน*',
  'คำนำหน้า*',
  'ชื่อ*',
  'นามสกุล*',
  'ชื่อเล่น',
  'วันที่จ้าง*',
  'วันที่เริ่มงาน*',
  'ประเภทการจ้าง*',
  'กลุ่มวันหยุด',
  'กลุ่มเงินเดือน*',
  'กลุ่ม OT',
  'ประเภทค่าจ้าง',
  'ค่าจ้าง',
  'ช่องทางการจ่ายเงิน',
  'ธนาคาร',
  'รหัสสาขา',
  'เลขที่บัญชี',
  'ประกันสังคม',
  'ประกันสังคม',
  'ภาษี',
  'ภาษี',
  'ภาษี',
]

const SUB_HEADERS = [
  ...HEADERS.slice(0, 17),
  'ประเภท',
  'จำนวน',
  'ประเภท',
  'จำนวน',
  'เริ่มคำนวณภาษี',
]

const VALID_ROW = [
  'EMP001',
  'นาย',
  'ทดสอบ',
  'ระบบ',
  'ทด',
  '2026-01-01',
  '2026-01-01',
  'ประจำ (รายเดือน)',
  'Office Holiday',
  'Office',
  'OT Normal',
  'รายเดือน',
  15000,
  'โอน',
  'ไทยพาณิชย์ (SCB)',
  '-',
  '123456789',
  'คิดตามฐานเงินเดือนจริงที่ได้รับ (หักจากค่าจ้าง)',
  '',
  'คิดภาษี ภงด.1 ใหม่ทุกเดือน (หักจากค่าจ้าง)',
  '',
  '2026-08-01',
]

async function buildWorkbook(
  templateCode: string | null,
  rows: (string | number | null)[][]
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Sheet1')
  sheet.addRow([templateCode])
  sheet.addRow(HEADERS)
  sheet.addRow(SUB_HEADERS)
  for (const row of rows) sheet.addRow(row)
  const buffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(buffer)
}

async function parse(rows: (string | number | null)[][]) {
  return parseEmployeeFinanceImport(await buildWorkbook('EMP-FIN-IMP', rows))
}

describe('parseEmployeeFinanceImport', () => {
  it('rejects a file with the wrong (or missing) template code', async () => {
    const result = await parseEmployeeFinanceImport(await buildWorkbook('EMP-IMP', [VALID_ROW]))
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.message, /ไม่ใช่เทมเพลตข้อมูลการเงินพนักงาน/)
  })

  it('matches ประกันสังคม/ภาษี sub-columns even when their row-3 label carries a trailing *', async () => {
    const starredSubHeaders = SUB_HEADERS.map((label, i) =>
      i === 17 || i === 19 ? `${label}*` : label
    ) // 0-based: index 17 = ประเภท (ประกันสังคม), 19 = ประเภท (ภาษี)
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Sheet1')
    sheet.addRow(['EMP-FIN-IMP'])
    sheet.addRow(HEADERS)
    sheet.addRow(starredSubHeaders)
    sheet.addRow(VALID_ROW)
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer())

    const result = await parseEmployeeFinanceImport(buffer)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.rows[0]!.socialSecurityType, 'actual_wage_employee_paid')
    assert.equal(result.rows[0]!.taxType, 'monthly_recalc_employee_paid')
  })

  it('rejects a file missing a required column', async () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Sheet1')
    sheet.addRow(['EMP-FIN-IMP'])
    sheet.addRow(HEADERS.slice(0, -1)) // drop the last ภาษี (เริ่มคำนวณภาษี) column
    sheet.addRow(SUB_HEADERS.slice(0, -1))
    sheet.addRow(VALID_ROW.slice(0, -1))
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer())

    const result = await parseEmployeeFinanceImport(buffer)
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.message, /เริ่มคำนวณภาษี/)
  })

  it('parses a fully valid row with no errors', async () => {
    const result = await parse([VALID_ROW])
    assert.equal(result.ok, true)
    if (!result.ok) return
    const row = result.rows[0]!
    assert.deepEqual(row.errors, [])
    assert.equal(row.employeeCode, 'EMP001')
    assert.equal(row.displayName, 'นายทดสอบ ระบบ')
    assert.equal(row.wageType, 'monthly')
    assert.equal(row.wageAmount, 15000)
    assert.equal(row.paymentMethod, 'transfer')
    assert.equal(row.bankBranchCode, '-')
    assert.equal(row.bankAccountNumber, '123456789')
    assert.equal(row.socialSecurityType, 'actual_wage_employee_paid')
    assert.equal(row.socialSecurityFixedAmount, null)
    assert.equal(row.taxType, 'monthly_recalc_employee_paid')
    assert.equal(row.taxFixedAmount, null)
    assert.equal(row.taxPercent, null)
    assert.equal(row.taxStartMonth, '2026-08-01')
  })

  it('requires รหัสพนักงาน', async () => {
    const row = [...VALID_ROW]
    row[0] = ''
    const result = await parse([row])
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.match(result.rows[0]!.errors.join(' '), /ไม่ระบุรหัสพนักงาน/)
  })

  it('requires ประเภทค่าจ้าง on every row', async () => {
    const row = [...VALID_ROW]
    row[11] = '' // ประเภทค่าจ้าง
    const result = await parse([row])
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.match(result.rows[0]!.errors.join(' '), /ไม่ระบุประเภทค่าจ้าง/)
  })

  it('requires ค่าจ้าง on every row', async () => {
    const row = [...VALID_ROW]
    row[12] = '' // ค่าจ้าง
    const result = await parse([row])
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.match(result.rows[0]!.errors.join(' '), /ไม่ระบุค่าจ้าง/)
  })

  it('does not require เลขที่บัญชี for cash payment', async () => {
    const row = [...VALID_ROW]
    row[13] = 'เงินสด' // ช่องทางการจ่ายเงิน
    row[16] = '' // เลขที่บัญชี
    const result = await parse([row])
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(result.rows[0]!.errors, [])
    assert.equal(result.rows[0]!.paymentMethod, 'cash')
    assert.equal(result.rows[0]!.bankAccountNumber, null)
  })

  it('rejects a bank name other than the one supported bank', async () => {
    const row = [...VALID_ROW]
    row[14] = 'กสิกรไทย'
    const result = await parse([row])
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.match(result.rows[0]!.errors.join(' '), /ธนาคารไม่ถูกต้อง/)
  })

  it('requires ประกันสังคม (จำนวน) when the type is fixed_monthly', async () => {
    const row = [...VALID_ROW]
    row[17] = 'คิดคงที่ทุกเดือน'
    row[18] = '' // ประกันสังคม (จำนวน) left blank
    const result = await parse([row])
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.match(result.rows[0]!.errors.join(' '), /ต้องระบุจำนวนประกันสังคม/)
  })

  it('rejects ประกันสังคม (จำนวน) when the type does not need one', async () => {
    const row = [...VALID_ROW]
    row[18] = '500' // type is still actual_wage_employee_paid from VALID_ROW
    const result = await parse([row])
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.match(result.rows[0]!.errors.join(' '), /ต้องเว้นว่างจำนวนประกันสังคม/)
  })

  it('reads ภาษี (จำนวน) as a percent when taxType is percent_of_income', async () => {
    const row = [...VALID_ROW]
    row[19] = 'คิดภาษี ภงด.1 เป็น % ของรายได้'
    row[20] = '5'
    const result = await parse([row])
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(result.rows[0]!.errors, [])
    assert.equal(result.rows[0]!.taxPercent, 5)
    assert.equal(result.rows[0]!.taxFixedAmount, null)
  })

  it('rejects a tax percent over 100', async () => {
    const row = [...VALID_ROW]
    row[19] = 'คิดภาษี ภงด.1 เป็น % ของรายได้'
    row[20] = '150'
    const result = await parse([row])
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.match(result.rows[0]!.errors.join(' '), /ต้องไม่เกิน 100/)
  })

  it('rejects เริ่มคำนวณภาษี that is not the 1st of a month', async () => {
    const row = [...VALID_ROW]
    row[21] = '2026-08-15'
    const result = await parse([row])
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.match(result.rows[0]!.errors.join(' '), /เริ่มคำนวณภาษีไม่ถูกต้อง/)
  })

  it('skips a fully blank row rather than treating it as an error', async () => {
    const result = await parse([VALID_ROW, HEADERS.map(() => '')])
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.rows.length, 1)
  })

  it('fails with no rows at all past the header', async () => {
    const result = await parseEmployeeFinanceImport(await buildWorkbook('EMP-FIN-IMP', []))
    assert.equal(result.ok, false)
  })
})
