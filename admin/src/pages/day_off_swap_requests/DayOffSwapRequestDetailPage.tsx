import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { DayOffSwapRequestListItem } from '@hrm/shared'
import {
  approveDayOffSwapRequest,
  getDayOffSwapRequest,
  rejectDayOffSwapRequest,
} from '../../api/dayOffSwapRequests'
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
  | { phase: 'ok'; request: DayOffSwapRequestListItem; canDecide: boolean }
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

function statusBadgeTone(
  status: DayOffSwapRequestListItem['status']
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

export function DayOffSwapRequestDetailPage() {
  const { id } = useParams()

  const [state, setState] = useState<State>({ phase: 'loading' })
  const [busy, setBusy] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [rejectReason, setRejectReason] = useState('')

  useEffect(() => {
    const requestId = Number(id)
    const controller = new AbortController()

    getDayOffSwapRequest(requestId, controller.signal)
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
    if (!confirm('อนุมัติคำขอสลับวันหยุดนี้?')) return

    setBusy(true)
    try {
      const { request, canDecide } = await approveDayOffSwapRequest(state.request.id)
      setState({ phase: 'ok', request, canDecide })
      notify.success(
        request.status === 'pending' ? 'ส่งต่อให้ HR/Admin แล้ว' : 'อนุมัติคำขอแล้ว',
        request.status === 'pending' ? undefined : 'บันทึกการสลับวันหยุดของพนักงานแล้ว'
      )
    } catch (err) {
      notify.error('อนุมัติไม่สำเร็จ', err instanceof Error ? err.message : undefined)
      // The decision may have raced with another admin — refetch to show the
      // current, authoritative state rather than leave a stale "pending" view.
      getDayOffSwapRequest(state.request.id)
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
      const { request, canDecide } = await rejectDayOffSwapRequest(state.request.id, rejectReason)
      setState({ phase: 'ok', request, canDecide })
      setRejecting(false)
      notify.success('ปฏิเสธคำขอแล้ว')
    } catch (err) {
      notify.error('ปฏิเสธไม่สำเร็จ', err instanceof Error ? err.message : undefined)
      getDayOffSwapRequest(state.request.id)
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
          <p className={eyebrow}>Shift</p>
          <h1>รายละเอียดคำขอสลับวันหยุด</h1>
          <p className={subtitle}>ตรวจสอบและอนุมัติ/ปฏิเสธคำขอสลับวันหยุดจากพนักงาน</p>
        </div>
        <Link className={link} to="/day-off-swap-requests">
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
            <dt className={specDt}>วันทำงาน (แทนวันหยุด)</dt>
            <dd className={specDd}>
              {formatDate(state.request.workDate)}
              {' — เดิมเป็น: '}
              {state.request.workDateOriginalLabel ?? 'วันหยุดประจำสัปดาห์'}
            </dd>

            <dt className={specDt}>กะที่จะทำงาน</dt>
            <dd className={specDd}>
              {state.request.workShiftName
                ? `${state.request.workShiftName} (${state.request.workShiftStartTime?.slice(0, 5)}-${state.request.workShiftEndTime?.slice(0, 5)})`
                : '— (ไม่มีกะ)'}
            </dd>

            <dt className={specDt}>วันที่ต้องการสลับ (หยุดแทน)</dt>
            <dd className={specDd}>{formatDate(state.request.offDate)}</dd>

            <dt className={specDt}>เหตุผลจากพนักงาน</dt>
            <dd className={specDd}>{state.request.reason}</dd>

            <dt className={specDt}>ส่งคำขอเมื่อ</dt>
            <dd className={specDd}>{formatDateTime(state.request.createdAt)}</dd>

            {state.request.requiresSupervisorApproval && (
              <>
                <dt className={specDt}>หัวหน้างาน</dt>
                <dd className={specDd}>{state.request.supervisorEmployeeName ?? '—'}</dd>
              </>
            )}

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
