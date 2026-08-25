import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { OvertimeRequestListItem, OvertimeWeeklyCapResponse } from '@hrm/shared'
import {
  approveOvertimeRequest,
  getOvertimeRequest,
  rejectOvertimeRequest,
} from '../../api/overtimeRequests'
import { useCanWrite } from '../../auth/meContext'
import { notify } from '../../notifications/notify'
import { fetchOvertimeWeeklyCap } from '../../api/overtimeReport'
import {
  DAY_STATUS_LABEL,
  formatDecimalHours,
  formatOvertimeDate,
  formatOvertimeHours,
  hhmm,
} from '../../overtimeFormat'
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
  | { phase: 'ok'; request: OvertimeRequestListItem }
  | { phase: 'error'; message: string }

type WeeklyCap = OvertimeWeeklyCapResponse & { wouldExceed: boolean }

const STATUS_LABEL = {
  pending: 'รอดำเนินการ',
  approved: 'อนุมัติแล้ว',
  rejected: 'ปฏิเสธแล้ว',
  cancelled: 'ยกเลิกแล้ว',
} as const

function statusBadgeTone(
  status: OvertimeRequestListItem['status']
): 'pending' | 'active' | 'danger' | 'inactive' {
  if (status === 'approved') return 'active'
  if (status === 'rejected') return 'danger'
  if (status === 'cancelled') return 'inactive'
  return 'pending'
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

export function OvertimeRequestDetailPage() {
  const { id } = useParams()
  const canWrite = useCanWrite()

  const [state, setState] = useState<State>({ phase: 'loading' })
  const [busy, setBusy] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [rejectReason, setRejectReason] = useState('')
  const [weeklyCap, setWeeklyCap] = useState<WeeklyCap | null>(null)

  useEffect(() => {
    const requestId = Number(id)
    const controller = new AbortController()

    getOvertimeRequest(requestId, controller.signal)
      .then((request) => setState({ phase: 'ok', request }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'request failed',
        })
      })

    // Advisory only, so a failure here stays silent — it must never be what
    // stops an approver from making a decision.
    fetchOvertimeWeeklyCap(requestId, controller.signal)
      .then((cap) =>
        setWeeklyCap({
          ...cap,
          wouldExceed: cap.approvedMinutes + cap.requestMinutes > cap.capMinutes,
        })
      )
      .catch(() => {})

    return () => controller.abort()
  }, [id])

  async function handleApprove() {
    if (state.phase !== 'ok') return
    if (!confirm('อนุมัติคำขอทำงานล่วงเวลานี้?')) return

    setBusy(true)
    try {
      const request = await approveOvertimeRequest(state.request.id)
      setState({ phase: 'ok', request })
      notify.success('อนุมัติคำขอแล้ว', 'บันทึกการทำงานล่วงเวลาของพนักงานแล้ว')
    } catch (err) {
      notify.error('อนุมัติไม่สำเร็จ', err instanceof Error ? err.message : undefined)
      // The decision may have raced with another admin, or the request may have
      // gone stale since it was filed — refetch so the page shows the current,
      // authoritative state rather than a stale "pending" view.
      getOvertimeRequest(state.request.id)
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
      const request = await rejectOvertimeRequest(state.request.id, rejectReason)
      setState({ phase: 'ok', request })
      setRejecting(false)
      notify.success('ปฏิเสธคำขอแล้ว')
    } catch (err) {
      notify.error('ปฏิเสธไม่สำเร็จ', err instanceof Error ? err.message : undefined)
      getOvertimeRequest(state.request.id)
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
          <p className={eyebrow}>Overtime</p>
          <h1>รายละเอียดคำขอทำงานล่วงเวลา</h1>
          <p className={subtitle}>ตรวจสอบและอนุมัติ/ปฏิเสธคำขอ OT จากพนักงาน</p>
        </div>
        <Link className={link} to="/overtime-requests">
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
            <dt className={specDt}>วันที่ขอ OT</dt>
            <dd className={specDd}>
              {formatOvertimeDate(state.request.otDate)}
              {' — '}
              {DAY_STATUS_LABEL[state.request.dayStatus]}
              {state.request.dayLabel !== null && ` (${state.request.dayLabel})`}
            </dd>

            <dt className={specDt}>ช่วงเวลาที่ขอ</dt>
            <dd className={specDd}>
              {hhmm(state.request.startTime)} - {hhmm(state.request.endTime)}
              {state.request.crossesMidnight && ' (ข้ามเที่ยงคืน)'}
            </dd>

            <dt className={specDt}>รวมชั่วโมง OT</dt>
            <dd className={specDd}>
              {formatOvertimeHours(state.request.requestedMinutes)} ({state.request.requestedMinutes} นาที)
            </dd>

            {/* The window the request had to stay clear of — shown so a
                reviewer can see for themselves that it did. */}
            <dt className={specDt}>เวลาทำงานปกติของวันนั้น</dt>
            <dd className={specDd}>
              {state.request.shiftName !== null && state.request.shiftStartTime !== null
                ? `${state.request.shiftName} ${hhmm(state.request.shiftStartTime)}-${hhmm(state.request.shiftEndTime ?? '')}`
                : '— (ไม่มีกะ)'}
            </dd>

            <dt className={specDt}>กลุ่มการทำงานล่วงเวลา</dt>
            <dd className={specDd}>{state.request.overtimeGroupName}</dd>

            <dt className={specDt}>เหตุผลจากพนักงาน</dt>
            <dd className={specDd}>{state.request.reason}</dd>

            {state.request.createdByName !== null && (
              <>
                <dt className={specDt}>ขอแทนโดย</dt>
                <dd className={specDd}>
                  {state.request.createdByName}
                  {state.request.batchId !== null && (
                    <>
                      {' '}
                      (
                      <Link className={link} to={`/overtime-requests/batch/${state.request.batchId}`}>
                        ดูคำขอกลุ่มนี้
                      </Link>
                      )
                    </>
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

          {state.request.status === 'pending' && weeklyCap !== null && (
            <div
              className={`mt-4 rounded-md border px-3 py-2.5 text-[0.8rem] ${
                weeklyCap.wouldExceed
                  ? 'border-amber-300 bg-amber-50 text-amber-900'
                  : 'border-slate-200 bg-slate-50 text-slate-600'
              }`}
            >
              สัปดาห์นี้ ({formatOvertimeDate(weeklyCap.weekStart)}–
              {formatOvertimeDate(weeklyCap.weekEnd)}) อนุมัติไปแล้ว{' '}
              <span className="font-semibold tabular-nums">
                {formatDecimalHours(weeklyCap.approvedMinutes)}
              </span>{' '}
              ชม. · หากอนุมัติคำขอนี้จะเป็น{' '}
              <span className="font-semibold tabular-nums">
                {formatDecimalHours(weeklyCap.approvedMinutes + weeklyCap.requestMinutes)}
              </span>{' '}
              ชม. จากเพดาน {formatDecimalHours(weeklyCap.capMinutes)} ชม.
              {weeklyCap.wouldExceed && ' — เกินเพดานตามกฎหมาย โปรดพิจารณา'}
            </div>
          )}

          {state.request.status === 'pending' && canWrite && (
            <div className="mt-5 border-t border-slate-200 pt-4">
              {!rejecting ? (
                <div className="flex gap-2.5">
                  <button
                    type="button"
                    className={button('primary')}
                    disabled={busy}
                    onClick={() => void handleApprove()}
                  >
                    อนุมัติ
                  </button>
                  <button
                    type="button"
                    className={button('danger')}
                    disabled={busy}
                    onClick={() => setRejecting(true)}
                  >
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
