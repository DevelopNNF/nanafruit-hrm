import { useEffect, useState } from 'react'
import type { Employee, LeaveBalanceSummary, LeaveRequest, LeaveType } from '@hrm/shared'
import { fetchMyLeaveBalances } from './api/leaveBalances'
import { fetchActiveLeaveTypes } from './api/leaveTypes'
import { cancelLeaveRequest, fetchMyLeaveRequests, submitLeaveRequest } from './api/leaveRequests'
import { ApiRequestError } from './api/client'
import { LeaveBalanceGauge } from './LeaveBalanceGauge'

type Props = {
  employee: Employee
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

function statusLabel(request: LeaveRequest): string {
  if (request.status === 'pending') return 'รอดำเนินการ'
  if (request.status === 'approved') return 'อนุมัติแล้ว'
  if (request.status === 'cancelled') return 'ยกเลิกแล้ว'
  return `ปฏิเสธ: ${request.decisionReason ?? ''}`
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

export function LeaveRequestCard({ employee }: Props) {
  const [listState, setListState] = useState<ListState>({ phase: 'loading' })
  const [mode, setMode] = useState<'list' | 'form'>('list')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
    } catch (err) {
      setError(messageFor(err))
    } finally {
      setBusy(false)
    }
  }

  async function cancel(id: number) {
    if (!confirm('ยกเลิกคำขอลานี้?')) return
    setBusy(true)
    try {
      const updated = await cancelLeaveRequest(id)
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
    <div className="card ok leave-card">
      <p className="headline">คำขอลา</p>

      {mode === 'list' && (
        <>
          {listState.phase === 'loading' && <p className="hint">กำลังโหลด…</p>}
          {listState.phase === 'error' && <p className="form-error">{listState.message}</p>}

          {listState.phase === 'ready' && (
            <>
              {listState.requests.length === 0 ? (
                <p className="hint">ยังไม่มีคำขอลา</p>
              ) : (
                <ul className="leave-list">
                  {listState.requests.map((request) => (
                    <li key={request.id} className={`leave-item ${request.status}`}>
                      <div className="leave-item-head">
                        <span>
                          {request.leaveTypeName} · {formatDateRange(request)}
                        </span>
                        <span className="leave-item-status">{statusLabel(request)}</span>
                      </div>
                      <span>{request.totalDays} วัน</span>
                      {request.reason && <span className="leave-item-reason">{request.reason}</span>}
                      {request.status === 'pending' && (
                        <button
                          type="button"
                          className="leave-item-cancel"
                          disabled={busy}
                          onClick={() => void cancel(request.id)}
                        >
                          ยกเลิกคำขอ
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <button type="button" className="secondary-button" onClick={openForm}>
                ยื่นขอลา
              </button>
            </>
          )}
        </>
      )}

      {mode === 'form' && (
        <form onSubmit={(e) => void submit(e)} className="correction-form">
          <label>
            ประเภทการลา
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
            <div className="leave-gauges">
              <div>
                <p className="leave-gauge-row-label">{selectedLeaveType.leaveName}</p>
                <LeaveBalanceGauge
                  usedDays={selectedSummary?.usedDays ?? 0}
                  pendingDays={selectedSummary?.pendingDays ?? 0}
                  remainingDays={selectedSummary?.remainingDays ?? 0}
                />
              </div>
            </div>
          )}

          <div className="leave-form-row">
            <label>
              วันที่เริ่มลา
              <input
                type="date"
                value={startDate}
                min={today()}
                onChange={(e) => changeStartDate(e.target.value)}
                required
                disabled={busy}
              />
            </label>
            <label>
              วันที่สิ้นสุด
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
              <div className="leave-half-day-toggle">
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
                <div className="leave-form-row">
                  <label>
                    เวลาเริ่ม
                    <input
                      type="time"
                      value={startTime}
                      onChange={(e) => setStartTime(e.target.value)}
                      required
                      disabled={busy}
                    />
                  </label>
                  <label>
                    เวลาสิ้นสุด
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

          <label>
            เหตุผล{selectedLeaveType?.requireReason && ' *'}
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required={selectedLeaveType?.requireReason ?? false}
              rows={3}
              disabled={busy}
            />
          </label>

          {error !== null && <p className="form-error">{error}</p>}

          <div className="correction-form-actions">
            <button type="submit" disabled={busy || !leaveTypeId}>
              {busy ? 'กำลังส่ง…' : 'ส่งคำขอ'}
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
