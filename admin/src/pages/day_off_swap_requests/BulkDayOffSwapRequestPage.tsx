import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { DayOffSwapRequestBulkPrecheckOutcome, DayOffSwapRequestEligibleEmployee } from '@hrm/shared'
import { ApiRequestError } from '../../api/client'
import { createBulkDayOffSwapRequest, fetchDayOffSwapRequestEligibleEmployees } from '../../api/dayOffSwapRequests'
import { DatePicker } from '../../components/DatePicker'
import { TransferList } from '../../components/TransferList'
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
  fieldLabel,
  muted,
  pageHead,
  requiredMark,
  subtitle,
} from '../../styles'
import { ArrowLeft } from 'lucide-react'

type EligibleState =
  | { phase: 'loading' }
  | { phase: 'ok'; scope: 'all' | 'team'; employees: DayOffSwapRequestEligibleEmployee[] }
  | { phase: 'forbidden' }
  | { phase: 'error'; message: string }

/** Local calendar date as YYYY-MM-DD — toISOString would shift the day west of UTC. */
function today(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * "ขอสลับวันหยุดแบบกลุ่ม" — one workDate/offDate/reason applied to several
 * employees at once, mirroring BulkOvertimeRequestPage's TransferList +
 * single-bulk-endpoint shape. Who shows up on the left depends entirely on
 * the signed-in account: HR/Admin sees every active employee, a supervisor
 * sees only their own active direct reports, and anyone else gets a 403 the
 * page shows as "no access" rather than an empty picker.
 *
 * Unlike the LIFF self-service form (and its admin single-employee
 * counterpart), this does not require the ≥3-day minimum notice — HR asked
 * for admin-filed swaps to allow a more urgent same-week request. The server
 * still validates everything else per employee (work_date must currently be
 * a day off, off_date a workday, a standing shift, no conflicting request).
 */
export function BulkDayOffSwapRequestPage() {
  const navigate = useNavigate()
  const [workDate, setWorkDate] = useState(today())
  const [offDate, setOffDate] = useState(today())
  const [reason, setReason] = useState('')
  const [eligibleState, setEligibleState] = useState<EligibleState>({ phase: 'loading' })
  const [selectedEmployeeIds, setSelectedEmployeeIds] = useState<number[]>([])
  const [submitting, setSubmitting] = useState(false)
  // Only ever set when the batch was blocked — nothing was created and this
  // is the pre-check breakdown of who passed/failed, so the admin can fix
  // the failing ones and resubmit. On success the page navigates away
  // instead of showing this.
  const [outcomes, setOutcomes] = useState<DayOffSwapRequestBulkPrecheckOutcome[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetchDayOffSwapRequestEligibleEmployees(controller.signal)
      .then((res) => setEligibleState({ phase: 'ok', scope: res.scope, employees: res.employees }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        if (err instanceof ApiRequestError && err.code === 'FORBIDDEN') {
          setEligibleState({ phase: 'forbidden' })
          return
        }
        setEligibleState({ phase: 'error', message: err instanceof Error ? err.message : 'request failed' })
      })
    return () => controller.abort()
  }, [])

  const employees = eligibleState.phase === 'ok' ? eligibleState.employees : []
  const employeeById = new Map(employees.map((e) => [e.employeeId, e]))
  const outcomeByEmployeeId = new Map((outcomes ?? []).map((o) => [o.employeeId, o]))

  const transferItems = employees.map((e) => ({
    id: e.employeeId,
    label: `${e.employeeCode} — ${e.employeeName}`,
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
    if (reason.trim() === '') {
      notify.error('ยังไม่ได้ระบุเหตุผล', 'กรอกเหตุผลการขอสลับวันหยุดก่อนบันทึก')
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
      const result = await createBulkDayOffSwapRequest({
        workDate,
        offDate,
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
      notify.success(`ส่งคำขอสลับวันหยุดสำเร็จ ${result.outcomes.length} คน`)
      navigate(`/day-off-swap-requests/batch/${result.batchId}`)
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
              to="/day-off-swap-requests"
            >
              <ArrowLeft size={13} />
              กลับไปรายการคำขอ
            </Link>
          </p>
          <h1>ขอสลับวันหยุดแบบกลุ่ม</h1>
          <p className={subtitle}>
            ระบุวันทำงาน/วันที่ต้องการสลับชุดเดียว แล้วเลือกพนักงานที่จะขอให้ — คำขอของแต่ละคนยังต้องผ่านการอนุมัติตามปกติ
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
            <label className={fieldLabel}>
              <span>
                วันหยุด → ขอเป็นวันทำงาน <span className={requiredMark}>*</span>
              </span>
              <DatePicker required value={workDate} onChange={setWorkDate} min={today()} />
            </label>
            <label className={fieldLabel}>
              <span>
                วันทำงานเดิม → ขอเป็นวันหยุด <span className={requiredMark}>*</span>
              </span>
              <DatePicker required value={offDate} onChange={setOffDate} min={today()} />
            </label>
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

          <div className="flex w-full justify-end">
            <button
              className={button('primary')}
              type="submit"
              disabled={submitting || eligibleState.phase !== 'ok' || selectedEmployeeIds.length === 0}
            >
              {submitting ? 'กำลังบันทึก…' : 'ส่งคำขอสลับวันหยุด'}
            </button>
          </div>
        </form>
      )}

      {outcomes && outcomes.some((o) => o.kind === 'invalid') && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>ยังส่งคำขอไม่ได้ — มีพนักงานไม่ผ่านเงื่อนไข</p>
          <ul className={muted}>
            {outcomes
              .filter((o): o is Extract<DayOffSwapRequestBulkPrecheckOutcome, { kind: 'invalid' }> => o.kind === 'invalid')
              .map((o) => (
                <li key={o.employeeId}>
                  {'• '}
                  {employeeById.get(o.employeeId)?.employeeCode ?? o.employeeId} ({o.message})
                </li>
              ))}
          </ul>
        </div>
      )}
    </>
  )
}
