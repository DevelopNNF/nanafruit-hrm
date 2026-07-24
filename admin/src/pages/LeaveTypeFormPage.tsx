import { useEffect, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import type { LeaveTypeInput } from '@hrm/shared'
import { createLeaveType, getLeaveType, updateLeaveType } from '../api/leaveTypes'
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

const GENDER_OPTIONS: { value: LeaveTypeInput['gender']; label: string }[] = [
  { value: 'all', label: 'ทุกเพศ' },
  { value: 'male', label: 'ชายเท่านั้น' },
  { value: 'female', label: 'หญิงเท่านั้น' },
]

const emptyDraft: LeaveTypeInput = {
  leaveCode: '',
  leaveName: '',
  isPaid: true,
  allowHalfDay: false,
  allowHourly: false,
  minLeaveDays: 0.5,
  maxLeaveDays: null,
  advanceNoticeDays: 0,
  gender: 'all',
  isCountHoliday: false,
  isCountWeekend: false,
  defaultDaysPerYear: null,
  requireReason: false,
  sortOrder: 0,
  isActive: true,
}

const fieldGrid = 'grid gap-x-5 gap-y-4 grid-cols-[repeat(auto-fit,minmax(13rem,1fr))]'
const sectionTitle =
  'mb-5 border-b border-slate-200 pb-3 text-xs font-bold tracking-wider text-slate-500 uppercase'
const checkboxLabel = 'flex items-center gap-2 text-xs font-medium text-slate-600'

export function LeaveTypeFormPage() {
  const params = useParams()
  const navigate = useNavigate()
  const canWrite = useCanWrite()

  // The route is /master/leave-types/new or /master/leave-types/:id.
  const idParam = params['id']
  const isNew = idParam === undefined
  const id = isNew ? null : Number(idParam)

  const [draft, setDraft] = useState<LeaveTypeInput>(emptyDraft)
  const [hasMaxLeave, setHasMaxLeave] = useState(false)
  const [hasDefaultDaysPerYear, setHasDefaultDaysPerYear] = useState(false)
  const [loading, setLoading] = useState(!isNew)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (id === null) return
    const controller = new AbortController()

    getLeaveType(id, controller.signal)
      .then((leaveType) => {
        setDraft({
          leaveCode: leaveType.leaveCode,
          leaveName: leaveType.leaveName,
          isPaid: leaveType.isPaid,
          allowHalfDay: leaveType.allowHalfDay,
          allowHourly: leaveType.allowHourly,
          minLeaveDays: leaveType.minLeaveDays,
          maxLeaveDays: leaveType.maxLeaveDays,
          advanceNoticeDays: leaveType.advanceNoticeDays,
          gender: leaveType.gender,
          isCountHoliday: leaveType.isCountHoliday,
          isCountWeekend: leaveType.isCountWeekend,
          defaultDaysPerYear: leaveType.defaultDaysPerYear,
          requireReason: leaveType.requireReason,
          sortOrder: leaveType.sortOrder,
          isActive: leaveType.isActive,
        })
        setHasMaxLeave(leaveType.maxLeaveDays !== null)
        setHasDefaultDaysPerYear(leaveType.defaultDaysPerYear !== null)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setError(err instanceof Error ? err.message : 'request failed')
        setLoading(false)
      })

    return () => controller.abort()
  }, [id])

  function set<K extends keyof LeaveTypeInput>(key: K, value: LeaveTypeInput[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  function toggleHasMaxLeave(checked: boolean) {
    setHasMaxLeave(checked)
    if (!checked) set('maxLeaveDays', null)
    else if (draft.maxLeaveDays === null) set('maxLeaveDays', draft.minLeaveDays)
  }

  function toggleHasDefaultDaysPerYear(checked: boolean) {
    setHasDefaultDaysPerYear(checked)
    if (!checked) set('defaultDaysPerYear', null)
    else if (draft.defaultDaysPerYear === null) set('defaultDaysPerYear', 6)
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      if (id === null) await createLeaveType(draft)
      else await updateLeaveType(id, draft)
      notify.success(isNew ? 'เพิ่มประเภทการลาสำเร็จ' : 'บันทึกการแก้ไขสำเร็จ')
      void navigate('/master/leave-types')
    } catch (err) {
      // Server-side rejections (duplicate code, bad range) land here — keep
      // the user's input on screen and show why it was refused.
      setError(err instanceof Error ? err.message : 'save failed')
      setSaving(false)
    }
  }

  // A viewer has no business on the "new leave type" route at all — there is
  // nothing on it they could finish. The edit route still shows them the
  // record, read-only, because reading is exactly what their role is for.
  if (isNew && !canWrite) return <Navigate to="/master/leave-types" replace />

  if (loading) return <p className={muted}>กำลังโหลด…</p>

  return (
    <>
      <header className={pageHead}>
        <div>
          <p className={eyebrow}>
            <Link
              className="inline-flex items-center gap-1.5 text-slate-500 no-underline normal-case tracking-normal hover:text-navy"
              to="/master/leave-types"
            >
              <ArrowLeft size={13} />
              กลับไปรายการประเภทการลา
            </Link>
          </p>
          <h1>{isNew ? 'เพิ่มประเภทการลา' : canWrite ? 'แก้ไขประเภทการลา' : 'ข้อมูลประเภทการลา'}</h1>
          <p className={subtitle}>
            {isNew ? 'กรอกข้อมูลให้ครบทุกช่องที่มีเครื่องหมาย *' : draft.leaveName}
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
                  Leave Code <span className={requiredMark}>*</span>
                </span>
                <input
                  required
                  className={fieldControl}
                  value={draft.leaveCode}
                  onChange={(e) => set('leaveCode', e.target.value)}
                />
              </label>
              <label className={fieldLabel}>
                <span>
                  ชื่อประเภทการลา <span className={requiredMark}>*</span>
                </span>
                <input
                  required
                  className={fieldControl}
                  value={draft.leaveName}
                  onChange={(e) => set('leaveName', e.target.value)}
                />
              </label>
              <label className={fieldLabel}>
                <span>ลำดับการแสดงผล</span>
                <input
                  type="number"
                  step={1}
                  className={fieldControl}
                  value={draft.sortOrder}
                  onChange={(e) => set('sortOrder', Number(e.target.value))}
                />
              </label>
            </div>
          </section>

          <section className={`${card} mb-4`}>
            <h2 className={sectionTitle}>เงื่อนไขการลา (Leave rules)</h2>
            <div className={fieldGrid}>
              <label className={fieldLabel}>
                <span>
                  จำนวนวันลาขั้นต่ำต่อครั้ง <span className={requiredMark}>*</span>
                </span>
                <input
                  required
                  type="number"
                  min={0.5}
                  step={0.5}
                  className={fieldControl}
                  value={draft.minLeaveDays}
                  onChange={(e) => set('minLeaveDays', Number(e.target.value))}
                />
              </label>
              <label className={fieldLabel}>
                <span>วันแจ้งลาล่วงหน้า (วัน)</span>
                <input
                  type="number"
                  min={0}
                  step={1}
                  className={fieldControl}
                  value={draft.advanceNoticeDays}
                  onChange={(e) => set('advanceNoticeDays', Number(e.target.value))}
                />
              </label>
              <label className={fieldLabel}>
                <span>เพศที่มีสิทธิ์ลา</span>
                <select
                  className={fieldControl}
                  value={draft.gender}
                  onChange={(e) => set('gender', e.target.value as LeaveTypeInput['gender'])}
                >
                  {GENDER_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="mt-4 flex flex-col gap-2.5">
              <label className={checkboxLabel}>
                <input
                  type="checkbox"
                  checked={hasMaxLeave}
                  onChange={(e) => toggleHasMaxLeave(e.target.checked)}
                />
                <span>จำกัดจำนวนวันลาสูงสุดต่อครั้ง</span>
              </label>
              {hasMaxLeave && (
                <label className={fieldLabel}>
                  <span>
                    จำนวนวันลาสูงสุดต่อครั้ง <span className={requiredMark}>*</span>
                  </span>
                  <input
                    required
                    type="number"
                    min={draft.minLeaveDays}
                    step={0.5}
                    className={`${fieldControl} max-w-40`}
                    value={draft.maxLeaveDays ?? ''}
                    onChange={(e) => set('maxLeaveDays', Number(e.target.value))}
                  />
                </label>
              )}
            </div>

            <div className="mt-4 flex flex-col gap-2.5">
              <label className={checkboxLabel}>
                <input
                  type="checkbox"
                  checked={draft.isPaid}
                  onChange={(e) => set('isPaid', e.target.checked)}
                />
                <span>เป็นการลาแบบได้รับค่าจ้าง</span>
              </label>
              <label className={checkboxLabel}>
                <input
                  type="checkbox"
                  checked={draft.allowHalfDay}
                  onChange={(e) => set('allowHalfDay', e.target.checked)}
                />
                <span>อนุญาตให้ลาครึ่งวัน</span>
              </label>
              <label className={checkboxLabel}>
                <input
                  type="checkbox"
                  checked={draft.allowHourly}
                  onChange={(e) => set('allowHourly', e.target.checked)}
                />
                <span>อนุญาตให้ลาเป็นชั่วโมง</span>
              </label>
              <label className={checkboxLabel}>
                <input
                  type="checkbox"
                  checked={draft.requireReason}
                  onChange={(e) => set('requireReason', e.target.checked)}
                />
                <span>บังคับให้ระบุเหตุผลตอนยื่นคำขอลา</span>
              </label>
            </div>
          </section>

          <section className={`${card} mb-4`}>
            <h2 className={sectionTitle}>สิทธิ์วันลาประจำปี (Annual balance)</h2>
            <div className="flex flex-col gap-2.5">
              <label className={checkboxLabel}>
                <input
                  type="checkbox"
                  checked={hasDefaultDaysPerYear}
                  onChange={(e) => toggleHasDefaultDaysPerYear(e.target.checked)}
                />
                <span>ประเภทนี้มีสิทธิ์วันลาสะสมต่อปี (ออกสิทธิ์ผ่านหน้า “สิทธิ์วันลา”)</span>
              </label>
              {hasDefaultDaysPerYear && (
                <label className={`${fieldLabel} max-w-40`}>
                  <span>
                    จำนวนวันสิทธิ์เริ่มต้นต่อปี <span className={requiredMark}>*</span>
                  </span>
                  <input
                    required
                    type="number"
                    min={0.5}
                    step={0.5}
                    className={fieldControl}
                    value={draft.defaultDaysPerYear ?? ''}
                    onChange={(e) => set('defaultDaysPerYear', Number(e.target.value))}
                  />
                </label>
              )}
            </div>
          </section>

          <section className={`${card} mb-4`}>
            <h2 className={sectionTitle}>การนับวันลา (Day counting)</h2>
            <p className={`${muted} mb-3`}>
              ใช้คำนวณจำนวนวันลาตอนพนักงานยื่นคำขอ โดยอ้างอิงปฏิทินวันหยุด (Master → วันหยุด) และวันทำงานตามกะของพนักงานแต่ละคน
            </p>
            <div className="flex flex-col gap-2.5">
              <label className={checkboxLabel}>
                <input
                  type="checkbox"
                  checked={draft.isCountHoliday}
                  onChange={(e) => set('isCountHoliday', e.target.checked)}
                />
                <span>นับวันหยุดนักขัตฤกษ์เป็นวันลา</span>
              </label>
              <label className={checkboxLabel}>
                <input
                  type="checkbox"
                  checked={draft.isCountWeekend}
                  onChange={(e) => set('isCountWeekend', e.target.checked)}
                />
                <span>นับวันเสาร์-อาทิตย์ (หรือวันที่ไม่ได้ทำงานตามกะ) เป็นวันลา</span>
              </label>
              <label className={checkboxLabel}>
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
              onClick={() => void navigate('/master/leave-types')}
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
              onClick={() => void navigate('/master/leave-types')}
            >
              กลับ
            </button>
          </div>
        )}
      </form>
    </>
  )
}
