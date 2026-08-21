import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { DayOffSwapRequest } from '@hrm/shared'
import {
  cancelDayOffSwapRequest,
  fetchMyDayOffSwapRequests,
  submitDayOffSwapRequest,
  updateDayOffSwapRequest,
} from '../api/dayOffSwapRequests'
import { ApiRequestError } from '../api/client'
import { RequestShell, type RequestListItem } from './RequestShell'
import { ConfirmModal } from './ConfirmModal'

type Props = {
  onBack: () => void
}

type ListState =
  | { phase: 'loading' }
  | { phase: 'ready'; requests: DayOffSwapRequest[] }
  | { phase: 'error'; message: string }

function messageFor(err: unknown): string {
  if (err instanceof ApiRequestError) return err.message
  return 'เชื่อมต่อไม่สำเร็จ กรุณาลองใหม่อีกครั้ง'
}

/** Earliest date this request may use — today (local device time) + 3 days,
 *  the required minimum notice. Same local-timezone reasoning as the other
 *  request cards' today() helper. */
function minRequestDate(): string {
  const now = new Date()
  now.setDate(now.getDate() + 3)
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

export function DayOffSwapRequestCard({ onBack }: Props) {
  const [listState, setListState] = useState<ListState>({ phase: 'loading' })
  const [mode, setMode] = useState<'list' | 'form'>('list')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [cancelId, setCancelId] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [workDate, setWorkDate] = useState(minRequestDate())
  const [offDate, setOffDate] = useState(minRequestDate())
  const [reason, setReason] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    fetchMyDayOffSwapRequests(controller.signal)
      .then((requests) => setListState({ phase: 'ready', requests }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setListState({ phase: 'error', message: messageFor(err) })
      })
    return () => controller.abort()
  }, [])

  function openCreateForm() {
    setEditingId(null)
    setWorkDate(minRequestDate())
    setOffDate(minRequestDate())
    setReason('')
    setError(null)
    setMode('form')
  }

  function openEditForm(request: DayOffSwapRequest) {
    setEditingId(request.id)
    setWorkDate(request.workDate)
    setOffDate(request.offDate)
    setReason(request.reason)
    setError(null)
    setMode('form')
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const request =
        editingId === null
          ? await submitDayOffSwapRequest({ workDate, offDate, reason })
          : await updateDayOffSwapRequest(editingId, { workDate, offDate, reason })

      setListState((prev) => {
        const requests = prev.phase === 'ready' ? prev.requests : []
        const exists = requests.some((r) => r.id === request.id)
        return {
          phase: 'ready',
          requests: exists ? requests.map((r) => (r.id === request.id ? request : r)) : [request, ...requests],
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
      const updated = await cancelDayOffSwapRequest(cancelId)
      setListState((prev) => ({
        phase: 'ready',
        requests: prev.phase === 'ready' ? prev.requests.map((r) => (r.id === cancelId ? updated : r)) : [updated],
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
          title: `${formatDate(request.offDate)} (หยุด) → ${formatDate(request.workDate)} (ทำงาน)`,
          meta: '',
          status: request.status,
          reason: request.reason,
          decisionNote:
            request.status === 'rejected' ? `เหตุผลจากผู้อนุมัติ: ${request.decisionReason ?? ''}` : undefined,
          onEdit: request.status === 'pending' ? () => openEditForm(request) : undefined,
          onCancel: request.status === 'pending' ? () => setCancelId(request.id) : undefined,
        }))
      : []

  return (
    <>
      <RequestShell
        title="สลับวันหยุด"
        englishTag="DayOffSwapRequestScreen"
        ruleText="ต้องขอล่วงหน้าอย่างน้อย 3 วัน · แก้ไข/ยกเลิกได้ขณะรอดำเนินการ"
        onBack={onBack}
        mode={mode}
        busy={busy}
        newLabel="ขอสลับวันหยุด"
        onOpenForm={openCreateForm}
        listPhase={listState.phase}
        listErrorMessage={listState.phase === 'error' ? listState.message : undefined}
        emptyText="ยังไม่มีคำขอสลับวันหยุด"
        items={items}
        onSubmit={(e) => void submit(e)}
        onCloseForm={() => setMode('list')}
        formError={error}
        submitLabel={editingId === null ? 'ส่งคำขอ' : 'บันทึกการแก้ไข'}
        canSubmit={reason.trim() !== ''}
        reasonLabel="เหตุผล *"
        reason={reason}
        onReasonChange={setReason}
      >
        <label className="field">
          <span>วันทำงานเดิม → ขอเป็นวันหยุด</span>
          <input
            type="date"
            value={offDate}
            min={minRequestDate()}
            onChange={(e) => setOffDate(e.target.value)}
            required
            disabled={busy}
          />
        </label>

        <label className="field">
          <span>วันหยุด → ขอเป็นวันทำงาน</span>
          <input
            type="date"
            value={workDate}
            min={minRequestDate()}
            onChange={(e) => setWorkDate(e.target.value)}
            required
            disabled={busy}
          />
        </label>
      </RequestShell>

      {cancelTarget && (
        <ConfirmModal
          title="ยกเลิกคำขอสลับวันหยุดนี้?"
          message={`${formatDate(cancelTarget.offDate)} (หยุด) → ${formatDate(cancelTarget.workDate)} (ทำงาน) — ยกเลิกแล้วจะกู้คืนไม่ได้ ต้องยื่นใหม่`}
          confirmLabel="ยกเลิกคำขอ"
          busy={busy}
          onConfirm={() => void confirmCancel()}
          onCancel={() => setCancelId(null)}
        />
      )}
    </>
  )
}
