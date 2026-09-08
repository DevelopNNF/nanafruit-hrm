import { useEffect, useMemo, useState } from 'react'
import { Pencil } from 'lucide-react'
import {
  ATTENDANCE_DAILY_FILTERS,
  attendanceBadges,
  formatWorkMinutes,
  type AttendanceCandidatePunch,
  type AttendanceDailyFilter,
  type AttendanceDailyItem,
  type AttendanceDailySummary,
  type AttendanceEventType,
} from '@hrm/shared'
import { exportAttendanceDaily, listAttendanceDaily } from '../../api/attendanceDaily'
import { confirmAttendancePunch, fetchCandidatePunches } from '../../api/attendancePunchConfirm'
import { resolveEmployeeIds } from '../../api/employees'
import { useCanWrite, useCanWritePayroll } from '../../auth/meContext'
import { EmployeeFilterBar, filterFieldLabel, filterFieldRow } from '../../components/EmployeeFilterBar'
import { Pagination } from '../../components/Pagination'
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover'
import { useEmployeeFilters } from '../../hooks/useEmployeeFilters'
import { notify } from '../../notifications/notify'
import {
  alert,
  alertDetail,
  alertTitle,
  badge,
  button,
  cardEmpty,
  eyebrow,
  fieldControl,
  muted,
  pageHead,
  subtitle,
} from '../../styles'

type State =
  | { phase: 'loading' }
  | { phase: 'ok'; days: AttendanceDailyItem[]; summary: AttendanceDailySummary }
  | { phase: 'error'; message: string }

/** Matches the server's own default in attendanceDailyQueries.ts — passed
 *  explicitly anyway so a server-side change can't silently desync the
 *  page-count math in <Pagination>. */
const DEFAULT_PAGE_SIZE = 50

const FILTER_LABEL: Record<AttendanceDailyFilter, string> = {
  present: 'ปกติ',
  late: 'มาสาย',
  early_leave: 'ออกก่อนเวลา',
  leave: 'มีการลา',
  absent: 'ขาดงาน',
  incomplete: 'ลงเวลาไม่ครบ',
  day_off: 'วันหยุด',
  unscheduled_work: 'ทำงานวันหยุด',
}

function toDateInput(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
}

/** Returns the default date range (26th of previous month to 25th of current month),
 *  matching the default window used by the attendance:compute job. */
function defaultRange(): { from: string; to: string } {
  const current_date = new Date()
  const year = current_date.getFullYear()
  const month = current_date.getMonth()
  const from = new Date(year, month, 1)
  const to = new Date(year, month + 1, 0)
  return { from: toDateInput(from), to: toDateInput(to) }
}

function formatDate(dateOnly: string): string {
  return new Date(`${dateOnly}T00:00:00`).toLocaleDateString('th-TH', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

/** 'HH:MM' in Thailand time. The instants come back as UTC ISO strings, and
 *  the org runs on Thailand time regardless of where the browser is. */
function formatTime(iso: string | null): string | null {
  if (iso === null) return null
  return new Date(iso).toLocaleTimeString('th-TH', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Bangkok',
  })
}

function formatDate2(iso: string | null): string | null {
  if (iso === null) return null
  return new Date(iso).toLocaleString('th-TH', {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  })
}

function formatDateTime(iso: string | null): string | null {
  if (iso === null) return null
  return new Date(iso).toLocaleString('th-TH', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Bangkok',
  })
}



/** True when `end` lands on a later Thailand date than `start` — the marker
 *  that an overnight shift's clock-out belongs to the following day. */
function crossesMidnight(start: string | null, end: string | null): boolean {
  if (start === null || end === null) return false
  const day = (iso: string) =>
    new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' })
  return day(end) > day(start)
}

function formatStamp(iso: string | null): string {
  if (iso === null) return 'ยังไม่เคยประมวลผล'
  return new Date(iso).toLocaleString('th-TH', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Bangkok',
  })
}

