import { useEffect, useMemo, useState } from 'react'
import type { DailyShiftAssignmentOutcome, Employee, Shift } from '@hrm/shared'
import { ApiRequestError } from '../api/client'
import { assignDailyShifts, fetchDailyShiftAssignmentEligibleEmployees } from '../api/employees'
import { listShifts } from '../api/shifts'
import { DatePicker } from '../components/DatePicker'
import { TransferList } from '../components/TransferList'
import { notify } from '../notifications/notify'
import {
  alert,
  alertDetail,
  alertTitle,
  badge,
  button,
  card,
  eyebrow,
  fieldControl,
  muted,
  pageHead,
  requiredMark,
  subtitle,
} from '../styles'

type LoadState<T> = { phase: 'loading' } | { phase: 'ok'; value: T } | { phase: 'error'; message: string }

type EmployeesState =
  | { phase: 'loading' }
  | { phase: 'ok'; scope: 'all' | 'team'; employees: Employee[] }
  | { phase: 'forbidden' }
  | { phase: 'error'; message: string }

/** Local calendar date as YYYY-MM-DD — same reasoning as EmployeeFormPage's
 *  own `today`: toISOString would shift the day west of UTC. */
function today(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * Assigns a shift to several temporary daily workers (employmentType
 * 'ชั่วคราว') for one calendar date at once. These employees have no
 * fixed/recurring shift — a supervisor or HR picks it fresh each day, unlike
 * the permanent/temporary-swap model on the employee's own shift history
 * (ShiftHistoryCard), which assumes a baseline shift exists to swap around.
 *
 * The employee pool is scoped the same way Bulk OT Request's is
 * (resolveSupervisorScope, server-side): every active employee for HR/Admin,
 * or only the caller's own active direct reports for a resolved supervisor —
 * see fetchDailyShiftAssignmentEligibleEmployees. 'ชั่วคราว' is still
 * filtered client-side on top of that scope, same as before.
 */
export function DailyShiftAssignmentPage() {
  const [date, setDate] = useState(today())
  const [employeesState, setEmployeesState] = useState<EmployeesState>({ phase: 'loading' })
  const [shiftsState, setShiftsState] = useState<LoadState<Shift[]>>({ phase: 'loading' })
  const [selectedEmployeeIds, setSelectedEmployeeIds] = useState<number[]>([])
  const [shiftId, setShiftId] = useState<number | ''>('')
  const [submitting, setSubmitting] = useState(false)
  const [outcomes, setOutcomes] = useState<DailyShiftAssignmentOutcome[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetchDailyShiftAssignmentEligibleEmployees(controller.signal)
      .then((res) => setEmployeesState({ phase: 'ok', scope: res.scope, employees: res.employees }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        if (err instanceof ApiRequestError && err.code === 'FORBIDDEN') {
          setEmployeesState({ phase: 'forbidden' })
          return
        }
        setEmployeesState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'request failed',
        })
      })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    listShifts(controller.signal)
      .then((shifts) => setShiftsState({ phase: 'ok', value: shifts.filter((s) => s.isActive) }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setShiftsState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'request failed',
        })
      })
    return () => controller.abort()
  }, [])

  const tempWorkers = useMemo(() => {
    if (employeesState.phase !== 'ok') return []
    return employeesState.employees
      .filter((e) => e.employment.employmentType === 'ชั่วคราว' && e.employment.status === 'Active')
      .sort((a, b) => a.employeeCode.localeCompare(b.employeeCode))
  }, [employeesState])

  const outcomeByEmployeeId = useMemo(
    () => new Map((outcomes ?? []).map((o) => [o.employeeId, o])),
    [outcomes]
  )
  const employeeById = useMemo(() => new Map(tempWorkers.map((e) => [e.id, e])), [tempWorkers])

  const transferItems = useMemo(
    () =>
      tempWorkers.map((e) => ({
        id: e.id,
        label: `${e.employeeCode} — ${e.title}${e.firstNameTh} ${e.lastNameTh}`,
        sublabel: e.employment.departmentName,
      })),
    [tempWorkers]
  )

  function renderOutcomeBadge(employeeId: number) {
    const outcome = outcomeByEmployeeId.get(employeeId)
    if (!outcome) return null
    if (outcome.kind === 'ok') return <span className={badge('active')}>สำเร็จ</span>
    if (outcome.kind === 'conflict') {
      return (
        <span
          className={badge('pending')}
          title={`ทับกับช่วงเดิม (${outcome.existingEffectiveFrom} – ${outcome.existingEffectiveTo ?? 'ปัจจุบัน'})`}
        >
          ทับกับกะเดิม
        </span>
      )
    }
    return (
      <span className={badge('danger')} title={outcome.message}>
        ผิดพลาด
      </span>
    )
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (shiftId === '') {
      notify.error('ยังไม่ได้เลือกกะ', 'เลือกกะที่จะมอบหมายก่อนบันทึก')
      return
    }
    if (selectedEmployeeIds.length === 0) {
      notify.error('ยังไม่ได้เลือกพนักงาน', 'ย้ายพนักงานอย่างน้อยหนึ่งคนไปฝั่งขวาก่อนบันทึก')
      return
    }
    const assignments = selectedEmployeeIds.map((employeeId) => ({ employeeId, shiftId: Number(shiftId) }))

    setSubmitting(true)
    setError(null)
    setOutcomes(null)
    try {
      const result = await assignDailyShifts({ date, assignments })
      setOutcomes(result)
      const okCount = result.filter((o) => o.kind === 'ok').length
      const problemCount = result.length - okCount
      if (problemCount === 0) {
        notify.success(`มอบหมายกะสำเร็จ ${okCount} คน`)
        setSelectedEmployeeIds([])
      } else {
        notify.error(`มอบหมายสำเร็จ ${okCount} คน — มีปัญหา ${problemCount} คน ดูรายละเอียดด้านล่าง`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'บันทึกไม่สำเร็จ')
    } finally {
      setSubmitting(false)
    }
  }

  const loading = employeesState.phase === 'loading' || shiftsState.phase === 'loading'
  const shifts = shiftsState.phase === 'ok' ? shiftsState.value : []

  return (
    <>
      <header className={pageHead}>
        <div>
          <p className={eyebrow}>จัดการเวลา</p>
          <h1>มอบหมายกะรายวัน</h1>
          <p className={subtitle}>
            สำหรับพนักงานรายวันชั่วคราว (ไม่มีกะตายตัว) — เลือกกะ แล้วย้ายพนักงานที่จะมอบหมายกะนั้นไปฝั่งขวา บันทึกได้ครั้งละหนึ่งกะ
          </p>
        </div>
      </header>

      {error && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>บันทึกไม่สำเร็จ</p>
          <p className={alertDetail}>{error}</p>
        </div>
      )}

      {employeesState.phase === 'forbidden' && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>ไม่มีสิทธิ์เข้าถึงหน้านี้</p>
          <p className={alertDetail}>
            หน้านี้ใช้ได้เฉพาะ HR, Admin หรือหัวหน้างานที่มีพนักงานในการดูแล — ถ้าคิดว่าควรมีสิทธิ์ กรุณาติดต่อ HR
          </p>
        </div>
      )}

      {employeesState.phase === 'error' && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>โหลดรายชื่อพนักงานไม่สำเร็จ</p>
          <p className={alertDetail}>{employeesState.message}</p>
        </div>
      )}
      {shiftsState.phase === 'error' && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>โหลดรายการกะไม่สำเร็จ</p>
          <p className={alertDetail}>{shiftsState.message}</p>
        </div>
      )}

      {employeesState.phase !== 'forbidden' && (
        <form className={`${card} mb-4`} onSubmit={(e) => void handleSubmit(e)}>
          <div className="mb-4 flex flex-wrap items-end gap-3">
            <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-slate-600">
              <span>วันที่</span>
              <DatePicker required value={date} onChange={setDate} />
            </label>
            <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-slate-600">
              <span>
                กะที่จะมอบหมาย<span className={requiredMark}>*</span>
              </span>
              <select
                className={fieldControl}
                required
                value={shiftId}
                onChange={(e) => setShiftId(e.target.value ? Number(e.target.value) : '')}
              >
                <option value="">— เลือกกะ —</option>
                {shifts.map((shift) => (
                  <option key={shift.id} value={shift.id}>
                    {shift.shiftName}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {loading && <p className={muted}>กำลังโหลด…</p>}

          {!loading && tempWorkers.length === 0 && (
            <p className={muted}>
              {employeesState.phase === 'ok' && employeesState.scope === 'team'
                ? 'ยังไม่มีพนักงานรายวันชั่วคราวในการดูแลของคุณ'
                : 'ยังไม่มีพนักงานรายวันชั่วคราว (ประเภทการจ้าง "ชั่วคราว") ในระบบ'}
            </p>
          )}

          {!loading && tempWorkers.length > 0 && (
            <div className="mb-4">
              <TransferList
                items={transferItems}
                value={selectedEmployeeIds}
                onChange={setSelectedEmployeeIds}
                leftTitle={
                  employeesState.phase === 'ok' && employeesState.scope === 'team'
                    ? 'พนักงานในการดูแล'
                    : 'พนักงานทั้งหมด'
                }
                rightTitle="พนักงานที่เลือก"
                renderStatus={renderOutcomeBadge}
              />
            </div>
          )}

          <button
            className={button('primary')}
            type="submit"
            disabled={submitting || loading || tempWorkers.length === 0}
          >
            {submitting ? 'กำลังบันทึก…' : 'บันทึกการมอบหมาย'}
          </button>
        </form>
      )}

      {outcomes && outcomes.some((o) => o.kind === 'conflict') && (
        <div className={alert('info')}>
          <p className={alertTitle()}>บางรายการมีปัญหา</p>
          <p className={muted}>
            {outcomes
              .filter((o): o is Extract<DailyShiftAssignmentOutcome, { kind: 'conflict' }> => o.kind === 'conflict')
              .map((o) => employeeById.get(o.employeeId)?.employeeCode ?? o.employeeId)
              .join(', ')}
            {' '}มีช่วงกะที่กำหนดไว้แล้วครอบวันนี้อยู่ — ไปแก้ไขที่หน้าประวัติกะของพนักงานคนนั้นแทน
          </p>
        </div>
      )}
    </>
  )
}
