// Fills server/templates/payroll-template.xlsx with one period's calculated
// entries — a management report, not a payslip, so it lists every employee
// on one sheet instead of one file per person (that's payslipPdf.ts's job).
//
// The template ships with exactly one placeholder column for "other income"
// and one for "other deductions", but HR wants every line item broken out
// into its own named column (OT 1.5, ค่ากะ, ค่าชุด, ภาษี, ...) — and which
// items actually occurred varies period to period. So this module grows or
// shrinks those two placeholder columns at export time into however many
// columns that period's data needs, cloning the placeholder's own style
// (font, borders, the accounting number format) onto each one — the column
// equivalent of what duplicateRow does for rows, done by hand since ExcelJS
// has no duplicateColumn.

import { fileURLToPath } from 'node:url'
import ExcelJS from 'exceljs'
import { listPayrollEntriesForExport, listPayrollLineItemColumns } from './payrollReportQueries.js'
import { parsePeriodCode } from './payrollPeriod.js'
import { parseDateOnlyUtc } from './leaveRequestQueries.js'
import { round2 } from './payrollEarnings.js'

const TEMPLATE_PATH = fileURLToPath(new URL('../templates/payroll-template.xlsx', import.meta.url))

// Row 1 is the title, row 2 the header, row 3 the styled sample row, row 4
// the pre-styled "รวม" totals row — all four carry the styling that has to
// be cloned onto any column this module inserts.
const TITLE_ROW = 1
const HEADER_ROW = 2
const SAMPLE_ROW = 3
const TOTAL_ROW_TEMPLATE = 4
const STYLED_ROWS = [TITLE_ROW, HEADER_ROW, SAMPLE_ROW, TOTAL_ROW_TEMPLATE]

// Fixed column positions in the template as shipped — see the sheet itself
// for the full header row. Only the two placeholder columns move; everything
// from A to I (1-9) never does.
const INCOME_PLACEHOLDER_COL = 10 // J: the template's one "other income" column
const DEDUCTION_PLACEHOLDER_COL = 12 // L: the template's one "other deduction" column, before income resizing
const TEMPLATE_TOTAL_COLUMNS = 14 // A-N as the template ships, before any resizing

const THAI_MONTH_NAMES = [
  'มกราคม',
  'กุมภาพันธ์',
  'มีนาคม',
  'เมษายน',
  'พฤษภาคม',
  'มิถุนายน',
  'กรกฎาคม',
  'สิงหาคม',
  'กันยายน',
  'ตุลาคม',
  'พฤศจิกายน',
  'ธันวาคม',
]

type ColumnStyleSnapshot = Map<number, Partial<ExcelJS.Style>>

function snapshotColumnStyle(ws: ExcelJS.Worksheet, col: number): ColumnStyleSnapshot {
  const snap: ColumnStyleSnapshot = new Map()
  for (const r of STYLED_ROWS) snap.set(r, { ...ws.getRow(r).getCell(col).style })
  return snap
}

function applyColumnStyle(ws: ExcelJS.Worksheet, col: number, snap: ColumnStyleSnapshot): void {
  for (const r of STYLED_ROWS) {
    const style = snap.get(r)
    if (style) ws.getRow(r).getCell(col).style = { ...style }
  }
}

// worksheet.spliceColumns is what ExcelJS ships for inserting/removing
// columns, but inserting more than one column with it produces a workbook
// Excel refuses to open ("we found a problem with some content") — a known,
// unfixed bug (exceljs/exceljs#2865). Rows 1-4 are the only ones that exist
// at the point this module restructures columns (duplicateRow for the real
// data rows runs afterward), so shifting those four rows' cells by hand is
// cheap and sidesteps the bug entirely rather than working around it.

/** Moves every cell/width at column >= fromCol, up to uptoCol, right by
 *  `count` columns (rows 1-4 only), then blanks the vacated columns for the
 *  caller to fill in. Iterates highest column first so a cell is never
 *  overwritten before it's been read. */
