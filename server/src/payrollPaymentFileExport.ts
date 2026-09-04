// The payment file for one approved period: who to pay, how, and how much —
// split into a bank-transfer sheet and a cash/check sheet, since HR handles
// the two by completely different means (feed the first into their own
// banking system by hand, hand out the second in person).
//
// Deliberately not the SCB-specific bulk-transfer file format: nobody here
// has that spec yet. A plain two-sheet workbook is what HR asked for now;
// revisit when the bank's exact layout is available.
//
// No template, unlike payrollReportExport.ts — this shape is fixed (no
// per-period dynamic columns), so a workbook is built by hand rather than
// grown out of a placeholder.

import ExcelJS from 'exceljs'
import { listPayrollEntriesForPaymentFile } from './payrollReportQueries.js'
import { round2 } from './payrollEarnings.js'
import { PAYMENT_METHOD_LABELS } from './employeeFinanceLabels.js'

const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFE2E8F0' },
}

const CURRENCY_FORMAT = '#,##0.00'

function styleHeaderRow(row: ExcelJS.Row): void {
  row.eachCell((cell) => {
    cell.font = { bold: true }
    cell.fill = HEADER_FILL
  })
  row.commit()
}

export type PayrollPaymentFileWorkbook = {
  buffer: ExcelJS.Buffer
  transferCount: number
  otherCount: number
}

/**
 * The generated workbook, ready to send as
 * application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, plus how
 * many rows landed in each sheet — the caller needs both for its audit entry.
 */
export async function buildPayrollPaymentFileWorkbook(
  periodId: number
): Promise<PayrollPaymentFileWorkbook> {
  const rows = await listPayrollEntriesForPaymentFile(periodId)

  const transferRows = rows.filter((r) => r.paymentMethod === 'transfer')
  const otherRows = rows.filter((r) => r.paymentMethod !== 'transfer')

  const workbook = new ExcelJS.Workbook()

  const transferSheet = workbook.addWorksheet('โอนเงิน')
  transferSheet.columns = [
    { header: 'รหัสพนักงาน', key: 'code', width: 14 },
    { header: 'ชื่อ-สกุล', key: 'name', width: 28 },
    { header: 'ธนาคาร', key: 'bank', width: 22 },
    { header: 'เลขบัญชี', key: 'account', width: 18 },
    { header: 'สาขา', key: 'branch', width: 14 },
    { header: 'จำนวนเงิน', key: 'amount', width: 16, style: { numFmt: CURRENCY_FORMAT } },
  ]
  styleHeaderRow(transferSheet.getRow(1))
  let transferTotal = 0
  for (const r of transferRows) {
    transferSheet.addRow({
      code: r.employeeCode,
      name: r.employeeName,
      bank: r.bankName ?? '—',
      account: r.bankAccountNumber ?? '—',
      branch: r.bankBranchCode ?? '—',
      amount: r.netPay,
    })
    transferTotal += r.netPay
  }
  const transferTotalRow = transferSheet.addRow({ name: 'รวม', amount: round2(transferTotal) })
  transferTotalRow.font = { bold: true }
  transferTotalRow.commit()

  const otherSheet = workbook.addWorksheet('เงินสด-เช็ค')
  otherSheet.columns = [
    { header: 'รหัสพนักงาน', key: 'code', width: 14 },
    { header: 'ชื่อ-สกุล', key: 'name', width: 28 },
    { header: 'วิธีจ่าย', key: 'method', width: 16 },
    { header: 'จำนวนเงิน', key: 'amount', width: 16, style: { numFmt: CURRENCY_FORMAT } },
  ]
  styleHeaderRow(otherSheet.getRow(1))
  let otherTotal = 0
  for (const r of otherRows) {
    otherSheet.addRow({
      code: r.employeeCode,
      name: r.employeeName,
      method: r.paymentMethod ? PAYMENT_METHOD_LABELS[r.paymentMethod] : 'ไม่มีข้อมูล',
      amount: r.netPay,
    })
    otherTotal += r.netPay
  }
  const otherTotalRow = otherSheet.addRow({ name: 'รวม', amount: round2(otherTotal) })
  otherTotalRow.font = { bold: true }
  otherTotalRow.commit()

  return {
    buffer: await workbook.xlsx.writeBuffer(),
    transferCount: transferRows.length,
    otherCount: otherRows.length,
  }
}
