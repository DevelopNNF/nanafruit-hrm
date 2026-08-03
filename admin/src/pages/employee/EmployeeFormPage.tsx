import { useEffect, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import {
  EMPLOYEE_STATUSES,
  EMPLOYMENT_TYPES,
  GENDERS,
  TITLES,
  type Department,
  type Employee,
  type EmployeeInput,
  type HolidayGroup,
  type Job,
  type Shift,
} from '@hrm/shared'
import { createEmployee, deleteEmployee, getEmployee } from '../../api/employees'
import { listJobs } from '../../api/jobs'
import { listDepartments } from '../../api/departments'
import { listShifts } from '../../api/shifts'
import { listHolidayGroups } from '../../api/holidayGroups'
import { DatePicker } from '../../components/DatePicker'
import { EmployeeBasicTab } from '../../components/EmployeeBasicTab'
import { EmployeeEmploymentTab } from '../../components/EmployeeEmploymentTab'
import { LeaveBalanceCard } from '../../components/LeaveBalanceCard'
import { ShiftHistoryCard } from '../../components/ShiftHistoryCard'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs'
import { useCanWrite } from '../../auth/meContext'
import { notify } from '../../notifications/notify'
import {
  alert,
  alertDetail,
  alertTitle,
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

/** Local calendar date as YYYY-MM-DD. toISOString would shift the day west of UTC. */
function today(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

const emptyDraft: EmployeeInput = {
  employeeCode: '',
  title: TITLES[0],
  firstNameTh: '',
  lastNameTh: '',
  firstNameEn: '',
  lastNameEn: '',
  nickname: null,
  gender: null,
  employment: {
    status: EMPLOYEE_STATUSES[0],
    hireDate: today(),
    // 0 is not a real master_jobs id — it's the sentinel for "nothing picked
    // yet", matched by the disabled placeholder option in the Job Title select.
    jobId: 0,
    // Same sentinel reasoning as jobId — 0 is not a real master_departments id.
    departmentId: 0,
    employmentType: EMPLOYMENT_TYPES[0],
    // Unlike jobId, null is a real value here — shift assignment is optional —
    // so it doubles as both "nothing picked yet" and "deliberately unset".
    shiftId: null,
    // Same reasoning as shiftId — not every employee has a holiday calendar
    // assigned yet.
    holidayGroupId: null,
  },
}

const fieldGrid = 'grid gap-x-5 gap-y-4 grid-cols-[repeat(auto-fit,minmax(13rem,1fr))]'
const sectionTitle = 'mb-5 border-b border-slate-200 pb-3 text-xs font-bold tracking-wider text-slate-500 uppercase'

const EDIT_TABS = [
  { value: 'basic', label: 'รูปพนักงาน & ข้อมูลพื้นฐาน' },
  { value: 'employment', label: 'ข้อมูลการจ้างงาน' },
  { value: 'leave', label: 'สิทธิการลา' },
  { value: 'shift', label: 'การเปลี่ยนกะ' },
] as const
type EditTabValue = (typeof EDIT_TABS)[number]['value']

export function EmployeeFormPage() {
  const params = useParams()
  const navigate = useNavigate()
  const canWrite = useCanWrite()

  // The route is /employees/new or /employees/:id — the param tells us which.
  const idParam = params['id']
  const isNew = idParam === undefined
  const id = isNew ? null : Number(idParam)

  // A viewer has no business on the "new employee" route at all — there is
  // nothing on it they could finish. The edit route still shows them the record,
  // read-only, because reading is exactly what their role is for.
  if (isNew && !canWrite) return <Navigate to="/employees" replace />

  if (isNew) return <NewEmployeeForm canWrite={canWrite} onCancel={() => void navigate('/employees')} />
  if (id !== null) return <EditEmployeePage id={id} canWrite={canWrite} />
  return null
}

/**
 * Creating an employee is a single uncluttered form — there is no id yet for
 * a photo, LINE link code, leave balance or shift history to attach to, so
 * there is nothing to split into tabs here.
 */
function NewEmployeeForm({ canWrite, onCancel }: { canWrite: boolean; onCancel: () => void }) {
  const navigate = useNavigate()
  const [draft, setDraft] = useState<EmployeeInput>(emptyDraft)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  type JobOptionsState =
    | { phase: 'loading' }
    | { phase: 'ok'; jobs: Job[] }
    | { phase: 'error'; message: string }
  const [jobOptions, setJobOptions] = useState<JobOptionsState>({ phase: 'loading' })

  type DepartmentOptionsState =
    | { phase: 'loading' }
    | { phase: 'ok'; departments: Department[] }
    | { phase: 'error'; message: string }
  const [departmentOptions, setDepartmentOptions] = useState<DepartmentOptionsState>({
    phase: 'loading',
  })

  type ShiftOptionsState =
    | { phase: 'loading' }
    | { phase: 'ok'; shifts: Shift[] }
    | { phase: 'error'; message: string }
  const [shiftOptions, setShiftOptions] = useState<ShiftOptionsState>({ phase: 'loading' })

  type HolidayGroupOptionsState =
    | { phase: 'loading' }
    | { phase: 'ok'; holidayGroups: HolidayGroup[] }
    | { phase: 'error'; message: string }
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
    listShifts(controller.signal)
      .then((shifts) =>
        setShiftOptions({ phase: 'ok', shifts: shifts.filter((shift) => shift.isActive) })
      )
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setShiftOptions({
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

  function setBasic<K extends keyof EmployeeInput>(key: K, value: EmployeeInput[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  function setEmployment<K extends keyof EmployeeInput['employment']>(
    key: K,
    value: EmployeeInput['employment'][K]
  ) {
    setDraft((prev) => ({ ...prev, employment: { ...prev.employment, [key]: value } }))
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      await createEmployee(draft)
      notify.success('เพิ่มพนักงานสำเร็จ')
      void navigate('/employees')
    } catch (err) {
      // Server-side rejections (duplicate code, bad enum) land here — keep the
      // user's input on screen and show why it was refused.
      setError(err instanceof Error ? err.message : 'save failed')
      setSaving(false)
    }
  }

  const activeJobIds = jobOptions.phase === 'ok' ? jobOptions.jobs.map((j) => j.id) : []
  // A saved employee can point at a job that's since been deactivated — kept
  // selectable (labelled) rather than silently dropped out from under the
  // draft on open.
  const currentJobMissing =
    draft.employment.jobId !== 0 && !activeJobIds.includes(draft.employment.jobId)

  const activeDepartmentIds =
    departmentOptions.phase === 'ok' ? departmentOptions.departments.map((d) => d.id) : []
  const currentDepartmentMissing =
    draft.employment.departmentId !== 0 &&
    !activeDepartmentIds.includes(draft.employment.departmentId)

  const activeShiftIds = shiftOptions.phase === 'ok' ? shiftOptions.shifts.map((s) => s.id) : []
  const currentShiftMissing =
    draft.employment.shiftId !== null && !activeShiftIds.includes(draft.employment.shiftId)

  const activeHolidayGroupIds =
    holidayGroupOptions.phase === 'ok' ? holidayGroupOptions.holidayGroups.map((g) => g.id) : []
  const currentHolidayGroupMissing =
    draft.employment.holidayGroupId !== null &&
    !activeHolidayGroupIds.includes(draft.employment.holidayGroupId)

  return (
    <>
      <header className={pageHead}>
        <div>
          <p className={eyebrow}>
            <Link
              className="inline-flex items-center gap-1.5 text-slate-500 no-underline normal-case tracking-normal hover:text-navy"
              to="/employees"
            >
              <ArrowLeft size={13} />
              กลับไปรายชื่อพนักงาน
            </Link>
          </p>
          <h1>เพิ่มพนักงาน</h1>
          <p className={subtitle}>กรอกข้อมูลให้ครบทุกช่องที่มีเครื่องหมาย *</p>
        </div>
      </header>

      {error && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>บันทึกไม่สำเร็จ</p>
          <p className={alertDetail}>{error}</p>
        </div>
      )}

      <form className="max-w-3xl" onSubmit={(e) => void handleSubmit(e)}>
        {/* One fieldset rather than a `disabled` on each control: a field added
            later is read-only by default instead of by remembering. */}
        <fieldset disabled={!canWrite} className="min-w-0 border-0 p-0">
          <section className={`${card} mb-4`}>
            <h2 className={sectionTitle}>ข้อมูลพื้นฐาน (Basic information)</h2>
            <div className={fieldGrid}>
              <label className={fieldLabel}>
                <span>
                  รหัสพนักงาน <span className={requiredMark}>*</span>
                </span>
                <input
                  required
                  className={fieldControl}
                  value={draft.employeeCode}
                  onChange={(e) => setBasic('employeeCode', e.target.value)}
                />
              </label>
              <label className={fieldLabel}>
                <span>
                  คำนำหน้า <span className={requiredMark}>*</span>
                </span>
                <select
                  className={fieldControl}
                  value={draft.title}
                  onChange={(e) =>
                    setBasic('title', e.target.value as EmployeeInput['title'])
                  }
                >
                  {TITLES.map((title) => (
                    <option key={title} value={title}>
                      {title}
                    </option>
                  ))}
                </select>
              </label>
              <label className={fieldLabel}>
                <span>
                  ชื่อ (ไทย) <span className={requiredMark}>*</span>
                </span>
                <input
                  required
                  className={fieldControl}
                  value={draft.firstNameTh}
                  onChange={(e) => setBasic('firstNameTh', e.target.value)}
                />
              </label>
              <label className={fieldLabel}>
                <span>
                  นามสกุล (ไทย) <span className={requiredMark}>*</span>
                </span>
                <input
                  required
                  className={fieldControl}
                  value={draft.lastNameTh}
                  onChange={(e) => setBasic('lastNameTh', e.target.value)}
                />
              </label>
              <label className={fieldLabel}>
                <span>
                  ชื่อ (EN) <span className={requiredMark}>*</span>
                </span>
                <input
                  required
                  className={fieldControl}
                  value={draft.firstNameEn}
                  onChange={(e) => setBasic('firstNameEn', e.target.value)}
                />
              </label>
              <label className={fieldLabel}>
                <span>
                  นามสกุล (EN) <span className={requiredMark}>*</span>
                </span>
                <input
                  required
                  className={fieldControl}
                  value={draft.lastNameEn}
                  onChange={(e) => setBasic('lastNameEn', e.target.value)}
                />
              </label>
              <label className={fieldLabel}>
                <span>ชื่อเล่น</span>
                <input
                  className={fieldControl}
                  value={draft.nickname ?? ''}
                  onChange={(e) => setBasic('nickname', e.target.value || null)}
                />
              </label>
              <label className={fieldLabel}>
                <span>เพศ</span>
                <select
                  className={fieldControl}
                  value={draft.gender ?? ''}
                  onChange={(e) =>
                    setBasic('gender', (e.target.value || null) as EmployeeInput['gender'])
                  }
                >
                  <option value="">— ไม่ระบุ —</option>
                  {GENDERS.map((gender) => (
                    <option key={gender} value={gender}>
                      {gender === 'male' ? 'ชาย' : 'หญิง'}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </section>

          <section className={`${card} mb-4`}>
            <h2 className={sectionTitle}>ข้อมูลการจ้างงาน (Employment information)</h2>
            <div className={fieldGrid}>
              <label className={fieldLabel}>
                <span>
                  สถานะการจ้างงาน <span className={requiredMark}>*</span>
                </span>
                <select
                  className={fieldControl}
                  value={draft.employment.status}
                  onChange={(e) =>
                    setEmployment(
                      'status',
                      e.target.value as EmployeeInput['employment']['status']
                    )
                  }
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
                  value={draft.employment.hireDate}
                  onChange={(value) => setEmployment('hireDate', value)}
                />
              </label>
              <label className={fieldLabel}>
                <span>
                  ประเภทการจ้าง <span className={requiredMark}>*</span>
                </span>
                <select
                  className={fieldControl}
                  value={draft.employment.employmentType}
                  onChange={(e) =>
                    setEmployment(
                      'employmentType',
                      e.target.value as EmployeeInput['employment']['employmentType']
                    )
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
                  value={draft.employment.jobId}
                  onChange={(e) => setEmployment('jobId', Number(e.target.value))}
                >
                  <option value={0} disabled>
                    {jobOptions.phase === 'loading' ? 'กำลังโหลดตำแหน่งงาน…' : '— เลือกตำแหน่งงาน —'}
                  </option>
                  {currentJobMissing && (
                    <option value={draft.employment.jobId}>
                      #{draft.employment.jobId} (ไม่พร้อมใช้งาน)
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
                <select
                  required
                  className={fieldControl}
                  disabled={departmentOptions.phase === 'loading'}
                  value={draft.employment.departmentId}
                  onChange={(e) => setEmployment('departmentId', Number(e.target.value))}
                >
                  <option value={0} disabled>
                    {departmentOptions.phase === 'loading' ? 'กำลังโหลดแผนก…' : '— เลือกแผนก —'}
                  </option>
                  {currentDepartmentMissing && (
                    <option value={draft.employment.departmentId}>
                      #{draft.employment.departmentId} (ไม่พร้อมใช้งาน)
                    </option>
                  )}
                  {departmentOptions.phase === 'ok' &&
                    departmentOptions.departments.map((department) => (
                      <option key={department.id} value={department.id}>
                        {department.deptName}
                      </option>
                    ))}
                </select>
                {departmentOptions.phase === 'error' && (
                  <span className="text-[0.7rem] text-red-700">
                    โหลดรายการแผนกไม่สำเร็จ: {departmentOptions.message}
                  </span>
                )}
              </label>
              <label className={fieldLabel}>
                <span>กะการทำงาน (Shift)</span>
                <select
                  className={fieldControl}
                  disabled={shiftOptions.phase === 'loading'}
                  value={draft.employment.shiftId ?? ''}
                  onChange={(e) =>
                    setEmployment('shiftId', e.target.value ? Number(e.target.value) : null)
                  }
                >
                  <option value="">
                    {shiftOptions.phase === 'loading' ? 'กำลังโหลดกะการทำงาน…' : '— ไม่ระบุกะ —'}
                  </option>
                  {currentShiftMissing && (
                    <option value={draft.employment.shiftId ?? ''}>
                      #{draft.employment.shiftId} (ไม่พร้อมใช้งาน)
                    </option>
                  )}
                  {shiftOptions.phase === 'ok' &&
                    shiftOptions.shifts.map((shift) => (
                      <option key={shift.id} value={shift.id}>
                        {shift.shiftName}
                      </option>
                    ))}
                </select>
                {shiftOptions.phase === 'error' && (
                  <span className="text-[0.7rem] text-red-700">
                    โหลดรายการกะการทำงานไม่สำเร็จ: {shiftOptions.message}
                  </span>
                )}
              </label>
              <label className={fieldLabel}>
                <span>กลุ่มวันหยุด (Holiday Group)</span>
                <select
                  className={fieldControl}
                  disabled={holidayGroupOptions.phase === 'loading'}
                  value={draft.employment.holidayGroupId ?? ''}
                  onChange={(e) =>
                    setEmployment(
                      'holidayGroupId',
                      e.target.value ? Number(e.target.value) : null
                    )
                  }
                >
                  <option value="">
                    {holidayGroupOptions.phase === 'loading'
                      ? 'กำลังโหลดกลุ่มวันหยุด…'
                      : '— ไม่ระบุกลุ่ม —'}
                  </option>
                  {currentHolidayGroupMissing && (
                    <option value={draft.employment.holidayGroupId ?? ''}>
                      #{draft.employment.holidayGroupId} (ไม่พร้อมใช้งาน)
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

        <div className="flex items-center gap-2.5 pt-1">
          <button className={button('primary')} type="submit" disabled={saving}>
            {saving ? 'กำลังบันทึก…' : 'บันทึก'}
          </button>
          <button className={button()} type="button" onClick={onCancel} disabled={saving}>
            ยกเลิก
          </button>
        </div>
      </form>
    </>
  )
}

/** Editing an existing employee: header + delete action, then the 4 tabs. */
function EditEmployeePage({ id, canWrite }: { id: number; canWrite: boolean }) {
  const navigate = useNavigate()
  const [employee, setEmployee] = useState<Employee | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [tab, setTab] = useState<EditTabValue>('basic')

  useEffect(() => {
    const controller = new AbortController()
    getEmployee(id, controller.signal)
      .then((emp) => {
        setEmployee(emp)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setError(err instanceof Error ? err.message : 'request failed')
        setLoading(false)
      })
    return () => controller.abort()
  }, [id])

  // Re-fetches the employee after ShiftHistoryCard records a change — that
  // card's own list is already up to date from its own reload, this only
  // refreshes the read-only "current shift" field shown on the employment tab.
  function refreshCurrentShift() {
    getEmployee(id)
      .then((emp) => setEmployee(emp))
      .catch(() => {
        /* best-effort refresh only */
      })
  }

  async function handleDelete() {
    if (!employee) return
    if (!confirm(`ลบพนักงาน ${employee.employeeCode}?`)) return
    setDeleting(true)
    try {
      await deleteEmployee(id)
      notify.success('ลบพนักงานสำเร็จ')
      void navigate('/employees')
    } catch (err) {
      notify.error(err instanceof Error ? err.message : 'delete failed')
      setDeleting(false)
    }
  }

  if (loading) return <p className={muted}>กำลังโหลด…</p>

  return (
    <>
      <header className={pageHead}>
        <div>
          <p className={eyebrow}>
            <Link
              className="inline-flex items-center gap-1.5 text-slate-500 no-underline normal-case tracking-normal hover:text-navy"
              to="/employees"
            >
              <ArrowLeft size={13} />
              กลับไปรายชื่อพนักงาน
            </Link>
          </p>
          <h1>{canWrite ? 'แก้ไขข้อมูลพนักงาน' : 'ข้อมูลพนักงาน'}</h1>
          <p className={subtitle}>{employee ? `รหัส ${employee.employeeCode}` : null}</p>
        </div>
        {canWrite && employee && (
          <button
            className={button('danger')}
            type="button"
            onClick={() => void handleDelete()}
            disabled={deleting}
          >
            ลบพนักงาน
          </button>
        )}
      </header>

      {!canWrite && (
        <div className={alert('info')}>
          <p className={alertTitle()}>โหมดอ่านอย่างเดียว</p>
          <p className={muted}>สิทธิ์ของคุณดูข้อมูลได้อย่างเดียว จึงแก้ไขข้อมูลนี้ไม่ได้</p>
        </div>
      )}

      {error && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>โหลดข้อมูลไม่สำเร็จ</p>
          <p className={alertDetail}>{error}</p>
        </div>
      )}

      {employee && (
        <Tabs value={tab} onValueChange={(v) => setTab(v as EditTabValue)}>
          <TabsList>
            {EDIT_TABS.map((t) => (
              <TabsTrigger key={t.value} value={t.value}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="basic">
            <EmployeeBasicTab employee={employee} canWrite={canWrite} onSaved={setEmployee} />
          </TabsContent>
          <TabsContent value="employment">
            <EmployeeEmploymentTab employee={employee} canWrite={canWrite} onSaved={setEmployee} />
          </TabsContent>
          <TabsContent value="leave">
            <LeaveBalanceCard employeeId={employee.id} canWrite={canWrite} />
          </TabsContent>
          <TabsContent value="shift">
            <ShiftHistoryCard
              employeeId={employee.id}
              canWrite={canWrite}
              onChanged={refreshCurrentShift}
            />
          </TabsContent>
        </Tabs>
      )}
    </>
  )
}
