import { useEffect, useRef, useState } from 'react'
import { EMPLOYEE_PHOTO_MAX_BYTES, EMPLOYEE_PHOTO_MIME_TYPES, type ShiftChangeRequest, type Shift } from '@hrm/shared'
import {
  cancelShiftChangeRequest,
  completeShiftChangeAttachmentUpload,
  deleteShiftChangeAttachment,
  fetchMyShiftChangeRequests,
  getShiftChangeAttachmentUrl,
  presignShiftChangeAttachmentUpload,
  submitShiftChangeRequest,
  updateShiftChangeRequest,
} from '../api/shiftChangeRequests'
import { fetchActiveShifts } from '../api/shifts'
import { ApiRequestError } from '../api/client'

type ListState =
  | { phase: 'loading' }
  | { phase: 'ready'; requests: ShiftChangeRequest[] }
  | { phase: 'error'; message: string }

type ShiftState =
  | { phase: 'loading' }
  | { phase: 'ready'; shifts: Shift[] }
  | { phase: 'error'; message: string }

function messageFor(err: unknown): string {
  if (err instanceof ApiRequestError) return err.message
  return 'เชื่อมต่อไม่สำเร็จ กรุณาลองใหม่อีกครั้ง'
}

/** Today, local device time, as 'YYYY-MM-DD' — same helper as the other
 *  request cards', under the same assumption that liff only ever runs on a
 *  phone set to Thailand time. */
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

function statusLabel(request: ShiftChangeRequest): string {
  if (request.status === 'pending') return 'รอดำเนินการ'
  if (request.status === 'approved') return 'อนุมัติแล้ว'
  if (request.status === 'cancelled') return 'ยกเลิกแล้ว'
  return `ปฏิเสธ: ${request.decisionReason ?? ''}`
}

function isAllowedMimeType(type: string): type is (typeof EMPLOYEE_PHOTO_MIME_TYPES)[number] {
  return (EMPLOYEE_PHOTO_MIME_TYPES as readonly string[]).includes(type)
}

