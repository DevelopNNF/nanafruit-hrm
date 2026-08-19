import { useEffect, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import type { PayrollGroup, PayrollPeriod } from '@hrm/shared'
import { listPayrollGroups } from '../../api/payrollGroups'
import {
  createPayrollPeriod,
  getPayrollPeriod,
  previewPayrollPeriod,
  updatePayrollPeriod,
  voidPayrollPeriod,
} from '../../api/payrollPeriods'
import { useCanWritePayroll } from '../../auth/meContext'
import { DatePicker } from '../../components/DatePicker'
import {
  PAYROLL_PERIOD_STATUS_LABELS,
  formatThaiDate,
  windowDayCount,
} from '../../components/payrollLabels'
import { notify } from '../../notifications/notify'
import {
  alert,
  alertDetail,
  alertTitle,
  badge,
  button,
  card,
  eyebrow,
  fieldControl,
  muted,
  pageHead,
  requiredMark,
  subtitle,
} from '../../styles'

const sectionTitle =
  'mb-5 border-b border-slate-200 pb-3 text-xs font-bold tracking-wider text-slate-500 uppercase'

const fieldStack = 'flex flex-col gap-3'
const fieldRow = 'flex flex-wrap items-center gap-3'
const fieldRowLabel = 'w-56 flex-none text-xs font-medium text-slate-600 text-right'

type Draft = {
  payrollGroupId: number | null
  periodCode: string
  periodStart: string
  periodEnd: string
  payDate: string
  note: string | null
}

const emptyDraft: Draft = {
  payrollGroupId: null,
  periodCode: '',
  periodStart: '',
  periodEnd: '',
  payDate: '',
  note: null,
}

/**
 * Create or edit one payroll period.
 *
 * The window is derived by the server from the group's cut-off day the moment
 * both the group and the period code are known, and then left editable: HR can
 * still correct it while the period is a draft, and the server takes whatever
 * comes back. Deriving it here instead would put the cut-off rule in two
 * places, which is how two places end up disagreeing about when August
 * started.
 */
export function PayrollPeriodFormPage() {
  const params = useParams()
  const navigate = useNavigate()
  const canWrite = useCanWritePayroll()

  const idParam = params['id']
  const isNew = idParam === undefined
  const id = isNew ? null : Number(idParam)

  const [groups, setGroups] = useState<PayrollGroup[]>([])
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [period, setPeriod] = useState<PayrollPeriod | null>(null)
  const [loading, setLoading] = useState(!isNew)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [voidReason, setVoidReason] = useState('')
  const [voidOpen, setVoidOpen] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    listPayrollGroups(controller.signal)
      // Only active groups can take a new period; an existing period keeps
      // naming its own group from the row itself.
      .then((all) => setGroups(all.filter((group) => group.isActive)))
      .catch(() => setGroups([]))
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (id === null) return
    const controller = new AbortController()

    getPayrollPeriod(id, controller.signal)
      .then((loaded) => {
        setPeriod(loaded)
        setDraft({
          payrollGroupId: loaded.payrollGroupId,
          periodCode: loaded.periodCode,
          periodStart: loaded.periodStart,
          periodEnd: loaded.periodEnd,
          payDate: loaded.payDate,
          note: loaded.note,
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

  /** Fills the window from the server's derivation. Only ever called on the
   *  create form — an existing period's dates are what they are. */
  async function fillWindow(payrollGroupId: number | null, periodCode: string) {
    if (payrollGroupId === null || !/^\d{4}-\d{2}$/.test(periodCode)) return
    try {
      const preview = await previewPayrollPeriod(payrollGroupId, periodCode)
      setDraft((prev) => ({
        ...prev,
        periodStart: preview.periodStart,
        periodEnd: preview.periodEnd,
        payDate: preview.payDate,
      }))
    } catch (err) {
      notify.error('คำนวณช่วงวันที่ไม่สำเร็จ', err instanceof Error ? err.message : undefined)
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (draft.payrollGroupId === null) {
      notify.error('กรอกข้อมูลไม่ครบ', 'กรุณาเลือกกลุ่มเงินเดือน')
      return
    }
    setSaving(true)
    setError(null)
    try {
      if (id === null) {
        await createPayrollPeriod({
          payrollGroupId: draft.payrollGroupId,
          periodCode: draft.periodCode,
          periodStart: draft.periodStart,
          periodEnd: draft.periodEnd,
          payDate: draft.payDate,
          note: draft.note,
        })
      } else {
        await updatePayrollPeriod(id, {
          periodStart: draft.periodStart,
          periodEnd: draft.periodEnd,
          payDate: draft.payDate,
          note: draft.note,
        })
      }
      notify.success(isNew ? 'สร้างงวดเงินเดือนสำเร็จ' : 'บันทึกการแก้ไขสำเร็จ')
      void navigate('/payroll/periods')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed')
      setSaving(false)
    }
  }

  async function handleVoid() {
    if (id === null) return
    if (voidReason.trim() === '') {
      notify.error('กรอกข้อมูลไม่ครบ', 'กรุณาระบุเหตุผลในการยกเลิกงวด')
      return
    }
    setSaving(true)
    try {
      const updated = await voidPayrollPeriod(id, voidReason.trim())
      setPeriod(updated)
      setVoidOpen(false)
      notify.success('ยกเลิกงวดแล้ว')
    } catch (err) {
      notify.error('ยกเลิกงวดไม่สำเร็จ', err instanceof Error ? err.message : undefined)
    } finally {
      setSaving(false)
    }
  }

  if (isNew && !canWrite) return <Navigate to="/payroll/periods" replace />
  if (loading) return <p className={muted}>กำลังโหลด…</p>

  const status = period?.status ?? 'draft'
  const editable = canWrite && status === 'draft'
  const dayCount =
    draft.periodStart && draft.periodEnd ? windowDayCount(draft.periodStart, draft.periodEnd) : null

  return (
    <>
      <header className={pageHead}>
        <div>
          <p className={eyebrow}>
            <Link
              className="inline-flex items-center gap-1.5 text-slate-500 no-underline normal-case tracking-normal hover:text-navy"
              to="/payroll/periods"
            >
              <ArrowLeft size={13} />
              กลับไปรายการงวดเงินเดือน
            </Link>
          </p>
          <h1>{isNew ? 'สร้างงวดเงินเดือน' : `งวด ${draft.periodCode}`}</h1>
          <p className={subtitle}>
            {isNew ? 'เลือกกลุ่มและงวด แล้วระบบจะคำนวณช่วงวันที่ให้' : period?.payrollGroupName}
          </p>
        </div>
        {!isNew && (
          <span className={badge(status === 'voided' ? 'danger' : status === 'draft' ? 'inactive' : 'pending')}>
            {PAYROLL_PERIOD_STATUS_LABELS[status]}
          </span>
        )}
      </header>

      {!canWrite && (
        <div className={alert('info')}>
          <p className={alertTitle()}>โหมดอ่านอย่างเดียว</p>
          <p className={muted}>การจัดการงวดเงินเดือนต้องใช้สิทธิ์ฝ่ายเงินเดือน (HRM.Payroll)</p>
        </div>
      )}

      {canWrite && !isNew && status !== 'draft' && (
        <div className={alert('info')}>
          <p className={alertTitle()}>งวดนี้พ้นสถานะร่างแล้ว</p>
          <p className={muted}>
            แก้ช่วงวันที่ไม่ได้ เพราะตัวเลขที่คำนวณไว้อ้างอิงกับช่วงเดิม
            {period?.voidReason ? ` — เหตุผลที่ยกเลิก: ${period.voidReason}` : ''}
          </p>
        </div>
      )}

      {error && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>บันทึกไม่สำเร็จ</p>
          <p className={alertDetail}>{error}</p>
        </div>
      )}

      <form className="max-w-3xl" onSubmit={(e) => void handleSubmit(e)}>
        <fieldset disabled={!editable} className="min-w-0 border-0 p-0">
          <section className={`${card} mb-4`}>
            <h2 className={sectionTitle}>งวด (Period)</h2>
            <div className={fieldStack}>
              <label className={fieldRow}>
                <span className={fieldRowLabel}>
                  กลุ่มเงินเดือน <span className={requiredMark}>*</span> :
                </span>
                {/* The group is fixed once the period exists: moving a period to
                    another group is creating a different period. */}
                <select
                  required
                  disabled={!isNew || !editable}
                  className={`${fieldControl} max-w-xs`}
                  value={draft.payrollGroupId ?? ''}
                  onChange={(e) => {
                    const value = e.target.value ? Number(e.target.value) : null
                    setDraft((prev) => ({ ...prev, payrollGroupId: value }))
                    void fillWindow(value, draft.periodCode)
                  }}
                >
                  <option value="" disabled>
                    — โปรดระบุ —
                  </option>
                  {groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.groupName}
                    </option>
                  ))}
                  {/* A period whose group has since been deactivated still has
                      to name it, the same way the employment tab does. */}
                  {period && !groups.some((group) => group.id === period.payrollGroupId) && (
                    <option value={period.payrollGroupId}>
                      {period.payrollGroupName} (ไม่พร้อมใช้งาน)
                    </option>
                  )}
                </select>
              </label>
              <label className={fieldRow}>
                <span className={fieldRowLabel}>
                  งวดเดือน <span className={requiredMark}>*</span> :
                </span>
                <input
                  required
                  type="month"
                  disabled={!isNew || !editable}
                  className={`${fieldControl} max-w-44`}
                  value={draft.periodCode}
                  onChange={(e) => {
                    const value = e.target.value
                    setDraft((prev) => ({ ...prev, periodCode: value }))
                    void fillWindow(draft.payrollGroupId, value)
                  }}
                />
                <span className={muted}>เดือนที่จ่ายเงิน เช่น 2026-08</span>
              </label>
            </div>
          </section>

          <section className={`${card} mb-4`}>
            <h2 className={sectionTitle}>ช่วงเวลา (Window)</h2>
            <p className={`${muted} mb-3`}>
              คำนวณให้อัตโนมัติจากวันตัดรอบของกลุ่ม แก้ได้ตอนที่งวดยังเป็นร่างเท่านั้น
            </p>
            <div className={fieldStack}>
              <label className={fieldRow}>
                <span className={fieldRowLabel}>
                  เริ่มงวด <span className={requiredMark}>*</span> :
                </span>
                <DatePicker
                  required
                  disabled={!editable}
                  value={draft.periodStart}
                  onChange={(value) => setDraft((prev) => ({ ...prev, periodStart: value }))}
                />
              </label>
              <label className={fieldRow}>
                <span className={fieldRowLabel}>
                  สิ้นสุดงวด <span className={requiredMark}>*</span> :
                </span>
                <DatePicker
                  required
                  disabled={!editable}
                  min={draft.periodStart}
                  value={draft.periodEnd}
                  onChange={(value) => setDraft((prev) => ({ ...prev, periodEnd: value }))}
                />
                {dayCount !== null && (
                  <span className={muted}>รวม {dayCount} วัน</span>
                )}
              </label>
              <label className={fieldRow}>
                <span className={fieldRowLabel}>
                  วันจ่ายเงิน <span className={requiredMark}>*</span> :
                </span>
                <DatePicker
                  required
                  disabled={!editable}
                  min={draft.periodEnd}
                  value={draft.payDate}
                  onChange={(value) => setDraft((prev) => ({ ...prev, payDate: value }))}
                />
              </label>
              <label className={fieldRow}>
                <span className={fieldRowLabel}>หมายเหตุ :</span>
                <input
                  className={`${fieldControl} max-w-md`}
                  value={draft.note ?? ''}
                  onChange={(e) =>
                    setDraft((prev) => ({ ...prev, note: e.target.value || null }))
                  }
                />
              </label>
            </div>
          </section>
        </fieldset>

        <div className="flex flex-wrap items-center gap-2.5 pt-1">
          {editable && (
            <button className={button('primary')} type="submit" disabled={saving}>
              {saving ? 'กำลังบันทึก…' : 'บันทึก'}
            </button>
          )}
          <button
            className={button()}
            type="button"
            onClick={() => void navigate('/payroll/periods')}
            disabled={saving}
          >
            {editable ? 'ยกเลิก' : 'กลับ'}
          </button>
          {/* Void, not delete: the row stays and stops blocking its month. */}
          {canWrite && !isNew && (status === 'draft' || status === 'review' || status === 'approved') && (
            <button
              className={button('danger')}
              type="button"
              onClick={() => setVoidOpen((open) => !open)}
              disabled={saving}
            >
              ยกเลิกงวดนี้
            </button>
          )}
        </div>
      </form>

      {voidOpen && (
        <section className={`${card} mt-4 max-w-3xl`}>
          <h2 className={sectionTitle}>ยกเลิกงวด</h2>
          <p className={`${muted} mb-3`}>
            งวดที่ยกเลิกจะไม่ถูกลบ แต่จะไม่กันช่วงวันที่ไว้อีกต่อไป — สร้างงวดเดือนเดิมใหม่ได้
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-xs font-medium text-slate-600">
              <span>
                เหตุผล <span className={requiredMark}>*</span>
              </span>
              <input
                className={fieldControl}
                value={voidReason}
                onChange={(e) => setVoidReason(e.target.value)}
              />
            </label>
            <button
              className={button('danger')}
              type="button"
              disabled={saving}
              onClick={() => void handleVoid()}
            >
              ยืนยันยกเลิกงวด
            </button>
          </div>
        </section>
      )}

      {period && (
        <p className={`${muted} mt-4`}>
          สร้างเมื่อ {formatThaiDate(period.createdAt.slice(0, 10))}
          {period.voidedAt ? ` · ยกเลิกเมื่อ ${formatThaiDate(period.voidedAt.slice(0, 10))}` : ''}
        </p>
      )}
    </>
  )
}
