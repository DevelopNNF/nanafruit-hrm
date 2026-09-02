import { useEffect, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { OVERTIME_ROUNDING_MINUTES, type OvertimeGroupInput } from '@hrm/shared'
import { createOvertimeGroup, getOvertimeGroup, updateOvertimeGroup } from '../../../api/overtimeGroups'
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
  muted,
  pageHead,
  requiredMark,
  subtitle,
} from '../../../styles'

const ROUNDING_LABELS: Record<(typeof OVERTIME_ROUNDING_MINUTES)[number], string> = {
  0: 'ไม่ปัด',
  15: '15 นาที',
  30: '30 นาที',
  60: 'เต็มชั่วโมง',
}

// Comp-time rounding is nearest, not down (unlike the money-side rounding
// above), so its labels say so explicitly rather than reusing ROUNDING_LABELS.
const COMP_ROUNDING_LABELS: Record<(typeof OVERTIME_ROUNDING_MINUTES)[number], string> = {
  0: 'ไม่ปัด',
  15: 'ปัดใกล้สุด 15 นาที',
  30: 'ปัดใกล้สุด 30 นาที',
  60: 'ปัดใกล้สุดชั่วโมง',
}

const emptyDraft: OvertimeGroupInput = {
  groupCode: '',
  groupName: '',
  rateOtWorkday: 1.5,
  rateNormalDayoff: 1,
  rateOtDayoff: 3,
  rateNormalHoliday: 2,
  rateOtHoliday: 3,
  roundingMinutes: 0,
  isActive: true,
  compTimeEnabled: false,
  compRateOtWorkday: null,
  compRateNormalDayoff: null,
  compRateOtDayoff: null,
  compRateNormalHoliday: null,
  compRateOtHoliday: null,
  compAnnualCapEnabled: false,
  compAnnualCapMinutes: null,
  compRoundingMinutes: 0,
}

// Comp-time-off rates default to the same starting multipliers as the money
// rates when the checkbox is first ticked, purely so the form doesn't hand
// the admin five empty required fields with no starting point.
const defaultCompRates = {
  compRateOtWorkday: 1.5,
  compRateNormalDayoff: 1,
  compRateOtDayoff: 3,
  compRateNormalHoliday: 2,
  compRateOtHoliday: 3,
}

const sectionTitle =
  'mb-5 border-b border-slate-200 pb-3 text-xs font-bold tracking-wider text-slate-500 uppercase'

// Label and input share one line ("label * : [input]") instead of label-above
// -input-below, stacked one row per field instead of a wrapping grid — a
// deliberate deviation from fieldGrid/fieldLabel (styles.ts) for this form only.
const fieldStack = 'flex flex-col gap-3'
const fieldRow = 'flex flex-wrap items-center gap-3'
const fieldRowLabel = 'w-72 flex-none text-xs font-medium text-slate-600 text-right'