const th =
  'border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-left text-[0.675rem] font-semibold tracking-wider text-slate-500 uppercase whitespace-nowrap'
const td = 'border-b border-slate-200 px-4 py-2.5 align-middle text-slate-600'

/** A period as "in – out", with each side coloured when it went wrong. */
function TimeRange({
  start,
  end,
  lateStart,
  earlyEnd,
}: {
  start: string | null
  end: string | null
  lateStart?: boolean
  earlyEnd?: boolean
}) {
  const startText = formatTime(start)
  const endText = formatTime(end)
  if (startText === null && endText === null) return <span className="text-slate-300">—</span>

  return (
    <span className="whitespace-nowrap tabular-nums">
      {startText === null ? (
        <span className="text-slate-300">—</span>
      ) : (
        <span className={lateStart ? 'font-medium text-amber-700' : undefined}>{startText}</span>
      )}
      {' – '}
      {endText === null ? (
        <span className="text-slate-300">—</span>
      ) : (
        <span className={earlyEnd ? 'font-medium text-amber-700' : undefined}>{endText}</span>
      )}
      {crossesMidnight(start, end) && <sup className="ml-0.5 text-[0.625rem] text-slate-400">+1</sup>}
    </span>
  )
}

function typeLabel(type: AttendanceEventType): string {
  return type === 'check_in' ? 'เข้า' : 'ออก'
}

/** One candidate row inside PunchConfirmPopover's Available/Claimed sections —
 *  pulled out since both sections render the same row shape. */
function CandidatePunchRow({
  day,
  candidate,
  disabled,
  onSelect,
}: {
  day: AttendanceDailyItem
  candidate: AttendanceCandidatePunch
  disabled: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className="cursor-pointer flex flex-col gap-0.5 rounded-md border border-slate-200 px-2.5 py-1.5 text-left text-[0.775rem] hover:border-navy hover:bg-navy/5 disabled:opacity-60"
    >
      <span className="flex items-center justify-between">
        <span
          className={`${formatDate2(day.workDate) == formatDate2(candidate.eventTime) ? 'font-bold' : ''} tabular-nums text-slate-900`}
        >
          {formatDateTime(candidate.eventTime)} · {typeLabel(candidate.eventType)}
        </span>
        <span className="text-[0.7rem] text-slate-400">{candidate.source}</span>
      </span>
      {candidate.claimedByWorkDate !== null && (
        <span className="text-[0.7rem] text-amber-700">
          ปัจจุบันเป็นเวลาของวันที่ {formatDate(candidate.claimedByWorkDate)} — เลือกจะย้ายมาวันนี้แทน
        </span>
      )}
    </button>
  )
}

/**
 * Lets HR attach an already-recorded-but-unmatched punch (see
 * findCandidatePunches on the server) as this day's real check-in/out —
 * for the case ordinary buffer matching can't solve on its own: a punch
 * landed outside MATCH_BUFFER_MINUTES with no approved OT to widen the
 * search for it. Fixes only the "worked minutes"/incomplete-day verdict —
 * unapproved overtime still needs its own OT request, same as before.
 *
 * Candidates are fetched lazily on open rather than up front for every row,
 * since most days need no correction at all.
 */
