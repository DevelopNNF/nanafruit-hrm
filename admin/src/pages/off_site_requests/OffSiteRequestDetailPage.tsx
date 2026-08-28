import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { OffSiteWorkRequestListItem } from '@hrm/shared'
import { approveOffSiteWorkRequest, getOffSiteWorkRequest, rejectOffSiteWorkRequest } from '../../api/offSiteRequests'
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
  | { phase: 'ok'; request: OffSiteWorkRequestListItem; canDecide: boolean }
  | { phase: 'error'; message: string }

const STATUS_LABEL = {
  pending: 'รอดำเนินการ',
  approved: 'อนุมัติแล้ว',
  rejected: 'ปฏิเสธแล้ว',
  cancelled: 'ยกเลิกแล้ว',
} as const

const STAGE_LABEL = {
  supervisor: 'รอหัวหน้างานอนุมัติ',
  hr: 'รอ HR/Admin อนุมัติ',
} as const

function statusBadgeTone(status: OffSiteWorkRequestListItem['status']): 'pending' | 'active' | 'danger' | 'inactive' {
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

function formatDateRange(request: OffSiteWorkRequestListItem): string {
  return request.startDate === request.endDate
    ? formatDate(request.startDate)
    : `${formatDate(request.startDate)} – ${formatDate(request.endDate)}`
}

export function OffSiteRequestDetailPage() {
  const { id } = useParams()

  const [state, setState] = useState<State>({ phase: 'loading' })
  const [busy, setBusy] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [rejectReason, setRejectReason] = useState('')

  useEffect(() => {
    const requestId = Number(id)
    const controller = new AbortController()

    getOffSiteWorkRequest(requestId, controller.signal)
      .then(({ request, canDecide }) => setState({ phase: 'ok', request, canDecide }))
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
    if (!confirm('อนุมัติคำขอทำงานนอกสถานที่นี้?')) return

    setBusy(true)
    try {
      const { request, canDecide } = await approveOffSiteWorkRequest(state.request.id)
      setState({ phase: 'ok', request, canDecide })
      notify.success(
        request.status === 'pending' ? 'ส่งต่อให้ HR/Admin แล้ว' : 'อนุมัติคำขอแล้ว',
        request.status === 'pending' ? undefined : 'พนักงานลงเวลาที่พิกัดนี้ได้ทันที'
      )
    } catch (err) {
      notify.error('อนุมัติไม่สำเร็จ', err instanceof Error ? err.message : undefined)
      getOffSiteWorkRequest(state.request.id)
        .then(({ request, canDecide }) => setState({ phase: 'ok', request, canDecide }))
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
      const { request, canDecide } = await rejectOffSiteWorkRequest(state.request.id, rejectReason)
      setState({ phase: 'ok', request, canDecide })
      setRejecting(false)
      notify.success('ปฏิเสธคำขอแล้ว')
    } catch (err) {
      notify.error('ปฏิเสธไม่สำเร็จ', err instanceof Error ? err.message : undefined)
      getOffSiteWorkRequest(state.request.id)
        .then(({ request, canDecide }) => setState({ phase: 'ok', request, canDecide }))
        .catch(() => {})
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <header className={pageHead}>
        <div>
          <p className={eyebrow}>Off-Site Work</p>
          <h1>รายละเอียดคำขอทำงานนอกสถานที่</h1>
          <p className={subtitle}>ตรวจสอบและอนุมัติ/ปฏิเสธคำขอทำงานนอกสถานที่จากพนักงาน</p>
        </div>
        <Link className={link} to="/off-site-work-requests">
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
            <dt className={specDt}>สถานที่</dt>
            <dd className={specDd}>{state.request.placeName}</dd>

            <dt className={specDt}>พิกัด</dt>
            <dd className={specDd}>
              <a
                className={link}
                target="_blank"
                rel="noreferrer"
                href={`https://www.google.com/maps?q=${state.request.latitude},${state.request.longitude}`}
              >
                {state.request.latitude.toFixed(6)}, {state.request.longitude.toFixed(6)}
              </a>
            </dd>

            <dt className={specDt}>ช่วงวันที่</dt>
            <dd className={specDd}>{formatDateRange(state.request)}</dd>

            <dt className={specDt}>เหตุผลจากพนักงาน</dt>
            <dd className={specDd}>{state.request.reason}</dd>

            <dt className={specDt}>ส่งคำขอเมื่อ</dt>
            <dd className={specDd}>{formatDateTime(state.request.createdAt)}</dd>

            <dt className={specDt}>หัวหน้างาน</dt>
            <dd className={specDd}>{state.request.supervisorEmployeeName ?? '—'}</dd>

            {state.request.status === 'pending' && state.request.currentStage && (
              <>
                <dt className={specDt}>ขั้นตอนปัจจุบัน</dt>
                <dd className={specDd}>{STAGE_LABEL[state.request.currentStage]}</dd>
              </>
            )}

            {state.request.supervisorApprovedByName && (
              <>
                <dt className={specDt}>หัวหน้างานอนุมัติโดย</dt>
                <dd className={specDd}>
                  {state.request.supervisorApprovedByName}
                  {state.request.supervisorApprovedAt &&
                    ` เมื่อ ${formatDateTime(state.request.supervisorApprovedAt)}`}
                </dd>
              </>
            )}

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

          {state.request.status === 'pending' && state.canDecide && (
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
