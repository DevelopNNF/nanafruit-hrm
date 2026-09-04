// Renders one payslip as a PDF buffer. Pure in the sense that matters here —
// no db, no clock (the "generated at" stamp is the one exception, and it's
// informational only, not something later logic reads back) — same house
// style as overtimeCalculation.ts/wageRate.ts, as close as a page-layout
// function can get to it.
//
// MVP layout: functional two-column income/deduction table, not a pixel-exact
// reproduction of a paper slip. Expect to revise the visual details once the
// user has looked at a real one.

import { fileURLToPath } from 'node:url'
import PDFDocument from 'pdfkit'
import type { PayrollEntry } from '@hrm/shared'
import { COMPANY_INFO } from './companyInfo.js'
import type { PayslipData } from './payslipData.js'

const FONT_REGULAR = fileURLToPath(new URL('../assets/fonts/Sarabun-Regular.ttf', import.meta.url))
const FONT_BOLD = fileURLToPath(new URL('../assets/fonts/Sarabun-Bold.ttf', import.meta.url))
const LOGO_PATH = fileURLToPath(new URL('../assets/logo/slip-logo-nana.png', import.meta.url))

const WAGE_TYPE_LABEL: Record<PayrollEntry['wageType'], string> = {
  monthly: 'รายเดือน',
  daily: 'รายวัน',
}

