import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { TimeCorrectionListItem, TimeCorrectionStatus } from '@hrm/shared'
import { listTimeCorrections } from '../api/timeCorrections'
import { alert, alertDetail, alertTitle, badge, cardEmpty, eyebrow, muted, pageHead, subtitle } from '../styles'

type State =
  | { phase: 'loading' }
  | { phase: 'ok'; requests: TimeCorrectionListItem[] }
  | { phase: 'error'; message: string }

type TabValue = TimeCorrectionStatus | 'all'

const TABS: { value: TabValue; label: string }[] = [
  { value: 'pending', label: 'รอดำเนินการ' },
  { value: 'approved', label: 'อนุมัติแล้ว' },
  { value: 'rejected', label: 'ปฏิเสธแล้ว' },
  { value: 'all', label: 'ทั้งหมด' },
]

const STATUS_LABEL: Record<TimeCorrectionStatus, string> = {
  pending: 'รอดำเนินการ',
  approved: 'อนุมัติแล้ว',
  rejected: 'ปฏิเสธแล้ว',
}

function statusBadgeTone(status: TimeCorrectionStatus): 'pending' | 'active' | 'danger' {
  if (status === 'approved') return 'active'
  if (status === 'rejected') return 'danger'
  return 'pending'
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

const tabClass = (isActive: boolean) =>
  [
    'rounded-md px-3 py-1.5 text-[0.825rem] font-medium transition-colors',
    isActive ? 'bg-navy text-white' : 'text-slate-600 hover:bg-slate-100',
  ].join(' ')

export function TimeCorrectionListPage() {
  const [tab, setTab] = useState<TabValue>('pending')
  const [state, setState] = useState<State>({ phase: 'loading' })
  const navigate = useNavigate()

  // No setState({ phase: 'loading' }) at the top: the initial state already
  // is 'loading', and switching tabs just leaves the old table in place until
  // the new one is ready, rather than flashing blank — same reasoning as
  // AttendanceListPage's filter effect.
  useEffect(() => {
    const controller = new AbortController()

    listTimeCorrections(tab === 'all' ? undefined : tab, controller.signal)
      .then((requests) => setState({ phase: 'ok', requests }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'request failed',
        })
      })

    return () => controller.abort()
  }, [tab])

  return (
    <>
      <header className={pageHead}>
        <div>
          <p className={eyebrow}>Time Attendance</p>
          <h1>คำขอแก้ไขเวลา</h1>
          <p className={subtitle}>คำขอแก้ไข/เพิ่มเวลาเข้า-ออกงานจากพนักงาน รออนุมัติหรือปฏิเสธ</p>
        </div>
      </header>

      <div className="mb-5 flex flex-wrap gap-1.5 rounded-lg border border-slate-200 bg-white p-1.5 shadow-sm">
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            className={tabClass(tab === t.value)}
            onClick={() => setTab(t.value)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {state.phase === 'loading' && <p className={muted}>กำลังโหลด…</p>}

      {state.phase === 'error' && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>โหลดข้อมูลไม่สำเร็จ</p>
          <p className={alertDetail}>{state.message}</p>
        </div>
      )}

      {state.phase === 'ok' && state.requests.length === 0 && (
        <div className={`rounded-lg border border-slate-200 bg-white shadow-sm ${cardEmpty}`}>
          <p className="mb-1.5 font-semibold text-slate-900">ไม่พบคำขอในหมวดนี้</p>
          <p className={muted}>ลองเปลี่ยนแท็บด้านบน</p>
        </div>
      )}

      {state.phase === 'ok' && state.requests.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between gap-4 border-b border-slate-200 bg-slate-50 px-4 py-3.5">
            <p className="text-[0.775rem] whitespace-nowrap text-slate-500 tabular-nums">
              {state.requests.length} รายการ
              {state.requests.length === 500 && ' (แสดงล่าสุด 500 รายการ)'}
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[0.825rem] [&_tbody_tr:last-child_td]:border-b-0">
              <thead>
                <tr>
                  {['#', 'รหัสพนักงาน', 'ชื่อพนักงาน', 'ประเภท', 'วันเวลาที่ขอแก้ไข', 'เหตุผล', 'สถานะ'].map((h) => (
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
                {state.requests.map((request, index) => (
                  <tr
                    key={request.id}
                    onClick={() => void navigate(`/time-corrections/${request.id}`)}
                    className="cursor-pointer hover:bg-slate-50"
                  >
                    <td className="w-12 border-b border-slate-200 px-4 py-2.5 align-middle text-slate-500">
                      {index + 1}
                    </td>
                    <td className="border-b border-slate-200 px-4 py-2.5 align-middle font-medium text-slate-900">
                      {request.employeeCode}
                    </td>
                    <td className="border-b border-slate-200 px-4 py-2.5 align-middle text-slate-600">
                      {request.employeeName}
                    </td>
                    <td className="border-b border-slate-200 px-4 py-2.5 align-middle">
                      <span className={badge(request.eventType === 'check_in' ? 'active' : 'inactive')}>
                        {request.eventType === 'check_in' ? 'เข้างาน' : 'ออกงาน'}
                      </span>
                    </td>
                    <td className="border-b border-slate-200 px-4 py-2.5 align-middle whitespace-nowrap text-slate-600 tabular-nums">
                      {formatDateTime(request.requestedEventTime)}
                    </td>
                    <td className="max-w-64 truncate border-b border-slate-200 px-4 py-2.5 align-middle text-slate-600">
                      {request.reason}
                    </td>
                    <td className="border-b border-slate-200 px-4 py-2.5 align-middle">
                      <span className={badge(statusBadgeTone(request.status))}>{STATUS_LABEL[request.status]}</span>
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