function PunchConfirmPopover({
  day,
  onUpdated,
}: {
  day: AttendanceDailyItem
  onUpdated: (day: AttendanceDailyItem) => void
}) {
  const [open, setOpen] = useState(false)
  const [candidates, setCandidates] = useState<AttendanceCandidatePunch[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (next && candidates === null) {
      setLoading(true)
      setError(null)
      fetchCandidatePunches(day.employeeId, day.workDate)
        .then((res) => setCandidates(res.candidates))
        .catch((err: unknown) => setError(err instanceof Error ? err.message : 'โหลดรายการลงเวลาไม่สำเร็จ'))
        .finally(() => setLoading(false))
    }
  }

  async function handleConfirm(eventId: number | null) {
    setSaving(true)
    setError(null)
    try {
      const res = await confirmAttendancePunch(day.employeeId, day.workDate, eventId)
      onUpdated(res.day)
      setOpen(false)
      setCandidates(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'บันทึกไม่สำเร็จ')
    } finally {
      setSaving(false)
    }
  }

  const isConfirmed = day.actualCheckInConfirmed || day.actualCheckOutConfirmed
  const availableCandidates = candidates?.filter((c) => c.claimedByWorkDate === null) ?? []
  const claimedCandidates = candidates?.filter((c) => c.claimedByWorkDate !== null) ?? []

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center text-slate-400 hover:text-navy cursor-pointer"
          title="แก้ไขเวลาจริงจากรายการลงเวลาที่มีอยู่"
        >
          <Pencil size={12} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start">
        <div className="flex w-72 flex-col gap-3">
          <div>
            <p className="text-[0.825rem] font-bold text-slate-900">เลือกเวลาจริงของวันที่ {formatDate(day.workDate)}</p>
            <p className="mt-0.5 text-[0.75rem] text-slate-500">
              เลือกจากรายการลงเวลาที่มีอยู่จริงแต่ยังไม่ถูกจับคู่กับวันนี้ (เช่น ลงเวลาเลยเวลาเลิกงานไปมาก
              โดยยังไม่มี OT อนุมัติ) จะแก้ไขแค่เวลาจริง ไม่กระทบชั่วโมง OT — พนักงานยังต้องยื่นขออนุมัติ OT
              เองแยกต่างหาก
            </p>
          </div>

          {loading && <p className={muted}>กำลังโหลด…</p>}

          {!loading && candidates !== null && candidates.length === 0 && (
            <p className={muted}>ไม่พบรายการลงเวลาที่ยังไม่ได้จับคู่ใกล้วันนี้</p>
          )}

          {!loading && candidates !== null && candidates.length > 0 && (
            <div className="flex max-h-72 flex-col gap-3 overflow-y-auto">
              <div className="flex flex-col gap-1">
                <p className={eyebrow}>ยังไม่ถูกใช้ ({availableCandidates.length})</p>
                {availableCandidates.length === 0 ? (
                  <p className="text-[0.75rem] text-slate-400">ไม่มีรายการที่ว่างอยู่</p>
                ) : (
                  availableCandidates.map((c) => (
                    <CandidatePunchRow key={c.id} day={day} candidate={c} disabled={saving} onSelect={() => handleConfirm(c.id)} />
                  ))
                )}
              </div>

              {claimedCandidates.length > 0 && (
                <div className="flex flex-col gap-1">
                  <p className={eyebrow}>ถูกใช้โดยวันอื่นอยู่ ({claimedCandidates.length})</p>
                  {claimedCandidates.map((c) => (
                    <CandidatePunchRow key={c.id} day={day} candidate={c} disabled={saving} onSelect={() => handleConfirm(c.id)} />
                  ))}
                </div>
              )}
            </div>
          )}

          {error && <p className="text-[0.775rem] text-red-700">{error}</p>}

          <div className="flex items-center gap-3">
            {isConfirmed && (
              <button
                type="button"
                disabled={saving}
                className="text-[0.775rem] text-slate-500 hover:text-slate-700 disabled:opacity-60"
                onClick={() => handleConfirm(null)}
              >
                ยกเลิกการยืนยัน
              </button>
            )}
            <span className="flex-1" />
            <button type="button" className={button()} onClick={() => setOpen(false)}>
              ปิด
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function AttendanceDailyListPage() {
  const canConfirmPunch = useCanWrite()
  const canWritePayroll = useCanWritePayroll()
  const initial = useMemo(() => defaultRange(), [])
  // Every field here — date range, this report's own attendance-status
  // filter, and (via useEmployeeFilters) department/job/employment type/
  // work location/employee status — applies as soon as it changes; only
  // the free-text search inside EmployeeFilterBar needs an explicit ค้นหา,
  // same as everywhere else that filter bar is used.
  const [fromDate, setFromDate] = useState(initial.from)
  const [toDate, setToDate] = useState(initial.to)
  const [status, setStatus] = useState<AttendanceDailyFilter | ''>('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE)
  const [state, setState] = useState<State>({ phase: 'loading' })
  // True while a search/page request is in flight — set by the action that
  // triggers it and cleared once the fetch effect below settles, so the
  // effect itself never sets it directly.
  const [fetching, setFetching] = useState(true)
  const [exporting, setExporting] = useState(false)

  const employeeFilters = useEmployeeFilters({
    // 'all' rather than 'Active' here — attendance rows can belong to an
    // employee who has since left, and hiding those by default would make
    // a past period look incomplete.
    defaultStatus: 'all',
    canWritePayroll,
    onApply: () => {
      setFetching(true)
      setPage(1)
    },
  })

  function handleFromDateChange(value: string) {
    setFetching(true)
    setPage(1)
    setFromDate(value)
  }

  function handleToDateChange(value: string) {
    setFetching(true)
    setPage(1)
    setToDate(value)
  }

  function handleStatusChange(value: AttendanceDailyFilter | '') {
    setFetching(true)
    setPage(1)
    setStatus(value)
  }

  // No reset to 'loading' when the page/filters change: the previous table
  // stays up until the new one lands, rather than flashing blank — same
  // reasoning as LeaveRequestListPage's tab effect. `fetching` drives a
  // lighter-weight indicator instead.
  useEffect(() => {
    const controller = new AbortController()
    const hasEmployeeFilter = Object.keys(employeeFilters.filter).length > 0

    // Two calls, not one: attendance_daily has no join of its own to filter
    // by department/job/etc., so those are resolved to employee ids against
    // /employees/search first (skipped entirely when unset, since resolving
    // "everyone" would be a pointless full scan).
    Promise.resolve(hasEmployeeFilter ? resolveEmployeeIds(employeeFilters.filter, controller.signal) : undefined)
      .then((employeeIds) =>
        listAttendanceDaily(
          {
            fromDate,
            toDate,
            ...(status !== '' && { status }),
            ...(employeeIds !== undefined && { employeeIds }),
          },
          { page, pageSize },
          controller.signal
        )
      )
      .then((body) => {
        setState({ phase: 'ok', days: body.days, summary: body.summary })
        setFetching(false)
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setState({ phase: 'error', message: err instanceof Error ? err.message : 'request failed' })
        setFetching(false)
      })

    return () => controller.abort()
  }, [fromDate, toDate, status, page, pageSize, employeeFilters.filter])

  const summary = state.phase === 'ok' ? state.summary : null

  function goToPage(next: number) {
    setFetching(true)
    setPage(next)
  }

  function handlePageSizeChange(next: number) {
    setFetching(true)
    setPageSize(next)
    setPage(1)
  }

  /** Swaps one row in place after a punch is confirmed/unconfirmed, so the
   *  table reflects the new verdict without refetching the whole page. */
  function patchDay(updated: AttendanceDailyItem) {
    setState((prev) =>
      prev.phase === 'ok' ? { ...prev, days: prev.days.map((d) => (d.id === updated.id ? updated : d)) } : prev
    )
  }

  async function handleExport() {
    setExporting(true)
    try {
      const hasEmployeeFilter = Object.keys(employeeFilters.filter).length > 0
      const employeeIds = hasEmployeeFilter ? await resolveEmployeeIds(employeeFilters.filter) : undefined
      const blob = await exportAttendanceDaily({
        fromDate,
        toDate,
        ...(status !== '' && { status }),
        ...(employeeIds !== undefined && { employeeIds }),
      })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `attendance-${fromDate}-to-${toDate}.xlsx`
      link.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      notify.error('ดาวน์โหลด Excel ไม่สำเร็จ', err instanceof Error ? err.message : undefined)
    } finally {
      setExporting(false)
    }
  }

  return (
    <>
      <header className={pageHead}>
        <div>
          <p className={eyebrow}>Attendance</p>
          <h1>รายงานการลงเวลา</h1>
          <p className={subtitle}>สรุปการลงเวลารายวัน เทียบกับกะที่พนักงานสังกัด</p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          {summary && (
            <div className="rounded-lg border border-navy/20 bg-navy/7 px-3 py-2 text-xs whitespace-nowrap text-navy">
              <span className="font-medium">ประมวลผลล่าสุด</span> {formatStamp(summary.lastComputedAt)}
            </div>
          )}
          <button
            type="button"
            className={button('default')}
            disabled={exporting || state.phase !== 'ok' || state.days.length === 0}
            onClick={handleExport}
          >
            {exporting ? 'กำลังสร้างไฟล์…' : 'ดาวน์โหลด Excel'}
          </button>
        </div>
      </header>

      <div className="mb-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <EmployeeFilterBar
          {...employeeFilters.barProps}
          fetching={fetching}
          extraFields={
            <>
              <label className={filterFieldRow}>
                <span className={filterFieldLabel}>ตั้งแต่วันที่ :</span>
                <input
                  type="date"
                  className={`${fieldControl} w-full`}
                  value={fromDate}
                  max={toDate}
                  onChange={(e) => handleFromDateChange(e.target.value)}
                />
              </label>
              <label className={filterFieldRow}>
                <span className={filterFieldLabel}>ถึงวันที่ :</span>
                <input
                  type="date"
                  className={`${fieldControl} w-full`}
                  value={toDate}
                  min={fromDate}
                  onChange={(e) => handleToDateChange(e.target.value)}
                />
              </label>
              <label className={filterFieldRow}>
                <span className={filterFieldLabel}>สถานะการลงเวลา :</span>
                <select
                  className={`${fieldControl} w-full`}
                  value={status}
                  onChange={(e) => handleStatusChange(e.target.value as AttendanceDailyFilter | '')}
                >
                  <option value="">ทุกสถานะ</option>
                  {ATTENDANCE_DAILY_FILTERS.map((f) => (
                    <option key={f} value={f}>
                      {FILTER_LABEL[f]}
                    </option>
                  ))}
                </select>
              </label>
            </>
          }
        />
      </div>

      {summary && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {(
            [
              ['ทั้งหมด', summary.total, ''],
              ['ปกติ', summary.present, ''],
              ['มาสาย', summary.late, 'text-amber-700'],
              ['ออกก่อนเวลา', summary.earlyLeave, 'text-amber-700'],
              ['ขาดงาน', summary.absent, 'text-red-700'],
              ['ลงเวลาไม่ครบ', summary.incomplete, 'text-red-700'],
            ] as const
          ).map(([label, value, tone]) => (
            <div key={label} className="rounded-lg border border-slate-200 bg-white px-3.5 py-3 shadow-sm">
              <p className="text-xs text-slate-500">{label}</p>
              <p className={`mt-0.5 text-2xl font-medium tabular-nums ${tone || 'text-slate-900'}`}>{value}</p>
            </div>
          ))}
        </div>
      )}

      {state.phase === 'loading' && <p className={muted}>กำลังโหลด…</p>}

      {state.phase === 'error' && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>โหลดข้อมูลไม่สำเร็จ</p>
          <p className={alertDetail}>{state.message}</p>
        </div>
      )}

      {state.phase === 'ok' && state.days.length === 0 && (
        <div className={`rounded-lg border border-slate-200 bg-white shadow-sm ${cardEmpty}`}>
          <p className="mb-1.5 font-semibold text-slate-900">ไม่พบข้อมูลในช่วงที่เลือก</p>
          <p className={muted}>
            ลองขยายช่วงวันที่ หรือตรวจสอบว่ารันคำสั่งประมวลผล (attendance:compute) ครอบคลุมช่วงนี้แล้วหรือยัง
          </p>
        </div>
      )}

      {state.phase === 'ok' && state.days.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 bg-slate-50 px-4 py-3.5">
            <p className="text-[0.775rem] whitespace-nowrap text-slate-500">เรียงตามรหัสพนักงาน แล้วจึงตามวันที่</p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[0.825rem] [&_tbody_tr:last-child_td]:border-b-0">
              <thead>
                <tr>
                  {['ชื่อพนักงาน', 'วันที่', 'เวลาเข้า – ออก', 'เวลาจริง', 'ชั่วโมงทำงานจริง', 'สถานะ'].map((h) => (
                    <th key={h} className={th}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {state.days.map((day) => {
                  const owed = day.expectedWorkMinutes
                  const worked = day.workedMinutes
                  const short = worked !== null && owed !== null && worked < owed
                  return (
                    <tr key={day.id} className="hover:bg-slate-50">
                      <td className={td}>
                        <div className="font-medium text-slate-900">{day.employeeName}</div>
                        <div className="text-[0.71rem] text-slate-400 tabular-nums">{`${day.employeeCode} (${day.employeeFingerprintCode ?? '—'})`}</div>
                      </td>
                      <td className={td}>
                        <div className="whitespace-nowrap tabular-nums">{formatDate(day.workDate)}</div>
                        <div className="text-[0.71rem] text-slate-400">{day.shiftCode ?? '—'}</div>
                      </td>
                      <td className={td}>
                        <TimeRange start={day.effectiveCheckInAt} end={day.effectiveCheckOutAt} />
                        {day.leaveMinutes > 0 && day.expectedCheckInAt !== day.effectiveCheckInAt && (
                          <div className="text-[0.71rem] text-slate-400">
                            <span className="line-through">{formatTime(day.expectedCheckInAt)}</span> ตามกะ
                          </div>
                        )}
                      </td>
                      <td className={td}>
                        <div className="flex items-center gap-1.5">
                          {canConfirmPunch && <PunchConfirmPopover day={day} onUpdated={patchDay} />}
                          <TimeRange
                            start={day.actualCheckInAt}
                            end={day.actualCheckOutAt}
                            lateStart={day.lateMinutes > 0}
                            earlyEnd={day.earlyLeaveMinutes > 0}
                          />
                          {(day.actualCheckInConfirmed || day.actualCheckOutConfirmed) && (
                            <span className="text-[0.65rem] font-medium text-navy" title="ยืนยันด้วยมือ">
                              ✓
                            </span>
                          )}
                        </div>
                      </td>
                      <td className={td}>
                        {worked === null ? (
                          <span className="text-slate-300">—</span>
                        ) : (
                          <>
                            <div
                              className={`font-medium whitespace-nowrap tabular-nums ${short ? 'text-amber-700' : 'text-slate-900'}`}
                            >
                              {formatWorkMinutes(worked)}
                            </div>
                            {short && owed !== null && (
                              <div className="text-[0.71rem] whitespace-nowrap text-slate-400">
                                จาก {formatWorkMinutes(owed)}
                              </div>
                            )}
                          </>
                        )}
                      </td>
                      <td className={td}>
                        <div className="flex flex-wrap gap-1">
                          {attendanceBadges(day).map((b) => (
                            <span key={b.label} className={badge(b.tone)}>
                              {b.label}
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <Pagination
            page={page}
            pageSize={pageSize}
            totalItems={state.summary.total}
            onPageChange={goToPage}
            onPageSizeChange={handlePageSizeChange}
            disabled={fetching}
          />
        </div>
      )}
    </>
  )
}
