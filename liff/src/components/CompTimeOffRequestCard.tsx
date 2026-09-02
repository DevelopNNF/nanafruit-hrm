import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { computeOvertimeMinutes, type CompTimeOffRequest } from '@hrm/shared'
import {
  cancelCompTimeOffRequest,
  fetchCompTimeBalance,
  fetchMyCompTimeOffRequests,
  submitCompTimeOffRequest,
  updateCompTimeOffRequest,
} from '../api/compTimeOffRequests'
import { ApiRequestError } from '../api/client'
import { RequestShell, type RequestListItem } from './RequestShell'
import { ConfirmModal } from './ConfirmModal'

type Props = {
  onBack: () => void
}

type ListState =
  | { phase: 'loading' }
  | { phase: 'ready'; requests: CompTimeOffRequest[] }
  | { phase: 'error'; message: string }

type BalanceState =
  | { phase: 'loading' }
  | { phase: 'ready'; availableMinutes: number }
  | { phase: 'error' }

function messageFor(err: unknown): string {
  if (err instanceof ApiRequestError) return err.message
  return 'เชื่อมต่อไม่สำเร็จ กรุณาลองใหม่อีกครั้ง'
}

/** Today in the device's own timezone, 'YYYY-MM-DD' — same reasoning as
 *  every other request card's today() helper. */
function today(): string {
  const now = new Date()
  const offsetMs = now.getTimezoneOffset() * 60_000
  return new Date(now.getTime() - offsetMs).toISOString().slice(0, 10)
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

export function CompTimeOffRequestCard({ onBack }: Props) {
  const [listState, setListState] = useState<ListState>({ phase: 'loading' })
  const [balanceState, setBalanceState] = useState<BalanceState>({ phase: 'loading' })
  const [mode, setMode] = useState<'list' | 'form'>('list')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [cancelId, setCancelId] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [offDate, setOffDate] = useState(today())
  const [startTime, setStartTime] = useState('09:00')
  const [endTime, setEndTime] = useState('12:00')
  const [reason, setReason] = useState('')
  // The minutes the request being edited already reserves against the fetched
  // balance — 0 when creating new. availableMinutes below is fetched once and
  // reflects the CURRENT set of pending requests, this one included, so its
  // own minutes must be added back the same way the server's PUT handler
  // does (excludeMinutes) or every edit of an unchanged request looks like it
  // exceeds a balance that was never actually available to begin with.
  const [editingOriginalMinutes, setEditingOriginalMinutes] = useState(0)

  function loadBalance(signal?: AbortSignal) {
    fetchCompTimeBalance(signal)
      .then((balance) => setBalanceState({ phase: 'ready', availableMinutes: balance.availableMinutes }))
      .catch(() => {
        if (signal?.aborted) return
        setBalanceState({ phase: 'error' })
      })
  }

  useEffect(() => {
    const controller = new AbortController()
    fetchMyCompTimeOffRequests(controller.signal)
      .then((requests) => setListState({ phase: 'ready', requests }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setListState({ phase: 'error', message: messageFor(err) })
      })
    loadBalance(controller.signal)
    return () => controller.abort()
  }, [])

  const preview = useMemo(() => computeOvertimeMinutes(startTime, endTime), [startTime, endTime])

  function openCreateForm() {
    setEditingId(null)
    setEditingOriginalMinutes(0)
    setOffDate(today())
    setStartTime('09:00')
    setEndTime('12:00')
    setReason('')
    setError(null)
    setMode('form')
  }

  function openEditForm(request: CompTimeOffRequest) {
    setEditingId(request.id)
    setEditingOriginalMinutes(request.requestedMinutes)
    setOffDate(request.offDate)
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
      const input = { offDate, startTime, endTime, reason }
      const request =
        editingId === null
          ? await submitCompTimeOffRequest(input)
          : await updateCompTimeOffRequest(editingId, input)

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
      loadBalance()
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
      const updated = await cancelCompTimeOffRequest(cancelId)
      setListState((prev) => ({
        phase: 'ready',
        requests:
          prev.phase === 'ready' ? prev.requests.map((r) => (r.id === cancelId ? updated : r)) : [updated],
      }))
      loadBalance()
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
          title: `${formatDate(request.offDate)} ${hhmm(request.startTime)}-${hhmm(request.endTime)}`,
          meta: formatHours(request.requestedMinutes),
          status: request.status,
          reason: request.reason,
          decisionNote:
            request.status === 'rejected' ? `เหตุผลจากผู้อนุมัติ: ${request.decisionReason ?? ''}` : undefined,
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

  const ruleText =
    balanceState.phase === 'ready'
      ? `ยอดวันหยุดสะสมคงเหลือ: ${formatHours(balanceState.availableMinutes)}`
      : balanceState.phase === 'error'
        ? 'โหลดยอดคงเหลือไม่สำเร็จ'
        : 'กำลังโหลดยอดคงเหลือ…'

  // Effective ceiling for the form in progress: the fetched balance plus
  // whatever this same request already reserves, when editing — see
  // editingOriginalMinutes' comment.
  const effectiveAvailableMinutes =
    balanceState.phase === 'ready' ? balanceState.availableMinutes + editingOriginalMinutes : null

  const exceedsBalance =
    effectiveAvailableMinutes !== null && preview !== null && preview > effectiveAvailableMinutes

  return (
    <>
      <RequestShell
        title="ใช้วันหยุดสะสม"
        englishTag="CompTimeOffRequestScreen"
        ruleText={ruleText}
        onBack={onBack}
        mode={mode}
        busy={busy}
        newLabel="ขอใช้วันหยุดสะสม"
        onOpenForm={openCreateForm}
        listPhase={listState.phase}
        listErrorMessage={listState.phase === 'error' ? listState.message : undefined}
        emptyText="ยังไม่มีคำขอใช้วันหยุดสะสม"
        items={items}
        onSubmit={(e) => void submit(e)}
        onCloseForm={() => setMode('list')}
        formError={error}
        submitLabel={editingId === null ? 'ส่งคำขอ' : 'บันทึกการแก้ไข'}
        canSubmit={preview !== null && preview > 0 && !exceedsBalance && reason.trim() !== ''}
        reasonLabel="เหตุผล *"
        reason={reason}
        onReasonChange={setReason}
      >
        <label className="field">
          <span>วันที่ต้องการหยุด</span>
          <input
            type="date"
            value={offDate}
            min={today()}
            onChange={(e) => setOffDate(e.target.value)}
            required
            disabled={busy}
          />
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

        {preview !== null && (
          <p className={`request-form-summary ${exceedsBalance ? 'conflict' : ''}`}>รวม {formatHours(preview)}</p>
        )}

        {exceedsBalance && (
          <p className="form-error">
            ยอดวันหยุดสะสมคงเหลือไม่พอ (คงเหลือ{' '}
            {effectiveAvailableMinutes !== null ? formatHours(effectiveAvailableMinutes) : ''})
          </p>
        )}
      </RequestShell>

      {cancelTarget && (
        <ConfirmModal
          title="ยกเลิกคำขอใช้วันหยุดสะสมนี้?"
          message={`${formatDate(cancelTarget.offDate)} ${hhmm(cancelTarget.startTime)}-${hhmm(cancelTarget.endTime)} — ยกเลิกแล้วจะกู้คืนไม่ได้ ต้องยื่นใหม่`}
          confirmLabel="ยกเลิกคำขอ"
          busy={busy}
          onConfirm={() => void confirmCancel()}
          onCancel={() => setCancelId(null)}
        />
      )}
    </>
  )
}
