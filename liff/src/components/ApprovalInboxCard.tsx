import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { ApprovalResourceType, PendingApprovalItem } from '@hrm/shared'
import { approveApprovalItem, fetchPendingApprovals, rejectApprovalItem } from '../api/approvals'
import { ApiRequestError } from '../api/client'
import { PageHeader } from './PageHeader'
import { StatusPill } from './StatusPill'
import { ConfirmModal } from './ConfirmModal'
import { ApprovalRejectModal } from './ApprovalRejectModal'

type Props = {
  onBack: () => void
}

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; pending: PendingApprovalItem[]; done: PendingApprovalItem[] }
  | { phase: 'error'; message: string }

type Tab = 'pending' | 'done'

const TYPE_LABEL: Record<ApprovalResourceType, string> = {
  leave: 'คำขอลา',
  overtime: 'OT',
  shiftChange: 'เปลี่ยนกะ',
  dayOffSwap: 'สลับวันหยุด',
  timeCorrection: 'แก้ไขเวลา',
  offSite: 'นอกสถานที่',
}

function messageFor(err: unknown): string {
  if (err instanceof ApiRequestError) return err.message
  return 'เชื่อมต่อไม่สำเร็จ กรุณาลองใหม่อีกครั้ง'
}

function formatDate(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString('th-TH', {
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

/** Each resource's list item carries different date/detail fields — this is
 *  the one place that knows how to turn all 5 into the same title/meta pair
 *  the card renders, mirroring the formatting each request type's own
 *  screen already uses for its own list (see e.g. OvertimeRequestCard). */
function titleAndMeta(item: PendingApprovalItem): { title: string; meta: string } {
  switch (item.resourceType) {
    case 'leave': {
      const r = item.request
      const range =
        r.startDate === r.endDate
          ? formatDate(r.startDate)
          : `${formatDate(r.startDate)} – ${formatDate(r.endDate)}`
      return { title: `${r.leaveTypeName} · ${range}`, meta: `${r.totalDays} วัน` }
    }
    case 'overtime': {
      const r = item.request
      return {
        title: `${formatDate(r.otDate)} ${hhmm(r.startTime)}-${hhmm(r.endTime)}${r.crossesMidnight ? ' (+1)' : ''}`,
        meta: formatHours(r.requestedMinutes),
      }
    }
    case 'shiftChange': {
      const r = item.request
      return {
        title: `${formatDate(r.requestedDate)} · ${r.currentShiftName ?? 'ไม่มีกะ'} → ${r.newShiftName}`,
        meta: '',
      }
    }
    case 'dayOffSwap': {
      const r = item.request
      return { title: `${formatDate(r.offDate)} (หยุด) → ${formatDate(r.workDate)} (ทำงาน)`, meta: '' }
    }
    case 'timeCorrection': {
      const r = item.request
      return {
        title: `${r.eventType === 'check_in' ? 'เข้างาน' : 'ออกงาน'} · ${formatDateTime(r.requestedEventTime)}`,
        meta: '',
      }
    }
    case 'offSite': {
      const r = item.request
      const range =
        r.startDate === r.endDate
          ? formatDate(r.startDate)
          : `${formatDate(r.startDate)} – ${formatDate(r.endDate)}`
      return { title: `${r.placeName} · ${range}`, meta: '' }
    }
  }
}

export function ApprovalInboxCard({ onBack }: Props) {
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [tab, setTab] = useState<Tab>('pending')
  const [approvingItem, setApprovingItem] = useState<PendingApprovalItem | null>(null)
  const [rejectingItem, setRejectingItem] = useState<PendingApprovalItem | null>(null)
  const [busy, setBusy] = useState(false)

  function load(signal?: AbortSignal) {
    fetchPendingApprovals(signal)
      .then((body) => setState({ phase: 'ready', pending: body.pending, done: body.done }))
      .catch((err: unknown) => {
        if (signal?.aborted) return
        setState({ phase: 'error', message: messageFor(err) })
      })
  }

  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal)
    return () => controller.abort()
  }, [])

  async function confirmApprove() {
    if (!approvingItem) return
    setBusy(true)
    try {
      await approveApprovalItem(approvingItem)
      setApprovingItem(null)
      load()
      toast('อนุมัติคำขอแล้ว')
    } catch (err) {
      alert(messageFor(err))
    } finally {
      setBusy(false)
    }
  }

  async function confirmReject(reason: string) {
    if (!rejectingItem) return
    setBusy(true)
    try {
      await rejectApprovalItem(rejectingItem, reason)
      setRejectingItem(null)
      load()
      toast('ปฏิเสธคำขอแล้ว')
    } catch (err) {
      alert(messageFor(err))
    } finally {
      setBusy(false)
    }
  }

  const pendingCount = state.phase === 'ready' ? state.pending.length : 0
  const doneCount = state.phase === 'ready' ? state.done.length : 0
  const list = state.phase === 'ready' ? (tab === 'pending' ? state.pending : state.done) : []

  return (
    <>
      <PageHeader title="รออนุมัติจากฉัน" onBack={onBack} />

      <p className="approval-banner">
        คำขอจากพนักงานในทีมที่คุณดูแล · ต้องระบุเหตุผลทุกครั้งที่ปฏิเสธคำขอ
      </p>

      <div className="approval-tabs">
        <button type="button" className={tab === 'pending' ? 'active' : ''} onClick={() => setTab('pending')}>
          รอฉันอนุมัติ {pendingCount}
        </button>
        <button type="button" className={tab === 'done' ? 'active' : ''} onClick={() => setTab('done')}>
          ตัดสินใจแล้ว {doneCount}
        </button>
      </div>

      {state.phase === 'loading' && <p className="hint">กำลังโหลด…</p>}
      {state.phase === 'error' && <p className="form-error">{state.message}</p>}

      {state.phase === 'ready' && list.length === 0 && (
        <div className="request-empty">
          <p>{tab === 'pending' ? 'เคลียร์ครบแล้ว ไม่มีคำขอรอคุณอนุมัติ' : 'ยังไม่มีคำขอที่คุณตัดสินใจไปแล้ว'}</p>
        </div>
      )}

      <ul className="request-list">
        {list.map((item) => {
          const { title, meta } = titleAndMeta(item)
          const r = item.request
          return (
            <li key={`${item.resourceType}-${r.id}`} className="request-item">
              <div className="approval-item-head">
                <span className="avatar" aria-hidden="true">
                  {r.employeeName.trim().charAt(0)}
                </span>
                <span className="approval-item-who">
                  <span className="approval-item-name">{r.employeeName}</span>
                  <span className="approval-item-code">{r.employeeCode}</span>
                </span>
                <span className={`approval-type-pill ${item.resourceType}`}>{TYPE_LABEL[item.resourceType]}</span>
              </div>

              <div className="approval-item-detail">
                <p className="request-item-title">{title}</p>
                {meta !== '' && <p className="request-item-meta">{meta}</p>}
              </div>

              <p className="request-item-reason">เหตุผลพนักงาน: {r.reason}</p>

              {r.status === 'pending' ? (
                <div className="request-item-actions">
                  <button type="button" className="request-cancel-button" onClick={() => setRejectingItem(item)}>
                    ปฏิเสธ
                  </button>
                  <button type="button" className="approval-approve-button" onClick={() => setApprovingItem(item)}>
                    อนุมัติ
                  </button>
                </div>
              ) : (
                <div className="approval-item-done">
                  <span className="approval-item-done-head">
                    <StatusPill status={r.status} />
                    {r.decidedAt !== null && (
                      <span className="request-item-meta">{formatDateTime(r.decidedAt)}</span>
                    )}
                  </span>
                  {r.decisionReason !== null && (
                    <p className="request-item-reason">เหตุผลของคุณ: {r.decisionReason}</p>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {approvingItem && (
        <ConfirmModal
          title="อนุมัติคำขอนี้?"
          message={`${approvingItem.request.employeeName} · ${titleAndMeta(approvingItem).title}`}
          confirmLabel="อนุมัติ"
          busy={busy}
          onConfirm={() => void confirmApprove()}
          onCancel={() => setApprovingItem(null)}
        />
      )}

      {rejectingItem && (
        <ApprovalRejectModal
          subject={`${rejectingItem.request.employeeName} · ${titleAndMeta(rejectingItem).title}`}
          busy={busy}
          onConfirm={(reason) => void confirmReject(reason)}
          onCancel={() => setRejectingItem(null)}
        />
      )}
    </>
  )
}