export function OvertimeGroupFormPage() {
  const params = useParams()
  const navigate = useNavigate()
  const canWrite = useCanWrite()

  // The route is /master/overtime-groups/new or /master/overtime-groups/:id.
  const idParam = params['id']
  const isNew = idParam === undefined
  const id = isNew ? null : Number(idParam)

  const [draft, setDraft] = useState<OvertimeGroupInput>(emptyDraft)
  const [loading, setLoading] = useState(!isNew)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (id === null) return
    const controller = new AbortController()

    getOvertimeGroup(id, controller.signal)
      .then((group) => {
        setDraft({
          groupCode: group.groupCode,
          groupName: group.groupName,
          rateOtWorkday: group.rateOtWorkday,
          rateNormalDayoff: group.rateNormalDayoff,
          rateOtDayoff: group.rateOtDayoff,
          rateNormalHoliday: group.rateNormalHoliday,
          rateOtHoliday: group.rateOtHoliday,
          roundingMinutes: group.roundingMinutes,
          isActive: group.isActive,
          compTimeEnabled: group.compTimeEnabled,
          compRateOtWorkday: group.compRateOtWorkday,
          compRateNormalDayoff: group.compRateNormalDayoff,
          compRateOtDayoff: group.compRateOtDayoff,
          compRateNormalHoliday: group.compRateNormalHoliday,
          compRateOtHoliday: group.compRateOtHoliday,
          compAnnualCapEnabled: group.compAnnualCapEnabled,
          compAnnualCapMinutes: group.compAnnualCapMinutes,
          compRoundingMinutes: group.compRoundingMinutes,
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

  function set<K extends keyof OvertimeGroupInput>(key: K, value: OvertimeGroupInput[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  function toggleCompTimeEnabled(enabled: boolean) {
    setDraft((prev) => ({
      ...prev,
      compTimeEnabled: enabled,
      // Prefill with sane defaults the first time it's switched on so the
      // admin isn't handed five blank required fields; clear everything
      // (including the cap) when switched off so a disabled group never
      // carries stale comp-time config.
      ...(enabled
        ? {
            compRateOtWorkday: prev.compRateOtWorkday ?? defaultCompRates.compRateOtWorkday,
            compRateNormalDayoff: prev.compRateNormalDayoff ?? defaultCompRates.compRateNormalDayoff,
            compRateOtDayoff: prev.compRateOtDayoff ?? defaultCompRates.compRateOtDayoff,
            compRateNormalHoliday: prev.compRateNormalHoliday ?? defaultCompRates.compRateNormalHoliday,
            compRateOtHoliday: prev.compRateOtHoliday ?? defaultCompRates.compRateOtHoliday,
          }
        : {
            compRateOtWorkday: null,
            compRateNormalDayoff: null,
            compRateOtDayoff: null,
            compRateNormalHoliday: null,
            compRateOtHoliday: null,
            compAnnualCapEnabled: false,
            compAnnualCapMinutes: null,
          }),
    }))
  }

  function toggleCompAnnualCapEnabled(enabled: boolean) {
    setDraft((prev) => ({
      ...prev,
      compAnnualCapEnabled: enabled,
      compAnnualCapMinutes: enabled ? (prev.compAnnualCapMinutes ?? 8 * 60) : null,
    }))
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      if (id === null) await createOvertimeGroup(draft)
      else await updateOvertimeGroup(id, draft)
      notify.success(isNew ? 'เพิ่มกลุ่มการทำงานล่วงเวลาสำเร็จ' : 'บันทึกการแก้ไขสำเร็จ')
      void navigate('/master/overtime-groups')
    } catch (err) {
      // Server-side rejections (duplicate code, bad rate) land here — keep
      // the user's input on screen and show why it was refused.
      setError(err instanceof Error ? err.message : 'save failed')
      setSaving(false)
    }
  }

  // A viewer has no business on the "new group" route at all — there is
  // nothing on it they could finish. The edit route still shows them the
  // record, read-only, because reading is exactly what their role is for.
  if (isNew && !canWrite) return <Navigate to="/master/overtime-groups" replace />

  if (loading) return <p className={muted}>กำลังโหลด…</p>

  return (
    <>
      <header className={pageHead}>
        <div>
          <p className={eyebrow}>
            <Link
              className="inline-flex items-center gap-1.5 text-slate-500 no-underline normal-case tracking-normal hover:text-navy"
              to="/master/overtime-groups"
            >
              <ArrowLeft size={13} />
              กลับไปรายการกลุ่มการทำงานล่วงเวลา
            </Link>
          </p>
          <h1>
            {isNew ? 'เพิ่มกลุ่มการทำงานล่วงเวลา' : canWrite ? 'แก้ไขกลุ่มการทำงานล่วงเวลา' : 'ข้อมูลกลุ่มการทำงานล่วงเวลา'}
          </h1>
          <p className={subtitle}>
            {isNew ? 'กรอกข้อมูลให้ครบทุกช่องที่มีเครื่องหมาย *' : draft.groupName}
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
            <div className={fieldStack}>
              <label className={fieldRow}>
                <span className={fieldRowLabel}>
                  Group Code <span className={requiredMark}>*</span> :
                </span>
                <input
                  required
                  className={`${fieldControl} max-w-xs`}
                  value={draft.groupCode}
                  onChange={(e) => set('groupCode', e.target.value)}
                />
              </label>
              <label className={fieldRow}>
                <span className={fieldRowLabel}>
                  ชื่อกลุ่ม <span className={requiredMark}>*</span> :
                </span>
                <input
                  required
                  className={`${fieldControl} max-w-xs`}
                  value={draft.groupName}
                  onChange={(e) => set('groupName', e.target.value)}
                />
              </label>
            </div>
          </section>

          <section className={`${card} mb-4`}>
            <h2 className={sectionTitle}>อัตราค่าล่วงเวลา (Overtime rates)</h2>
            <p className={`${muted} mb-3`}>
              ระบุเป็นตัวคูณของค่าจ้างต่อชั่วโมง เช่น 1.5 หมายถึง 1.5 เท่าของค่าจ้างปกติ
            </p>
            <div className={fieldStack}>
              <label className={fieldRow}>
                <span className={fieldRowLabel}>
                  วันทำงานปกติ (Working Day) — OT นอกเวลา <span className={requiredMark}>*</span> :
                </span>
                <input
                  required
                  type="number"
                  min={0.01}
                  step={0.01}
                  className={`${fieldControl} max-w-32`}
                  value={draft.rateOtWorkday}
                  onChange={(e) => set('rateOtWorkday', Number(e.target.value))}
                />
              </label>
              <label className={fieldRow}>
                <span className={fieldRowLabel}>
                  วันหยุด (Day Off) — OT ในเวลา <span className={requiredMark}>*</span> :
                </span>
                <input
                  required
                  type="number"
                  min={0.01}
                  step={0.01}
                  className={`${fieldControl} max-w-32`}
                  value={draft.rateNormalDayoff}
                  onChange={(e) => set('rateNormalDayoff', Number(e.target.value))}
                />
              </label>
              <label className={fieldRow}>
                <span className={fieldRowLabel}>
                  วันหยุด (Day Off) — OT นอกเวลา <span className={requiredMark}>*</span> :
                </span>
                <input
                  required
                  type="number"
                  min={0.01}
                  step={0.01}
                  className={`${fieldControl} max-w-32`}
                  value={draft.rateOtDayoff}
                  onChange={(e) => set('rateOtDayoff', Number(e.target.value))}
                />
              </label>
              <label className={fieldRow}>
                <span className={fieldRowLabel}>
                  วันหยุดพิเศษ (Holiday) — OT ในเวลา <span className={requiredMark}>*</span> :
                </span>
                <input
                  required
                  type="number"
                  min={0.01}
                  step={0.01}
                  className={`${fieldControl} max-w-32`}
                  value={draft.rateNormalHoliday}
                  onChange={(e) => set('rateNormalHoliday', Number(e.target.value))}
                />
              </label>
              <label className={fieldRow}>
                <span className={fieldRowLabel}>
                  วันหยุดพิเศษ (Holiday) — OT นอกเวลา <span className={requiredMark}>*</span> :
                </span>
                <input
                  required
                  type="number"
                  min={0.01}
                  step={0.01}
                  className={`${fieldControl} max-w-32`}
                  value={draft.rateOtHoliday}
                  onChange={(e) => set('rateOtHoliday', Number(e.target.value))}
                />
              </label>
              <label className={fieldRow}>
                <span className={fieldRowLabel}>
                  การปัดเศษเวลา <span className={requiredMark}>*</span> :
                </span>
                <select
                  className={`${fieldControl} max-w-40`}
                  value={draft.roundingMinutes}
                  onChange={(e) =>
                    set(
                      'roundingMinutes',
                      Number(e.target.value) as OvertimeGroupInput['roundingMinutes']
                    )
                  }
                >
                  {OVERTIME_ROUNDING_MINUTES.map((minutes) => (
                    <option key={minutes} value={minutes}>
                      {ROUNDING_LABELS[minutes]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </section>

          <section className={`${card} mb-4`}>
            <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
              <input
                type="checkbox"
                checked={draft.compTimeEnabled}
                onChange={(e) => toggleCompTimeEnabled(e.target.checked)}
              />
              <span>คิดเป็นวันหยุดสะสมได้</span>
            </label>

            {draft.compTimeEnabled && (
              <div className="mt-4 border-t border-slate-200 pt-4">
                <h2 className={sectionTitle}>อัตราการแปลงเป็นวันหยุดสะสม (Comp-time conversion rates)</h2>
                <p className={`${muted} mb-3`}>
                  ระบุเป็นตัวคูณของชั่วโมงที่ทำ OT เช่น ทำ OT 4 ชั่วโมง อัตรา 1.5 → ได้วันหยุดสะสม 6 ชั่วโมง
                </p>
                <div className={fieldStack}>
                  <label className={fieldRow}>
                    <span className={fieldRowLabel}>
                      วันทำงานปกติ (Working Day) — OT นอกเวลา <span className={requiredMark}>*</span> :
                    </span>
                    <input
                      required
                      type="number"
                      min={0.01}
                      step={0.01}
                      className={`${fieldControl} max-w-32`}
                      value={draft.compRateOtWorkday ?? ''}
                      onChange={(e) => set('compRateOtWorkday', Number(e.target.value))}
                    />
                  </label>
                  <label className={fieldRow}>
                    <span className={fieldRowLabel}>
                      วันหยุด (Day Off) — OT ในเวลา <span className={requiredMark}>*</span> :
                    </span>
                    <input
                      required
                      type="number"
                      min={0.01}
                      step={0.01}
                      className={`${fieldControl} max-w-32`}
                      value={draft.compRateNormalDayoff ?? ''}
                      onChange={(e) => set('compRateNormalDayoff', Number(e.target.value))}
                    />
                  </label>
                  <label className={fieldRow}>
                    <span className={fieldRowLabel}>
                      วันหยุด (Day Off) — OT นอกเวลา <span className={requiredMark}>*</span> :
                    </span>
                    <input
                      required
                      type="number"
                      min={0.01}
                      step={0.01}
                      className={`${fieldControl} max-w-32`}
                      value={draft.compRateOtDayoff ?? ''}
                      onChange={(e) => set('compRateOtDayoff', Number(e.target.value))}
                    />
                  </label>
                  <label className={fieldRow}>
                    <span className={fieldRowLabel}>
                      วันหยุดพิเศษ (Holiday) — OT ในเวลา <span className={requiredMark}>*</span> :
                    </span>
                    <input
                      required
                      type="number"
                      min={0.01}
                      step={0.01}
                      className={`${fieldControl} max-w-32`}
                      value={draft.compRateNormalHoliday ?? ''}
                      onChange={(e) => set('compRateNormalHoliday', Number(e.target.value))}
                    />
                  </label>
                  <label className={fieldRow}>
                    <span className={fieldRowLabel}>
                      วันหยุดพิเศษ (Holiday) — OT นอกเวลา <span className={requiredMark}>*</span> :
                    </span>
                    <input
                      required
                      type="number"
                      min={0.01}
                      step={0.01}
                      className={`${fieldControl} max-w-32`}
                      value={draft.compRateOtHoliday ?? ''}
                      onChange={(e) => set('compRateOtHoliday', Number(e.target.value))}
                    />
                  </label>

                  <label className={fieldRow}>
                    <span className={fieldRowLabel}>การปัดเศษยอดสะสม :</span>
                    <select
                      className={`${fieldControl} max-w-40`}
                      value={draft.compRoundingMinutes}
                      onChange={(e) =>
                        set(
                          'compRoundingMinutes',
                          Number(e.target.value) as OvertimeGroupInput['compRoundingMinutes']
                        )
                      }
                    >
                      {OVERTIME_ROUNDING_MINUTES.map((minutes) => (
                        <option key={minutes} value={minutes}>
                          {COMP_ROUNDING_LABELS[minutes]}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className={fieldRow}>
                    <span className={fieldRowLabel}>
                      <input
                        type="checkbox"
                        className="mr-2 align-middle"
                        checked={draft.compAnnualCapEnabled}
                        onChange={(e) => toggleCompAnnualCapEnabled(e.target.checked)}
                      />
                      จำกัดจำนวนชั่วโมงสูงสุดทั้งปี :
                    </span>
                    {draft.compAnnualCapEnabled && (
                      <span className="flex items-center gap-2">
                        <input
                          required
                          type="number"
                          min={1}
                          step={1}
                          className={`${fieldControl} max-w-32`}
                          value={
                            draft.compAnnualCapMinutes === null
                              ? ''
                              : Math.round(draft.compAnnualCapMinutes / 60)
                          }
                          onChange={(e) => set('compAnnualCapMinutes', Number(e.target.value) * 60)}
                        />
                        <span className={muted}>ชั่วโมง / ปี</span>
                      </span>
                    )}
                  </label>
                  {draft.compAnnualCapEnabled && (
                    <p className={muted}>
                      เมื่อยอดสะสมของพนักงานถึงเพดานนี้แล้ว OT ส่วนที่เกินจะจ่ายเป็นเงินตามอัตรา OT ปกติแทน
                    </p>
                  )}
                </div>
              </div>
            )}
          </section>

          <section className={`${card} mb-4`}>
            <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
              <input
                type="checkbox"
                checked={draft.isActive}
                onChange={(e) => set('isActive', e.target.checked)}
              />
              <span>เปิดใช้งาน</span>
            </label>
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
              onClick={() => void navigate('/master/overtime-groups')}
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
              onClick={() => void navigate('/master/overtime-groups')}
            >
              กลับ
            </button>
          </div>
        )}
      </form>
    </>
  )
}
