import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  OVERTIME_BACKDATE_LIMIT_DAYS,
  computeOvertimeMinutes,
  findOvertimeShiftConflict,
  overtimeCrossesMidnight,
  type CalendarDay,
  type OvertimeRequest,
} from '@hrm/shared'
import {
  cancelOvertimeRequest,
  fetchMyOvertimeRequests,
  submitOvertimeRequest,
  updateOvertimeRequest,
} from '../api/overtimeRequests'
import { fetchMonthCalendar } from '../api/calendar'
import { ApiRequestError } from '../api/client'
import { DAY_STATUS_LABEL } from '../lib/calendarDayStatus'
import { RequestShell, type RequestListItem } from './RequestShell'
import { ConfirmModal } from './ConfirmModal'

type Props = {
  onBack: () => void
}

type ListState =
  | { phase: 'loading' }
  | { phase: 'ready'; requests: OvertimeRequest[] }
  | { phase: 'error'; message: string }

function messageFor(err: unknown): string {
  if (err instanceof ApiRequestError) return err.message
  return 'เชื่อมต่อไม่สำเร็จ กรุณาลองใหม่อีกครั้ง'
}

/** Today in the device's own timezone, 'YYYY-MM-DD'. Same local-timezone
 *  reasoning as the other request cards' today() helper. */
