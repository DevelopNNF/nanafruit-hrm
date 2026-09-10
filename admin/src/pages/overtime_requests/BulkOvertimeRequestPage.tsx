import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { computeOvertimeMinutes, type OvertimeBulkPrecheckOutcome, type OvertimeEligibleEmployee } from '@hrm/shared'
import { ApiRequestError } from '../../api/client'
import { createBulkOvertimeRequest, fetchOvertimeEligibleEmployees } from '../../api/overtimeRequests'
import { DatePicker } from '../../components/DatePicker'
import { TransferList } from '../../components/TransferList'
import { notify } from '../../notifications/notify'
import { formatDecimalHours, formatOvertimeHours } from '../../overtimeFormat'
import {
  alert,
  alertDetail,
  alertTitle,
  badge,
  button,
  card,
  eyebrow,
  fieldControl,
  fieldLabel,
  muted,
  pageHead,
  requiredMark,
  subtitle,
} from '../../styles'
import { ArrowLeft } from 'lucide-react'

type EligibleState =
  | { phase: 'loading' }
  | { phase: 'ok'; scope: 'all' | 'team'; employees: OvertimeEligibleEmployee[]; capMinutes: number }
  | { phase: 'forbidden' }
  | { phase: 'error'; message: string }

/** Local calendar date as YYYY-MM-DD — toISOString would shift the day west of UTC. */
function today(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * "ขอ OT แบบกลุ่ม" — one otDate/startTime/endTime/reason applied to several
 * employees at once, mirroring DailyShiftAssignmentPage's TransferList +
 * single-bulk-endpoint shape. Who shows up on the left depends entirely on
 * the signed-in account: HR/Admin sees every active employee, a supervisor
 * (resolved server-side from their Entra UPN) sees only their own active
 * direct reports, and anyone else gets a 403 the page shows as "no access"
 * rather than an empty picker — see resolveBulkOtScope's comment in
 * routes/overtimeRequests.ts for why those are different things.
 */
export function BulkOvertimeRequestPage() {
  const navigate = useNavigate()
  const [date, setDate] = useState(today())
  const [startTime, setStartTime] = useState('')
  const [endTime, setEndTime] = useState('')
  const [reason, setReason] = useState('')
  const [eligibleState, setEligibleState] = useState<EligibleState>({ phase: 'loading' })
  const [selectedEmployeeIds, setSelectedEmployeeIds] = useState<number[]>([])
  const [submitting, setSubmitting] = useState(false)
  // Only ever set when the batch was blocked — nothing was created and this
  // is the pre-check breakdown of who passed/failed, so the admin can fix
  // the failing ones and resubmit. On success the page navigates away
  // instead of showing this.
  const [outcomes, setOutcomes] = useState<OvertimeBulkPrecheckOutcome[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Re-fetched whenever the date changes: the weekly OT total shown next to
  // each name is specific to the Monday-Sunday week the chosen date falls in.
  // No setState({ phase: 'loading' }) at the top — the initial state already
  // is 'loading', and a date change re-running this just leaves the previous
  // date's picker in place until the new one is ready, same reasoning as
  // every other filtered list in this codebase (see e.g. AttendanceListPage).
  useEffect(() => {
    const controller = new AbortController()
    fetchOvertimeEligibleEmployees(date, controller.signal)
      .then((res) =>
        setEligibleState({
          phase: 'ok',
          scope: res.scope,
          employees: res.employees,
          capMinutes: res.capMinutes,
        })
      )
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        if (err instanceof ApiRequestError && err.code === 'FORBIDDEN') {
          setEligibleState({ phase: 'forbidden' })
          return
        }
        setEligibleState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'request failed',
        })
      })
    return () => controller.abort()
  }, [date])

  const requestedMinutes = useMemo(() => computeOvertimeMinutes(startTime, endTime), [startTime, endTime])

  const employees = eligibleState.phase === 'ok' ? eligibleState.employees : []
  const employeeById = new Map(employees.map((e) => [e.employeeId, e]))
  const outcomeByEmployeeId = new Map((outcomes ?? []).map((o) => [o.employeeId, o]))

  const transferItems = employees.map((e) => ({
    id: e.employeeId,
    label: `${e.employeeCode} — ${e.employeeName} (OT: ${formatDecimalHours(e.approvedMinutesThisWeek)}/${
      eligibleState.phase === 'ok' ? formatDecimalHours(eligibleState.capMinutes) : '—'
    } ชม.)`,
    sublabel: e.departmentName ?? undefined,
  }))

  function renderOutcomeBadge(employeeId: number) {
    const outcome = outcomeByEmployeeId.get(employeeId)
    if (!outcome) return null
    if (outcome.kind === 'ok') return <span className={badge('active')}>ผ่านเงื่อนไข</span>
    return (
      <span className={badge('danger')} title={outcome.message}>
        ไม่ผ่านเงื่อนไข
      </span>
    )
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (startTime === '' || endTime === '') {
      notify.error('กรอกช่วงเวลาไม่ครบ', 'ระบุเวลาเริ่มและเวลาสิ้นสุดก่อนบันทึก')
      return
    }
    if (reason.trim() === '') {
      notify.error('ยังไม่ได้ระบุเหตุผล', 'กรอกเหตุผลการขอ OT ก่อนบันทึก')
      return
    }
    if (selectedEmployeeIds.length === 0) {
      notify.error('ยังไม่ได้เลือกพนักงาน', 'ย้ายพนักงานอย่างน้อยหนึ่งคนไปฝั่งขวาก่อนบันทึก')
      return
    }

    setSubmitting(true)
    setError(null)
    setOutcomes(null)
    try {
      const result = await createBulkOvertimeRequest({
        otDate: date,
        startTime,
        endTime,
        reason: reason.trim(),
        employeeIds: selectedEmployeeIds,
      })
      if (result.blocked) {
        // All-or-nothing: nothing was created. Show the full breakdown so
        // the admin can see exactly who's blocking the batch, fix it
        // (deselect them or fix their data), and resubmit — selection is
        // left as-is on purpose.
        setOutcomes(result.outcomes)
        const invalidCount = result.outcomes.filter((o) => o.kind === 'invalid').length
        notify.error(
          'มีพนักงานไม่ผ่านเงื่อนไข ยังไม่ได้ส่งคำขอ',
          `${invalidCount} คนติดปัญหา ดูรายละเอียดด้านล่างแล้วแก้ไขก่อนส่งใหม่`
        )
        return
      }
      notify.success(`ส่งคำขอ OT สำเร็จ ${result.outcomes.length} คน`)
      navigate(`/overtime-requests/batch/${result.batchId}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'บันทึกไม่สำเร็จ')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <header className={pageHead}>
        <div>
          <p className={eyebrow}>
            <Link
              className="inline-flex items-center gap-1.5 text-slate-500 no-underline normal-case tracking-normal hover:text-navy"
              to="/overtime-requests"
            >
              <ArrowLeft size={13} />
              กลับไปรายการคำขอ
            </Link>
          </p>
          <h1>ขอ OT แบบกลุ่ม</h1>
          <p className={subtitle}>
            ระบุรายละเอียดการขอ OT ชุดเดียว แล้วเลือกพนักงานที่จะขอให้ — คำขอของแต่ละคนยังต้องผ่านการอนุมัติตามปกติ
          </p>
        </div>
      </header>

      {error && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>บันทึกไม่สำเร็จ</p>
          <p className={alertDetail}>{error}</p>
        </div>
      )}

      {eligibleState.phase === 'forbidden' && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>ไม่มีสิทธิ์เข้าถึงหน้านี้</p>
          <p className={alertDetail}>
            หน้านี้ใช้ได้เฉพาะ HR, Admin หรือหัวหน้างานที่มีพนักงานในการดูแล — ถ้าคิดว่าควรมีสิทธิ์ กรุณาติดต่อ HR
          </p>
        </div>
      )}

      {eligibleState.phase === 'error' && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>โหลดรายชื่อพนักงานไม่สำเร็จ</p>
          <p className={alertDetail}>{eligibleState.message}</p>
        </div>
      )}

      {eligibleState.phase !== 'forbidden' && (
        <form className={`${card} mb-4`} onSubmit={(e) => void handleSubmit(e)}>
          <div className="mb-4 flex flex-wrap items-end gap-3">
            <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-slate-600">
              <span>
                วันที่ขอ OT <span className={requiredMark}>*</span>
              </span>
              <DatePicker required value={date} onChange={setDate} />
            </label>
            <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-slate-600">
              <span>
                เวลาเริ่ม <span className={requiredMark}>*</span>
              </span>
              <input
                type="time"
                required
                className={fieldControl}
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-slate-600">
              <span>
                เวลาสิ้นสุด <span className={requiredMark}>*</span>
              </span>
              <input
                type="time"
                required
                className={fieldControl}
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
              />
            </label>
          {requestedMinutes !== null && (
            <p className={`${muted} mb-4`}>รวม {formatOvertimeHours(requestedMinutes)}</p>
          )}
          </div>

          <label className={`${fieldLabel} mb-4`}>
            <span>
              เหตุผล <span className={requiredMark}>*</span>
            </span>
            <textarea
              required
              rows={2}
              className={fieldControl}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>

          {eligibleState.phase === 'loading' && <p className={muted}>กำลังโหลดรายชื่อพนักงาน…</p>}

          {eligibleState.phase === 'ok' && eligibleState.employees.length === 0 && (
            <p className={muted}>
              {eligibleState.scope === 'team'
                ? 'ยังไม่มีพนักงานในการดูแลของคุณ'
                : 'ยังไม่มีพนักงานที่ยังทำงานอยู่ในระบบ'}
            </p>
          )}

          {eligibleState.phase === 'ok' && eligibleState.employees.length > 0 && (
            <div className="mb-4">
              <TransferList
                items={transferItems}
                value={selectedEmployeeIds}
                onChange={setSelectedEmployeeIds}
                leftTitle={eligibleState.scope === 'team' ? 'พนักงานในการดูแล' : 'พนักงานทั้งหมด'}
                rightTitle="พนักงานที่เลือก"
                renderStatus={renderOutcomeBadge}
              />
            </div>
          )}

          <div className='w-full flex justify-end'>
            <button
              className={button('primary')}
              type="submit"
              disabled={submitting || eligibleState.phase !== 'ok' || selectedEmployeeIds.length === 0}
              >
              {submitting ? 'กำลังบันทึก…' : 'ส่งคำขอ OT'}
            </button>
          </div>
        </form>
      )}

      {outcomes && outcomes.some((o) => o.kind === 'invalid') && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>ยังส่งคำขอไม่ได้ — มีพนักงานไม่ผ่านเงื่อนไข</p>
          <ul className={muted}>
            {outcomes
              .filter((o): o is Extract<OvertimeBulkPrecheckOutcome, { kind: 'invalid' }> => o.kind === 'invalid')
              .map((o) => (
                <li key={o.employeeId}>
                  {'• '}{employeeById.get(o.employeeId)?.employeeCode ?? o.employeeId} ({o.message})
                </li>
              ))}
          </ul>
        </div>
      )}
    </>
  )
}
