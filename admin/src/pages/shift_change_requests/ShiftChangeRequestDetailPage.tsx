import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { ShiftChangeRequestListItem } from '@hrm/shared'
import {
  approveShiftChangeRequest,
  getShiftChangeAttachmentUrl,
  getShiftChangeRequest,
  rejectShiftChangeRequest,
} from '../../api/shiftChangeRequests'
import { useCanWrite } from '../../auth/meContext'
import { notify } from '../../notifications/notify'
import {
  alert,
  alertDetail,
  alertTitle,
  badge,
  button,
  card,
  eyebrow,
  fieldControl,
  link,
  muted,
  pageHead,
  spec,
  specDd,
  specDt,
  subtitle,
} from '../../styles'

type State =
  | { phase: 'loading' }
  | { phase: 'ok'; request: ShiftChangeRequestListItem }
  | { phase: 'error'; message: string }

const STATUS_LABEL = {
  pending: 'รอดำเนินการ',
  approved: 'อนุมัติแล้ว',
  rejected: 'ปฏิเสธแล้ว',
  cancelled: 'ยกเลิกแล้ว',
} as const

function statusBadgeTone(
  status: ShiftChangeRequestListItem['status']
): 'pending' | 'active' | 'danger' | 'inactive' {
  if (status === 'approved') return 'active'
  if (status === 'rejected') return 'danger'
  if (status === 'cancelled') return 'inactive'
  return 'pending'
}

