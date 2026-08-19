import { useEffect, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { PAY_DAY_RULES, type PayDayRule, type PayrollGroupInput } from '@hrm/shared'
import { createPayrollGroup, getPayrollGroup, updatePayrollGroup } from '../../../api/payrollGroups'
import { useCanWritePayroll } from '../../../auth/meContext'
import { PAY_DAY_RULE_LABELS } from '../../../components/payrollLabels'
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

const emptyDraft: PayrollGroupInput = {
  groupCode: '',
  groupName: '',
  cutoffDay: 25,
  payDayRule: 'last_day_of_month',
  payDayOfMonth: null,
  isActive: true,
}

const sectionTitle =
  'mb-5 border-b border-slate-200 pb-3 text-xs font-bold tracking-wider text-slate-500 uppercase'

// Same one-line "label * : [input]" layout as the other master forms.
const fieldStack = 'flex flex-col gap-3'
const fieldRow = 'flex flex-wrap items-center gap-3'
const fieldRowLabel = 'w-72 flex-none text-xs font-medium text-slate-600 text-right'

export function PayrollGroupFormPage() {
  const params = useParams()
  const navigate = useNavigate()
  const canWrite = useCanWritePayroll()

  // The route is /master/payroll-groups/new or /master/payroll-groups/:id.
  const idParam = params['id']
  const isNew = idParam === undefined
  const id = isNew ? null : Number(idParam)

  const [draft, setDraft] = useState<PayrollGroupInput>(emptyDraft)
  const [loading, setLoading] = useState(!isNew)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (id === null) return
    const controller = new AbortController()

    getPayrollGroup(id, controller.signal)
      .then((group) => {
        setDraft({
          groupCode: group.groupCode,
          groupName: group.groupName,
          cutoffDay: group.cutoffDay,
          payDayRule: group.payDayRule,
          payDayOfMonth: group.payDayOfMonth,
          isActive: group.isActive,
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

  function set<K extends keyof PayrollGroupInput>(key: K, value: PayrollGroupInput[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  /** The two fields the table's CHECK pairs: switching away from fixed_day has
   *  to clear the day, or the save comes back as a constraint violation. */
  function setPayDayRule(rule: PayDayRule) {
    setDraft((prev) => ({
      ...prev,
      payDayRule: rule,
      payDayOfMonth: rule === 'fixed_day' ? (prev.payDayOfMonth ?? 25) : null,
    }))
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      if (id === null) await createPayrollGroup(draft)
      else await updatePayrollGroup(id, draft)
      notify.success(isNew ? 'เพิ่มกลุ่มเงินเดือนสำเร็จ' : 'บันทึกการแก้ไขสำเร็จ')
      void navigate('/master/payroll-groups')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed')
      setSaving(false)
    }
  }

  if (isNew && !canWrite) return <Navigate to="/master/payroll-groups" replace />

  if (loading) return <p className={muted}>กำลังโหลด…</p>

  return (
    <>
      <header className={pageHead}>
        <div>
          <p className={eyebrow}>
            <Link
              className="inline-flex items-center gap-1.5 text-slate-500 no-underline normal-case tracking-normal hover:text-navy"
              to="/master/payroll-groups"
            >
              <ArrowLeft size={13} />
              กลับไปรายการกลุ่มเงินเดือน
            </Link>
          </p>
          <h1>{isNew ? 'เพิ่มกลุ่มเงินเดือน' : canWrite ? 'แก้ไขกลุ่มเงินเดือน' : 'ข้อมูลกลุ่มเงินเดือน'}</h1>
          <p className={subtitle}>
            {isNew ? 'กรอกข้อมูลให้ครบทุกช่องที่มีเครื่องหมาย *' : draft.groupName}
          </p>
        </div>
      </header>

      {!canWrite && (
        <div className={alert('info')}>
          <p className={alertTitle()}>โหมดอ่านอย่างเดียว</p>
          <p className={muted}>การแก้ไขกลุ่มเงินเดือนต้องใช้สิทธิ์ฝ่ายเงินเดือน (HRM.Payroll)</p>
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
            <h2 className={sectionTitle}>รอบการจ่าย (Pay cycle)</h2>
            <p className={`${muted} mb-3`}>
              ตัดรอบวันที่ 25 หมายถึงงวดหนึ่งเริ่มวันที่ 26 ของเดือนก่อนหน้า ถึงวันที่ 25 ของเดือนนั้น
            </p>
            <div className={fieldStack}>
              <label className={fieldRow}>
                <span className={fieldRowLabel}>
                  ตัดรอบทุกวันที่ <span className={requiredMark}>*</span> :
                </span>
                <input
                  required
                  type="number"
                  min={1}
                  max={28}
                  step={1}
                  className={`${fieldControl} max-w-32`}
                  value={draft.cutoffDay}
                  onChange={(e) => set('cutoffDay', Number(e.target.value))}
                />
                {/* 28 is the cap the table enforces: a cut-off on the 30th does
                    not exist in February. */}
                <span className={muted}>ได้ตั้งแต่ 1 ถึง 28</span>
              </label>
              <label className={fieldRow}>
                <span className={fieldRowLabel}>
                  วันจ่ายเงิน <span className={requiredMark}>*</span> :
                </span>
                <select
                  className={`${fieldControl} max-w-52`}
                  value={draft.payDayRule}
                  onChange={(e) => setPayDayRule(e.target.value as PayDayRule)}
                >
                  {PAY_DAY_RULES.map((rule) => (
                    <option key={rule} value={rule}>
                      {PAY_DAY_RULE_LABELS[rule]}
                    </option>
                  ))}
                </select>
              </label>
              {draft.payDayRule === 'fixed_day' && (
                <label className={fieldRow}>
                  <span className={fieldRowLabel}>
                    จ่ายทุกวันที่ <span className={requiredMark}>*</span> :
                  </span>
                  <input
                    required
                    type="number"
                    min={1}
                    max={31}
                    step={1}
                    className={`${fieldControl} max-w-32`}
                    value={draft.payDayOfMonth ?? ''}
                    onChange={(e) =>
                      set('payDayOfMonth', e.target.value === '' ? null : Number(e.target.value))
                    }
                  />
                </label>
              )}
            </div>
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
              onClick={() => void navigate('/master/payroll-groups')}
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
              onClick={() => void navigate('/master/payroll-groups')}
            >
              กลับ
            </button>
          </div>
        )}
      </form>
    </>
  )
}
