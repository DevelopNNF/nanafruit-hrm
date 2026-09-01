import { useState } from 'react'
import {
  FINGERPRINT_CODE_MAX_LENGTH,
  GENDERS,
  NATIONALITIES,
  TITLES,
  type Employee,
  type EmployeeBasicInput,
} from '@hrm/shared'
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

/** Custom controls (DatePicker/TreeSelect elsewhere) anchor their `required`
 *  check on a zero-size hidden input, so the browser's native validation
 *  bubble can end up invisible or mispositioned. Checking here and surfacing
 *  it as a toast is the reliable path, regardless of what the browser does
 *  with `required`. */
function missingBasicFields(draft: EmployeeBasicInput): string[] {
  const missing: string[] = []
  if (!draft.employeeCode.trim()) missing.push('รหัสพนักงาน')
  if (!draft.firstNameTh.trim()) missing.push('ชื่อ (ไทย)')
  if (!draft.lastNameTh.trim()) missing.push('นามสกุล (ไทย)')
  if (!draft.nationality) missing.push('สัญชาติ')
  if (draft.nationality === 'ไทย' && (!draft.idCardNumber || !/^\d{13}$/.test(draft.idCardNumber))) {
    missing.push('เลขบัตรประชาชน (13 หลัก)')
  }
  return missing
}

function draftFrom(employee: Employee): EmployeeBasicInput {
  return {
    employeeCode: employee.employeeCode,
    idCardNumber: employee.idCardNumber,
    nationality: employee.nationality,
    fingerprintCode: employee.fingerprintCode,
    entraUpn: employee.entraUpn,
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
    const missing = missingBasicFields(draft)
    if (missing.length > 0) {
      notify.error('กรอกข้อมูลไม่ครบ', `กรุณากรอก: ${missing.join(', ')}`)
      return
    }
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

      {/* noValidate: native constraint validation blocks the submit event
          before handleSubmit ever runs, and for the custom controls
          elsewhere (DatePicker/TreeSelect's zero-size hidden `required`
          input) it can do so with no visible bubble at all — silently
          "nothing happens" on click. The missing-field toast below is the
          one validation path that always runs and is always visible. */}
      <form noValidate onSubmit={(e) => void handleSubmit(e)}>
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
                <span>ชื่อ (EN)</span>
                <input
                  className={fieldControl}
                  value={draft.firstNameEn ?? ''}
                  onChange={(e) => set('firstNameEn', e.target.value || null)}
                />
              </label>
              <label className={fieldLabel}>
                <span>นามสกุล (EN)</span>
                <input
                  className={fieldControl}
                  value={draft.lastNameEn ?? ''}
                  onChange={(e) => set('lastNameEn', e.target.value || null)}
                />
              </label>
              <label className={fieldLabel}>
                <span>
                  สัญชาติ <span className={requiredMark}>*</span>
                </span>
                <select
                  className={fieldControl}
                  value={draft.nationality ?? ''}
                  onChange={(e) =>
                    set('nationality', (e.target.value || null) as EmployeeBasicInput['nationality'])
                  }
                >
                  <option value="" disabled>
                    — เลือกสัญชาติ —
                  </option>
                  {NATIONALITIES.map((nationality) => (
                    <option key={nationality} value={nationality}>
                      {nationality}
                    </option>
                  ))}
                </select>
              </label>
              <label className={fieldLabel}>
                <span>
                  เลขบัตรประชาชน {draft.nationality === 'ไทย' && <span className={requiredMark}>*</span>}
                </span>
                <input
                  required={draft.nationality === 'ไทย'}
                  maxLength={13}
                  inputMode="numeric"
                  pattern="\d{13}"
                  className={fieldControl}
                  value={draft.idCardNumber ?? ''}
                  onChange={(e) => set('idCardNumber', e.target.value.replace(/\D/g, '') || null)}
                />
              </label>
              <label className={fieldLabel}>
                <span>รหัสลายนิ้วมือ</span>
                <input
                  maxLength={FINGERPRINT_CODE_MAX_LENGTH}
                  className={fieldControl}
                  value={draft.fingerprintCode ?? ''}
                  onChange={(e) => set('fingerprintCode', e.target.value.trim() || null)}
                />
              </label>
              <label className={fieldLabel}>
                <span>Entra UPN (สำหรับหัวหน้างานที่ต้องเข้า Admin)</span>
                <input
                  type="email"
                  className={fieldControl}
                  placeholder="someone@nanafruit.com"
                  value={draft.entraUpn ?? ''}
                  onChange={(e) => set('entraUpn', e.target.value.trim() || null)}
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

        {canWrite && <LinkCodeCard employee={employee} onSaved={onSaved} />}

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
