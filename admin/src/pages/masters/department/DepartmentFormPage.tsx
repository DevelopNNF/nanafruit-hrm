import { useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import type { Department, DepartmentInput } from '@hrm/shared'
import {
  createDepartment,
  getDepartment,
  listDepartments,
  updateDepartment,
} from '../../../api/departments'
import { useCanWrite } from '../../../auth/meContext'
import { notify } from '../../../notifications/notify'
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
} from '../../../styles'

const emptyDraft: DepartmentInput = {
  deptCode: '',
  deptName: '',
  parentDepartmentId: null,
  isActive: true,
}

type DepartmentOptionsState =
  | { phase: 'loading' }
  | { phase: 'ok'; departments: Department[] }
  | { phase: 'error'; message: string }

/**
 * A department can't be its own ancestor, so it (and everything already
 * under it) is excluded from the "หน่วยงานต้นสังกัด" options here — purely a
 * UX shortcut. The API still enforces this with a recursive check
 * (departmentQueries.wouldCreateCycle) since a second admin could edit a
 * middle department in the same chain between this list loading and submit.
 */
function excludingSelfAndDescendants(departments: Department[], selfId: number | null): Department[] {
  if (selfId === null) return departments

  const excluded = new Set<number>([selfId])
  let grew = true
  while (grew) {
    grew = false
    for (const dept of departments) {
      if (
        dept.parentDepartmentId !== null &&
        excluded.has(dept.parentDepartmentId) &&
        !excluded.has(dept.id)
      ) {
        excluded.add(dept.id)
        grew = true
      }
    }
  }

  return departments.filter((dept) => !excluded.has(dept.id))
}

export function DepartmentFormPage() {
  const params = useParams()
  const navigate = useNavigate()
  const canWrite = useCanWrite()

  // The route is /master/departments/new or /master/departments/:id — the
  // param tells us which.
  const idParam = params['id']
  const isNew = idParam === undefined
  const id = isNew ? null : Number(idParam)

  const [draft, setDraft] = useState<DepartmentInput>(emptyDraft)
  const [loading, setLoading] = useState(!isNew)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [departmentOptions, setDepartmentOptions] = useState<DepartmentOptionsState>({
    phase: 'loading',
  })

  useEffect(() => {
    if (id === null) return
    const controller = new AbortController()

    getDepartment(id, controller.signal)
      .then((department) => {
        setDraft({
          deptCode: department.deptCode,
          deptName: department.deptName,
          parentDepartmentId: department.parentDepartmentId,
          isActive: department.isActive,
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

  useEffect(() => {
    const controller = new AbortController()
    listDepartments(controller.signal)
      .then((departments) => setDepartmentOptions({ phase: 'ok', departments }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setDepartmentOptions({
          phase: 'error',
          message: err instanceof Error ? err.message : 'request failed',
        })
      })
    return () => controller.abort()
  }, [])

  const parentOptions = useMemo(() => {
    if (departmentOptions.phase !== 'ok') return []
    return excludingSelfAndDescendants(departmentOptions.departments, id)
  }, [departmentOptions, id])

  function set<K extends keyof DepartmentInput>(key: K, value: DepartmentInput[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      if (id === null) await createDepartment(draft)
      else await updateDepartment(id, draft)
      notify.success(isNew ? 'เพิ่มแผนกสำเร็จ' : 'บันทึกการแก้ไขสำเร็จ')
      void navigate('/master/departments')
    } catch (err) {
      // Server-side rejections (duplicate code, cycle in the hierarchy) land
      // here — keep the user's input on screen and show why it was refused.
      setError(err instanceof Error ? err.message : 'save failed')
      setSaving(false)
    }
  }

  // A viewer has no business on the "new department" route at all — there is
  // nothing on it they could finish. The edit route still shows them the
  // record, read-only, because reading is exactly what their role is for.
  if (isNew && !canWrite) return <Navigate to="/master/departments" replace />

  if (loading) return <p className={muted}>กำลังโหลด…</p>

  return (
    <>
      <header className={pageHead}>
        <div>
          <p className={eyebrow}>
            <Link
              className="inline-flex items-center gap-1.5 text-slate-500 no-underline normal-case tracking-normal hover:text-navy"
              to="/master/departments"
            >
              <ArrowLeft size={13} />
              กลับไปรายการแผนก
            </Link>
          </p>
          <h1>{isNew ? 'เพิ่มแผนก' : canWrite ? 'แก้ไขแผนก' : 'ข้อมูลแผนก'}</h1>
          <p className={subtitle}>
            {isNew ? 'กรอกข้อมูลให้ครบทุกช่องที่มีเครื่องหมาย *' : draft.deptName}
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
        <fieldset disabled={!canWrite} className="min-w-0 border-0 p-0">
          <section className={`${card} mb-4`}>
            <div className="flex flex-col gap-4">
              <label className={fieldLabel}>
                <span>
                  รหัสแผนก <span className={requiredMark}>*</span>
                </span>
                <input
                  required
                  className={fieldControl}
                  value={draft.deptCode}
                  onChange={(e) => set('deptCode', e.target.value)}
                />
              </label>
              <label className={fieldLabel}>
                <span>
                  ชื่อแผนก <span className={requiredMark}>*</span>
                </span>
                <input
                  required
                  className={fieldControl}
                  value={draft.deptName}
                  onChange={(e) => set('deptName', e.target.value)}
                />
              </label>
              <label className={fieldLabel}>
                <span>หน่วยงานต้นสังกัด (Parent Department)</span>
                <select
                  className={fieldControl}
                  disabled={departmentOptions.phase === 'loading'}
                  value={draft.parentDepartmentId ?? ''}
                  onChange={(e) =>
                    set('parentDepartmentId', e.target.value ? Number(e.target.value) : null)
                  }
                >
                  <option value="">
                    {departmentOptions.phase === 'loading'
                      ? 'กำลังโหลดรายการแผนก…'
                      : '— ไม่มีหน่วยงานต้นสังกัด —'}
                  </option>
                  {parentOptions.map((department) => (
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
              <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
                <input
                  type="checkbox"
                  checked={draft.isActive}
                  onChange={(e) => set('isActive', e.target.checked)}
                />
                <span>เปิดใช้งาน</span>
              </label>
            </div>
          </section>
        </fieldset>

        {canWrite ? (
          <div className="flex items-center gap-2.5 pt-1">
            <button className={button('primary')} type="submit" disabled={saving}>
              {saving ? 'กำลังบันทึก…' : 'บันทึก'}
            </button>
            <button
              className={button()}
              type="button"
              onClick={() => void navigate('/master/departments')}
              disabled={saving}
            >
              ยกเลิก
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2.5 pt-1">
            <button
              className={button()}
              type="button"
              onClick={() => void navigate('/master/departments')}
            >
              กลับ
            </button>
          </div>
        )}
      </form>
    </>
  )
}