export function ShiftChangeRequestCard() {
  const [listState, setListState] = useState<ListState>({ phase: 'loading' })
  const [mode, setMode] = useState<'list' | 'form'>('list')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [shiftState, setShiftState] = useState<ShiftState>({ phase: 'loading' })
  const [requestedDate, setRequestedDate] = useState(today())
  const [newShiftId, setNewShiftId] = useState(0)
  const [reason, setReason] = useState('')

  // Attachment already saved on the request being edited (null for a new
  // request, or once removed). attachmentFile is a newly picked file staged
  // to upload on the next submit — the two are independent so "remove" can
  // act immediately without waiting for the form to be saved.
  const [savedAttachmentKey, setSavedAttachmentKey] = useState<string | null>(null)
  const [attachmentPreviewUrl, setAttachmentPreviewUrl] = useState<string | null>(null)
  const [attachmentFile, setAttachmentFile] = useState<File | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetchMyShiftChangeRequests(controller.signal)
      .then((requests) => setListState({ phase: 'ready', requests }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setListState({ phase: 'error', message: messageFor(err) })
      })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (mode !== 'form') return
    const controller = new AbortController()
    fetchActiveShifts(controller.signal)
      .then((shifts) => {
        setShiftState({ phase: 'ready', shifts })
        setNewShiftId((prev) => (prev !== 0 ? prev : (shifts[0]?.id ?? 0)))
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setShiftState({ phase: 'error', message: messageFor(err) })
      })
    return () => controller.abort()
  }, [mode])

  function openCreateForm() {
    setEditingId(null)
    setRequestedDate(today())
    setNewShiftId(0)
    setReason('')
    setSavedAttachmentKey(null)
    setAttachmentPreviewUrl(null)
    setAttachmentFile(null)
    setError(null)
    setMode('form')
  }

  function openEditForm(request: ShiftChangeRequest) {
    setEditingId(request.id)
    setRequestedDate(request.requestedDate)
    setNewShiftId(request.newShiftId)
    setReason(request.reason)
    setSavedAttachmentKey(request.attachmentKey)
    setAttachmentPreviewUrl(null)
    setAttachmentFile(null)
    setError(null)
    setMode('form')

    if (request.attachmentKey !== null) {
      getShiftChangeAttachmentUrl(request.id)
        .then((url) => setAttachmentPreviewUrl(url))
        .catch(() => {
          // A stale preview is not worth surfacing an error banner over —
          // the "ดูรูปที่แนบไว้" link just won't render.
        })
    }
  }

  function handleFileSelected(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null
    event.target.value = ''
    if (!file) return

    if (!isAllowedMimeType(file.type)) {
      setError('รองรับเฉพาะไฟล์ JPEG, PNG หรือ WebP')
      return
    }
    if (file.size > EMPLOYEE_PHOTO_MAX_BYTES) {
      setError(`ไฟล์ต้องมีขนาดไม่เกิน ${Math.floor(EMPLOYEE_PHOTO_MAX_BYTES / (1024 * 1024))} MB`)
      return
    }
    setError(null)
    setAttachmentFile(file)
  }

  async function removeSavedAttachment() {
    if (editingId === null) return
    setBusy(true)
    try {
      await deleteShiftChangeAttachment(editingId)
      setSavedAttachmentKey(null)
      setAttachmentPreviewUrl(null)
    } catch (err) {
      setError(messageFor(err))
    } finally {
      setBusy(false)
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!newShiftId) return
    setBusy(true)
    setError(null)
    try {
      let request =
        editingId === null
          ? await submitShiftChangeRequest({ requestedDate, newShiftId, reason })
          : await updateShiftChangeRequest(editingId, { requestedDate, newShiftId, reason })

      if (attachmentFile) {
        const { uploadUrl, key } = await presignShiftChangeAttachmentUpload(request.id, {
          mimeType: attachmentFile.type as (typeof EMPLOYEE_PHOTO_MIME_TYPES)[number],
          sizeBytes: attachmentFile.size,
        })
        const putRes = await fetch(uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': attachmentFile.type },
          body: attachmentFile,
        })
        if (!putRes.ok) throw new Error('อัปโหลดไฟล์ไปยังที่จัดเก็บไม่สำเร็จ')
        request = await completeShiftChangeAttachmentUpload(request.id, key)
      }

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
    if (!confirm('ยกเลิกคำขอเปลี่ยนกะนี้?')) return
    setBusy(true)
    try {
      const updated = await cancelShiftChangeRequest(id)
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

  async function viewAttachment(id: number) {
    try {
      const url = await getShiftChangeAttachmentUrl(id)
      if (url) window.open(url, '_blank', 'noopener,noreferrer')
    } catch (err) {
      alert(messageFor(err))
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
                ขอเปลี่ยนกะ
              </button>

              {listState.requests.length === 0 ? (
                <p className="hint">ยังไม่มีคำขอเปลี่ยนกะ</p>
              ) : (
                <ul className="leave-list">
                  {listState.requests.map((request) => (
                    <li key={request.id} className={`leave-item ${request.status}`}>
                      <div className="leave-item-head">
                        <span>
                          {formatDate(request.requestedDate)} · {request.currentShiftName ?? 'ไม่มีกะ'} →{' '}
                          {request.newShiftName}
                        </span>
                        <span className="leave-item-status">{statusLabel(request)}</span>
                      </div>
                      {request.reason && <span className="leave-item-reason">{request.reason}</span>}
                      {request.attachmentKey !== null && (
                        <button type="button" className="attachment-link" onClick={() => void viewAttachment(request.id)}>
                          ดูรูปที่แนบไว้
                        </button>
                      )}
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
            วันที่ต้องการเปลี่ยนกะ
            <input
              type="date"
              value={requestedDate}
              min={today()}
              onChange={(e) => setRequestedDate(e.target.value)}
              required
              disabled={busy}
            />
          </label>

          <label>
            กะใหม่ที่ต้องการ
            {shiftState.phase === 'loading' && <span className="hint">กำลังโหลด…</span>}
            {shiftState.phase === 'error' && <span className="form-error">{shiftState.message}</span>}
            {shiftState.phase === 'ready' && (
              <select
                value={newShiftId || ''}
                onChange={(e) => setNewShiftId(Number(e.target.value))}
                disabled={busy}
                required
              >
                <option value="" disabled>
                  — เลือกกะ —
                </option>
                {shiftState.shifts.map((shift) => (
                  <option key={shift.id} value={shift.id}>
                    {shift.shiftName} ({shift.shiftStartTime.slice(0, 5)}-{shift.shiftEndTime.slice(0, 5)})
                  </option>
                ))}
              </select>
            )}
          </label>

          <label>
            เหตุผล
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} required rows={3} disabled={busy} />
          </label>

          <label>
            แนบรูปภาพ (ถ้ามี)
            <input
              ref={fileInputRef}
              type="file"
              accept={EMPLOYEE_PHOTO_MIME_TYPES.join(',')}
              onChange={handleFileSelected}
              disabled={busy}
            />
          </label>

          {attachmentFile && <p className="hint">เลือกไฟล์แล้ว: {attachmentFile.name} (จะอัปโหลดเมื่อกดส่งคำขอ)</p>}

          {savedAttachmentKey !== null && !attachmentFile && (
            <div className="attachment-existing">
              {attachmentPreviewUrl ? (
                <a href={attachmentPreviewUrl} target="_blank" rel="noopener noreferrer" className="attachment-link">
                  ดูรูปที่แนบไว้
                </a>
              ) : (
                <span className="hint">มีไฟล์แนบอยู่</span>
              )}
              <button type="button" className="leave-item-cancel" disabled={busy} onClick={() => void removeSavedAttachment()}>
                ลบไฟล์แนบ
              </button>
            </div>
          )}

          {error !== null && <p className="form-error">{error}</p>}

          <div className="correction-form-actions">
            <button type="submit" disabled={busy || !newShiftId}>
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
