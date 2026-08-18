import { useEffect, useMemo, useState } from 'react'
import {
  OVERTIME_WEEKLY_CAP_MINUTES,
  type Department,
  type OvertimeReportResponse,
} from '@hrm/shared'
import { fetchOvertimeReport } from '../../api/overtimeReport'
import { listDepartments } from '../../api/departments'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs'
import {
  DAY_STATUS_LABEL,
  formatBaht,
  formatDecimalHours,
  formatOvertimeDate,
} from '../../overtimeFormat'
import {
  alert,
  alertDetail,
  alertTitle,
  badge,
  button,
  cardEmpty,
  eyebrow,
  fieldControl,
  fieldLabel,
  muted,
  pageHead,
  subtitle,
} from '../../styles'

type State =
  | { phase: 'loading' }
  | { phase: 'ok'; report: OvertimeReportResponse }
  | { phase: 'error'; message: string }

type TabValue = 'employee' | 'day' | 'week'

function toDateInput(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
}

/** The current calendar month. Overtime is settled per payroll period, and a
 *  month is what anyone asking for an OT report means by default — unlike the
 *  attendance report, whose window follows the batch job. */
function defaultRange(): { from: string; to: string } {
  const now = new Date()
  const from = new Date(now.getFullYear(), now.getMonth(), 1)
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 0)
  return { from: toDateInput(from), to: toDateInput(to) }
}

