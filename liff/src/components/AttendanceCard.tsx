import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { AttendanceEventType, AttendanceTodayStatus } from '@hrm/shared'
import { clockAttendance, fetchAttendanceStatus } from '../api/attendance'
import { ApiRequestError } from '../api/client'
import { getCurrentCoordinates, type CoordinatesResult } from '../lib/geolocation'
import { describeDevice } from '../lib/deviceInfo'
import { ConfirmModal } from './ConfirmModal'

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; today: AttendanceTodayStatus }
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

function formatTimeOnly(iso: string): string {
  return new Date(iso).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
}

/** The date heading follows `workDate`, not the device's own today — past
 *  midnight, still inside an overnight shift, the server reports last
 *  night's work-date, and labelling that "today" would misdescribe whose
 *  shift is on screen. Same local-parse convention as the other request
 *  cards' formatDate. */
function dateHeading(workDate: string): string {
  const d = new Date(`${workDate}T00:00:00`)
  return `${WEEKDAYS_FULL_TH[d.getDay()]}ที่ ${d.getDate()} ${MONTHS_SHORT_TH[d.getMonth()]}`
}

/** check_in and check_out alternate strictly — this is the only rule the
 *  client enforces; the server re-checks it against the real last event. */
function nextEventType(today: AttendanceTodayStatus): AttendanceEventType {
  return today.checkInAt !== null && today.checkOutAt === null ? 'check_out' : 'check_in'
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

export function AttendanceCard() {
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
      .then((today) => setState({ phase: 'ready', today }))
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
      // Optimistic patch of just the slot this event fills, rather than a
      // refetch — a refetch could in principle re-run chooseAttendanceWindow
      // and land on a different work-date than the one just clocked against,
      // which would be a stranger result than briefly trusting our own write.
      setState((prev) =>
        prev.phase === 'ready'
          ? {
              phase: 'ready',
              today:
                eventType === 'check_in'
                  ? { ...prev.today, checkInAt: event.eventTime, checkInEventId: event.id }
                  : { ...prev.today, checkOutAt: event.eventTime, checkOutEventId: event.id },
            }
          : prev
      )
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

  return (
    <div className="card ok attendance-card">
      {state.phase === 'loading' && <p className="hint">กำลังโหลดสถานะ…</p>}

      {state.phase === 'error' && <p className="form-error">{state.message}</p>}

      {state.phase === 'ready' && (
        <>
          <div className="day-card-head">
            <div>
              <p className="headline">{dateHeading(state.today.workDate)}</p>
              <p className="hint">
                {state.today.shiftStartAt && state.today.shiftEndAt
                  ? `กะ ${formatTimeOnly(state.today.shiftStartAt)}–${formatTimeOnly(state.today.shiftEndAt)}`
                  : 'ไม่มีกะที่กำหนดไว้'}
              </p>
            </div>
            <span
              className={`status-pill ${
                state.today.checkInAt === null
                  ? 'pending'
                  : state.today.checkOutAt === null
                    ? 'approved'
                    : 'cancelled'
              }`}
            >
              {state.today.checkInAt === null
                ? 'ยังไม่ลงเวลา'
                : state.today.checkOutAt === null
                  ? 'กำลังทำงาน'
                  : 'ลงเวลาครบแล้ว'}
            </span>
          </div>

          <div className="punch-grid">
            <div className="punch-box">
              <p className="punch-box-label">CHECK IN</p>
              <p className="punch-box-value">
                {state.today.checkInAt ? formatTimeOnly(state.today.checkInAt) : '—:—'}
              </p>
            </div>
            <div className="punch-box">
              <p className="punch-box-label">CHECK OUT</p>
              <p className="punch-box-value">
                {state.today.checkOutAt ? formatTimeOnly(state.today.checkOutAt) : '—:—'}
              </p>
            </div>
          </div>

          <button
            type="button"
            className={`clock-button ${nextEventType(state.today)}`}
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            {nextEventType(state.today) === 'check_in' ? 'ลงเวลาเข้างาน' : 'ลงเวลาออกงาน'}
          </button>

          {error !== null && <p className="form-error">{error}</p>}
          {error === null && locationHint !== null && <p className="hint">{locationHint}</p>}

          {confirming && (
            <ConfirmModal
              title={
                nextEventType(state.today) === 'check_in'
                  ? 'ยืนยันลงเวลาเข้างาน?'
                  : 'ยืนยันลงเวลาออกงาน?'
              }
              confirmLabel="ยืนยัน"
              busy={busy}
              onConfirm={() => void handleConfirm(nextEventType(state.today))}
              onCancel={() => setConfirming(false)}
            />
          )}
        </>
      )}
    </div>
  )
}