function shiftColumnsRight(ws: ExcelJS.Worksheet, fromCol: number, count: number, uptoCol: number): void {
  for (let col = uptoCol; col >= fromCol; col--) {
    for (const r of STYLED_ROWS) {
      const src = ws.getRow(r).getCell(col)
      const dst = ws.getRow(r).getCell(col + count)
      dst.value = src.value
      dst.style = { ...src.style }
    }
    const width = ws.getColumn(col).width
    if (width !== undefined) ws.getColumn(col + count).width = width
  }
  for (let col = fromCol; col < fromCol + count; col++) {
    for (const r of STYLED_ROWS) ws.getRow(r).getCell(col).value = null
  }
}

/** The mirror of shiftColumnsRight: moves every cell/width at column >
 *  fromCol+count-1, up to uptoCol, left by `count` columns, closing the gap
 *  left by a removed placeholder column. */
function shiftColumnsLeft(ws: ExcelJS.Worksheet, fromCol: number, count: number, uptoCol: number): void {
  for (let col = fromCol + count; col <= uptoCol; col++) {
    for (const r of STYLED_ROWS) {
      const src = ws.getRow(r).getCell(col)
      const dst = ws.getRow(r).getCell(col - count)
      dst.value = src.value
      dst.style = { ...src.style }
    }
    const width = ws.getColumn(col).width
    if (width !== undefined) ws.getColumn(col - count).width = width
  }
  for (let col = uptoCol - count + 1; col <= uptoCol; col++) {
    for (const r of STYLED_ROWS) ws.getRow(r).getCell(col).value = null
  }
}

/**
 * Grows or shrinks the single placeholder column at `col` into exactly
 * `count` columns sharing the placeholder's own style. `uptoCol` is the
 * current rightmost column in use, tracked by the caller rather than read
 * off the worksheet — see the two shift functions above. Returns the
 * resulting column indices (empty if count is 0) and the net column delta
 * the caller must add to every column index to its right.
 */
function resizePlaceholderColumn(
  ws: ExcelJS.Worksheet,
  col: number,
  count: number,
  uptoCol: number
): { columns: number[]; delta: number } {
  if (count === 0) {
    shiftColumnsLeft(ws, col, 1, uptoCol)
    return { columns: [], delta: -1 }
  }
  if (count === 1) {
    return { columns: [col], delta: 0 }
  }

  const style = snapshotColumnStyle(ws, col)
  const width = ws.getColumn(col).width
  const extra = count - 1
  shiftColumnsRight(ws, col + 1, extra, uptoCol)
  for (let i = 0; i < extra; i++) {
    const newCol = col + 1 + i
    applyColumnStyle(ws, newCol, style)
    if (width !== undefined) ws.getColumn(newCol).width = width
  }
  return { columns: Array.from({ length: count }, (_, i) => col + i), delta: extra }
}

export type PayrollPeriodReportWorkbook = {
  buffer: ExcelJS.Buffer
  entryCount: number
}

/**
 * The generated workbook, ready to send as
 * application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, plus
 * how many entries it holds — the caller needs that for its own audit log
 * entry and would otherwise have to re-query it.
 *
 * periodCode drives the title only ("...ประจำเดือน สิงหาคม 2026", matching
 * the template's own sample text — a Gregorian year, not the Buddhist one
 * th-TH's Intl formatting would default to, hence the spelled-out month
 * names instead of toLocaleDateString).
 */
