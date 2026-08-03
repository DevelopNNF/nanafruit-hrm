import { useEffect, useMemo, useState } from 'react'
import {
  EMPLOYEE_STATUSES,
  EMPLOYMENT_TYPES,
  type Department,
  type Employee,
  type EmploymentInput,
  type Job,
  type HolidayGroup,
} from '@hrm/shared'
import { updateEmployeeEmployment } from '../api/employees'
import { listJobs } from '../api/jobs'
import { listDepartments } from '../api/departments'
import { listHolidayGroups } from '../api/holidayGroups'
import { DatePicker } from './DatePicker'
import { TreeSelect, type TreeSelectOption } from './TreeSelect'
import { notify } from '../notifications/notify'
import {
  alert,
  alertDetail,
  alertTitle,
  button,
  card,
  fieldControl,
  fieldLabel,
  requiredMark,
} from '../styles'

const fieldGrid = 'grid gap-x-5 gap-y-4 grid-cols-[repeat(auto-fit,minmax(13rem,1fr))]'
const sectionTitle = 'mb-5 border-b border-slate-200 pb-3 text-xs font-bold tracking-wider text-slate-500 uppercase'

type JobOptionsState =
  | { phase: 'loading' }
  | { phase: 'ok'; jobs: Job[] }
  | { phase: 'error'; message: string }

type DepartmentOptionsState =
  | { phase: 'loading' }
  | { phase: 'ok'; departments: Department[] }
  | { phase: 'error'; message: string }

type HolidayGroupOptionsState =
  | { phase: 'loading' }
  | { phase: 'ok'; holidayGroups: HolidayGroup[] }
  | { phase: 'error'; message: string }

function draftFrom(employee: Employee): EmploymentInput {
  return {
    status: employee.employment.status,
    hireDate: employee.employment.hireDate,
    employmentType: employee.employment.employmentType,
    jobId: employee.employment.jobId,
    departmentId: employee.employment.departmentId,
    holidayGroupId: employee.employment.holidayGroupId,
  }
}

/**
 * Tab 2 of the employee edit screen: employment details. Shift is shown
 * read-only here — changing it needs an effective date and always goes
 * through the shift-history tab's own form, which is the only writer of
 * "current shift". Saves independently of basic info via its own
 * PATCH /employees/:id/employment.
 */
