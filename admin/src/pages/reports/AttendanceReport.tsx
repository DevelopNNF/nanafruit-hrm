import { useEffect, useMemo, useState } from 'react'
import {
  ATTENDANCE_DAILY_FILTERS,
  WORK_LOCATIONS,
  attendanceBadges,
  formatWorkMinutes,
  type AttendanceDailyFilter,
  type AttendanceDailyItem,
  type AttendanceDailySummary,
  type Department,
  type WorkLocation,
} from '@hrm/shared'
import { exportAttendanceDaily, listAttendanceDaily } from '../../api/attendanceDaily'
import { listDepartments } from '../../api/departments'
import { notify } from '../../notifications/notify'
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
  | { phase: 'ok'; days: AttendanceDailyItem[]; summary: AttendanceDailySummary; truncated: boolean }
  | { phase: 'error'; message: string }

const FILTER_LABEL: Record<AttendanceDailyFilter, string> = {
  present: 'ปกติ',
  late: 'มาสาย',
  early_leave: 'ออกก่อนเวลา',
  leave: 'มีการลา',
  absent: 'ขาดงาน',
  incomplete: 'ลงเวลาไม่ครบ',
  day_off: 'วันหยุด',
  unscheduled_work: 'ทำงานวันหยุด',
}

function toDateInput(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
}

/** Returns the default date range (26th of previous month to 25th of current month),
 *  matching the default window used by the attendance:compute job. */
function defaultRange(): { from: string; to: string } {
  const current_date = new Date()
  const year = current_date.getFullYear()
  const month = current_date.getMonth()
  const from = new Date(year, month, 1)
  const to = new Date(year, month + 1, 0)
  return { from: toDateInput(from), to: toDateInput(to) }
}

function formatDate(dateOnly: string): string {
  return new Date(`${dateOnly}T00:00:00`).toLocaleDateString('th-TH', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

/** 'HH:MM' in Thailand time. The instants come back as UTC ISO strings, and
 *  the org runs on Thailand time regardless of where the browser is. */
function formatTime(iso: string | null): string | null {
  if (iso === null) return null
  return new Date(iso).toLocaleTimeString('th-TH', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Bangkok',
  })
}

/** True when `end` lands on a later Thailand date than `start` — the marker
 *  that an overnight shift's clock-out belongs to the following day. */
function crossesMidnight(start: string | null, end: string | null): boolean {
  if (start === null || end === null) return false
  const day = (iso: string) =>
    new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' })
  return day(end) > day(start)
}

function formatStamp(iso: string | null): string {
  if (iso === null) return 'ยังไม่เคยประมวลผล'
  return new Date(iso).toLocaleString('th-TH', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Bangkok',
  })
}

const th =
  'border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-left text-[0.675rem] font-semibold tracking-wider text-slate-500 uppercase whitespace-nowrap'
const td = 'border-b border-slate-200 px-4 py-2.5 align-middle text-slate-600'

/** A period as "in – out", with each side coloured when it went wrong. */
function TimeRange({
  start,
  end,
  lateStart,
  earlyEnd,
}: {
  start: string | null
  end: string | null
  lateStart?: boolean
  earlyEnd?: boolean
}) {
  const startText = formatTime(start)
  const endText = formatTime(end)
  if (startText === null && endText === null) return <span className="text-slate-300">—</span>

  return (
    <span className="whitespace-nowrap tabular-nums">
      {startText === null ? (
        <span className="text-slate-300">—</span>
      ) : (
        <span className={lateStart ? 'font-medium text-amber-700' : undefined}>{startText}</span>
      )}
      {' – '}
      {endText === null ? (
        <span className="text-slate-300">—</span>
      ) : (
        <span className={earlyEnd ? 'font-medium text-amber-700' : undefined}>{endText}</span>
      )}
      {crossesMidnight(start, end) && <sup className="ml-0.5 text-[0.625rem] text-slate-400">+1</sup>}
    </span>
  )
}

