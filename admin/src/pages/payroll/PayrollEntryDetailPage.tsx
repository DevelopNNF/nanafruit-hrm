import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, TriangleAlert } from 'lucide-react'
import type { PayrollEntryReviewReason, PayrollEntryWithLines, PayrollPeriod } from '@hrm/shared'
import { getPayrollEntry, reviewPayrollEntry } from '../../api/payrollEntries'
import { getPayrollPeriod } from '../../api/payrollPeriods'
import { useCanWritePayroll } from '../../auth/meContext'
import { PAYROLL_ENTRY_REVIEW_REASON_LABELS, formatThaiDate } from '../../components/payrollLabels'
import { notify } from '../../notifications/notify'
import { alert, alertDetail, alertTitle, badge, card, eyebrow, muted, pageHead, subtitle } from '../../styles'

const sectionTitle =
  'mb-5 border-b border-slate-200 pb-3 text-xs font-bold tracking-wider text-slate-500 uppercase'

/** Same rendering as WageHistoryCard's formatAmount — repeated locally,
 *  matching how this codebase treats small formatting helpers. */
function formatAmount(amount: number): string {
  return amount.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const WAGE_TYPE_LABEL: Record<PayrollEntryWithLines['wageType'], string> = {
  monthly: 'รายเดือน',
  daily: 'รายวัน',
}

type State =
  | { phase: 'loading' }
  | { phase: 'ok'; entry: PayrollEntryWithLines }
  | { phase: 'error'; message: string }

/**
 * The payslip for one employee, one period. Every figure is read-only — a
 * payroll_entries row is written exclusively by POST
 * /payroll-periods/:id/calculate, so correcting one means fixing what it
 * derives from (attendance, a wage assignment, a leave request) and
 * recalculating. reviewedAt is the one exception: a checkbox here, not a
 * derived figure, for HR to confirm they looked at this specific payslip on
 * the way to approving the whole period. Shown only when needsReview is
 * true — an entry nobody flagged has nothing to individually confirm — and
 * only editable while the period is 'review'. The server enforces both
 * rules too, this is just the UI reflecting them.
 *
 * Shows late/early minutes as both the full amount and the amount actually
 * deducted, per the phase plan: "สาย 6 นาที" on the attendance report and
 * "หัก 1 นาที" here are both correct and answer different questions.
 */
export function PayrollEntryDetailPage() {
  const params = useParams()
  const id = Number(params['id'])
  const canWrite = useCanWritePayroll()
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [periodId, setPeriodId] = useState<number | null>(null)
  const [period, setPeriod] = useState<PayrollPeriod | null>(null)
  const [reviewSaving, setReviewSaving] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    getPayrollEntry(id, controller.signal)
      .then((entry) => {
        setState({ phase: 'ok', entry })
        setPeriodId(entry.payrollPeriodId)
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setState({ phase: 'error', message: err instanceof Error ? err.message : 'request failed' })
      })
    return () => controller.abort()
  }, [id])

  useEffect(() => {
    if (periodId === null) return
    const controller = new AbortController()
    getPayrollPeriod(periodId, controller.signal)
      .then((loaded) => setPeriod(loaded))
      .catch(() => {
        // Same reasoning as PayrollPeriodFormPage's secondary loads: the
        // checkbox just stays disabled if this fails, the payslip itself
        // still rendered fine.
      })
    return () => controller.abort()
  }, [periodId])

  async function handleReviewToggle(reviewed: boolean) {
    setReviewSaving(true)
    try {
      const updated = await reviewPayrollEntry(id, reviewed)
      setState({ phase: 'ok', entry: updated })
    } catch (err) {
      notify.error(
        reviewed ? 'ทำเครื่องหมายตรวจสอบไม่สำเร็จ' : 'ยกเลิกเครื่องหมายตรวจสอบไม่สำเร็จ',
        err instanceof Error ? err.message : undefined
      )
    } finally {
      setReviewSaving(false)
    }
  }

  if (state.phase === 'loading') return <p className={muted}>กำลังโหลด…</p>

  if (state.phase === 'error') {
    return (
      <div className={alert('danger')}>
        <p className={alertTitle('danger')}>โหลดข้อมูลไม่สำเร็จ</p>
        <p className={alertDetail}>{state.message}</p>
      </div>
    )
  }

  const entry = state.entry
  const incomeLines = entry.lines.filter((l) => l.itemType === 'income')
  const deductionLines = entry.lines.filter((l) => l.itemType !== 'income')
  const reviewEditable = canWrite && period?.status === 'review'

  return (
    <>
      <header className={pageHead}>
        <div>
          <p className={eyebrow}>
            <Link
              className="inline-flex items-center gap-1.5 text-slate-500 no-underline normal-case tracking-normal hover:text-navy"
              to={`/payroll/periods/${entry.payrollPeriodId}`}
            >
              <ArrowLeft size={13} />
              กลับไปงวดเงินเดือน
            </Link>
          </p>
          <h1>{entry.employeeName}</h1>
          <p className={subtitle}>
            {entry.employeeCode} · {WAGE_TYPE_LABEL[entry.wageType]}
          </p>
        </div>
        {entry.needsReview && <span className={badge('danger')}>ต้องตรวจสอบ</span>}
      </header>

      {/* Only entries the system flagged (needsReview) carry this checkbox —
          one nobody flagged has nothing for HR to individually confirm, so
          there is nothing to check here for it. Server enforces the same
          rule in setEntryReviewed. */}
      {entry.needsReview && (
        <label
          className={`${card} mb-4 flex max-w-3xl items-center gap-2.5 text-sm ${
            reviewEditable ? '' : 'opacity-75'
          }`}
        >
          <input
            type="checkbox"
            checked={entry.reviewedAt !== null}
            disabled={!reviewEditable || reviewSaving}
            onChange={(e) => void handleReviewToggle(e.target.checked)}
          />
          <span className="font-medium text-slate-900">ตรวจสอบแล้ว</span>
          {entry.reviewedAt !== null && (
            <span className={muted}>เมื่อ {new Date(entry.reviewedAt).toLocaleString('th-TH')}</span>
          )}
          {!reviewEditable && entry.reviewedAt === null && period && period.status !== 'review' && (
            <span className={muted}>ทำเครื่องหมายได้เฉพาะตอนงวดอยู่ในขั้นตอนตรวจสอบ</span>
          )}
        </label>
      )}

      {entry.needsReview && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>ต้องตรวจสอบ {entry.reviewReasons.length} เรื่อง</p>
          <ul className="mt-2 flex flex-col gap-2">
            {entry.reviewReasons.map((reason) => (
              <ReviewReasonItem key={reason.code} reason={reason} />
            ))}
          </ul>
        </div>
      )}

      <section className={`${card} mb-4 max-w-3xl`}>
        <h2 className={sectionTitle}>สรุปเวลาทำงาน</h2>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          {entry.wageType === 'daily' ? (
            <>
              <SummaryItem label="วันที่ได้ค่าจ้าง" value={`${entry.workDays ?? 0} วัน`} />
              <SummaryItem label="วันลาแบบมีเงิน" value={`${entry.paidLeaveDays ?? 0} วัน`} />
            </>
          ) : (
            <>
              <SummaryItem label="วันที่มีสภาพพนักงานในงวด" value={`${entry.employedDays ?? 0} วัน`} />
              <SummaryItem label="อยู่ครบทั้งงวด" value={entry.isFullPeriod ? 'ใช่' : 'ไม่ครบ'} />
              <SummaryItem label="วันลาแบบมีเงิน" value={`${entry.paidLeaveDays ?? 0} วัน`} />
            </>
          )}
          <SummaryItem label="วันขาด/ลาไม่มีเงิน" value={`${entry.absentDays} วัน`} />
          <SummaryItem
            label="นาทีสาย (หัก)"
            value={`${entry.lateMinutesTotal} นาที (หัก ${entry.lateMinutesDeducted})`}
          />
          <SummaryItem
            label="นาทีออกก่อน (หัก)"
            value={`${entry.earlyLeaveMinutesTotal} นาที (หัก ${entry.earlyLeaveMinutesDeducted})`}
          />
        </dl>
      </section>

      <section className={`${card} mb-4 max-w-3xl`}>
        <h2 className={sectionTitle}>สลิปเงินเดือน</h2>
        <LineTable title="รายรับ" lines={incomeLines} />
        <LineTable title="รายการหัก" lines={deductionLines} />

        <div className="mt-4 flex flex-col gap-1 border-t border-slate-200 pt-4 text-sm">
          <div className="flex justify-between text-slate-600">
            <span>รวมรับ</span>
            <span className="tabular-nums">{formatAmount(entry.grossEarnings)}</span>
          </div>
          <div className="flex justify-between text-slate-600">
            <span>รวมหัก</span>
            <span className="tabular-nums">{formatAmount(entry.totalDeductions)}</span>
          </div>
          <div className="flex justify-between text-base font-semibold text-slate-900">
            <span>สุทธิ</span>
            <span className="tabular-nums">{formatAmount(entry.netPay)}</span>
          </div>
        </div>
      </section>

      <p className={muted}>คำนวณเมื่อ {new Date(entry.calculatedAt).toLocaleString('th-TH')}</p>
    </>
  )
}