function today(): string {
  const now = new Date()
  const offsetMs = now.getTimezoneOffset() * 60_000
  return new Date(now.getTime() - offsetMs).toISOString().slice(0, 10)
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** Earliest date a request may carry — the backdating limit the server
 *  enforces, applied here too so the picker cannot offer a date that would
 *  only be refused. */
function minRequestDate(): string {
  return addDays(today(), -OVERTIME_BACKDATE_LIMIT_DAYS)
}

function formatDate(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString('th-TH', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

function hhmm(time: string): string {
  return time.slice(0, 5)
}

function formatHours(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours === 0) return `${rest} นาที`
  if (rest === 0) return `${hours} ชั่วโมง`
  return `${hours} ชั่วโมง ${rest} นาที`
}

const RULE_TEXT = `ขอย้อนหลังได้ไม่เกิน ${OVERTIME_BACKDATE_LIMIT_DAYS} วัน · ช่วงเวลาที่ขอต้องอยู่นอกเวลาทำงานปกติ`

function monthKey(dateStr: string): string {
  return dateStr.slice(0, 7)
}

export function OvertimeRequestCard({ onBack }: Props) {
  const [listState, setListState] = useState<ListState>({ phase: 'loading' })
  const [mode, setMode] = useState<'list' | 'form'>('list')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [cancelId, setCancelId] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [otDate, setOtDate] = useState(today())
  const [startTime, setStartTime] = useState('18:00')
  const [endTime, setEndTime] = useState('20:00')
  const [reason, setReason] = useState('')

  // Calendar months already fetched, keyed 'YYYY-MM'. The form needs the day
  // being requested AND both its neighbours (an overnight shift from the day
  // before reaches into this morning), and those neighbours can fall in an
  // adjacent month, so more than one month can be in play at once.
  const [months, setMonths] = useState<Record<string, CalendarDay[]>>({})

  useEffect(() => {
    const controller = new AbortController()
    fetchMyOvertimeRequests(controller.signal)
      .then((requests) => setListState({ phase: 'ready', requests }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setListState({ phase: 'error', message: messageFor(err) })
      })
    return () => controller.abort()
  }, [])

  // Months already fetched or in flight. A ref, not derived from `months`, so
  // the effect below does not have to depend on the state it writes — which
  // would abort its own second request every time the first one landed.
  const requestedMonths = useRef<Set<string>>(new Set())

  // Loads whatever months the current date needs and isn't holding yet. A
  // failure here is deliberately silent: the calendar only powers a hint and
  // an early warning, and the server refuses an invalid request either way —
  // so a request must never be blocked on it having loaded.
  useEffect(() => {
    if (mode !== 'form' || !/^\d{4}-\d{2}-\d{2}$/.test(otDate)) return
    const keys = new Set([addDays(otDate, -1), otDate, addDays(otDate, 1)].map(monthKey))

    for (const key of keys) {
      if (requestedMonths.current.has(key)) continue
      requestedMonths.current.add(key)
      const [year, month] = key.split('-').map(Number) as [number, number]
      fetchMonthCalendar(year, month)
        .then((days) => setMonths((prev) => ({ ...prev, [key]: days })))
        .catch(() => requestedMonths.current.delete(key))
    }
  }, [mode, otDate])

  const preview = useMemo(() => {
    const minutes = computeOvertimeMinutes(startTime, endTime)
    const days = Object.values(months).flat()
    const day = days.find((d) => d.date === otDate) ?? null
    const conflict =
      minutes === null ? null : findOvertimeShiftConflict(otDate, startTime, endTime, days)
    return { minutes, day, conflict }
  }, [otDate, startTime, endTime, months])

  function openCreateForm() {
    setEditingId(null)
    setOtDate(today())
    setStartTime('18:00')
    setEndTime('20:00')
    setReason('')
    setError(null)
    setMode('form')
  }

  function openEditForm(request: OvertimeRequest) {
    setEditingId(request.id)
    setOtDate(request.otDate)
    setStartTime(hhmm(request.startTime))
    setEndTime(hhmm(request.endTime))
    setReason(request.reason)
    setError(null)
    setMode('form')
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const input = { otDate, startTime, endTime, reason }
      const request =
        editingId === null
          ? await submitOvertimeRequest(input)
          : await updateOvertimeRequest(editingId, input)

      setListState((prev) => {
        const requests = prev.phase === 'ready' ? prev.requests : []
        const exists = requests.some((r) => r.id === request.id)
        return {
          phase: 'ready',
          requests: exists
            ? requests.map((r) => (r.id === request.id ? request : r))
            : [request, ...requests],
        }
      })
      setMode('list')
      toast(editingId === null ? 'ส่งคำขอแล้ว รอผู้อนุมัติ' : 'บันทึกการแก้ไขแล้ว')
    } catch (err) {
      setError(messageFor(err))
    } finally {
      setBusy(false)
    }
  }

  async function confirmCancel() {
    if (cancelId === null) return
    setBusy(true)
    try {
      const updated = await cancelOvertimeRequest(cancelId)
      setListState((prev) => ({
        phase: 'ready',
        requests:
          prev.phase === 'ready' ? prev.requests.map((r) => (r.id === cancelId ? updated : r)) : [updated],
      }))
      toast('ยกเลิกคำขอแล้ว')
    } catch (err) {
      alert(messageFor(err))
    } finally {
      setBusy(false)
      setCancelId(null)
    }
  }

  const cancelTarget =
    listState.phase === 'ready' ? listState.requests.find((r) => r.id === cancelId) ?? null : null

  const items: RequestListItem[] =
    listState.phase === 'ready'
      ? listState.requests.map((request) => ({
          id: request.id,
          title: `${formatDate(request.otDate)} ${hhmm(request.startTime)}-${hhmm(request.endTime)}${request.crossesMidnight ? ' (+1)' : ''}`,
          meta: formatHours(request.requestedMinutes),
          status: request.status,
          reason: request.reason,
          decisionNote:
            request.status === 'rejected' ? `เหตุผลจากผู้อนุมัติ: ${request.decisionReason ?? ''}` : undefined,
          // Once a supervisor has already forwarded this to HR (even though
          // status is still 'pending'), it's locked — see LeaveRequestCard's
          // onCancel comment for the full reasoning, which applies to edit
          // here too.
          onEdit:
            request.status === 'pending' && request.supervisorApprovedByName === null
              ? () => openEditForm(request)
              : undefined,
          onCancel:
            request.status === 'pending' && request.supervisorApprovedByName === null
              ? () => setCancelId(request.id)
              : undefined,
        }))
      : []

  return (
    <>
      <RequestShell
        title="ทำงานล่วงเวลา"
        englishTag="OvertimeRequestScreen"
        ruleText={RULE_TEXT}
        onBack={onBack}
        mode={mode}
        busy={busy}
        newLabel="ขอ OT"
        onOpenForm={openCreateForm}
        listPhase={listState.phase}
        listErrorMessage={listState.phase === 'error' ? listState.message : undefined}
        emptyText="ยังไม่มีคำขอ OT"
        items={items}
        onSubmit={(e) => void submit(e)}
        onCloseForm={() => setMode('list')}
        formError={error}
        submitLabel={editingId === null ? 'ส่งคำขอ' : 'บันทึกการแก้ไข'}
        canSubmit={preview.conflict === null && reason.trim() !== ''}
        reasonLabel="เหตุผล *"
        reason={reason}
        onReasonChange={setReason}
      >
        <label className="field">
          <span>วันที่ต้องการขอ OT</span>
          <input
            type="date"
            value={otDate}
            min={minRequestDate()}
            onChange={(e) => setOtDate(e.target.value)}
            required
            disabled={busy}
          />
          {preview.day !== null && (
            <span className="hint">
              {DAY_STATUS_LABEL[preview.day.status]}
              {preview.day.label !== null && ` — ${preview.day.label}`}
              {preview.day.shiftName !== null &&
                preview.day.shiftStartTime !== null &&
                ` · เวลาทำงานปกติ ${preview.day.shiftName} ${hhmm(preview.day.shiftStartTime)}-${hhmm(preview.day.shiftEndTime ?? '')}`}
            </span>
          )}
        </label>

        <div className="field-row">
          <label className="field">
            <span>เวลาเริ่ม</span>
            <input
              type="time"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              required
              disabled={busy}
            />
          </label>
          <label className="field">
            <span>เวลาสิ้นสุด</span>
            <input
              type="time"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              required
              disabled={busy}
            />
          </label>
        </div>

        {preview.minutes !== null && (
          <p className={`request-form-summary ${preview.conflict !== null ? 'conflict' : ''}`}>
            รวม {formatHours(preview.minutes)}
            {overtimeCrossesMidnight(startTime, endTime) && ' (ข้ามเที่ยงคืน)'}
            {preview.conflict === null && ' — ระบบคำนวณคร่าว ๆ ยอดจริงยึดตามที่อนุมัติ'}
          </p>
        )}

        {/* Warned about here rather than only on submit, because the server
            rejects this outright and the employee would otherwise fill in a
            reason before finding out. */}
        {preview.conflict !== null && (
          <p className="form-error">
            ช่วงเวลานี้ทับกับเวลาทำงานปกติ ({preview.conflict.shiftName}{' '}
            {hhmm(preview.conflict.shiftStartTime ?? '')}-{hhmm(preview.conflict.shiftEndTime ?? '')} ของวันที่{' '}
            {formatDate(preview.conflict.date)}) กรุณาเลือกช่วงเวลานอกเวลาทำงาน
          </p>
        )}
      </RequestShell>

      {cancelTarget && (
        <ConfirmModal
          title="ยกเลิกคำขอทำงานล่วงเวลานี้?"
          message={`${formatDate(cancelTarget.otDate)} ${hhmm(cancelTarget.startTime)}-${hhmm(cancelTarget.endTime)} — ยกเลิกแล้วจะกู้คืนไม่ได้ ต้องยื่นใหม่`}
          confirmLabel="ยกเลิกคำขอ"
          busy={busy}
          onConfirm={() => void confirmCancel()}
          onCancel={() => setCancelId(null)}
        />
      )}
    </>
  )
}
