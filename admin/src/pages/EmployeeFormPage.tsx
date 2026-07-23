import { useEffect, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import {
  EMPLOYEE_STATUSES,
  EMPLOYMENT_TYPES,
  GENDERS,
  TITLES,
  type EmployeeInput,
  type HolidayGroup,
  type Job,
  type Shift,
} from '@hrm/shared'
import {
  createEmployee,
  deleteEmployee,
  getEmployee,
  updateEmployee,
} from '../api/employees'
import { listJobs } from '../api/jobs'
import { listShifts } from '../api/shifts'
import { listHolidayGroups } from '../api/holidayGroups'
import { DatePicker } from '../components/DatePicker'
import { LinkCodeCard } from '../components/LinkCodeCard'
import { useCanWrite } from '../auth/meContext'
import { notify } from '../notifications/notify'
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
} from '../styles'

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

export function EmployeeFormPage() {
  const params = useParams()
  const navigate = useNavigate()
  const canWrite = useCanWrite()

  // The route is /employees/new or /employees/:id — the param tells us which.
  const idParam = params['id']
  const isNew = idParam === undefined
  const id = isNew ? null : Number(idParam)

  const [draft, setDraft] = useState<EmployeeInput>(emptyDraft)
  const [loading, setLoading] = useState(!isNew)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The title/name as of the last load — EmploymentDetailsInput (what `draft`
  // holds) has no jobTitle/shiftName/holidayGroupName field, so this is the
  // only place the label for a deactivated job's, shift's or holiday group's
  // option comes from.
  const [loadedJobTitle, setLoadedJobTitle] = useState<string | null>(null)
  const [loadedShiftName, setLoadedShiftName] = useState<string | null>(null)
  const [loadedHolidayGroupName, setLoadedHolidayGroupName] = useState<string | null>(null)

  type JobOptionsState =
    | { phase: 'loading' }
    | { phase: 'ok'; jobs: Job[] }
    | { phase: 'error'; message: string }
  const [jobOptions, setJobOptions] = useState<JobOptionsState>({ phase: 'loading' })

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

    // Any role can read master_jobs (same canRead as employees), so this loads
    // regardless of canWrite — a viewer sees the same options a form submit would.
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

  useEffect(() => {
    if (id === null) return
    const controller = new AbortController()

    getEmployee(id, controller.signal)
      .then((employee) => {
        // Spelled out rather than destructuring `id` away: EmployeeInput is
        // Omit<Employee, 'id'>, so a new field on Employee fails to compile here
        // until the form grows an input for it.
        setDraft({
          employeeCode: employee.employeeCode,
          title: employee.title,
          firstNameTh: employee.firstNameTh,
          lastNameTh: employee.lastNameTh,
          firstNameEn: employee.firstNameEn,
          lastNameEn: employee.lastNameEn,
          nickname: employee.nickname,
          gender: employee.gender,
          employment: employee.employment,
        })
        setLoadedJobTitle(employee.employment.jobTitle)
        setLoadedShiftName(employee.employment.shiftName)
        setLoadedHolidayGroupName(employee.employment.holidayGroupName)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setError(err instanceof Error ? err.message : 'request failed')
        setLoading(false)
      })

    return () => controller.abort()
  }, [id])

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
      if (id === null) await createEmployee(draft)
      else await updateEmployee(id, draft)
      notify.success(isNew ? 'เพิ่มพนักงานสำเร็จ' : 'บันทึกการแก้ไขสำเร็จ')
      void navigate('/employees')
    } catch (err) {
      // Server-side rejections (duplicate code, bad enum) land here — keep the
      // user's input on screen and show why it was refused.
      setError(err instanceof Error ? err.message : 'save failed')
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (id === null) return
    if (!confirm(`ลบพนักงาน ${draft.employeeCode}?`)) return
    setSaving(true)
    setError(null)
    try {
      await deleteEmployee(id)
      notify.success('ลบพนักงานสำเร็จ')
      void navigate('/employees')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'delete failed')
      setSaving(false)
    }
  }

  // A viewer has no business on the "new employee" route at all — there is
  // nothing on it they could finish. The edit route still shows them the record,
  // read-only, because reading is exactly what their role is for.
  if (isNew && !canWrite) return <Navigate to="/employees" replace />

  if (loading) return <p className={muted}>กำลังโหลด…</p>

  const activeJobIds = jobOptions.phase === 'ok' ? jobOptions.jobs.map((j) => j.id) : []
  // A saved employee can point at a job that's since been deactivated — kept
  // selectable (labelled) rather than silently dropped out from under the
  // draft on open.
  const currentJobMissing =
    draft.employment.jobId !== 0 && !activeJobIds.includes(draft.employment.jobId)

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
          <h1>{isNew ? 'เพิ่มพนักงาน' : canWrite ? 'แก้ไขข้อมูลพนักงาน' : 'ข้อมูลพนักงาน'}</h1>
          <p className={subtitle}>
            {isNew ? 'กรอกข้อมูลให้ครบทุกช่องที่มีเครื่องหมาย *' : `รหัส ${draft.employeeCode}`}
          </p>
        </div>
      </header>

      {!canWrite && (
        <div className={alert('info')}>
          <p className={alertTitle()}>โหมดอ่านอย่างเดียว</p>
          <p className={muted}>สิทธิ์ของคุณดูข้อมูลได้อย่างเดียว จึงแก้ไขข้อมูลนี้ไม่ได้</p>
        </div>
      )}

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
                      {loadedJobTitle ?? `#${draft.employment.jobId}`} (ไม่พร้อมใช้งาน)
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
                      {loadedShiftName ?? `#${draft.employment.shiftId}`} (ไม่พร้อมใช้งาน)
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
                      {loadedHolidayGroupName ?? `#${draft.employment.holidayGroupId}`} (ไม่พร้อมใช้งาน)
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

        {/* Outside the form: issuing a code is its own action against a saved
            employee, and a button inside a form would submit it. */}
        {id !== null && canWrite && <LinkCodeCard employeeId={id} />}

        {canWrite ? (
          <div className="flex items-center gap-2.5 pt-1">
            <button className={button('primary')} type="submit" disabled={saving}>
              {saving ? 'กำลังบันทึก…' : 'บันทึก'}
            </button>
            <button
              className={button()}
              type="button"
              onClick={() => void navigate('/employees')}
              disabled={saving}
            >
              ยกเลิก
            </button>
            {!isNew && (
              <button
                className={button('danger')}
                type="button"
                onClick={() => void handleDelete()}
                disabled={saving}
              >
                ลบ
              </button>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2.5 pt-1">
            <button
              className={button()}
              type="button"
              onClick={() => void navigate('/employees')}
            >
              กลับ
            </button>
          </div>
        )}
      </form>
    </>
  )
}
