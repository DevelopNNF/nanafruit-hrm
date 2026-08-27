import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Upload } from 'lucide-react'
import type { AttendanceListItem, Employee } from '@hrm/shared'
import { listAttendance } from '../api/attendance'
import { listEmployees } from '../api/employees'
import { useCanWrite } from '../auth/meContext'
import { DatePicker } from '../components/DatePicker'
import { Pagination } from '../components/Pagination'
import {
  alert,
  alertDetail,
  alertTitle,
  badge,
  button,
  cardEmpty,
  eyebrow,
  link,
  muted,
  pageHead,
  subtitle,
} from '../styles'

type State =
  | { phase: 'loading' }
  | { phase: 'ok'; events: AttendanceListItem[]; total: number }
  | { phase: 'error'; message: string }

/** Matches the server's own default in attendanceQueries.ts. */
const DEFAULT_PAGE_SIZE = 50

/** Today, local time, as 'YYYY-MM-DD' — the default window is "today" rather
 *  than "everything": the unfiltered table now paginates instead of just
 *  truncating at 500, but a whole company's history is still not what this
 *  page is for browsing day-to-day. */
function today(): string {
  const now = new Date()
  const offsetMs = now.getTimezoneOffset() * 60_000
  return new Date(now.getTime() - offsetMs).toISOString().slice(0, 10)
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('th-TH', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const selectClass =
  'min-w-0 rounded-md border border-slate-300 bg-white px-2.5 py-2 text-[0.825rem] text-slate-900 hover:enabled:border-slate-500'

export function AttendanceListPage() {
  const canWrite = useCanWrite()
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [employees, setEmployees] = useState<Employee[]>([])
  const [employeeId, setEmployeeId] = useState<string>('')
  const [fromDate, setFromDate] = useState(today())
  const [toDate, setToDate] = useState(today())
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE)
  // True while a filter/page/page-size request is in flight — used to
  // disable <Pagination> rather than resetting `state` to 'loading'.
  const [fetching, setFetching] = useState(true)

  useEffect(() => {
    const controller = new AbortController()
    listEmployees(controller.signal)
      .then(setEmployees)
      .catch(() => {
        // The filter dropdown degrading to "all employees only" isn't worth a
        // page-level error — the table below still loads on its own.
      })
    return () => controller.abort()
  }, [])

  // No setState({ phase: 'loading' }) at the top: the initial state already
  // is 'loading', and a filter change re-running this just leaves the old
  // table in place until the new one is ready, rather than flashing blank.
  useEffect(() => {
    const controller = new AbortController()

    listAttendance(
      {
        ...(employeeId !== '' && { employeeId: Number(employeeId) }),
        ...(fromDate !== '' && { fromDate }),
        ...(toDate !== '' && { toDate }),
      },
      { page, pageSize },
      controller.signal
    )
      .then((body) => {
        setState({ phase: 'ok', events: body.events, total: body.total })
        setFetching(false)
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'request failed',
        })
        setFetching(false)
      })

    return () => controller.abort()
  }, [employeeId, fromDate, toDate, page, pageSize])

  // Every filter change resets back to page 1 — a new filter means a new
  // result set, and staying on e.g. page 4 of it would likely just be past
  // the end.
  function handleEmployeeChange(next: string) {
    setFetching(true)
    setEmployeeId(next)
    setPage(1)
  }

  function handleFromDateChange(next: string) {
    setFetching(true)
    setFromDate(next)
    setPage(1)
  }

  function handleToDateChange(next: string) {
    setFetching(true)
    setToDate(next)
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

  return (
    <>
      <header className={pageHead}>
        <div>
          <p className={eyebrow}>Time Attendance</p>
          <h1>การลงเวลา</h1>
          <p className={subtitle}>ประวัติการลงเวลาเข้า-ออกงานของพนักงาน</p>
        </div>
        <div className="flex items-center gap-3">
          <Link className={link} to="/attendance/imports">
            ประวัติการนำเข้า
          </Link>
          {canWrite && (
            <Link className={button('primary')} to="/attendance/import">
              <Upload size={16} /> นำเข้าการลงเวลา
            </Link>
          )}
        </div>
      </header>

      <div className="mb-5 flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-slate-600">
          พนักงาน
          <select
            className={selectClass}
            value={employeeId}
            onChange={(e) => handleEmployeeChange(e.target.value)}
          >
            <option value="">ทั้งหมด</option>
            {employees.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.employeeCode} — {emp.title}
                {emp.firstNameTh} {emp.lastNameTh}
              </option>
            ))}
          </select>
        </label>

        <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-slate-600">
          จากวันที่
          <DatePicker value={fromDate} onChange={handleFromDateChange} max={toDate || undefined} />
        </label>

        <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-slate-600">
          ถึงวันที่
          <DatePicker value={toDate} onChange={handleToDateChange} min={fromDate || undefined} />
        </label>
      </div>

      {state.phase === 'loading' && <p className={muted}>กำลังโหลด…</p>}

      {state.phase === 'error' && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>โหลดข้อมูลไม่สำเร็จ</p>
          <p className={alertDetail}>{state.message}</p>
        </div>
      )}

      {state.phase === 'ok' && state.events.length === 0 && (
        <div className={`rounded-lg border border-slate-200 bg-white shadow-sm ${cardEmpty}`}>
          <p className="mb-1.5 font-semibold text-slate-900">ไม่พบข้อมูลการลงเวลาในช่วงที่เลือก</p>
          <p className={muted}>ลองเปลี่ยนช่วงวันที่หรือพนักงาน</p>
        </div>
      )}

      {state.phase === 'ok' && state.events.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between gap-4 border-b border-slate-200 bg-slate-50 px-4 py-3.5">
            <p className="text-[0.775rem] whitespace-nowrap text-slate-500 tabular-nums">{state.total} รายการ</p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[0.825rem] [&_tbody_tr:last-child_td]:border-b-0">
              <thead>
                <tr>
                  {['#', 'รหัสพนักงาน', 'ชื่อพนักงาน', 'ประเภท', 'เวลา', 'กะ', 'จุดที่แมตช์', 'แหล่งที่มา'].map((h) => (
                    <th
                      key={h}
                      className="border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-left text-[0.675rem] font-semibold tracking-wider text-slate-500 uppercase whitespace-nowrap"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {state.events.map((event, index) => (
                  <tr key={event.id} className="hover:bg-slate-50">
                    <td className="w-12 border-b border-slate-200 px-4 py-2.5 align-middle text-slate-500">
                      {index + 1}
                    </td>
                    <td className="border-b border-slate-200 px-4 py-2.5 align-middle font-medium text-slate-900">
                      {event.employeeCode}
                    </td>
                    <td className="border-b border-slate-200 px-4 py-2.5 align-middle text-slate-600">
                      {event.employeeName}
                    </td>
                    <td className="border-b border-slate-200 px-4 py-2.5 align-middle">
                      <span className={badge(event.eventType === 'check_in' ? 'active' : 'inactive')}>
                        {event.eventType === 'check_in' ? 'เข้างาน' : 'ออกงาน'}
                      </span>
                    </td>
                    <td className="border-b border-slate-200 px-4 py-2.5 align-middle whitespace-nowrap text-slate-600 tabular-nums">
                      {formatDateTime(event.eventTime)}
                    </td>
                    <td className="border-b border-slate-200 px-4 py-2.5 align-middle whitespace-nowrap text-slate-600">
                      {event.shiftName ?? '—'}
                    </td>
                    <td className="border-b border-slate-200 px-4 py-2.5 align-middle whitespace-nowrap text-slate-600">
                      {event.matchedLocationName === null
                        ? '—'
                        : `${event.matchedLocationName} (${event.distanceMeters?.toFixed(1)} ม.)`}
                    </td>
                    <td className="border-b border-slate-200 px-4 py-2.5 align-middle whitespace-nowrap">
                      {event.source === 'admin_correction' ? (
                        <span className={badge('role')}>แก้ไขโดย HR</span>
                      ) : event.source === 'fingerprint_import' ? (
                        <span className={badge('pending')}>เครื่องสแกน</span>
                      ) : (
                        <span className={muted}>GPS</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Pagination
            page={page}
            pageSize={pageSize}
            totalItems={state.total}
            onPageChange={goToPage}
            onPageSizeChange={handlePageSizeChange}
            disabled={fetching}
          />
        </div>
      )}
    </>
  )
}
