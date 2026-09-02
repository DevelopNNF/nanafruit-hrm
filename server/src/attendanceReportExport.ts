// Fills server/templates/attendance-report-template.xlsx with a filtered,
// unlimited range of attendance_daily rows.
//
// The template owns every style choice — title font, header borders, and a
// pre-formatted sample row (row 3: font, borders, column number formats,
// including a real date format on the "วันที่" column) — so this module never
// touches a cell's .style, only its .value. worksheet.duplicateRow clones the
// sample row's formatting onto each data row, which is what keeps this file
// from needing to know anything about how the report should look.

import { fileURLToPath } from 'node:url'
import ExcelJS from 'exceljs'
import { attendanceBadges, formatWorkMinutes } from '@hrm/shared'
import {
  listAttendanceDailyForExport,
  type AttendanceDailyExportRow,
  type AttendanceDailyFilterInput,
} from './attendanceDailyQueries.js'
import { parseDateOnlyUtc } from './leaveRequestQueries.js'

// Resolved relative to this module, so it lands on server/templates whether
// running from src/ (tsx, dev) or dist/ (tsc build, prod) — same trick as
// migrate.ts's migrationsDir.
const TEMPLATE_PATH = fileURLToPath(new URL('../templates/attendance-report-template.xlsx', import.meta.url))

// Row 1 is the title, row 2 the header — both untouched here except for A1.
const SAMPLE_ROW = 3

function formatThaiDate(dateOnly: string): string {
  const [year, month, day] = dateOnly.split('-')
  return `${day}/${month}/${year}`
}

function formatTimeOfDay(iso: string): string {
  return new Date(iso).toLocaleTimeString('th-TH', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Bangkok',
  })
}

/** "08:27 - 17:34" from a pair of ISO instants, or "08:30 - 17:30" from a
 *  pair of ISO instants standing in for the shift's own window — same shape
 *  either way, so both the "เวลากะ" and "เวลาจริง" columns use this. Null in
 *  either half (no shift applied, or a punch never landed) reads as '—'
 *  rather than being handed to `new Date`, which turns a bare null into the
 *  epoch instead of failing loudly. */
function formatTimeRange(startAt: string | null, endAt: string | null): string {
  if (startAt === null && endAt === null) return '—'
  const startText = startAt === null ? '—' : formatTimeOfDay(startAt)
  const endText = endAt === null ? '—' : formatTimeOfDay(endAt)
  return `${startText} - ${endText}`
}

function writeRow(worksheet: ExcelJS.Worksheet, rowNumber: number, day: AttendanceDailyExportRow): void {
  const row = worksheet.getRow(rowNumber)
  let colNo = 1
  row.getCell(colNo++).value = day.employeeCode
  row.getCell(colNo++).value = day.employeeFingerprintCode
  row.getCell(colNo++).value = day.employeeName
  row.getCell(colNo++).value = day.startWorkingDate === null ? null : parseDateOnlyUtc(day.startWorkingDate)
  row.getCell(colNo++).value = day.endWorkingDate === null ? null : parseDateOnlyUtc(day.endWorkingDate)
  row.getCell(colNo++).value = day.departmentName ?? '—'
  row.getCell(colNo++).value = day.jobTitle ?? '—'
  row.getCell(colNo++).value = day.workLocation ?? '—'
  row.getCell(colNo++).value = parseDateOnlyUtc(day.workDate)
  row.getCell(colNo++).value = day.shiftCode ?? day.shiftName ?? '—'
  row.getCell(colNo++).value = formatTimeRange(day.expectedCheckInAt, day.expectedCheckOutAt)
  row.getCell(colNo++).value = formatTimeRange(day.actualCheckInAt, day.actualCheckOutAt)
  row.getCell(colNo++).value = day.workedMinutes === null ? '—' : formatWorkMinutes(day.workedMinutes)
  row.getCell(colNo++).value = attendanceBadges(day)
    .map((b) => b.label)
    .join(', ')
  row.commit()
}

/**
 * The generated workbook as a buffer, ready to send as
 * application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.
 *
 * Queries listAttendanceDailyForExport rather than listAttendanceDaily — no
 * LIST_LIMIT, since an export handed to HR must not come back silently short.
 */
export async function buildAttendanceReportWorkbook(filter: AttendanceDailyFilterInput): Promise<ExcelJS.Buffer> {
  const days = await listAttendanceDailyForExport(filter)

  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(TEMPLATE_PATH)
  const worksheet = workbook.worksheets[0]
  if (!worksheet) throw new Error('attendance report template has no worksheet')

  const from = filter.fromDate ? formatThaiDate(filter.fromDate) : '—'
  const to = filter.toDate ? formatThaiDate(filter.toDate) : '—'
  worksheet.getCell('A1').value = `รายงานการลงเวลา ตั้งแต่วันที่ ${from} ถึง ${to}`

  if (days.length === 0) {
    // Nothing to clone the sample row into — drop it so the export doesn't
    // ship the template's placeholder employee as if it were real data.
    worksheet.spliceRows(SAMPLE_ROW, 1)
  } else {
    // Clones the sample row's style onto count new rows inserted after it;
    // the sample row itself becomes the first data row below.
    worksheet.duplicateRow(SAMPLE_ROW, days.length - 1, true)
    days.forEach((day, i) => writeRow(worksheet, SAMPLE_ROW + i, day))
  }

  return workbook.xlsx.writeBuffer()
}
