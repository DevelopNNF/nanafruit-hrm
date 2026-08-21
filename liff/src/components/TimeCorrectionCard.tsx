import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { AttendanceEventType, TimeCorrectionRequest } from '@hrm/shared'
import { fetchMyTimeCorrections, submitTimeCorrection } from '../api/timeCorrections'
import { ApiRequestError } from '../api/client'
import { RequestShell, type RequestListItem } from './RequestShell'

type Props = {
  onBack: () => void
}

type ListState =
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
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Today, local device time, as 'YYYY-MM-DD' — the upper bound on the date
 *  picker, since a correction can never be for a moment that hasn't happened. */
function today(): string {
  const now = new Date()
  const offsetMs = now.getTimezoneOffset() * 60_000
  return new Date(now.getTime() - offsetMs).toISOString().slice(0, 10)
}

export function TimeCorrectionCard({ onBack }: Props) {
  const [listState, setListState] = useState<ListState>({ phase: 'loading' })
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
      .then((requests) => setListState({ phase: 'ready', requests }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setListState({ phase: 'error', message: messageFor(err) })
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
      setListState((prev) => ({
        phase: 'ready',
        requests: [request, ...(prev.phase === 'ready' ? prev.requests : [])],
      }))
      setMode('list')
      toast('ส่งคำขอแล้ว รอผู้อนุมัติ')
    } catch (err) {
      setError(messageFor(err))
    } finally {
      setBusy(false)
    }
  }

  const items: RequestListItem[] =
    listState.phase === 'ready'
      ? listState.requests.map((request) => ({
          id: request.id,
          title: `${request.eventType === 'check_in' ? 'เข้างาน' : 'ออกงาน'} · ${formatDateTime(request.requestedEventTime)}`,
          meta: `ยื่น ${formatDateTime(request.createdAt)}`,
          status: request.status,
          reason: request.reason,
          decisionNote:
            request.status === 'rejected' ? `เหตุผลจากผู้อนุมัติ: ${request.decisionReason ?? ''}` : undefined,
        }))
      : []

  return (
    <RequestShell
      title="แก้ไขเวลา"
      englishTag="TimeCorrectionScreen"
      ruleText="ยื่นแล้วแก้ไขหรือยกเลิกเองไม่ได้ — ตรวจสอบให้ครบก่อนส่ง"
      onBack={onBack}
      mode={mode}
      busy={busy}
      newLabel="ขอแก้ไขเวลา"
      onOpenForm={openForm}
      listPhase={listState.phase}
      listErrorMessage={listState.phase === 'error' ? listState.message : undefined}
      emptyText="ยังไม่มีคำขอแก้ไขเวลา"
      items={items}
      onSubmit={(e) => void submit(e)}
      onCloseForm={() => setMode('list')}
      formError={error}
      submitLabel="ส่งคำขอ"
      canSubmit={date !== '' && time !== '' && reason.trim() !== ''}
      reasonLabel="เหตุผล *"
      reason={reason}
      onReasonChange={setReason}
    >
      <div className="field-row">
        <label className="field">
          <span>วันที่</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} max={today()} required disabled={busy} />
        </label>
        <label className="field">
          <span>เวลา</span>
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} required disabled={busy} />
        </label>
      </div>

      <div className="field">
        <span>ประเภท</span>
        <div className="chip-toggle">
          <button
            type="button"
            className={eventType === 'check_in' ? 'active' : ''}
            disabled={busy}
            onClick={() => setEventType('check_in')}
          >
            เข้างาน
          </button>
          <button
            type="button"
            className={eventType === 'check_out' ? 'active' : ''}
            disabled={busy}
            onClick={() => setEventType('check_out')}
          >
            ออกงาน
          </button>
        </div>
      </div>
    </RequestShell>
  )
}
