import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import type { AttendanceImportBatch } from '@hrm/shared'
import { listAttendanceImportBatches } from '../api/attendanceImport'
import {
  alert,
  alertDetail,
  alertTitle,
  button,
  cardEmpty,
  eyebrow,
  muted,
  pageHead,
  subtitle,
} from '../styles'

type State =
  | { phase: 'loading' }
  | { phase: 'ok'; batches: AttendanceImportBatch[] }
  | { phase: 'error'; message: string }

const th =
  'border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-left text-[0.675rem] font-semibold tracking-wider text-slate-500 uppercase whitespace-nowrap'
const td = 'border-b border-slate-200 px-4 py-2.5 align-top text-[0.825rem] text-slate-600'

function formatDate(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString('th-TH', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
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

/**
 * Every accepted upload of a terminal's export.
 *
 * Read-only, and there is no undo: attendance_events is append-only by design,
 * so a wrong import is corrected the same way any other wrong punch is — with a
 * time correction. What this answers is "where did these punches come from, and
 * who loaded them".
 */
export function AttendanceImportHistoryPage() {
  const [state, setState] = useState<State>({ phase: 'loading' })

  useEffect(() => {
    const controller = new AbortController()
    listAttendanceImportBatches(controller.signal)
      .then((batches) => setState({ phase: 'ok', batches }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'request failed',
        })
      })
    return () => controller.abort()
  }, [])

  return (
    <>
      <header className={pageHead}>
        <div>
          <p className={eyebrow}>Time Attendance</p>
          <h1>ประวัติการนำเข้าการลงเวลา</h1>
          <p className={subtitle}>รายการไฟล์ที่นำเข้าจากเครื่องสแกนลายนิ้วมือ</p>
        </div>
        <Link className={button()} to="/attendance">
          <ArrowLeft size={16} /> กลับไปหน้าการลงเวลา
        </Link>
      </header>

      {state.phase === 'loading' && <p className={muted}>กำลังโหลด…</p>}

      {state.phase === 'error' && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>โหลดข้อมูลไม่สำเร็จ</p>
          <p className={alertDetail}>{state.message}</p>
        </div>
      )}

      {state.phase === 'ok' && state.batches.length === 0 && (
        <div className={`rounded-lg border border-slate-200 bg-white shadow-sm ${cardEmpty}`}>
          <p className="mb-1.5 font-semibold text-slate-900">ยังไม่มีการนำเข้าการลงเวลา</p>
          <p className={muted}>เมื่อนำเข้าไฟล์จากเครื่องสแกนแล้ว ประวัติจะแสดงที่นี่</p>
        </div>
      )}

      {state.phase === 'ok' && state.batches.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse [&_tbody_tr:last-child_td]:border-b-0">
              <thead>
                <tr>
                  {['นำเข้าเมื่อ', 'โดย', 'ไฟล์', 'ช่วงวันที่', 'พนักงาน', 'บันทึก', 'ข้ามซ้ำ', 'รหัสที่ไม่พบ'].map(
                    (h) => (
                      <th key={h} className={th}>
                        {h}
                      </th>
                    )
                  )}
                </tr>
              </thead>
              <tbody>
                {state.batches.map((batch) => (
                  <tr key={batch.id} className="hover:bg-slate-50">
                    <td className={`${td} whitespace-nowrap tabular-nums`}>
                      {formatDateTime(batch.importedAt)}
                    </td>
                    <td className={`${td} whitespace-nowrap`}>{batch.importedByName ?? '—'}</td>
                    <td className={`${td} max-w-[16rem] break-words text-slate-900`}>
                      {batch.fileName}
                    </td>
                    <td className={`${td} whitespace-nowrap tabular-nums`}>
                      {formatDate(batch.rangeFrom)} – {formatDate(batch.rangeTo)}
                    </td>
                    <td className={`${td} whitespace-nowrap tabular-nums`}>{batch.employeeCount}</td>
                    <td className={`${td} font-semibold whitespace-nowrap text-slate-900 tabular-nums`}>
                      {batch.eventCount}
                    </td>
                    <td className={`${td} whitespace-nowrap tabular-nums`}>
                      {batch.skippedDuplicateCount}
                    </td>
                    <td className={`${td} max-w-[14rem] break-words`}>
                      {batch.unmatchedCodes.length === 0 ? '—' : batch.unmatchedCodes.join(', ')}
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
