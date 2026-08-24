import { useEffect, useMemo, useState } from 'react'
import type { DailyShiftAssignmentOutcome, Employee, Shift } from '@hrm/shared'
import { assignDailyShifts, listEmployees } from '../api/employees'
import { listShifts } from '../api/shifts'
import { DatePicker } from '../components/DatePicker'
import { notify } from '../notifications/notify'
import {
  alert,
  alertDetail,
  alertTitle,
  button,
  card,
  eyebrow,
  fieldControl,
  muted,
  pageHead,
  subtitle,
} from '../styles'

type LoadState<T> = { phase: 'loading' } | { phase: 'ok'; value: T } | { phase: 'error'; message: string }

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
 * There is no server-side filter for "temporary daily workers" — GET
 * /employees always returns everyone, same as EmployeeListPage — so this
 * filters employmentType client-side after fetching the full list.
 */
export function DailyShiftAssignmentPage() {
  const [date, setDate] = useState(today())
  const [employeesState, setEmployeesState] = useState<LoadState<Employee[]>>({ phase: 'loading' })
  const [shiftsState, setShiftsState] = useState<LoadState<Shift[]>>({ phase: 'loading' })
  const [selections, setSelections] = useState<Record<number, number | ''>>({})
  const [bulkShiftId, setBulkShiftId] = useState<number | ''>('')
  const [submitting, setSubmitting] = useState(false)
  const [outcomes, setOutcomes] = useState<DailyShiftAssignmentOutcome[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    listEmployees(controller.signal)
      .then((employees) => setEmployeesState({ phase: 'ok', value: employees }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
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
    return employeesState.value
      .filter((e) => e.employment.employmentType === 'ชั่วคราว' && e.employment.status === 'Active')
      .sort((a, b) => a.employeeCode.localeCompare(b.employeeCode))
  }, [employeesState])

  const outcomeByEmployeeId = useMemo(
    () => new Map((outcomes ?? []).map((o) => [o.employeeId, o])),
    [outcomes]
  )
  const employeeById = useMemo(() => new Map(tempWorkers.map((e) => [e.id, e])), [tempWorkers])

  function setRowShift(employeeId: number, shiftId: number | '') {
    setSelections((prev) => ({ ...prev, [employeeId]: shiftId }))
  }

  function applyBulkShift() {
    if (bulkShiftId === '') return
    const next: Record<number, number | ''> = {}
    for (const e of tempWorkers) next[e.id] = bulkShiftId
    setSelections(next)
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    const assignments = Object.entries(selections)
      .filter(([, shiftId]) => shiftId !== '')
      .map(([employeeId, shiftId]) => ({ employeeId: Number(employeeId), shiftId: Number(shiftId) }))

    if (assignments.length === 0) {
      notify.error('ยังไม่ได้เลือกกะให้ใครเลย', 'เลือกกะอย่างน้อยหนึ่งคนก่อนบันทึก')
      return
    }

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
        setSelections({})
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
            สำหรับพนักงานรายวันชั่วคราว (ไม่มีกะตายตัว) — เลือกกะให้แต่ละคนสำหรับวันที่เลือก แล้วบันทึกพร้อมกัน
          </p>
        </div>
      </header>

      {error && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>บันทึกไม่สำเร็จ</p>
          <p className={alertDetail}>{error}</p>
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

      <form className={`${card} mb-4`} onSubmit={(e) => void handleSubmit(e)}>
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-slate-600">
            <span>วันที่</span>
            <DatePicker required value={date} onChange={setDate} />
          </label>
          <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-slate-600">
            <span>ใช้กะนี้กับทุกแถว</span>
            <select
              className={fieldControl}
              value={bulkShiftId}
              onChange={(e) => setBulkShiftId(e.target.value ? Number(e.target.value) : '')}
            >
              <option value="">— เลือกกะ —</option>
              {shifts.map((shift) => (
                <option key={shift.id} value={shift.id}>
                  {shift.shiftName}
                </option>
              ))}
            </select>
          </label>
          <button
            className={button()}
            type="button"
            disabled={bulkShiftId === '' || tempWorkers.length === 0}
            onClick={applyBulkShift}
          >
            ใช้กับทุกแถว
          </button>
        </div>

        {loading && <p className={muted}>กำลังโหลด…</p>}

        {!loading && tempWorkers.length === 0 && (
          <p className={muted}>ยังไม่มีพนักงานรายวันชั่วคราว (ประเภทการจ้าง &quot;ชั่วคราว&quot;) ในระบบ</p>
        )}

        {!loading && tempWorkers.length > 0 && (
          <div className="mb-4 overflow-x-auto rounded-md border border-slate-200">
            <table className="w-full border-collapse text-[0.775rem] [&_tbody_tr:last-child_td]:border-b-0">
              <thead>
                <tr>
                  {['รหัส', 'ชื่อ', 'แผนก', 'กะ', 'สถานะการมอบหมาย'].map((h) => (
                    <th
                      key={h}
                      className="border-b border-slate-200 bg-slate-50 px-3 py-1.5 text-left text-[0.65rem] font-semibold tracking-wider text-slate-500 uppercase"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tempWorkers.map((employee) => {
                  const outcome = outcomeByEmployeeId.get(employee.id)
                  return (
                    <tr key={employee.id}>
                      <td className="border-b border-slate-200 px-3 py-1.5 align-middle whitespace-nowrap text-slate-700">
                        {employee.employeeCode}
                      </td>
                      <td className="border-b border-slate-200 px-3 py-1.5 align-middle text-slate-900">
                        {employee.title}{employee.firstNameTh} {employee.lastNameTh}
                      </td>
                      <td className="border-b border-slate-200 px-3 py-1.5 align-middle text-slate-600">
                        {employee.employment.departmentName}
                      </td>
                      <td className="border-b border-slate-200 px-3 py-1.5 align-middle">
                        <select
                          className={fieldControl}
                          value={selections[employee.id] ?? ''}
                          onChange={(e) =>
                            setRowShift(employee.id, e.target.value ? Number(e.target.value) : '')
                          }
                        >
                          <option value="">— ไม่ระบุกะ —</option>
                          {shifts.map((shift) => (
                            <option key={shift.id} value={shift.id}>
                              {shift.shiftName}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="border-b border-slate-200 px-3 py-1.5 align-middle whitespace-nowrap">
                        {!outcome && <span className={muted}>—</span>}
                        {outcome?.kind === 'ok' && (
                          <span className="text-green-700">มอบหมายสำเร็จ</span>
                        )}
                        {outcome?.kind === 'conflict' && (
                          <span className="text-amber-700">
                            ทับกับช่วงเดิม ({outcome.existingEffectiveFrom} –{' '}
                            {outcome.existingEffectiveTo ?? 'ปัจจุบัน'}) — แก้ไขผ่านประวัติกะของพนักงาน
                          </span>
                        )}
                        {outcome?.kind === 'error' && (
                          <span className="text-red-700">ผิดพลาด: {outcome.message}</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
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
