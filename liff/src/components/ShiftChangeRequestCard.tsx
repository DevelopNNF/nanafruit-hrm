import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
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
import { RequestShell, type RequestListItem } from './RequestShell'
import { ConfirmModal } from './ConfirmModal'

type Props = {
  onBack: () => void
}

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

function isAllowedMimeType(type: string): type is (typeof EMPLOYEE_PHOTO_MIME_TYPES)[number] {
  return (EMPLOYEE_PHOTO_MIME_TYPES as readonly string[]).includes(type)
}

export function ShiftChangeRequestCard({ onBack }: Props) {
  const [listState, setListState] = useState<ListState>({ phase: 'loading' })
  const [mode, setMode] = useState<'list' | 'form'>('list')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [cancelId, setCancelId] = useState<number | null>(null)
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
      const updated = await cancelShiftChangeRequest(cancelId)
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

  async function viewAttachment(id: number) {
    try {
      const url = await getShiftChangeAttachmentUrl(id)
      if (url) window.open(url, '_blank', 'noopener,noreferrer')
    } catch (err) {
      alert(messageFor(err))
    }
  }

  const cancelTarget =
    listState.phase === 'ready' ? listState.requests.find((r) => r.id === cancelId) ?? null : null

  const items: RequestListItem[] =
    listState.phase === 'ready'
      ? listState.requests.map((request) => ({
          id: request.id,
          title: `${formatDate(request.requestedDate)} · ${request.currentShiftName ?? 'ไม่มีกะ'} → ${request.newShiftName}`,
          meta: '',
          status: request.status,
          reason: request.reason,
          decisionNote:
            request.status === 'rejected' ? `เหตุผลจากผู้อนุมัติ: ${request.decisionReason ?? ''}` : undefined,
          hasFile: request.attachmentKey !== null,
          onViewFile: request.attachmentKey !== null ? () => void viewAttachment(request.id) : undefined,
          onEdit: request.status === 'pending' ? () => openEditForm(request) : undefined,
          onCancel: request.status === 'pending' ? () => setCancelId(request.id) : undefined,
        }))
      : []

  return (
    <>
      <RequestShell
        title="ขอเปลี่ยนกะ"
        englishTag="ShiftChangeRequestScreen"
        ruleText="แก้ไข/ยกเลิกได้ขณะรอดำเนินการ · หน้าเดียวที่แนบรูปได้"
        onBack={onBack}
        mode={mode}
        busy={busy}
        newLabel="ขอเปลี่ยนกะ"
        onOpenForm={openCreateForm}
        listPhase={listState.phase}
        listErrorMessage={listState.phase === 'error' ? listState.message : undefined}
        emptyText="ยังไม่มีคำขอเปลี่ยนกะ"
        items={items}
        onSubmit={(e) => void submit(e)}
        onCloseForm={() => setMode('list')}
        formError={error}
        submitLabel={editingId === null ? 'ส่งคำขอ' : 'บันทึกการแก้ไข'}
        canSubmit={newShiftId !== 0 && reason.trim() !== ''}
        reasonLabel="เหตุผล *"
        reason={reason}
        onReasonChange={setReason}
      >
        <label className="field">
          <span>วันที่ต้องการเปลี่ยนกะ</span>
          <input
            type="date"
            value={requestedDate}
            min={today()}
            onChange={(e) => setRequestedDate(e.target.value)}
            required
            disabled={busy}
          />
        </label>

        <div className="field">
          <span>กะใหม่ที่ต้องการ</span>
          {shiftState.phase === 'loading' && <p className="hint">กำลังโหลด…</p>}
          {shiftState.phase === 'error' && <p className="form-error">{shiftState.message}</p>}
          {shiftState.phase === 'ready' && (
            <div className="option-list">
              {shiftState.shifts.map((shift) => (
                <button
                  key={shift.id}
                  type="button"
                  className={`option-row ${newShiftId === shift.id ? 'selected' : ''}`}
                  disabled={busy}
                  onClick={() => setNewShiftId(shift.id)}
                >
                  <span className="option-row-name">{shift.shiftName}</span>
                  <span className="option-row-detail">
                    {shift.shiftStartTime.slice(0, 5)}-{shift.shiftEndTime.slice(0, 5)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="field">
          <span>แนบรูปประกอบ</span>
          <label className={`file-drop ${attachmentFile ? 'attached' : ''}`}>
            <input
              ref={fileInputRef}
              type="file"
              className="file-drop-input"
              accept={EMPLOYEE_PHOTO_MIME_TYPES.join(',')}
              onChange={handleFileSelected}
              disabled={busy}
            />
            <span className="file-drop-text">
              {attachmentFile ? `เลือกไฟล์แล้ว: ${attachmentFile.name}` : 'แตะเพื่อเลือกรูปจากเครื่อง'}
            </span>
            <span className="file-drop-hint">JPEG / PNG / WebP · ไม่เกิน 5 MB</span>
          </label>

          {savedAttachmentKey !== null && !attachmentFile && (
            <div className="attachment-existing">
              {attachmentPreviewUrl ? (
                <a href={attachmentPreviewUrl} target="_blank" rel="noopener noreferrer" className="attachment-link">
                  ดูรูปที่แนบไว้
                </a>
              ) : (
                <span className="hint">มีไฟล์แนบอยู่</span>
              )}
              <button type="button" className="request-cancel-button" disabled={busy} onClick={() => void removeSavedAttachment()}>
                ลบไฟล์แนบ
              </button>
            </div>
          )}
        </div>
      </RequestShell>

      {cancelTarget && (
        <ConfirmModal
          title="ยกเลิกคำขอเปลี่ยนกะนี้?"
          message={`${formatDate(cancelTarget.requestedDate)} · ${cancelTarget.currentShiftName ?? 'ไม่มีกะ'} → ${cancelTarget.newShiftName} — ยกเลิกแล้วจะกู้คืนไม่ได้ ต้องยื่นใหม่`}
          confirmLabel="ยกเลิกคำขอ"
          busy={busy}
          onConfirm={() => void confirmCancel()}
          onCancel={() => setCancelId(null)}
        />
      )}
    </>
  )
}