function formatAmount(amount: number): string {
  return amount.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** Same rendering as admin's formatThaiDate (payrollLabels.ts) — repeated here
 *  rather than shared, since shared/ carries types, not formatting helpers,
 *  and the two runtimes (browser Intl vs Node Intl) are worth keeping able to
 *  diverge without a cross-package dependency. */
function formatThaiDate(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00`).toLocaleDateString('th-TH-u-ca-buddhist', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

const PAGE_MARGIN = 40
const LOGO_SIZE = 46
const COL_GAP = 24

/**
 * @param generatedByLabel Who triggered this specific PDF — an admin's
 *   display name, or the employee's own name for a self-service download via
 *   LIFF. Printed in the footer next to the timestamp, the same accountability
 *   `recordAudit`'s payroll_entry.download_pdf entry already captures, just
 *   visible on the document itself.
 */
export async function renderPayslipPdf(data: PayslipData, generatedByLabel: string): Promise<Buffer> {
  const { entry } = data

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: PAGE_MARGIN })
    const pageWidth = doc.page.width
    const contentWidth = pageWidth - PAGE_MARGIN * 2
    const colWidth = (contentWidth - COL_GAP) / 2
    const rightColX = PAGE_MARGIN + colWidth + COL_GAP

    const chunks: Buffer[] = []
    doc.on('data', (chunk: Buffer) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    doc.registerFont('Sarabun', FONT_REGULAR)
    doc.registerFont('Sarabun-Bold', FONT_BOLD)
    doc.font('Sarabun')

    // ── Header: logo left, company letterhead beside it ──────────────
    const headerTop = doc.y
    const textX = PAGE_MARGIN + LOGO_SIZE + 14
    try {
      doc.image(LOGO_PATH, PAGE_MARGIN, headerTop, { width: LOGO_SIZE, height: LOGO_SIZE })
    } catch {
      // A missing/unreadable logo file should not fail the whole slip —
      // the letterhead text alone still identifies the company.
    }
    doc
      .font('Sarabun-Bold')
      .fontSize(14)
      .text(COMPANY_INFO.name, textX, headerTop, { width: contentWidth - LOGO_SIZE - 14 })
    doc
      .font('Sarabun')
      .fontSize(9)
      .text(COMPANY_INFO.address, textX, doc.y, { width: contentWidth - LOGO_SIZE - 14 })
      .text(`เลขประจำตัวผู้เสียภาษี ${COMPANY_INFO.taxId}`, textX, doc.y, {
        width: contentWidth - LOGO_SIZE - 14,
      })

    doc.y = Math.max(doc.y, headerTop + LOGO_SIZE) + 10
    doc
      .font('Sarabun-Bold')
      .fontSize(13)
      .text('สลิปเงินเดือน', PAGE_MARGIN, doc.y, { width: contentWidth, align: 'center' })
    doc
      .font('Sarabun')
      .fontSize(10)
      .text(
        `งวด ${data.periodCode} (${formatThaiDate(data.periodStart)} – ${formatThaiDate(data.periodEnd)}) · จ่ายวันที่ ${formatThaiDate(data.payDate)}`,
        PAGE_MARGIN,
        doc.y,
        { width: contentWidth, align: 'center' }
      )
    doc.moveDown(1)

    // ── Employee block ───────────────────────────────────────────────
    const empTop = doc.y
    doc.fontSize(9.5)
    doc.text(`รหัสพนักงาน: ${entry.employeeCode}`, PAGE_MARGIN, empTop, { width: colWidth })
    doc.text(`ชื่อ-สกุล: ${entry.employeeName}`, PAGE_MARGIN, doc.y, { width: colWidth })
    doc.text(`แผนก: ${data.departmentName ?? '—'}`, PAGE_MARGIN, doc.y, { width: colWidth })
    doc.text(`ตำแหน่ง: ${data.jobTitle ?? '—'}`, PAGE_MARGIN, doc.y, { width: colWidth })

    doc.text(`เลขบัตรประชาชน: ${data.idCardNumber ?? '—'}`, rightColX, empTop, { width: colWidth })
    doc.text(`ประเภทค่าจ้าง: ${WAGE_TYPE_LABEL[entry.wageType]}`, rightColX, doc.y, { width: colWidth })
    if (entry.wageType === 'daily') {
      doc.text(`วันที่ได้ค่าจ้าง: ${entry.workDays ?? 0} วัน`, rightColX, doc.y, { width: colWidth })
    } else {
      doc.text(
        `วันที่มีสภาพพนักงานในงวด: ${entry.employedDays ?? 0} วัน`,
        rightColX,
        doc.y,
        { width: colWidth }
      )
    }
    doc.text(`วันลาแบบมีเงิน: ${entry.paidLeaveDays ?? 0} วัน`, rightColX, doc.y, { width: colWidth })

    doc.moveDown(1)
    doc
      .moveTo(PAGE_MARGIN, doc.y)
      .lineTo(PAGE_MARGIN + contentWidth, doc.y)
      .strokeColor('#cccccc')
      .stroke()
    doc.moveDown(0.6)

    // ── Two-column income/deduction table ──────────────────────────
    const incomeLines = entry.lines.filter((l) => l.itemType === 'income')
    const deductionLines = entry.lines.filter((l) => l.itemType !== 'income')

    const tableTop = doc.y
    const leftBottom = renderColumn(doc, 'รายได้', incomeLines, PAGE_MARGIN, tableTop, colWidth)
    const rightBottom = renderColumn(doc, 'รายการหัก', deductionLines, rightColX, tableTop, colWidth)
    doc.y = Math.max(leftBottom, rightBottom)

    doc.moveDown(0.6)
    doc
      .moveTo(PAGE_MARGIN, doc.y)
      .lineTo(PAGE_MARGIN + contentWidth, doc.y)
      .strokeColor('#cccccc')
      .stroke()
    doc.moveDown(0.6)

    // ── Totals ───────────────────────────────────────────────────────
    totalRow(doc, 'รวมรับ', entry.grossEarnings, PAGE_MARGIN, contentWidth)
    totalRow(doc, 'รวมหัก', entry.totalDeductions, PAGE_MARGIN, contentWidth)
    doc.font('Sarabun-Bold')
    totalRow(doc, 'สุทธิ', entry.netPay, PAGE_MARGIN, contentWidth)
    doc.font('Sarabun')

    doc.moveDown(1.2)
    doc
      .fontSize(8)
      .fillColor('#888888')
      .text(
        `สร้างโดย ${generatedByLabel} เมื่อ ${new Date().toLocaleString('th-TH')} — เอกสารนี้สร้างจากระบบอัตโนมัติ`,
        PAGE_MARGIN,
        doc.y,
        { width: contentWidth, align: 'right' }
      )

    doc.end()
  })
}

function renderColumn(
  doc: PDFKit.PDFDocument,
  title: string,
  lines: { itemName: string; amount: number }[],
  x: number,
  y: number,
  width: number
): number {
  doc.font('Sarabun-Bold').fontSize(10).text(title, x, y, { width })
  doc.font('Sarabun').fontSize(9.5)
  if (lines.length === 0) {
    doc.fillColor('#999999').text('— ไม่มีรายการ —', x, doc.y, { width })
    doc.fillColor('#000000')
    return doc.y
  }
  for (const line of lines) {
    const rowY = doc.y
    doc.text(line.itemName, x, rowY, { width: width - 80 })
    doc.text(formatAmount(line.amount), x + width - 80, rowY, { width: 80, align: 'right' })
  }
  return doc.y
}

function totalRow(doc: PDFKit.PDFDocument, label: string, amount: number, marginX: number, contentWidth: number): void {
  const y = doc.y
  doc.fontSize(10.5).text(label, marginX, y, { width: contentWidth - 90 })
  doc.text(formatAmount(amount), marginX + contentWidth - 90, y, { width: 90, align: 'right' })
}