/** One triggered reason, with the dates it applies to spelled out — a
 *  period-level reason like mixed_wage_type has no dates, since it isn't
 *  about any one day. */
function ReviewReasonItem({ reason }: { reason: PayrollEntryReviewReason }) {
  return (
    <li className="flex items-start gap-2 text-sm text-slate-700">
      <TriangleAlert size={15} className="mt-0.5 flex-none text-amber-600" />
      <span>
        {PAYROLL_ENTRY_REVIEW_REASON_LABELS[reason.code]}
        {reason.workDates.length > 0 && (
          <span className={`${muted} block`}>
            วันที่ {reason.workDates.map((d) => formatThaiDate(d)).join(', ')}
          </span>
        )}
      </span>
    </li>
  )
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="tabular-nums text-slate-900">{value}</dd>
    </div>
  )
}

function LineTable({ title, lines }: { title: string; lines: PayrollEntryWithLines['lines'] }) {
  if (lines.length === 0) return null
  return (
    <div className="mb-3">
      <p className="mb-1.5 text-xs font-semibold tracking-wide text-slate-500 uppercase">{title}</p>
      <table className="w-full border-collapse text-[0.825rem]">
        <tbody>
          {lines.map((l) => (
            <tr key={l.id}>
              <td className="border-b border-slate-100 py-1.5 text-slate-700">{l.itemName}</td>
              <td className="border-b border-slate-100 py-1.5 text-right text-slate-500 tabular-nums">
                {l.quantity !== null ? l.quantity : ''}
              </td>
              <td className="border-b border-slate-100 py-1.5 text-right text-slate-900 tabular-nums">
                {formatAmount(l.amount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
