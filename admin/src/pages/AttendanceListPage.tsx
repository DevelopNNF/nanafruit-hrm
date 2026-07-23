import { useEffect, useState } from 'react'
import type { AttendanceListItem, Employee } from '@hrm/shared'
import { listAttendance } from '../api/attendance'
import { listEmployees } from '../api/employees'
import { alert, alertDetail, alertTitle, badge, cardEmpty, eyebrow, muted, pageHead, subtitle } from '../styles'

type State =
  | { phase: 'loading' }
  | { phase: 'ok'; events: AttendanceListItem[] }
  | { phase: 'error'; message: string }

/** Today, local time, as 'YYYY-MM-DD' — the default window is "today" rather
 *  than "everything", since the unfiltered table only keeps the 500 most
 *  recent rows and that fills up fast across a whole company. */
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
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [employees, setEmployees] = useState<Employee[]>([])
  const [employeeId, setEmployeeId] = useState<string>('')
  const [fromDate, setFromDate] = useState(today())
  const [toDate, setToDate] = useState(today())

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
      controller.signal
    )
      .then((events) => setState({ phase: 'ok', events }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'request failed',
        })
      })

    return () => controller.abort()
  }, [employeeId, fromDate, toDate])

  return (
    <>
      <header className={pageHead}>
        <div>
          <p className={eyebrow}>Time Attendance</p>
          <h1>การลงเวลา</h1>
          <p className={subtitle}>ประวัติการลงเวลาเข้า-ออกงานของพนักงาน</p>
        </div>
      </header>

      <div className="mb-5 flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-slate-600">
          พนักงาน
          <select
            className={selectClass}
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
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
          <input
            type="date"
            className={selectClass}
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
          />
        </label>

        <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-slate-600">
          ถึงวันที่
          <input
            type="date"
            className={selectClass}
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
          />
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
            <p className="text-[0.775rem] whitespace-nowrap text-slate-500 tabular-nums">
              {state.events.length} รายการ
              {state.events.length === 500 && ' (แสดงล่าสุด 500 รายการ)'}
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[0.825rem] [&_tbody_tr:last-child_td]:border-b-0">
              <thead>
                <tr>
                  {['#', 'รหัสพนักงาน', 'ชื่อพนักงาน', 'ประเภท', 'เวลา', 'กะ', 'พิกัด', 'จุดที่แมตช์', 'อุปกรณ์'].map((h) => (
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
                    <td className="border-b border-slate-200 px-4 py-2.5 align-middle whitespace-nowrap font-mono text-[0.775rem] text-slate-600 tabular-nums">
                      {event.latitude === null || event.longitude === null
                        ? '—'
                        : `${event.latitude.toFixed(5)}, ${event.longitude.toFixed(5)}`}
                    </td>
                    <td className="border-b border-slate-200 px-4 py-2.5 align-middle whitespace-nowrap text-slate-600">
                      {event.matchedLocationName === null
                        ? '—'
                        : `${event.matchedLocationName} (${event.distanceMeters?.toFixed(1)} ม.)`}
                    </td>
                    <td
                      className="max-w-52 truncate border-b border-slate-200 px-4 py-2.5 align-middle font-mono text-[0.775rem] text-slate-500"
                      title={event.deviceInfo ?? undefined}
                    >
                      {event.deviceInfo ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  )
}
