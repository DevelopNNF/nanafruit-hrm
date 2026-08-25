import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { OvertimeRequestListItem } from '@hrm/shared'
import {
  approveOvertimeRequestBatch,
  getOvertimeRequestBatch,
  rejectOvertimeRequestBatch,
} from '../../api/overtimeRequests'
import { useCanWrite } from '../../auth/meContext'
import { notify } from '../../notifications/notify'
import { DAY_STATUS_LABEL, formatOvertimeDate, formatOvertimeHours, hhmm } from '../../overtimeFormat'
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
  subtitle,
} from '../../styles'

type State =
  | { phase: 'loading' }
  | { phase: 'ok'; requests: OvertimeRequestListItem[] }
  | { phase: 'error'; message: string }

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

/**
 * One "ขอ OT แบบกลุ่ม" submission, as the group of independent
 * overtime_requests rows it actually is (see migration 061's comment — there
 * is no batch table). "อนุมัติทั้งหมด"/"ปฏิเสธทั้งหมด" act on every row still
 * pending in one call; a row a batch decision could not settle (a stale
 * shift conflict, most often) stays pending here with its reason shown, for
 * a reviewer to open individually — this page has no per-row decide button
 * itself, since going to the request's own detail page can also correct
 * whatever went stale before deciding it.
 */
export function OvertimeRequestBatchDetailPage() {
  const { batchId } = useParams()
  const canWrite = useCanWrite()

  const [state, setState] = useState<State>({ phase: 'loading' })
  const [busy, setBusy] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [rejectReason, setRejectReason] = useState('')

  useEffect(() => {
    if (!batchId) return
    const controller = new AbortController()
    getOvertimeRequestBatch(batchId, controller.signal)
      .then((requests) => setState({ phase: 'ok', requests }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'request failed',
        })
      })
    return () => controller.abort()
  }, [batchId])

  async function refetch() {
    if (!batchId) return
    try {
      const requests = await getOvertimeRequestBatch(batchId)
      setState({ phase: 'ok', requests })
    } catch {
      // Best-effort refresh — the outcome notification already told the user
      // what happened.
    }
  }

  async function handleApproveAll() {
    if (!batchId) return
    if (!confirm('อนุมัติคำขอที่รอดำเนินการทั้งหมดในกลุ่มนี้?')) return

    setBusy(true)
    try {
      const outcomes = await approveOvertimeRequestBatch(batchId)
      const okCount = outcomes.filter((o) => o.kind === 'ok').length
      const staleCount = outcomes.length - okCount
      if (staleCount === 0) {
        notify.success(`อนุมัติแล้ว ${okCount} คำขอ`)
      } else {
        notify.error(
          `อนุมัติสำเร็จ ${okCount} คำขอ — ${staleCount} คำขอต้องตรวจสอบเป็นรายบุคคล`,
          'เปิดคำขอนั้นเพื่อดูรายละเอียด'
        )
      }
      await refetch()
    } catch (err) {
      notify.error('อนุมัติไม่สำเร็จ', err instanceof Error ? err.message : undefined)
      await refetch()
    } finally {
      setBusy(false)
    }
  }

  async function handleRejectAll(event: React.FormEvent) {
    event.preventDefault()
    if (!batchId) return

    setBusy(true)
    try {
      const outcomes = await rejectOvertimeRequestBatch(batchId, rejectReason)
      const okCount = outcomes.filter((o) => o.kind === 'ok').length
      notify.success(`ปฏิเสธแล้ว ${okCount} คำขอ`)
      setRejecting(false)
      setRejectReason('')
      await refetch()
    } catch (err) {
      notify.error('ปฏิเสธไม่สำเร็จ', err instanceof Error ? err.message : undefined)
      await refetch()
    } finally {
      setBusy(false)
    }
  }

  const first = state.phase === 'ok' ? state.requests[0] : undefined
  const pendingCount = state.phase === 'ok' ? state.requests.filter((r) => r.status === 'pending').length : 0

  return (
    <>
      <header className={pageHead}>
        <div>
          <p className={eyebrow}>Overtime</p>
          <h1>รายละเอียดคำขอ OT แบบกลุ่ม</h1>
          <p className={subtitle}>รายชื่อพนักงานทุกคนที่ถูกขอ OT พร้อมกันในคำขอนี้</p>
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

      {state.phase === 'ok' && first && (
        <div className={`${card} mb-4`}>
          <div className="mb-4 flex items-center justify-between gap-4">
            <div>
              <p className="font-semibold text-slate-900">
                {formatOvertimeDate(first.otDate)} · {hhmm(first.startTime)}-{hhmm(first.endTime)}
              </p>
              <p className={muted}>
                {first.createdByName ? `ขอแทนโดย ${first.createdByName}` : 'ขอโดยพนักงานเอง'} ·{' '}
                {state.requests.length} คน
              </p>
            </div>
          </div>

          <p className="mb-4 text-[0.825rem] text-slate-600">{first.reason}</p>

          {canWrite && pendingCount > 0 && (
            <div className="border-t border-slate-200 pt-4">
              {!rejecting ? (
                <div className="flex gap-2.5">
                  <button
                    type="button"
                    className={button('primary')}
                    disabled={busy}
                    onClick={() => void handleApproveAll()}
                  >
                    อนุมัติทั้งหมด ({pendingCount} คำขอ)
                  </button>
                  <button
                    type="button"
                    className={button('danger')}
                    disabled={busy}
                    onClick={() => setRejecting(true)}
                  >
                    ปฏิเสธทั้งหมด
                  </button>
                </div>
              ) : (
                <form onSubmit={(e) => void handleRejectAll(e)} className="flex flex-col gap-2.5">
                  <label className="flex flex-col gap-1.5 text-xs font-medium text-slate-600">
                    เหตุผลที่ปฏิเสธ (ต้องระบุทุกครั้ง — ใช้กับทุกคำขอที่รอดำเนินการในกลุ่มนี้)
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
                      ยืนยันการปฏิเสธทั้งหมด
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

      {state.phase === 'ok' && (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[0.825rem] [&_tbody_tr:last-child_td]:border-b-0">
              <thead>
                <tr>
                  {['รหัสพนักงาน', 'ชื่อพนักงาน', 'ประเภทวัน', 'ชั่วโมง', 'สถานะ'].map((h) => (
                    <th
                      key={h}
                      className="border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-left text-[0.675rem] font-semibold tracking-wider text-slate-500 uppercase whitespace-nowrap"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {state.requests.map((request) => (
                  <tr key={request.id}>
                    <td className="border-b border-slate-200 px-4 py-2.5 align-middle font-medium text-slate-900">
                      {request.employeeCode}
                    </td>
                    <td className="border-b border-slate-200 px-4 py-2.5 align-middle text-slate-600">
                      {request.employeeName}
                    </td>
                    <td className="border-b border-slate-200 px-4 py-2.5 align-middle whitespace-nowrap text-slate-600">
                      {DAY_STATUS_LABEL[request.dayStatus]}
                    </td>
                    <td className="border-b border-slate-200 px-4 py-2.5 align-middle whitespace-nowrap text-slate-600 tabular-nums">
                      {formatOvertimeHours(request.requestedMinutes)}
                    </td>
                    <td className="border-b border-slate-200 px-4 py-2.5 align-middle">
                      <div className="flex items-center gap-2">
                        <span className={badge(statusBadgeTone(request.status))}>
                          {STATUS_LABEL[request.status]}
                        </span>
                        <Link className={link} to={`/overtime-requests/${request.id}`}>
                          เปิดคำขอนี้
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  )
}