export function EmployeeEmploymentTab({
  employee,
  canWrite,
  onSaved,
}: {
  employee: Employee
  canWrite: boolean
  onSaved: (employee: Employee) => void
}) {
  const [draft, setDraft] = useState<EmploymentInput>(() => draftFrom(employee))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // employee.id never changes under this component, but the employment
  // fields do — e.g. after a shift change refreshes the parent's `employee`,
  // this resets the draft to match rather than showing stale values. Adjusted
  // during render (React's recommended pattern for this) rather than in an
  // effect, so it doesn't cause an extra commit.
  const [prevEmployee, setPrevEmployee] = useState(employee)
  if (employee !== prevEmployee) {
    setPrevEmployee(employee)
    setDraft(draftFrom(employee))
  }

  const [jobOptions, setJobOptions] = useState<JobOptionsState>({ phase: 'loading' })
  const [departmentOptions, setDepartmentOptions] = useState<DepartmentOptionsState>({
    phase: 'loading',
  })
  const [holidayGroupOptions, setHolidayGroupOptions] = useState<HolidayGroupOptionsState>({
    phase: 'loading',
  })

  useEffect(() => {
    const controller = new AbortController()
    listJobs(controller.signal)
      .then((jobs) => setJobOptions({ phase: 'ok', jobs: jobs.filter((job) => job.isActive) }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setJobOptions({
          phase: 'error',
          message: err instanceof Error ? err.message : 'request failed',
        })
      })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    listDepartments(controller.signal)
      .then((departments) =>
        setDepartmentOptions({
          phase: 'ok',
          departments: departments.filter((department) => department.isActive),
        })
      )
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setDepartmentOptions({
          phase: 'error',
          message: err instanceof Error ? err.message : 'request failed',
        })
      })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    listHolidayGroups(controller.signal)
      .then((holidayGroups) =>
        setHolidayGroupOptions({
          phase: 'ok',
          holidayGroups: holidayGroups.filter((group) => group.isActive),
        })
      )
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setHolidayGroupOptions({
          phase: 'error',
          message: err instanceof Error ? err.message : 'request failed',
        })
      })
    return () => controller.abort()
  }, [])

  function set<K extends keyof EmploymentInput>(key: K, value: EmploymentInput[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const updated = await updateEmployeeEmployment(employee.id, draft)
      notify.success('บันทึกข้อมูลการจ้างงานสำเร็จ')
      onSaved(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed')
    } finally {
      setSaving(false)
    }
  }

  const activeJobIds = jobOptions.phase === 'ok' ? jobOptions.jobs.map((j) => j.id) : []
  // A saved employee can point at a job that's since been deactivated — kept
  // selectable (labelled) rather than silently dropped out from under the
  // draft on open.
  const currentJobMissing = !activeJobIds.includes(draft.jobId)

  const activeDepartmentIds =
    departmentOptions.phase === 'ok' ? departmentOptions.departments.map((d) => d.id) : []
  const currentDepartmentMissing = !activeDepartmentIds.includes(draft.departmentId)

  const departmentTreeOptions: TreeSelectOption[] = useMemo(() => {
    const options: TreeSelectOption[] =
      departmentOptions.phase === 'ok'
        ? departmentOptions.departments.map((department) => ({
            id: department.id,
            label: department.deptName,
            parentId: department.parentDepartmentId,
          }))
        : []
    if (currentDepartmentMissing) {
      options.push({
        id: draft.departmentId,
        label: `${employee.employment.departmentName} (ไม่พร้อมใช้งาน)`,
        parentId: null,
      })
    }
    return options
  }, [departmentOptions, currentDepartmentMissing, draft.departmentId, employee.employment.departmentName])

  const activeHolidayGroupIds =
    holidayGroupOptions.phase === 'ok' ? holidayGroupOptions.holidayGroups.map((g) => g.id) : []
  const currentHolidayGroupMissing =
    draft.holidayGroupId !== null && !activeHolidayGroupIds.includes(draft.holidayGroupId)

  return (
    <>
      {error && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>บันทึกไม่สำเร็จ</p>
          <p className={alertDetail}>{error}</p>
        </div>
      )}

      <form className="" onSubmit={(e) => void handleSubmit(e)}>
        <fieldset disabled={!canWrite} className="min-w-0 border-0 p-0">
          <section className={`${card} mb-4`}>
            <h2 className={sectionTitle}>ข้อมูลการจ้างงาน (Employment information)</h2>
            <div className={fieldGrid}>
              <label className={fieldLabel}>
                <span>
                  สถานะการจ้างงาน <span className={requiredMark}>*</span>
                </span>
                <select
                  className={fieldControl}
                  value={draft.status}
                  onChange={(e) => set('status', e.target.value as EmploymentInput['status'])}
                >
                  {EMPLOYEE_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </select>
              </label>
              <label className={fieldLabel}>
                <span>
                  วันที่จ้าง <span className={requiredMark}>*</span>
                </span>
                <DatePicker
                  required
                  value={draft.hireDate}
                  onChange={(value) => set('hireDate', value)}
                  className='w-full'
                />
              </label>
              <label className={fieldLabel}>
                <span>
                  ประเภทการจ้าง <span className={requiredMark}>*</span>
                </span>
                <select
                  className={fieldControl}
                  value={draft.employmentType}
                  onChange={(e) =>
                    set('employmentType', e.target.value as EmploymentInput['employmentType'])
                  }
                >
                  {EMPLOYMENT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </label>
              <label className={fieldLabel}>
                <span>
                  Job Title <span className={requiredMark}>*</span>
                </span>
                <select
                  required
                  className={fieldControl}
                  disabled={jobOptions.phase === 'loading'}
                  value={draft.jobId}
                  onChange={(e) => set('jobId', Number(e.target.value))}
                >
                  {currentJobMissing && (
                    <option value={draft.jobId}>
                      {employee.employment.jobTitle} (ไม่พร้อมใช้งาน)
                    </option>
                  )}
                  {jobOptions.phase === 'ok' &&
                    jobOptions.jobs.map((job) => (
                      <option key={job.id} value={job.id}>
                        {job.jobTitle}
                      </option>
                    ))}
                </select>
                {jobOptions.phase === 'error' && (
                  <span className="text-[0.7rem] text-red-700">
                    โหลดรายการตำแหน่งงานไม่สำเร็จ: {jobOptions.message}
                  </span>
                )}
              </label>
              <label className={fieldLabel}>
                <span>
                  แผนก (Department) <span className={requiredMark}>*</span>
                </span>
                <TreeSelect
                  mode="single"
                  required
                  options={departmentTreeOptions}
                  value={draft.departmentId}
                  onChange={(value) => value !== null && set('departmentId', value)}
                  placeholder="เลือกแผนก"
                  disabled={departmentOptions.phase === 'loading'}
                  loading={departmentOptions.phase === 'loading'}
                />
                {departmentOptions.phase === 'error' && (
                  <span className="text-[0.7rem] text-red-700">
                    โหลดรายการแผนกไม่สำเร็จ: {departmentOptions.message}
                  </span>
                )}
              </label>
              <label className={fieldLabel}>
                <span>กะการทำงาน (Shift)</span>
                {/* Read-only: a change needs an effective date, so it goes
                    through the shift-history tab's own form instead. */}
                <input
                  className={fieldControl}
                  value={employee.employment.shiftName ?? '— ไม่ระบุกะ —'}
                  disabled
                  readOnly
                />
              </label>
              <label className={fieldLabel}>
                <span>กลุ่มวันหยุด (Holiday Group)</span>
                <select
                  className={fieldControl}
                  disabled={holidayGroupOptions.phase === 'loading'}
                  value={draft.holidayGroupId ?? ''}
                  onChange={(e) =>
                    set('holidayGroupId', e.target.value ? Number(e.target.value) : null)
                  }
                >
                  <option value="">
                    {holidayGroupOptions.phase === 'loading'
                      ? 'กำลังโหลดกลุ่มวันหยุด…'
                      : '— ไม่ระบุกลุ่ม —'}
                  </option>
                  {currentHolidayGroupMissing && (
                    <option value={draft.holidayGroupId ?? ''}>
                      {employee.employment.holidayGroupName ?? `#${draft.holidayGroupId}`} (ไม่พร้อมใช้งาน)
                    </option>
                  )}
                  {holidayGroupOptions.phase === 'ok' &&
                    holidayGroupOptions.holidayGroups.map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.groupName}
                      </option>
                    ))}
                </select>
                {holidayGroupOptions.phase === 'error' && (
                  <span className="text-[0.7rem] text-red-700">
                    โหลดรายการกลุ่มวันหยุดไม่สำเร็จ: {holidayGroupOptions.message}
                  </span>
                )}
              </label>
            </div>
          </section>
        </fieldset>

        {canWrite && (
          <div className="flex items-center gap-2.5 pt-1">
            <button className={button('primary')} type="submit" disabled={saving}>
              {saving ? 'กำลังบันทึก…' : 'บันทึก'}
            </button>
          </div>
        )}
      </form>
    </>
  )
}
