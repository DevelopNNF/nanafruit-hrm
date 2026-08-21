import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { Employee, LeaveBalanceSummary, LeaveRequest, LeaveType } from '@hrm/shared'
import { fetchMyLeaveBalances } from '../api/leaveBalances'
import { fetchActiveLeaveTypes } from '../api/leaveTypes'
import { cancelLeaveRequest, fetchMyLeaveRequests, submitLeaveRequest } from '../api/leaveRequests'
import { ApiRequestError } from '../api/client'
import { LeaveBalanceGauge } from './LeaveBalanceGauge'
import { RequestShell, type RequestListItem } from './RequestShell'
import { ConfirmModal } from './ConfirmModal'

type Props = {
  employee: Employee
  onBack: () => void
}

type ListState =
  | { phase: 'loading' }
  | { phase: 'ready'; requests: LeaveRequest[] }
  | { phase: 'error'; message: string }

type LeaveTypeState =
  | { phase: 'loading' }
  | { phase: 'ready'; leaveTypes: LeaveType[] }
  | { phase: 'error'; message: string }

/** Whether to show time-of-day controls at all: a half day or an hourly
 *  request only ever covers a single calendar date. */
type PartialMode = 'full' | 'morning' | 'afternoon' | 'custom'

function messageFor(err: unknown): string {
  if (err instanceof ApiRequestError) return err.message
  return 'เชื่อมต่อไม่สำเร็จ กรุณาลองใหม่อีกครั้ง'
}

/** Today, local device time, as 'YYYY-MM-DD' — same helper as
 *  TimeCorrectionCard's, under the same assumption that liff only ever runs
 *  on a phone set to Thailand time. */
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

function formatDateRange(request: LeaveRequest): string {
  const range =
    request.startDate === request.endDate
      ? formatDate(request.startDate)
      : `${formatDate(request.startDate)} – ${formatDate(request.endDate)}`
  if (request.startTime && request.endTime) {
    return `${range} (${request.startTime.slice(0, 5)}-${request.endTime.slice(0, 5)})`
  }
  return range
}

function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