export function AttendanceDailyListPage() {
  const initial = useMemo(defaultRange, [])
  const [fromDate, setFromDate] = useState(initial.from)
  const [toDate, setToDate] = useState(initial.to)
  const [departmentId, setDepartmentId] = useState<number | ''>('')
  const [status, setStatus] = useState<AttendanceDailyFilter | ''>('')
  const [workLocation, setWorkLocation] = useState<WorkLocation | ''>('')
  const [departments, setDepartments] = useState<Department[]>([])
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [exporting, setExporting] = useState(false)

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
  // until the new one lands, rather than flashing blank — same reasoning as
  // LeaveRequestListPage's tab effect.
  useEffect(() => {
    const controller = new AbortController()

    listAttendanceDaily(
      {
        fromDate,
        toDate,
        ...(departmentId !== '' && { departmentId }),
        ...(status !== '' && { status }),
        ...(workLocation !== '' && { workLocation }),
      },
      controller.signal
    )
      .then((body) => setState({ phase: 'ok', ...body }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setState({ phase: 'error', message: err instanceof Error ? err.message : 'request failed' })
      })

    return () => controller.abort()
  }, [fromDate, toDate, departmentId, status, workLocation])

  const summary = state.phase === 'ok' ? state.summary : null

  async function handleExport() {
    setExporting(true)
    try {
      const blob = await exportAttendanceDaily({
        fromDate,
        toDate,
        ...(departmentId !== '' && { departmentId }),
        ...(status !== '' && { status }),
        ...(workLocation !== '' && { workLocation }),
      })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `attendance-${fromDate}-to-${toDate}.xlsx`
      link.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      notify.error('ดาวน์โหลด Excel ไม่สำเร็จ', err instanceof Error ? err.message : undefined)
    } finally {
      setExporting(false)
    }
  }

  return (
    <>
      <header className={pageHead}>
        <div>
          <p className={eyebrow}>Attendance</p>
          <h1>รายงานการลงเวลา</h1>
          <p className={subtitle}>สรุปการลงเวลารายวัน เทียบกับกะที่พนักงานสังกัด</p>
        </div>
        {summary && (
          <div className="rounded-lg border border-navy/20 bg-navy/7 px-3 py-2 text-xs whitespace-nowrap text-navy">
            <span className="font-medium">ประมวลผลล่าสุด</span> {formatStamp(summary.lastComputedAt)}
          </div>
        )}
      </header>

      <div className="mb-4 grid grid-cols-1 gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
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
        <label className={fieldLabel}>
          <span>สถานะ</span>
          <select
            className={fieldControl}
            value={status}
            onChange={(e) => setStatus(e.target.value as AttendanceDailyFilter | '')}
          >
            <option value="">ทุกสถานะ</option>
            {ATTENDANCE_DAILY_FILTERS.map((f) => (
              <option key={f} value={f}>
                {FILTER_LABEL[f]}
              </option>
            ))}
          </select>
        </label>
        <label className={fieldLabel}>
          <span>สถานที่ปฏิบัติงาน</span>
          <select
            className={fieldControl}
            value={workLocation}
            onChange={(e) => setWorkLocation(e.target.value as WorkLocation | '')}
          >
            <option value="">ทุกสถานที่</option>
            {WORK_LOCATIONS.map((loc) => (
              <option key={loc} value={loc}>
                {loc}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-end">
          <button
            type="button"
            className={`${button('primary')} w-full`}
            disabled={exporting || state.phase !== 'ok' || state.days.length === 0}
            onClick={handleExport}
          >
            {exporting ? 'กำลังสร้างไฟล์…' : 'ดาวน์โหลด Excel'}
          </button>
        </div>
      </div>

      {summary && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {(
            [
              ['ทั้งหมด', summary.total, ''],
              ['ปกติ', summary.present, ''],
              ['มาสาย', summary.late, 'text-amber-700'],
              ['ออกก่อนเวลา', summary.earlyLeave, 'text-amber-700'],
              ['ขาดงาน', summary.absent, 'text-red-700'],
              ['ลงเวลาไม่ครบ', summary.incomplete, 'text-red-700'],
            ] as const
          ).map(([label, value, tone]) => (
            <div key={label} className="rounded-lg border border-slate-200 bg-white px-3.5 py-3 shadow-sm">
              <p className="text-xs text-slate-500">{label}</p>
              <p className={`mt-0.5 text-2xl font-medium tabular-nums ${tone || 'text-slate-900'}`}>{value}</p>
            </div>
          ))}
        </div>
      )}

      {state.phase === 'loading' && <p className={muted}>กำลังโหลด…</p>}

      {state.phase === 'error' && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>โหลดข้อมูลไม่สำเร็จ</p>
          <p className={alertDetail}>{state.message}</p>
        </div>
      )}

      {state.phase === 'ok' && state.days.length === 0 && (
        <div className={`rounded-lg border border-slate-200 bg-white shadow-sm ${cardEmpty}`}>
          <p className="mb-1.5 font-semibold text-slate-900">ไม่พบข้อมูลในช่วงที่เลือก</p>
          <p className={muted}>
            ลองขยายช่วงวันที่ หรือตรวจสอบว่ารันคำสั่งประมวลผล (attendance:compute) ครอบคลุมช่วงนี้แล้วหรือยัง
          </p>
        </div>
      )}

      {state.phase === 'ok' && state.days.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between gap-4 border-b border-slate-200 bg-slate-50 px-4 py-3.5">
            <p className="text-[0.775rem] whitespace-nowrap text-slate-500 tabular-nums">
              {state.summary.total} รายการ
              {state.truncated && ` (แสดง ${state.days.length} รายการแรก)`}
            </p>
            <p className="text-[0.775rem] whitespace-nowrap text-slate-500">เรียงตามรหัสพนักงาน แล้วจึงตามวันที่</p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[0.825rem] [&_tbody_tr:last-child_td]:border-b-0">
              <thead>
                <tr>
                  {['ชื่อพนักงาน', 'วันที่', 'เวลาเข้า – ออก', 'เวลาจริง', 'ชั่วโมงทำงานจริง', 'สถานะ'].map((h) => (
                    <th key={h} className={th}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {state.days.map((day) => {
                  const owed = day.expectedWorkMinutes
                  const worked = day.workedMinutes
                  const short = worked !== null && owed !== null && worked < owed
                  return (
                    <tr key={day.id} className="hover:bg-slate-50">
                      <td className={td}>
                        <div className="font-medium text-slate-900">{day.employeeName}</div>
                        <div className="text-[0.71rem] text-slate-400 tabular-nums">{day.employeeCode}</div>
                      </td>
                      <td className={td}>
                        <div className="whitespace-nowrap tabular-nums">{formatDate(day.workDate)}</div>
                        <div className="text-[0.71rem] text-slate-400">{day.shiftCode ?? '—'}</div>
                      </td>
                      <td className={td}>
                        <TimeRange start={day.effectiveCheckInAt} end={day.effectiveCheckOutAt} />
                        {day.leaveMinutes > 0 && day.expectedCheckInAt !== day.effectiveCheckInAt && (
                          <div className="text-[0.71rem] text-slate-400">
                            <span className="line-through">{formatTime(day.expectedCheckInAt)}</span> ตามกะ
                          </div>
                        )}
                      </td>
                      <td className={td}>
                        <TimeRange
                          start={day.actualCheckInAt}
                          end={day.actualCheckOutAt}
                          lateStart={day.lateMinutes > 0}
                          earlyEnd={day.earlyLeaveMinutes > 0}
                        />
                      </td>
                      <td className={td}>
                        {worked === null ? (
                          <span className="text-slate-300">—</span>
                        ) : (
                          <>
                            <div
                              className={`font-medium whitespace-nowrap tabular-nums ${short ? 'text-amber-700' : 'text-slate-900'}`}
                            >
                              {formatWorkMinutes(worked)}
                            </div>
                            {short && owed !== null && (
                              <div className="text-[0.71rem] whitespace-nowrap text-slate-400">
                                จาก {formatWorkMinutes(owed)}
                              </div>
                            )}
                          </>
                        )}
                      </td>
                      <td className={td}>
                        <div className="flex flex-wrap gap-1">
                          {attendanceBadges(day).map((b) => (
                            <span key={b.label} className={badge(b.tone)}>
                              {b.label}
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  )
}