function formatStamp(iso: string | null): string {
  if (iso === null) return '—'
  return new Date(iso).toLocaleString('th-TH', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const th =
  'border-b border-slate-200 bg-slate-50 px-3 py-2.5 text-left text-[0.675rem] font-semibold tracking-wider text-slate-500 uppercase whitespace-nowrap'
const td = 'border-b border-slate-200 px-3 py-2.5 align-middle text-slate-600 whitespace-nowrap'
const tdNum = `${td} text-right tabular-nums`

/** RFC 4180 enough for Excel: quote everything, double the quotes inside. */
function toCsv(rows: (string | number | null)[][]): string {
  return rows
    .map((row) =>
      row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')
    )
    .join('\r\n')
}

function downloadCsv(filename: string, rows: (string | number | null)[][]): void {
  // BOM first, or Excel on Windows reads the Thai as mojibake.
  const blob = new Blob(['﻿' + toCsv(rows)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

export function OvertimeReport() {
  const initial = useMemo(() => defaultRange(), [])
  const [fromDate, setFromDate] = useState(initial.from)
  const [toDate, setToDate] = useState(initial.to)
  const [departmentId, setDepartmentId] = useState<number | ''>('')
  const [departments, setDepartments] = useState<Department[]>([])
  const [tab, setTab] = useState<TabValue>('employee')
  const [state, setState] = useState<State>({ phase: 'loading' })

  useEffect(() => {
    const controller = new AbortController()
    listDepartments(controller.signal)
      .then(setDepartments)
      .catch(() => {
        // A missing department list only costs one filter; the report itself
        // still works, so this stays silent rather than blocking the page.
      })
    return () => controller.abort()
  }, [])

  // No reset to 'loading' when the filters change: the previous table stays up
  // until the new one lands rather than flashing blank, same as the
  // attendance report.
  useEffect(() => {
    const controller = new AbortController()

    fetchOvertimeReport(
      { fromDate, toDate, ...(departmentId !== '' && { departmentId }) },
      controller.signal
    )
      .then((report) => setState({ phase: 'ok', report }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setState({ phase: 'error', message: err instanceof Error ? err.message : 'request failed' })
      })

    return () => controller.abort()
  }, [fromDate, toDate, departmentId])

  const report = state.phase === 'ok' ? state.report : null
  const summary = report?.summary ?? null

  function exportCsv() {
    if (report === null) return
    const rows: (string | number | null)[][] = [
      [
        'รหัสพนักงาน',
        'ชื่อพนักงาน',
        'แผนก',
        'กลุ่ม OT',
        'OT วันทำงาน (ชม.)',
        'ในเวลา วันหยุด (ชม.)',
        'นอกเวลา วันหยุด (ชม.)',
        'ในเวลา วันหยุดพิเศษ (ชม.)',
        'นอกเวลา วันหยุดพิเศษ (ชม.)',
        'รวม (ชม.)',
        'ค่าจ้าง/ชม.',
        'รวมเงิน',
      ],
      ...report.byEmployee.map((e) => [
        e.employeeCode,
        e.employeeName,
        e.departmentName,
        e.overtimeGroupName,
        formatDecimalHours(e.otWorkdayMinutes),
        formatDecimalHours(e.normalDayoffMinutes),
        formatDecimalHours(e.otDayoffMinutes),
        formatDecimalHours(e.normalHolidayMinutes),
        formatDecimalHours(e.otHolidayMinutes),
        formatDecimalHours(e.totalMinutes),
        e.hourlyWage,
        e.amount,
      ]),
    ]
    downloadCsv(`overtime-${fromDate}-to-${toDate}.csv`, rows)
  }

  return (
    <>
      <header className={pageHead}>
        <div>
          <p className={eyebrow}>Overtime</p>
          <h1>รายงาน OT</h1>
          <p className={subtitle}>
            ชั่วโมงล่วงเวลาที่อนุมัติแล้วและลงเวลาจริง แยกตามหมวดเรทค่าจ้าง
          </p>
        </div>
        {summary && (
          <div className="rounded-lg border border-navy/20 bg-navy/7 px-3 py-2 text-xs whitespace-nowrap text-navy">
            <span className="font-medium">ประมวลผลล่าสุด</span> {formatStamp(summary.lastComputedAt)}
          </div>
        )}
      </header>

      <div className="mb-4 grid grid-cols-1 gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-2 lg:grid-cols-4">
        <label className={fieldLabel}>
          <span>ตั้งแต่วันที่</span>
          <input
            type="date"
            className={fieldControl}
            value={fromDate}
            max={toDate}
            onChange={(e) => setFromDate(e.target.value)}
          />
        </label>
        <label className={fieldLabel}>
          <span>ถึงวันที่</span>
          <input
            type="date"
            className={fieldControl}
            value={toDate}
            min={fromDate}
            onChange={(e) => setToDate(e.target.value)}
          />
        </label>
        <label className={fieldLabel}>
          <span>แผนก</span>
          <select
            className={fieldControl}
            value={departmentId}
            onChange={(e) => setDepartmentId(e.target.value === '' ? '' : Number(e.target.value))}
          >
            <option value="">ทุกแผนก</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.deptName}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-end">
          <button
            type="button"
            className={`${button('default')} w-full`}
            disabled={report === null || report.byEmployee.length === 0}
            onClick={exportCsv}
          >
            ดาวน์โหลด CSV
          </button>
        </div>
      </div>

      {summary && (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="พนักงานที่มี OT" value={`${summary.employees} คน`} />
          <Stat label="รวมชั่วโมง OT" value={`${formatDecimalHours(summary.totalMinutes)} ชม.`} />
          <Stat label="รวมเงิน OT (บาท)" value={formatBaht(summary.totalAmount)} />
          <Stat
            label="ต้องตรวจสอบ"
            value={`${summary.daysUnderApproved + summary.weeksOverCap + summary.employeesMissingWage} รายการ`}
            tone={
              summary.daysUnderApproved + summary.weeksOverCap + summary.employeesMissingWage > 0
                ? 'warn'
                : 'plain'
            }
            hint={[
              summary.daysUnderApproved > 0 ? `ลงเวลาไม่ครบ ${summary.daysUnderApproved} วัน` : null,
              summary.weeksOverCap > 0 ? `เกิน 36 ชม. ${summary.weeksOverCap} สัปดาห์` : null,
              summary.employeesMissingWage > 0
                ? `ไม่มีข้อมูลค่าจ้าง ${summary.employeesMissingWage} คน`
                : null,
            ]
              .filter((s): s is string => s !== null)
              .join(' · ')}
          />
        </div>
      )}

      {state.phase === 'loading' && <p className={muted}>กำลังโหลด…</p>}

      {state.phase === 'error' && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>โหลดข้อมูลไม่สำเร็จ</p>
          <p className={alertDetail}>{state.message}</p>
        </div>
      )}

      {report !== null && report.byDay.length === 0 && (
        <div className={`rounded-lg border border-slate-200 bg-white shadow-sm ${cardEmpty}`}>
          <p className="mb-1.5 font-semibold text-slate-900">ไม่มี OT ในช่วงเวลานี้</p>
          <p className={muted}>
            รายงานนับเฉพาะคำขอ OT ที่อนุมัติแล้ว และคำนวณจากเวลาที่ลงจริง
          </p>
        </div>
      )}

      {report !== null && report.byDay.length > 0 && (
        <Tabs value={tab} onValueChange={(v) => setTab(v as TabValue)}>
          <TabsList>
            <TabsTrigger value="employee">สรุปรายคน</TabsTrigger>
            <TabsTrigger value="day">รายวัน</TabsTrigger>
            <TabsTrigger value="week">รายสัปดาห์ (เพดาน 36 ชม.)</TabsTrigger>
          </TabsList>

          <TabsContent value={tab}>
            <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
              <div className="overflow-x-auto">
                {tab === 'employee' && (
                  <table className="w-full border-collapse text-[0.825rem] [&_tbody_tr:last-child_td]:border-b-0">
                    <thead>
                      <tr>
                        <th className={th}>รหัส</th>
                        <th className={th}>ชื่อพนักงาน</th>
                        <th className={th}>แผนก</th>
                        <th className={`${th} text-right`}>OT วันทำงาน</th>
                        <th className={`${th} text-right`}>ในเวลา วันหยุด</th>
                        <th className={`${th} text-right`}>นอกเวลา วันหยุด</th>
                        <th className={`${th} text-right`}>ในเวลา วันหยุดพิเศษ</th>
                        <th className={`${th} text-right`}>นอกเวลา วันหยุดพิเศษ</th>
                        <th className={`${th} text-right`}>รวม (ชม.)</th>
                        <th className={`${th} text-right`}>ค่าจ้าง/ชม.</th>
                        <th className={`${th} text-right`}>รวมเงิน</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.byEmployee.map((e) => (
                        <tr key={e.employeeId} className="hover:bg-slate-50">
                          <td className={`${td} font-medium text-slate-900`}>{e.employeeCode}</td>
                          <td className={td}>{e.employeeName}</td>
                          <td className={td}>{e.departmentName ?? '—'}</td>
                          <td className={tdNum}>{formatDecimalHours(e.otWorkdayMinutes)}</td>
                          <td className={tdNum}>{formatDecimalHours(e.normalDayoffMinutes)}</td>
                          <td className={tdNum}>{formatDecimalHours(e.otDayoffMinutes)}</td>
                          <td className={tdNum}>{formatDecimalHours(e.normalHolidayMinutes)}</td>
                          <td className={tdNum}>{formatDecimalHours(e.otHolidayMinutes)}</td>
                          <td className={`${tdNum} font-semibold text-slate-900`}>
                            {formatDecimalHours(e.totalMinutes)}
                          </td>
                          <td className={tdNum}>
                            {e.hourlyWage === null ? (
                              <span
                                className="text-slate-400"
                                title="ค่าจ้างต่อชั่วโมงต่างกันในช่วงนี้ หรือยังไม่ได้กรอกข้อมูลการเงิน"
                              >
                                —
                              </span>
                            ) : (
                              formatBaht(e.hourlyWage)
                            )}
                          </td>
                          <td className={`${tdNum} font-semibold text-slate-900`}>
                            {formatBaht(e.amount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {tab === 'day' && (
                  <table className="w-full border-collapse text-[0.825rem] [&_tbody_tr:last-child_td]:border-b-0">
                    <thead>
                      <tr>
                        <th className={th}>วันที่</th>
                        <th className={th}>รหัส</th>
                        <th className={th}>ชื่อพนักงาน</th>
                        <th className={th}>ประเภทวัน</th>
                        <th className={`${th} text-right`}>ขอไว้ (ชม.)</th>
                        <th className={`${th} text-right`}>ทำจริง (ชม.)</th>
                        <th className={`${th} text-right`}>ในเวลา</th>
                        <th className={`${th} text-right`}>นอกเวลา</th>
                        <th className={th}>เรท</th>
                        <th className={`${th} text-right`}>เงิน</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.byDay.map((d) => {
                        const short = d.actualMinutes < d.approvedMinutes
                        return (
                          <tr key={`${d.employeeId}-${d.workDate}`} className="hover:bg-slate-50">
                            <td className={td}>{formatOvertimeDate(d.workDate)}</td>
                            <td className={`${td} font-medium text-slate-900`}>{d.employeeCode}</td>
                            <td className={td}>{d.employeeName}</td>
                            <td className={td}>{DAY_STATUS_LABEL[d.dayStatus]}</td>
                            <td className={tdNum}>{formatDecimalHours(d.approvedMinutes)}</td>
                            <td className={tdNum}>
                              <span className={short ? 'font-semibold text-amber-700' : undefined}>
                                {formatDecimalHours(d.actualMinutes)}
                              </span>
                              {short && (
                                <span className={`ml-2 ${badge('pending')}`}>ลงเวลาไม่ครบ</span>
                              )}
                            </td>
                            <td className={tdNum}>{formatDecimalHours(d.normalMinutes)}</td>
                            <td className={tdNum}>{formatDecimalHours(d.extraMinutes)}</td>
                            <td className={td}>
                              {d.normalMinutes > 0 ? `${d.normalRate}x / ` : ''}
                              {d.extraRate}x
                            </td>
                            <td className={`${tdNum} font-semibold text-slate-900`}>
                              {formatBaht(d.amount)}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}

                {tab === 'week' && (
                  <table className="w-full border-collapse text-[0.825rem] [&_tbody_tr:last-child_td]:border-b-0">
                    <thead>
                      <tr>
                        <th className={th}>รหัส</th>
                        <th className={th}>ชื่อพนักงาน</th>
                        <th className={th}>สัปดาห์ (จันทร์-อาทิตย์)</th>
                        <th className={`${th} text-right`}>รวม (ชม.)</th>
                        <th className={`${th} text-right`}>คงเหลือจาก 36 ชม.</th>
                        <th className={th}>สถานะ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.byWeek.map((w) => (
                        <tr key={`${w.employeeId}-${w.weekStart}`} className="hover:bg-slate-50">
                          <td className={`${td} font-medium text-slate-900`}>{w.employeeCode}</td>
                          <td className={td}>{w.employeeName}</td>
                          <td className={td}>
                            {formatOvertimeDate(w.weekStart)} – {formatOvertimeDate(w.weekEnd)}
                          </td>
                          <td className={`${tdNum} font-semibold text-slate-900`}>
                            {formatDecimalHours(w.totalMinutes)}
                          </td>
                          <td className={tdNum}>
                            {formatDecimalHours(
                              Math.max(OVERTIME_WEEKLY_CAP_MINUTES - w.totalMinutes, 0)
                            )}
                          </td>
                          <td className={td}>
                            {w.overCap ? (
                              <span className={badge('danger')}>เกินเพดาน 36 ชม.</span>
                            ) : (
                              <span className={badge('active')}>อยู่ในเกณฑ์</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </TabsContent>
        </Tabs>
      )}
    </>
  )
}

function Stat({
  label,
  value,
  tone = 'plain',
  hint,
}: {
  label: string
  value: string
  tone?: 'plain' | 'warn'
  hint?: string
}) {
  return (
    <div
      className={`rounded-lg border p-3 shadow-sm ${
        tone === 'warn' ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-white'
      }`}
    >
      <p className="text-[0.7rem] font-medium tracking-wide text-slate-500">{label}</p>
      <p
        className={`mt-1 text-lg font-semibold tabular-nums ${
          tone === 'warn' ? 'text-amber-800' : 'text-slate-900'
        }`}
      >
        {value}
      </p>
      {hint !== undefined && hint !== '' && (
        <p className="mt-0.5 text-[0.7rem] text-slate-500">{hint}</p>
      )}
    </div>
  )
}
