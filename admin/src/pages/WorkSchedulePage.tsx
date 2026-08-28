import { useEffect, useState } from 'react'
import { CALENDAR_DAY_STATUSES, type CalendarDayStatus, type EmployeeWorkSchedule, type WorkScheduleDay } from '@hrm/shared'
import { getWorkSchedule } from '../api/schedule'
import { Pagination } from '../components/Pagination'
import { alert, alertDetail, alertTitle, eyebrow, fieldControl, fieldLabel, muted, pageHead, subtitle } from '../styles'

type State =
  | { phase: 'loading' }
  | { phase: 'ok'; employees: EmployeeWorkSchedule[]; total: number }
  | { phase: 'error'; message: string }

/** Matches the server's own default in scheduleQueries.ts. */
const DEFAULT_PAGE_SIZE = 20

const MONTH_LABELS = [
  'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม',
]

const STATUS_LABEL: Record<CalendarDayStatus, string> = {
  workday: 'กะปกติ',
  weekly_off: 'วันหยุดประจำสัปดาห์',
  holiday: 'วันหยุดบริษัท',
  leave: 'วันลา',
  swap_workday: 'สลับมาทำงาน',
  swap_dayoff: 'สลับวันหยุด',
}

// A grid cell's fill — deliberately its own palette, not liff's
// --day-workday/--day-weekly-off/--day-holiday tokens: those mean "what the
// employee actually did" on their own calendar, while this grid means "what
// their schedule says", so the same word (e.g. "workday") needs a different
// visual here.
const STATUS_CELL: Record<CalendarDayStatus, string> = {
  workday: 'bg-white text-navy font-medium',
  weekly_off: 'bg-slate-300 text-slate-500',
  holiday: 'bg-emerald-800 text-white',
  leave: 'bg-amber-200 text-amber-900',
  swap_workday: 'bg-sky-200 text-sky-900 font-medium',
  swap_dayoff: 'bg-purple-200 text-purple-900',
}

function cellText(day: WorkScheduleDay): string {
  switch (day.status) {
    case 'workday':
    case 'swap_workday':
      return day.shiftCode ?? ''
    case 'leave':
      return 'ลา'
    case 'swap_dayoff':
      return 'หยุด'
    default:
      return ''
  }
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate()
}

function formatDate(dateOnly: string): string {
  return new Date(`${dateOnly}T00:00:00`).toLocaleDateString('th-TH', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

const th =
  'border-b border-slate-200 bg-slate-50 px-2 py-2.5 text-center text-[0.675rem] font-semibold tracking-wider text-slate-500 whitespace-nowrap'

export function WorkSchedulePage() {
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [state, setState] = useState<State>({ phase: 'loading' })
  // True while a month/page/page-size change is in flight — used to disable
  // <Pagination> rather than resetting `state` to 'loading'.
  const [fetching, setFetching] = useState(true)

  // No reset to 'loading' when year/month/page changes: the previous month's
  // table stays up until the new one lands, rather than flashing blank —
  // same reasoning as AttendanceReport.tsx's filter effect.
  useEffect(() => {
    const controller = new AbortController()
    getWorkSchedule(year, month, { page, pageSize }, controller.signal)
      .then((body) => {
        setState({ phase: 'ok', employees: body.employees, total: body.total })
        setFetching(false)
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setState({ phase: 'error', message: err instanceof Error ? err.message : 'request failed' })
        setFetching(false)
      })
    return () => controller.abort()
  }, [year, month, page, pageSize])

  function handleMonthChange(next: number) {
    setFetching(true)
    setMonth(next)
    setPage(1)
  }

  function handleYearChange(next: number) {
    setFetching(true)
    setYear(next)
    setPage(1)
  }

  function goToPage(next: number) {
    setFetching(true)
    setPage(next)
  }

  function handlePageSizeChange(next: number) {
    setFetching(true)
    setPageSize(next)
    setPage(1)
  }

  const dayCount = daysInMonth(year, month)
  const dayNumbers = Array.from({ length: dayCount }, (_, i) => i + 1)
  const yearOptions = Array.from({ length: 4 }, (_, i) => now.getFullYear() - 2 + i)

  return (
    <>
      <header className={pageHead}>
        <div>
          <p className={eyebrow}>Schedule</p>
          <h1>ตารางการทำงาน</h1>
          <p className={subtitle}>กะของพนักงานทุกคนในเดือนที่เลือก</p>
        </div>
      </header>

      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <label className={fieldLabel}>
          <span>เดือน</span>
          <select
            className={fieldControl}
            value={month}
            onChange={(e) => handleMonthChange(Number(e.target.value))}
          >
            {MONTH_LABELS.map((label, i) => (
              <option key={label} value={i + 1}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className={fieldLabel}>
          <span>ปี</span>
          <select
            className={fieldControl}
            value={year}
            onChange={(e) => handleYearChange(Number(e.target.value))}
          >
            {yearOptions.map((y) => (
              <option key={y} value={y}>
                {y + 543}
              </option>
            ))}
          </select>
        </label>

        <div className="ml-auto flex flex-wrap gap-3 text-xs text-slate-600">
          {CALENDAR_DAY_STATUSES.map((s) => (
            <div key={s} className="flex items-center gap-1.5">
              <span className={`inline-block h-3 w-3 rounded-sm border border-slate-300 ${STATUS_CELL[s]}`} />
              {STATUS_LABEL[s]}
            </div>
          ))}
        </div>
      </div>

      {state.phase === 'loading' && <p className={muted}>กำลังโหลด…</p>}

      {state.phase === 'error' && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>โหลดข้อมูลไม่สำเร็จ</p>
          <p className={alertDetail}>{state.message}</p>
        </div>
      )}

      {state.phase === 'ok' && (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[0.75rem] [&_tbody_tr:last-child_td]:border-b-0">
              <thead>
                <tr>
                  <th className={`${th} sticky left-0 z-10 text-left`}>พนักงาน</th>
                  {dayNumbers.map((d) => (
                    <th key={d} className={`${th} w-9`}>
                      {d}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {state.employees.map((emp) => (
                  <tr key={emp.employeeId}>
                    <td className="sticky left-0 z-10 border-b border-slate-200 bg-white px-3 py-2 whitespace-nowrap text-slate-900">
                      <div className="font-medium">{emp.fullName}</div>
                      <div className="text-[0.7rem] text-slate-400 tabular-nums">{emp.employeeCode}</div>
                    </td>
                    {emp.days.slice(0, dayCount).map((day) => (
                      <td
                        key={day.date}
                        title={`${formatDate(day.date)} · ${STATUS_LABEL[day.status]}${day.label ? ` (${day.label})` : ''}`}
                        className={`border-b border-l border-slate-200 px-1 py-2 text-center tabular-nums ${STATUS_CELL[day.status]}`}
                      >
                        {cellText(day)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {state.total === 0 ? (
            <p className={`${muted} p-6 text-center`}>ไม่พบพนักงานสถานะ Active</p>
          ) : (
            <Pagination
              page={page}
              pageSize={pageSize}
              totalItems={state.total}
              onPageChange={goToPage}
              onPageSizeChange={handlePageSizeChange}
              pageSizeOptions={[10, 20, 50, 100]}
              disabled={fetching}
            />
          )}
        </div>
      )}
    </>
  )
}
