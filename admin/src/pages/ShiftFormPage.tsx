import { useEffect, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { WORKDAYS, type ShiftInput } from '@hrm/shared'
import { createShift, getShift, updateShift } from '../api/shifts'
import { computeWorkMinutes, formatWorkMinutes } from '../shiftHours'
import { TimeInput } from '../components/TimeInput'
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

const emptyDraft: ShiftInput = {
  shiftCode: '',
  shiftName: '',
  shiftStartTime: '',
  shiftEndTime: '',
  breakStartTime: null,
  breakEndTime: null,
  workdays: 0,
  isActive: true,
}

/** 'HH:MM:SS' -> 'HH:MM', which is what <input type="time"> wants. */
function toInputTime(time: string | null): string {
  return time ? time.slice(0, 5) : ''
}

export function ShiftFormPage() {
  const params = useParams()
  const navigate = useNavigate()
  const canWrite = useCanWrite()

  // The route is /master/shifts/new or /master/shifts/:id — the param tells us which.
  const idParam = params['id']
  const isNew = idParam === undefined
  const id = isNew ? null : Number(idParam)

  const [draft, setDraft] = useState<ShiftInput>(emptyDraft)
  const [hasBreak, setHasBreak] = useState(false)
  const [loading, setLoading] = useState(!isNew)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (id === null) return
    const controller = new AbortController()

    getShift(id, controller.signal)
      .then((shift) => {
        setDraft({
          shiftCode: shift.shiftCode,
          shiftName: shift.shiftName,
          shiftStartTime: toInputTime(shift.shiftStartTime),
          shiftEndTime: toInputTime(shift.shiftEndTime),
          breakStartTime: toInputTime(shift.breakStartTime) || null,
          breakEndTime: toInputTime(shift.breakEndTime) || null,
          workdays: shift.workdays,
          isActive: shift.isActive,
        })
        setHasBreak(shift.breakStartTime !== null)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setError(err instanceof Error ? err.message : 'request failed')
        setLoading(false)
      })

    return () => controller.abort()
  }, [id])

  function set<K extends keyof ShiftInput>(key: K, value: ShiftInput[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  function toggleWorkday(bit: number) {
    setDraft((prev) => ({
      ...prev,
      workdays: (prev.workdays & bit) !== 0 ? prev.workdays & ~bit : prev.workdays | bit,
    }))
  }

  function toggleHasBreak(checked: boolean) {
    setHasBreak(checked)
    if (!checked) {
      set('breakStartTime', null)
      set('breakEndTime', null)
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      if (id === null) await createShift(draft)
      else await updateShift(id, draft)
      notify.success(isNew ? 'เพิ่มกะการทำงานสำเร็จ' : 'บันทึกการแก้ไขสำเร็จ')
      void navigate('/master/shifts')
    } catch (err) {
      // Server-side rejections (duplicate code) land here — keep the user's
      // input on screen and show why it was refused.
      setError(err instanceof Error ? err.message : 'save failed')
      setSaving(false)
    }
  }

  // A viewer has no business on the "new shift" route at all — there is nothing
  // on it they could finish. The edit route still shows them the record,
  // read-only, because reading is exactly what their role is for.
  if (isNew && !canWrite) return <Navigate to="/master/shifts" replace />

  if (loading) return <p className={muted}>กำลังโหลด…</p>

  const workMinutes = computeWorkMinutes(draft)

  return (
    <>
      <header className={pageHead}>
        <div>
          <p className={eyebrow}>
            <Link
              className="inline-flex items-center gap-1.5 text-slate-500 no-underline normal-case tracking-normal hover:text-navy"
              to="/master/shifts"
            >
              <ArrowLeft size={13} />
              กลับไปรายการกะการทำงาน
            </Link>
          </p>
          <h1>{isNew ? 'เพิ่มกะการทำงาน' : canWrite ? 'แก้ไขกะการทำงาน' : 'ข้อมูลกะการทำงาน'}</h1>
          <p className={subtitle}>
            {isNew ? 'กรอกข้อมูลให้ครบทุกช่องที่มีเครื่องหมาย *' : draft.shiftName}
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
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <label className={fieldLabel}>
                  <span>
                    Shift Code <span className={requiredMark}>*</span>
                  </span>
                  <input
                    required
                    className={fieldControl}
                    value={draft.shiftCode}
                    onChange={(e) => set('shiftCode', e.target.value)}
                  />
                </label>
                <label className={fieldLabel}>
                  <span>
                    Shift Name <span className={requiredMark}>*</span>
                  </span>
                  <input
                    required
                    className={fieldControl}
                    value={draft.shiftName}
                    onChange={(e) => set('shiftName', e.target.value)}
                  />
                </label>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <label className={fieldLabel}>
                  <span>
                    เวลาเข้ากะ <span className={requiredMark}>*</span>
                  </span>
                  <TimeInput
                    required
                    value={draft.shiftStartTime}
                    onChange={(v) => set('shiftStartTime', v)}
                  />
                </label>
                <label className={fieldLabel}>
                  <span>
                    เวลาออกกะ <span className={requiredMark}>*</span>
                  </span>
                  <TimeInput
                    required
                    value={draft.shiftEndTime}
                    onChange={(v) => set('shiftEndTime', v)}
                  />
                  <span className="font-normal text-slate-400">
                    ถ้าเวลาออกกะน้อยกว่าเวลาเข้ากะ ระบบจะถือว่ากะนี้ข้ามเที่ยงคืน
                  </span>
                </label>
              </div>

              <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
                <input
                  type="checkbox"
                  checked={hasBreak}
                  onChange={(e) => toggleHasBreak(e.target.checked)}
                />
                <span>มีเวลาพัก</span>
              </label>

              {hasBreak && (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <label className={fieldLabel}>
                    <span>
                      เวลาเริ่มพัก <span className={requiredMark}>*</span>
                    </span>
                    <TimeInput
                      required
                      value={draft.breakStartTime ?? ''}
                      onChange={(v) => set('breakStartTime', v || null)}
                    />
                  </label>
                  <label className={fieldLabel}>
                    <span>
                      เวลาหมดเวลาพัก <span className={requiredMark}>*</span>
                    </span>
                    <TimeInput
                      required
                      value={draft.breakEndTime ?? ''}
                      onChange={(v) => set('breakEndTime', v || null)}
                    />
                  </label>
                </div>
              )}

              <p className="text-[0.825rem] text-slate-600">
                <span className="font-medium text-slate-700">ชั่วโมงทำงาน (ไม่รวมเวลาพัก): </span>
                {workMinutes === null ? (
                  <span className="text-slate-400">กรอกเวลาเข้า-ออกกะให้ครบ</span>
                ) : (
                  <span className="font-semibold text-slate-900">{formatWorkMinutes(workMinutes)}</span>
                )}
              </p>

              <div className={fieldLabel}>
                <span>
                  วันทำงาน <span className={requiredMark}>*</span>
                </span>
                <div className="flex flex-wrap gap-3 pt-1">
                  {WORKDAYS.map((day) => (
                    <label
                      key={day.key}
                      className="flex items-center gap-1.5 text-[0.825rem] font-normal text-slate-700"
                    >
                      <input
                        type="checkbox"
                        checked={(draft.workdays & day.bit) !== 0}
                        onChange={() => toggleWorkday(day.bit)}
                      />
                      <span>{day.label}</span>
                    </label>
                  ))}
                </div>
              </div>

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
              onClick={() => void navigate('/master/shifts')}
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
              onClick={() => void navigate('/master/shifts')}
            >
              กลับ
            </button>
          </div>
        )}
      </form>
    </>
  )
}
