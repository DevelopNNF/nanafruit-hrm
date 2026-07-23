import { useEffect, useState } from 'react'
import type { AttendanceEventType, TimeCorrectionRequest } from '@hrm/shared'
import { fetchMyTimeCorrections, submitTimeCorrection } from './api/timeCorrections'
import { ApiRequestError } from './api/client'

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; requests: TimeCorrectionRequest[] }
  | { phase: 'error'; message: string }

function messageFor(err: unknown): string {
  if (err instanceof ApiRequestError) return err.message
  return 'เชื่อมต่อไม่สำเร็จ กรุณาลองใหม่อีกครั้ง'
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('th-TH', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function statusLabel(request: TimeCorrectionRequest): string {
  if (request.status === 'pending') return 'รอดำเนินการ'
  if (request.status === 'approved') return 'อนุมัติแล้ว'
  return `ปฏิเสธ: ${request.decisionReason ?? ''}`
}

/** Today, local device time, as 'YYYY-MM-DD' — the upper bound on the date
 *  picker, since a correction can never be for a moment that hasn't happened. */
function today(): string {
  const now = new Date()
  const offsetMs = now.getTimezoneOffset() * 60_000
  return new Date(now.getTime() - offsetMs).toISOString().slice(0, 10)
}

export function TimeCorrectionCard() {
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [mode, setMode] = useState<'list' | 'form'>('list')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [eventType, setEventType] = useState<AttendanceEventType>('check_in')
  const [reason, setReason] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    fetchMyTimeCorrections(controller.signal)
      .then((requests) => setState({ phase: 'ready', requests }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setState({ phase: 'error', message: messageFor(err) })
      })
    return () => controller.abort()
  }, [])

  function openForm() {
    setDate('')
    setTime('')
    setEventType('check_in')
    setReason('')
    setError(null)
    setMode('form')
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      // Combined in the device's local time — liff is mobile-only and the
      // employee's phone is assumed to be set to Thailand time, same
      // assumption the live clock-in flow already makes.
      const requestedEventTime = new Date(`${date}T${time}`).toISOString()
      const request = await submitTimeCorrection({ eventType, requestedEventTime, reason })
      setState((prev) => ({
        phase: 'ready',
        requests: [request, ...(prev.phase === 'ready' ? prev.requests : [])],
      }))
      setMode('list')
    } catch (err) {
      setError(messageFor(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card ok correction-card">
      <p className="headline">คำขอแก้ไขเวลา</p>

      {mode === 'list' && (
        <>
          {state.phase === 'loading' && <p className="hint">กำลังโหลด…</p>}
          {state.phase === 'error' && <p className="form-error">{state.message}</p>}

          {state.phase === 'ready' && (
            <>
              {state.requests.length === 0 ? (
                <p className="hint">ยังไม่มีคำขอแก้ไขเวลา</p>
              ) : (
                <ul className="correction-list">
                  {state.requests.map((request) => (
                    <li key={request.id} className={`correction-item ${request.status}`}>
                      <span>
                        {request.eventType === 'check_in' ? 'เข้างาน' : 'ออกงาน'} ·{' '}
                        {formatDateTime(request.requestedEventTime)}
                      </span>
                      <span className="correction-status">{statusLabel(request)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <button type="button" className="secondary-button" onClick={openForm}>
                ขอแก้ไขเวลา
              </button>
            </>
          )}
        </>
      )}

      {mode === 'form' && (
        <form onSubmit={(e) => void submit(e)} className="correction-form">
          <label>
            วันที่
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              max={today()}
              required
              disabled={busy}
            />
          </label>
          <label>
            เวลา
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} required disabled={busy} />
          </label>
          <label>
            ประเภท
            <select
              value={eventType}
              onChange={(e) => setEventType(e.target.value as AttendanceEventType)}
              disabled={busy}
            >
              <option value="check_in">เข้างาน</option>
              <option value="check_out">ออกงาน</option>
            </select>
          </label>
          <label>
            เหตุผล
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} required rows={3} disabled={busy} />
          </label>

          {error !== null && <p className="form-error">{error}</p>}

          <div className="correction-form-actions">
            <button type="submit" disabled={busy}>
              {busy ? 'กำลังส่ง…' : 'ส่งคำขอ'}
            </button>
            <button type="button" className="secondary-button" disabled={busy} onClick={() => setMode('list')}>
              ยกเลิก
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
