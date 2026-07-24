import { useEffect, useState } from 'react'
import type { AttendanceEvent, AttendanceEventType } from '@hrm/shared'
import { clockAttendance, fetchAttendanceStatus } from '../api/attendance'
import { ApiRequestError } from '../api/client'
import { getCurrentCoordinates, type CoordinatesResult } from '../lib/geolocation'
import { describeDevice } from '../lib/deviceInfo'

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; lastEvent: AttendanceEvent | null }
  | { phase: 'error'; message: string }

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

export function AttendanceCard() {
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [locationHint, setLocationHint] = useState<string | null>(null)

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
    } catch (err) {
      setError(messageFor(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card ok attendance-card">
      <p className="headline">ลงเวลาทำงาน</p>

      {state.phase === 'loading' && <p className="hint">กำลังโหลดสถานะ…</p>}

      {state.phase === 'error' && <p className="form-error">{state.message}</p>}

      {state.phase === 'ready' && (
        <>
          <p className="hint">
            {state.lastEvent
              ? `${state.lastEvent.eventType === 'check_in' ? 'เข้างานล่าสุด' : 'ออกงานล่าสุด'}: ${formatTime(state.lastEvent.eventTime)}`
              : 'ยังไม่มีประวัติการลงเวลา'}
          </p>

          <button
            type="button"
            className={`clock-button ${nextEventType(state.lastEvent)}`}
            disabled={busy}
            onClick={() => void submit(nextEventType(state.lastEvent))}
          >
            {busy
              ? 'กำลังบันทึก…'
              : nextEventType(state.lastEvent) === 'check_in'
                ? 'ลงเวลาเข้างาน'
                : 'ลงเวลาออกงาน'}
          </button>

          {error !== null && <p className="form-error">{error}</p>}
          {error === null && locationHint !== null && <p className="hint">{locationHint}</p>}
        </>
      )}
    </div>
  )
}
