import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { AttendanceEvent, AttendanceEventType, Employee } from '@hrm/shared'
import { clockAttendance, fetchAttendanceStatus } from '../api/attendance'
import { ApiRequestError } from '../api/client'
import { getCurrentCoordinates, type CoordinatesResult } from '../lib/geolocation'
import { describeDevice } from '../lib/deviceInfo'
import { ConfirmModal } from './ConfirmModal'

type Props = {
  employee: Employee
}

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; lastEvent: AttendanceEvent | null }
  | { phase: 'error'; message: string }

const WEEKDAYS_FULL_TH = [
  'วันอาทิตย์', 'วันจันทร์', 'วันอังคาร', 'วันพุธ', 'วันพฤหัสบดี', 'วันศุกร์', 'วันเสาร์',
]
const MONTHS_SHORT_TH = [
  'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.',
]

function messageFor(err: unknown): string {
  if (err instanceof ApiRequestError) return err.message
  return 'เชื่อมต่อไม่สำเร็จ กรุณาลองใหม่อีกครั้ง'
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('th-TH', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatTimeOnly(iso: string): string {
  return new Date(iso).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
}

function todayHeading(): string {
  const now = new Date()
  return `${WEEKDAYS_FULL_TH[now.getDay()]}ที่ ${now.getDate()} ${MONTHS_SHORT_TH[now.getMonth()]}`
}

/** check_in and check_out alternate strictly — this is the only rule the
 *  client enforces; the server re-checks it against the real last event. */
function nextEventType(lastEvent: AttendanceEvent | null): AttendanceEventType {
  return lastEvent?.eventType === 'check_in' ? 'check_out' : 'check_in'
}

/** Shown after a successful clock event whose GPS fix didn't come through —
 *  never blocks the button, only explains why the coordinates column in
 *  admin/ is blank for this one. */
function locationHintFor(result: CoordinatesResult): string | null {
  if (result.ok) return null
  switch (result.reason) {
    case 'unsupported':
      return 'บันทึกเวลาแล้ว (อุปกรณ์นี้ไม่รองรับการระบุตำแหน่ง)'
    case 'denied':
      return 'บันทึกเวลาแล้ว (ไม่ได้รับสิทธิ์เข้าถึงตำแหน่ง ลองเปิดสิทธิ์ตำแหน่งที่ตั้งให้ LINE ในการตั้งค่าเครื่อง)'
    case 'timeout':
    case 'unavailable':
      return 'บันทึกเวลาแล้ว (ค้นหาตำแหน่งไม่สำเร็จ)'
  }
}

export function AttendanceCard({ employee }: Props) {
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [locationHint, setLocationHint] = useState<string | null>(null)
  // Gating submit() behind an explicit confirm tap is what stops the
  // repeated-tap-spam this replaces — the clock button itself no longer
  // fires a network call.
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    fetchAttendanceStatus(controller.signal)
      .then((lastEvent) => setState({ phase: 'ready', lastEvent }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setState({ phase: 'error', message: messageFor(err) })
      })
    return () => controller.abort()
  }, [])

  async function submit(eventType: AttendanceEventType) {
    setBusy(true)
    setError(null)
    setLocationHint(null)
    try {
      // A missing/denied GPS fix must not block the clock event — see
      // geolocation.ts — so this always proceeds to clockAttendance.
      const result = await getCurrentCoordinates()
      const event = await clockAttendance(eventType, result.ok ? result.coordinates : null, describeDevice())
      setState({ phase: 'ready', lastEvent: event })
      setLocationHint(locationHintFor(result))
      toast(eventType === 'check_in' ? 'ลงเวลาเข้างานสำเร็จแล้ว' : 'ลงเวลาออกงานสำเร็จแล้ว')
      return true
    } catch (err) {
      setError(messageFor(err))
      return false
    } finally {
      setBusy(false)
    }
  }

  async function handleConfirm(eventType: AttendanceEventType) {
    // Close either way: a failure is shown as `error` on the card itself,
    // which the modal overlay would otherwise hide from view.
    await submit(eventType)
    setConfirming(false)
  }

  const shiftStart = employee.employment.shiftStartTime?.slice(0, 5) ?? null
  const shiftEnd = employee.employment.shiftEndTime?.slice(0, 5) ?? null

  return (
    <div className="card ok attendance-card">
      <div className="day-card-head">
        <div>
          <p className="headline">{todayHeading()}</p>
          <p className="hint">
            {shiftStart && shiftEnd ? `กะ ${shiftStart}–${shiftEnd}` : 'ไม่มีกะที่กำหนดไว้'}
          </p>
        </div>

        {state.phase === 'ready' && (
          <span
            className={`status-pill ${
              state.lastEvent === null ? 'pending' : state.lastEvent.eventType === 'check_in' ? 'approved' : 'cancelled'
            }`}
          >
            {state.lastEvent === null
              ? 'ยังไม่ลงเวลา'
              : state.lastEvent.eventType === 'check_in'
                ? 'กำลังทำงาน'
                : 'ลงเวลาล่าสุดแล้ว'}
          </span>
        )}
      </div>

      {state.phase === 'loading' && <p className="hint">กำลังโหลดสถานะ…</p>}

      {state.phase === 'error' && <p className="form-error">{state.message}</p>}

      {state.phase === 'ready' && (
        <>
          <div className="punch-grid">
            <div className="punch-box">
              <p className="punch-box-label">CHECK IN</p>
              <p className="punch-box-value">
                {state.lastEvent?.eventType === 'check_in' ? formatTimeOnly(state.lastEvent.eventTime) : '—:—'}
              </p>
            </div>
            <div className="punch-box">
              <p className="punch-box-label">CHECK OUT</p>
              <p className="punch-box-value">
                {state.lastEvent?.eventType === 'check_out' ? formatTimeOnly(state.lastEvent.eventTime) : '—:—'}
              </p>
            </div>
          </div>

          <p className="hint">
            {state.lastEvent
              ? `${state.lastEvent.eventType === 'check_in' ? 'เข้างานล่าสุด' : 'ออกงานล่าสุด'}: ${formatTime(state.lastEvent.eventTime)}`
              : 'ยังไม่มีประวัติการลงเวลา'}
          </p>

          <button
            type="button"
            className={`clock-button ${nextEventType(state.lastEvent)}`}
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            {nextEventType(state.lastEvent) === 'check_in' ? 'ลงเวลาเข้างาน' : 'ลงเวลาออกงาน'}
          </button>

          {error !== null && <p className="form-error">{error}</p>}
          {error === null && locationHint !== null && <p className="hint">{locationHint}</p>}

          {confirming && (
            <ConfirmModal
              title={
                nextEventType(state.lastEvent) === 'check_in'
                  ? 'ยืนยันลงเวลาเข้างาน?'
                  : 'ยืนยันลงเวลาออกงาน?'
              }
              confirmLabel="ยืนยัน"
              busy={busy}
              onConfirm={() => void handleConfirm(nextEventType(state.lastEvent))}
              onCancel={() => setConfirming(false)}
            />
          )}
        </>
      )}
    </div>
  )
}
