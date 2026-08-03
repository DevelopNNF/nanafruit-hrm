import { useState } from 'react'
import { GENDERS, TITLES, type Employee, type EmployeeBasicInput } from '@hrm/shared'
import { updateEmployeeBasic } from '../api/employees'
import { EmployeePhotoCard } from './EmployeePhotoCard'
import { LinkCodeCard } from './LinkCodeCard'
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

function draftFrom(employee: Employee): EmployeeBasicInput {
  return {
    employeeCode: employee.employeeCode,
    title: employee.title,
    firstNameTh: employee.firstNameTh,
    lastNameTh: employee.lastNameTh,
    firstNameEn: employee.firstNameEn,
    lastNameEn: employee.lastNameEn,
    nickname: employee.nickname,
    gender: employee.gender,
  }
}

/**
 * Tab 1 of the employee edit screen: photo, basic identity fields, and LINE
 * account binding. Saves independently of employment info via its own
 * PATCH /employees/:id/basic — no need to know the employment tab's draft.
 */
export function EmployeeBasicTab({
  employee,
  canWrite,
  onSaved,
}: {
  employee: Employee
  canWrite: boolean
  onSaved: (employee: Employee) => void
}) {
  const [draft, setDraft] = useState<EmployeeBasicInput>(() => draftFrom(employee))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function set<K extends keyof EmployeeBasicInput>(key: K, value: EmployeeBasicInput[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const updated = await updateEmployeeBasic(employee.id, draft)
      notify.success('บันทึกข้อมูลพื้นฐานสำเร็จ')
      onSaved(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <EmployeePhotoCard employeeId={employee.id} canWrite={canWrite} />

      {error && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>บันทึกไม่สำเร็จ</p>
          <p className={alertDetail}>{error}</p>
        </div>
      )}

      <form onSubmit={(e) => void handleSubmit(e)}>
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
                  onChange={(e) => set('employeeCode', e.target.value)}
                />
              </label>
              <label className={fieldLabel}>
                <span>
                  คำนำหน้า <span className={requiredMark}>*</span>
                </span>
                <select
                  className={fieldControl}
                  value={draft.title}
                  onChange={(e) => set('title', e.target.value as EmployeeBasicInput['title'])}
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
                  onChange={(e) => set('firstNameTh', e.target.value)}
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
                  onChange={(e) => set('lastNameTh', e.target.value)}
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
                  onChange={(e) => set('firstNameEn', e.target.value)}
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
                  onChange={(e) => set('lastNameEn', e.target.value)}
                />
              </label>
              <label className={fieldLabel}>
                <span>ชื่อเล่น</span>
                <input
                  className={fieldControl}
                  value={draft.nickname ?? ''}
                  onChange={(e) => set('nickname', e.target.value || null)}
                />
              </label>
              <label className={fieldLabel}>
                <span>เพศ</span>
                <select
                  className={fieldControl}
                  value={draft.gender ?? ''}
                  onChange={(e) =>
                    set('gender', (e.target.value || null) as EmployeeBasicInput['gender'])
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
        </fieldset>

        {canWrite && <LinkCodeCard employeeId={employee.id} />}

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
