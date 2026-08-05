import { useEffect, useState } from 'react'
import type { DayOffSwapRequest } from '@hrm/shared'
import {
  cancelDayOffSwapRequest,
  fetchMyDayOffSwapRequests,
  submitDayOffSwapRequest,
  updateDayOffSwapRequest,
} from '../api/dayOffSwapRequests'
import { ApiRequestError } from '../api/client'

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

function statusLabel(request: DayOffSwapRequest): string {
  if (request.status === 'pending') return 'รอดำเนินการ'
  if (request.status === 'approved') return 'อนุมัติแล้ว'
  if (request.status === 'cancelled') return 'ยกเลิกแล้ว'
  return `ปฏิเสธ: ${request.decisionReason ?? ''}`
}

export function DayOffSwapRequestCard() {
  const [listState, setListState] = useState<ListState>({ phase: 'loading' })
  const [mode, setMode] = useState<'list' | 'form'>('list')
  const [editingId, setEditingId] = useState<number | null>(null)
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
    } catch (err) {
      setError(messageFor(err))
    } finally {
      setBusy(false)
    }
  }

  async function cancel(id: number) {
    if (!confirm('ยกเลิกคำขอสลับวันหยุดนี้?')) return
    setBusy(true)
    try {
      const updated = await cancelDayOffSwapRequest(id)
      setListState((prev) => ({
        phase: 'ready',
        requests: prev.phase === 'ready' ? prev.requests.map((r) => (r.id === id ? updated : r)) : [updated],
      }))
    } catch (err) {
      alert(messageFor(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="leave-card">
      {mode === 'list' && (
        <>
          {listState.phase === 'loading' && <p className="hint">กำลังโหลด…</p>}
          {listState.phase === 'error' && <p className="form-error">{listState.message}</p>}

          {listState.phase === 'ready' && (
            <>
              <button type="button" className="secondary-button" onClick={openCreateForm}>
                ขอสลับวันหยุด
              </button>

              {listState.requests.length === 0 ? (
                <p className="hint">ยังไม่มีคำขอสลับวันหยุด</p>
              ) : (
                <ul className="leave-list">
                  {listState.requests.map((request) => (
                    <li key={request.id} className={`leave-item ${request.status}`}>
                      <div className="leave-item-head">
                        <span>
                          {formatDate(request.offDate)} (หยุด) → {formatDate(request.workDate)} (ทำงาน)  
                        </span>
                        <span className="leave-item-status">{statusLabel(request)}</span>
                      </div>
                      {request.reason && <span className="leave-item-reason">{request.reason}</span>}
                      {request.status === 'pending' && (
                        <div className="leave-item-actions">
                          <button
                            type="button"
                            className="leave-item-cancel"
                            disabled={busy}
                            onClick={() => openEditForm(request)}
                          >
                            แก้ไข
                          </button>
                          <button
                            type="button"
                            className="leave-item-cancel"
                            disabled={busy}
                            onClick={() => void cancel(request.id)}
                          >
                            ยกเลิกคำขอ
                          </button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      )}

      {mode === 'form' && (
        <form onSubmit={(e) => void submit(e)} className="correction-form">
          <label>
            วันทำงานเดิม
            <input
              type="date"
              value={offDate}
              min={minRequestDate()}
              onChange={(e) => setOffDate(e.target.value)}
              required
              disabled={busy}
            />
            <span className="hint">วันทำงานที่ต้องการเปลี่ยนเป็นวันหยุด</span>
          </label>

          <label>
            วันหยุดที่ต้องการสลับ
            <input
              type="date"
              value={workDate}
              min={minRequestDate()}
              onChange={(e) => setWorkDate(e.target.value)}
              required
              disabled={busy}
            />
            <span className="hint">วันหยุดบริษัท หรือวันหยุดประจำสัปดาห์ ที่ต้องการเปลี่ยนเป็นวันทำงาน</span>
          </label>

          <label>
            เหตุผล
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} required rows={3} disabled={busy} />
          </label>

          <span className="hint">หมายเหตุ: ต้องขอล่วงหน้าอย่างน้อย <span className='font-bold'>3</span> วัน</span>

          {error !== null && <p className="form-error">{error}</p>}

          <div className="correction-form-actions">
            <button type="submit" disabled={busy}>
              {busy ? 'กำลังส่ง…' : editingId === null ? 'ส่งคำขอ' : 'บันทึกการแก้ไข'}
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