function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('th-TH', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
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

export function ShiftChangeRequestDetailPage() {
  const { id } = useParams()
  const canWrite = useCanWrite()

  const [state, setState] = useState<State>({ phase: 'loading' })
  const [attachmentUrl, setAttachmentUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [rejectReason, setRejectReason] = useState('')

  useEffect(() => {
    const requestId = Number(id)
    const controller = new AbortController()

    getShiftChangeRequest(requestId, controller.signal)
      .then((request) => {
        setState({ phase: 'ok', request })
        if (request.attachmentKey !== null) {
          getShiftChangeAttachmentUrl(requestId, controller.signal)
            .then((url) => setAttachmentUrl(url))
            .catch(() => {
              // The photo preview is a convenience — losing it isn't worth
              // an error banner over an otherwise-loaded request.
            })
        }
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'request failed',
        })
      })

    return () => controller.abort()
  }, [id])

  async function handleApprove() {
    if (state.phase !== 'ok') return
    if (!confirm('อนุมัติคำขอเปลี่ยนกะนี้?')) return

    setBusy(true)
    try {
      const request = await approveShiftChangeRequest(state.request.id)
      setState({ phase: 'ok', request })
      notify.success('อนุมัติคำขอแล้ว', 'บันทึกการเปลี่ยนกะของพนักงานแล้ว')
    } catch (err) {
      notify.error('อนุมัติไม่สำเร็จ', err instanceof Error ? err.message : undefined)
      // The decision may have raced with another admin — refetch to show the
      // current, authoritative state rather than leave a stale "pending" view.
      getShiftChangeRequest(state.request.id)
        .then((request) => setState({ phase: 'ok', request }))
        .catch(() => {})
    } finally {
      setBusy(false)
    }
  }

  async function handleReject(event: React.FormEvent) {
    event.preventDefault()
    if (state.phase !== 'ok') return

    setBusy(true)
    try {
      const request = await rejectShiftChangeRequest(state.request.id, rejectReason)
      setState({ phase: 'ok', request })
      setRejecting(false)
      notify.success('ปฏิเสธคำขอแล้ว')
    } catch (err) {
      notify.error('ปฏิเสธไม่สำเร็จ', err instanceof Error ? err.message : undefined)
      getShiftChangeRequest(state.request.id)
        .then((request) => setState({ phase: 'ok', request }))
        .catch(() => {})
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <header className={pageHead}>
        <div>
          <p className={eyebrow}>Shift</p>
          <h1>รายละเอียดคำขอเปลี่ยนกะ</h1>
          <p className={subtitle}>ตรวจสอบและอนุมัติ/ปฏิเสธคำขอเปลี่ยนกะจากพนักงาน</p>
        </div>
        <Link className={link} to="/shift-change-requests">
          ← กลับไปรายการคำขอ
        </Link>
      </header>

      {state.phase === 'loading' && <p className={muted}>กำลังโหลด…</p>}

      {state.phase === 'error' && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>โหลดข้อมูลไม่สำเร็จ</p>
          <p className={alertDetail}>{state.message}</p>
        </div>
      )}

      {state.phase === 'ok' && (
        <div className={`${card} max-w-2xl`}>
          <div className="mb-4 flex items-center justify-between gap-4">
            <div>
              <p className="font-semibold text-slate-900">
                {state.request.employeeCode} — {state.request.employeeName}
              </p>
            </div>
            <span className={badge(statusBadgeTone(state.request.status))}>
              {STATUS_LABEL[state.request.status]}
            </span>
          </div>

          <dl className={spec}>
            <dt className={specDt}>วันที่ขอเปลี่ยนกะ</dt>
            <dd className={specDd}>{formatDate(state.request.requestedDate)}</dd>

            <dt className={specDt}>กะเดิม</dt>
            <dd className={specDd}>{state.request.currentShiftName ?? '— (ยังไม่มีกะ)'}</dd>

            <dt className={specDt}>กะใหม่ที่ต้องการ</dt>
            <dd className={specDd}>{state.request.newShiftName}</dd>

            <dt className={specDt}>เหตุผลจากพนักงาน</dt>
            <dd className={specDd}>{state.request.reason}</dd>

            {state.request.attachmentKey !== null && (
              <>
                <dt className={specDt}>รูปที่แนบ</dt>
                <dd className={specDd}>
                  {attachmentUrl ? (
                    <a href={attachmentUrl} target="_blank" rel="noopener noreferrer">
                      <img
                        src={attachmentUrl}
                        alt="รูปที่แนบมากับคำขอ"
                        className="h-28 w-28 rounded-md border border-slate-200 object-cover"
                      />
                    </a>
                  ) : (
                    'กำลังโหลด…'
                  )}
                </dd>
              </>
            )}

            <dt className={specDt}>ส่งคำขอเมื่อ</dt>
            <dd className={specDd}>{formatDateTime(state.request.createdAt)}</dd>

            {state.request.status !== 'pending' && state.request.status !== 'cancelled' && (
              <>
                <dt className={specDt}>ดำเนินการโดย</dt>
                <dd className={specDd}>{state.request.decidedByName}</dd>

                <dt className={specDt}>ดำเนินการเมื่อ</dt>
                <dd className={specDd}>
                  {state.request.decidedAt ? formatDateTime(state.request.decidedAt) : '—'}
                </dd>

                {state.request.status === 'rejected' && (
                  <>
                    <dt className={specDt}>เหตุผลที่ปฏิเสธ</dt>
                    <dd className={specDd}>{state.request.decisionReason}</dd>
                  </>
                )}
              </>
            )}
          </dl>

          {state.request.status === 'pending' && canWrite && (
            <div className="mt-5 border-t border-slate-200 pt-4">
              {!rejecting ? (
                <div className="flex gap-2.5">
                  <button type="button" className={button('primary')} disabled={busy} onClick={() => void handleApprove()}>
                    อนุมัติ
                  </button>
                  <button type="button" className={button('danger')} disabled={busy} onClick={() => setRejecting(true)}>
                    ปฏิเสธ
                  </button>
                </div>
              ) : (
                <form onSubmit={(e) => void handleReject(e)} className="flex flex-col gap-2.5">
                  <label className="flex flex-col gap-1.5 text-xs font-medium text-slate-600">
                    เหตุผลที่ปฏิเสธ (ต้องระบุทุกครั้ง)
                    <textarea
                      value={rejectReason}
                      onChange={(e) => setRejectReason(e.target.value)}
                      required
                      rows={3}
                      disabled={busy}
                      className={fieldControl}
                    />
                  </label>
                  <div className="flex gap-2.5">
                    <button
                      type="submit"
                      className={button('danger')}
                      disabled={busy || rejectReason.trim() === ''}
                    >
                      ยืนยันการปฏิเสธ
                    </button>
                    <button
                      type="button"
                      className={button('default')}
                      disabled={busy}
                      onClick={() => {
                        setRejecting(false)
                        setRejectReason('')
                      }}
                    >
                      ยกเลิก
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}
        </div>
      )}
    </>
  )
}