function minutesToTime(mins: number): string {
  const wrapped = ((mins % 1440) + 1440) % 1440
  const h = Math.floor(wrapped / 60)
  const m = wrapped % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** The clock-time exactly between a shift's start and end, for the "ครึ่งเช้า
 *  / ครึ่งบ่าย" presets — treats end <= start as crossing midnight, same
 *  interpretation the server's day-counting gives master_shifts. */
function shiftMidpoint(start: string, end: string): string {
  const s = timeToMinutes(start)
  let e = timeToMinutes(end)
  if (e <= s) e += 1440
  return minutesToTime(s + Math.round((e - s) / 2))
}

export function LeaveRequestCard({ employee, onBack }: Props) {
  const [listState, setListState] = useState<ListState>({ phase: 'loading' })
  const [mode, setMode] = useState<'list' | 'form'>('list')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cancelId, setCancelId] = useState<number | null>(null)

  const [leaveTypeState, setLeaveTypeState] = useState<LeaveTypeState>({ phase: 'loading' })
  const [balances, setBalances] = useState<LeaveBalanceSummary[]>([])

  const [leaveTypeId, setLeaveTypeId] = useState(0)
  const [startDate, setStartDate] = useState(today())
  const [endDate, setEndDate] = useState(today())
  const [partialMode, setPartialMode] = useState<PartialMode>('full')
  const [startTime, setStartTime] = useState('')
  const [endTime, setEndTime] = useState('')
  const [reason, setReason] = useState('')

  const shiftStart = employee.employment.shiftStartTime?.slice(0, 5) ?? null
  const shiftEnd = employee.employment.shiftEndTime?.slice(0, 5) ?? null
  const hasShift = shiftStart !== null && shiftEnd !== null

  useEffect(() => {
    const controller = new AbortController()
    fetchMyLeaveRequests(controller.signal)
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
    fetchActiveLeaveTypes(controller.signal)
      .then((leaveTypes) => {
        setLeaveTypeState({ phase: 'ready', leaveTypes })
        const eligible = leaveTypes.find(
          (lt) => lt.gender === 'all' || lt.gender === employee.gender
        )
        if (eligible) setLeaveTypeId(eligible.id)
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setLeaveTypeState({ phase: 'error', message: messageFor(err) })
      })
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  useEffect(() => {
    if (mode !== 'form') return
    const year = Number(startDate.slice(0, 4))
    const controller = new AbortController()
    fetchMyLeaveBalances(year, controller.signal)
      .then((summaries) => setBalances(summaries))
      .catch(() => {
        // The gauge is a convenience, not something worth surfacing an error
        // banner over — the form still validates for real on the server.
      })
    return () => controller.abort()
  }, [mode, startDate])

  const leaveTypes = leaveTypeState.phase === 'ready' ? leaveTypeState.leaveTypes : []
  const eligibleLeaveTypes = leaveTypes.filter(
    (lt) => lt.gender === 'all' || lt.gender === employee.gender
  )
  const selectedLeaveType = leaveTypes.find((lt) => lt.id === leaveTypeId)
  const selectedSummary = balances.find((s) => s.leaveTypeId === leaveTypeId)

  const isSingleDay = startDate === endDate
  const supportsPartialDay =
    hasShift && isSingleDay && selectedLeaveType !== undefined &&
    (selectedLeaveType.allowHalfDay || selectedLeaveType.allowHourly)

  function openForm() {
    setLeaveTypeId(0)
    setStartDate(today())
    setEndDate(today())
    setPartialMode('full')
    setStartTime('')
    setEndTime('')
    setReason('')
    setError(null)
    setMode('form')
  }

  function applyPartialMode(next: PartialMode) {
    setPartialMode(next)
    if (next === 'full') {
      setStartTime('')
      setEndTime('')
    } else if (next === 'morning' && shiftStart && shiftEnd) {
      setStartTime(shiftStart)
      setEndTime(shiftMidpoint(shiftStart, shiftEnd))
    } else if (next === 'afternoon' && shiftStart && shiftEnd) {
      setStartTime(shiftMidpoint(shiftStart, shiftEnd))
      setEndTime(shiftEnd)
    } else if (next === 'custom' && shiftStart && shiftEnd) {
      setStartTime(shiftStart)
      setEndTime(shiftEnd)
    }
  }

  function changeStartDate(value: string) {
    setStartDate(value)
    if (endDate < value) setEndDate(value)
    if (value !== endDate && endDate !== '') applyPartialMode('full')
  }

  function changeEndDate(value: string) {
    setEndDate(value)
    if (value !== startDate) applyPartialMode('full')
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!leaveTypeId) return
    setBusy(true)
    setError(null)
    try {
      const request = await submitLeaveRequest({
        leaveTypeId,
        startDate,
        endDate,
        startTime: partialMode === 'full' ? null : `${startTime}:00`,
        endTime: partialMode === 'full' ? null : `${endTime}:00`,
        reason: reason.trim() === '' ? null : reason.trim(),
      })
      setListState((prev) => ({
        phase: 'ready',
        requests: [request, ...(prev.phase === 'ready' ? prev.requests : [])],
      }))
      setMode('list')
      toast('ส่งคำขอแล้ว รอผู้อนุมัติ')
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
      const updated = await cancelLeaveRequest(cancelId)
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
          title: `${request.leaveTypeName} · ${formatDateRange(request)}`,
          meta: `${request.totalDays} วัน · ยื่น ${formatDate(request.createdAt.slice(0, 10))}`,
          status: request.status,
          reason: request.reason,
          decisionNote:
            request.status === 'rejected' ? `เหตุผลจากผู้อนุมัติ: ${request.decisionReason ?? ''}` : undefined,
          onCancel: request.status === 'pending' ? () => setCancelId(request.id) : undefined,
        }))
      : []

  let leaveSummary: string | null = null
  if (leaveTypeId) {
    if (!isSingleDay) {
      const days =
        Math.round((new Date(`${endDate}T00:00:00Z`).getTime() - new Date(`${startDate}T00:00:00Z`).getTime()) / 86400000) + 1
      leaveSummary = `รวมประมาณ ${days > 0 ? days : 1} วัน · ${formatDate(startDate)} – ${formatDate(endDate)}`
    } else if (partialMode === 'morning' || partialMode === 'afternoon') {
      leaveSummary = `รวม 0.5 วัน · ${formatDate(startDate)}`
    } else if (partialMode === 'custom') {
      leaveSummary = `${formatDate(startDate)} · ระบบจะคำนวณจำนวนวันจากช่วงเวลาที่เลือก`
    } else {
      leaveSummary = `รวมประมาณ 1 วัน · ${formatDate(startDate)}`
    }
  }

  return (
    <>
      <RequestShell
        title="คำขอลา"
        englishTag="LeaveScreen"
        ruleText="ยกเลิกได้เฉพาะคำขอที่รอดำเนินการ · ไม่มีปุ่มแก้ไข ถ้าต้องแก้ให้ยกเลิกแล้วยื่นใหม่"
        onBack={onBack}
        mode={mode}
        busy={busy}
        newLabel="ยื่นขอลา"
        onOpenForm={openForm}
        listPhase={listState.phase}
        listErrorMessage={listState.phase === 'error' ? listState.message : undefined}
        emptyText="ยังไม่มีคำขอลา"
        items={items}
        onSubmit={(e) => void submit(e)}
        onCloseForm={() => setMode('list')}
        formError={error}
        submitLabel="ส่งคำขอ"
        canSubmit={leaveTypeId !== 0 && (!selectedLeaveType?.requireReason || reason.trim() !== '')}
        reasonLabel={selectedLeaveType?.requireReason ? 'เหตุผล *' : 'เหตุผล (ไม่บังคับ)'}
        reason={reason}
        onReasonChange={setReason}
      >
        <label className="field">
          <span>ประเภทการลา</span>
          {leaveTypeState.phase === 'loading' && <span className="hint">กำลังโหลด…</span>}
          {leaveTypeState.phase === 'error' && <span className="form-error">{leaveTypeState.message}</span>}
          {leaveTypeState.phase === 'ready' && (
            <select
              value={leaveTypeId || ''}
              onChange={(e) => setLeaveTypeId(Number(e.target.value))}
              disabled={busy}
              required
            >
              <option value="" disabled>
                — เลือกประเภทการลา —
              </option>
              {eligibleLeaveTypes.map((lt) => (
                <option key={lt.id} value={lt.id}>
                  {lt.leaveName}
                </option>
              ))}
            </select>
          )}
        </label>

        {selectedLeaveType && (
          <div className="leave-type-gauge-box">
            <p className="leave-gauge-row-label">{selectedLeaveType.leaveName}</p>
            <LeaveBalanceGauge
              usedDays={selectedSummary?.usedDays ?? 0}
              pendingDays={selectedSummary?.pendingDays ?? 0}
              remainingDays={selectedSummary?.remainingDays ?? 0}
            />
          </div>
        )}

        <div className="field-row">
          <label className="field">
            <span>วันที่เริ่มลา</span>
            <input
              type="date"
              value={startDate}
              min={today()}
              onChange={(e) => changeStartDate(e.target.value)}
              required
              disabled={busy}
            />
          </label>
          <label className="field">
            <span>วันที่สิ้นสุด</span>
            <input
              type="date"
              value={endDate}
              min={startDate}
              onChange={(e) => changeEndDate(e.target.value)}
              required
              disabled={busy}
            />
          </label>
        </div>

        {supportsPartialDay && (
          <>
            <div className="chip-toggle">
              <button
                type="button"
                className={partialMode === 'full' ? 'active' : ''}
                disabled={busy}
                onClick={() => applyPartialMode('full')}
              >
                เต็มวัน
              </button>
              {selectedLeaveType?.allowHalfDay && (
                <>
                  <button
                    type="button"
                    className={partialMode === 'morning' ? 'active' : ''}
                    disabled={busy}
                    onClick={() => applyPartialMode('morning')}
                  >
                    ครึ่งเช้า
                  </button>
                  <button
                    type="button"
                    className={partialMode === 'afternoon' ? 'active' : ''}
                    disabled={busy}
                    onClick={() => applyPartialMode('afternoon')}
                  >
                    ครึ่งบ่าย
                  </button>
                </>
              )}
              {selectedLeaveType?.allowHourly && (
                <button
                  type="button"
                  className={partialMode === 'custom' ? 'active' : ''}
                  disabled={busy}
                  onClick={() => applyPartialMode('custom')}
                >
                  ระบุเวลาเอง
                </button>
              )}
            </div>

            {partialMode === 'custom' && (
              <div className="field-row">
                <label className="field">
                  <span>เวลาเริ่ม</span>
                  <input
                    type="time"
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                    required
                    disabled={busy}
                  />
                </label>
                <label className="field">
                  <span>เวลาสิ้นสุด</span>
                  <input
                    type="time"
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                    required
                    disabled={busy}
                  />
                </label>
              </div>
            )}
          </>
        )}

        {leaveSummary !== null && <p className="request-form-summary">{leaveSummary}</p>}
      </RequestShell>

      {cancelTarget && (
        <ConfirmModal
          title="ยกเลิกคำขอลานี้?"
          message={`${cancelTarget.leaveTypeName} · ${formatDateRange(cancelTarget)} — ยกเลิกแล้วจะกู้คืนไม่ได้ ต้องยื่นใหม่`}
          confirmLabel="ยกเลิกคำขอ"
          busy={busy}
          onConfirm={() => void confirmCancel()}
          onCancel={() => setCancelId(null)}
        />
      )}
    </>
  )
}