export async function buildPayrollPeriodReportWorkbook(
  periodId: number,
  periodCode: string
): Promise<PayrollPeriodReportWorkbook> {
  const [{ income, deduction }, entries] = await Promise.all([
    listPayrollLineItemColumns(periodId),
    listPayrollEntriesForExport(periodId),
  ])

  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(TEMPLATE_PATH)
  const worksheet = workbook.worksheets[0]
  if (!worksheet) throw new Error('payroll report template has no worksheet')

  const parsed = parsePeriodCode(periodCode)
  const monthLabel = parsed ? `${THAI_MONTH_NAMES[parsed.month - 1]} ${parsed.year}` : periodCode
  worksheet.getCell('A1').value = `รายงานผลการคำนวณเงินเดือนสุทธิประจำเดือน ${monthLabel}`

  const incomeResult = resizePlaceholderColumn(
    worksheet,
    INCOME_PLACEHOLDER_COL,
    income.length,
    TEMPLATE_TOTAL_COLUMNS
  )
  const deductionCol = DEDUCTION_PLACEHOLDER_COL + incomeResult.delta
  const deductionResult = resizePlaceholderColumn(
    worksheet,
    deductionCol,
    deduction.length,
    TEMPLATE_TOTAL_COLUMNS + incomeResult.delta
  )

  const grossTotalCol = 11 + incomeResult.delta // K: "รวมรายรับ"
  const deductionTotalCol = 13 + incomeResult.delta + deductionResult.delta // M: "รวมรายจ่าย"
  const netPayCol = 14 + incomeResult.delta + deductionResult.delta // N: "ยอดสุทธิ"

  income.forEach((def, i) => {
    worksheet.getRow(HEADER_ROW).getCell(incomeResult.columns[i]!).value = def.itemName
  })
  deduction.forEach((def, i) => {
    worksheet.getRow(HEADER_ROW).getCell(deductionResult.columns[i]!).value = def.itemName
  })

  if (entries.length === 0) {
    // Nothing to clone the sample row into — drop it so the export doesn't
    // ship the template's placeholder employee as if it were real data.
    worksheet.spliceRows(SAMPLE_ROW, 1)
    return { buffer: await workbook.xlsx.writeBuffer(), entryCount: 0 }
  }

  // Clones the (now column-adjusted) sample row's style onto count new rows
  // inserted after it — the totals row below it, wherever it now sits, comes
  // along for the ride automatically since this is a real row insertion.
  worksheet.duplicateRow(SAMPLE_ROW, entries.length - 1, true)

  const totals = {
    basicWage: 0,
    income: new Array(income.length).fill(0) as number[],
    grossEarnings: 0,
    deduction: new Array(deduction.length).fill(0) as number[],
    totalDeductions: 0,
    netPay: 0,
  }

  entries.forEach((entry, i) => {
    const row = worksheet.getRow(SAMPLE_ROW + i)
    row.getCell(1).value = entry.employeeCode
    row.getCell(2).value = entry.employeeName
    row.getCell(3).value = entry.departmentName ?? '—'
    row.getCell(4).value = entry.jobTitle ?? '—'
    row.getCell(5).value = entry.startWorkingDate === null ? null : parseDateOnlyUtc(entry.startWorkingDate)
    row.getCell(6).value = entry.employmentType ?? '—'
    row.getCell(7).value = entry.workDaysDisplay
    row.getCell(8).value = entry.wageRate
    row.getCell(9).value = entry.basicWage
    income.forEach((def, idx) => {
      const amount = entry.lineAmounts.get(def.itemCode) ?? 0
      row.getCell(incomeResult.columns[idx]!).value = amount
      totals.income[idx]! += amount
    })
    row.getCell(grossTotalCol).value = entry.grossEarnings
    deduction.forEach((def, idx) => {
      const amount = entry.lineAmounts.get(def.itemCode) ?? 0
      row.getCell(deductionResult.columns[idx]!).value = amount
      totals.deduction[idx]! += amount
    })
    row.getCell(deductionTotalCol).value = entry.totalDeductions
    row.getCell(netPayCol).value = entry.netPay
    row.commit()

    totals.basicWage += entry.basicWage
    totals.grossEarnings += entry.grossEarnings
    totals.totalDeductions += entry.totalDeductions
    totals.netPay += entry.netPay
  })

  const totalRow = worksheet.getRow(SAMPLE_ROW + entries.length)
  // ค่าจ้าง (column 8) is a per-employee rate, not additive across different
  // people's wage types — left blank on the totals row rather than summed
  // into a meaningless figure.
  // totalRow.getCell(8).value = null
  totalRow.getCell(9).value = round2(totals.basicWage)
  income.forEach((_, idx) => {
    totalRow.getCell(incomeResult.columns[idx]!).value = round2(totals.income[idx]!)
  })
  totalRow.getCell(grossTotalCol).value = round2(totals.grossEarnings)
  deduction.forEach((_, idx) => {
    totalRow.getCell(deductionResult.columns[idx]!).value = round2(totals.deduction[idx]!)
  })
  totalRow.getCell(deductionTotalCol).value = round2(totals.totalDeductions)
  totalRow.getCell(netPayCol).value = round2(totals.netPay)
  totalRow.commit()

  return { buffer: await workbook.xlsx.writeBuffer(), entryCount: entries.length }
}
