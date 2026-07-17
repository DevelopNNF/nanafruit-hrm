import { useEffect, useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import {
  EMPLOYEE_STATUSES,
  EMPLOYMENT_TYPES,
  TITLES,
  type EmployeeInput,
} from '@hrm/shared'
import {
  createEmployee,
  deleteEmployee,
  getEmployee,
  updateEmployee,
} from '../api/employees'
import { LinkCodeCard } from '../components/LinkCodeCard'
import { useCanWrite } from '../auth/meContext'

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
  employment: {
    status: EMPLOYEE_STATUSES[0],
    hireDate: today(),
    employmentType: EMPLOYMENT_TYPES[0],
    jobTitle: '',
  },
}

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
          employment: employee.employment,
        })
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

  if (loading) return <p className="muted">กำลังโหลด…</p>

  return (
    <>
      <header className="page-head">
        <div>
          <h1>{isNew ? 'เพิ่มพนักงาน' : canWrite ? 'แก้ไขข้อมูลพนักงาน' : 'ข้อมูลพนักงาน'}</h1>
          <p className="subtitle">
            {isNew ? 'Employee Master' : `รหัส ${draft.employeeCode}`}
          </p>
        </div>
      </header>

      {!canWrite && (
        <div className="card form-card">
          <p className="muted">สิทธิ์ของคุณดูข้อมูลได้อย่างเดียว จึงแก้ไขข้อมูลนี้ไม่ได้</p>
        </div>
      )}

      {error && (
        <div className="card error">
          <p className="headline">บันทึกไม่สำเร็จ</p>
          <p className="detail">{error}</p>
        </div>
      )}

      <form onSubmit={(e) => void handleSubmit(e)}>
        {/* One fieldset rather than a `disabled` on each control: a field added
            later is read-only by default instead of by remembering. */}
        <fieldset disabled={!canWrite}>
          <section className="card form-card">
            <h2>Basic information</h2>
            <div className="field-grid">
              <label>
                <span>Employee Code *</span>
                <input
                  required
                  value={draft.employeeCode}
                  onChange={(e) => setBasic('employeeCode', e.target.value)}
                />
              </label>
              <label>
                <span>คำนำหน้า *</span>
                <select
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
              <label>
                <span>ชื่อ (ไทย) *</span>
                <input
                  required
                  value={draft.firstNameTh}
                  onChange={(e) => setBasic('firstNameTh', e.target.value)}
                />
              </label>
              <label>
                <span>นามสกุล (ไทย) *</span>
                <input
                  required
                  value={draft.lastNameTh}
                  onChange={(e) => setBasic('lastNameTh', e.target.value)}
                />
              </label>
              <label>
                <span>First name (EN) *</span>
                <input
                  required
                  value={draft.firstNameEn}
                  onChange={(e) => setBasic('firstNameEn', e.target.value)}
                />
              </label>
              <label>
                <span>Last name (EN) *</span>
                <input
                  required
                  value={draft.lastNameEn}
                  onChange={(e) => setBasic('lastNameEn', e.target.value)}
                />
              </label>
              <label>
                <span>ชื่อเล่น</span>
                <input
                  value={draft.nickname ?? ''}
                  onChange={(e) => setBasic('nickname', e.target.value || null)}
                />
              </label>
            </div>
          </section>

          <section className="card form-card">
            <h2>Employment information</h2>
            <div className="field-grid">
              <label>
                <span>Employee Status *</span>
                <select
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
              <label>
                <span>Hire Date *</span>
                <input
                  required
                  type="date"
                  value={draft.employment.hireDate}
                  onChange={(e) => setEmployment('hireDate', e.target.value)}
                />
              </label>
              <label>
                <span>Employment Type *</span>
                <select
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
              <label>
                <span>Job Title *</span>
                <input
                  required
                  value={draft.employment.jobTitle}
                  onChange={(e) => setEmployment('jobTitle', e.target.value)}
                />
              </label>
            </div>
          </section>
        </fieldset>

        {canWrite ? (
          <div className="form-actions">
            <button className="button primary" type="submit" disabled={saving}>
              {saving ? 'กำลังบันทึก…' : 'บันทึก'}
            </button>
            <button
              className="button"
              type="button"
              onClick={() => void navigate('/employees')}
              disabled={saving}
            >
              ยกเลิก
            </button>
            {!isNew && (
              <button
                className="button danger"
                type="button"
                onClick={() => void handleDelete()}
                disabled={saving}
              >
                ลบ
              </button>
            )}
          </div>
        ) : (
          <div className="form-actions">
            <button
              className="button"
              type="button"
              onClick={() => void navigate('/employees')}
            >
              กลับ
            </button>
          </div>
        )}
      </form>

      {/* Outside the form: issuing a code is its own action against a saved
          employee, and a button inside a form would submit it. */}
      {id !== null && canWrite && <LinkCodeCard employeeId={id} />}
    </>
  )
}
