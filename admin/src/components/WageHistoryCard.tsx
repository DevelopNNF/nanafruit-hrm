import { useEffect, useState } from 'react'
import { WAGE_TYPES, type WageAssignment, type WageType } from '@hrm/shared'
import { createWageChange, getWageHistory } from '../api/employees'
import { DatePicker } from './DatePicker'
import { WAGE_TYPE_LABELS } from './employeeFinanceLabels'
import { notify } from '../notifications/notify'
import { alert, alertDetail, alertTitle, button, card, fieldControl, muted } from '../styles'

type HistoryState =
  | { phase: 'loading' }
  | { phase: 'ok'; assignments: WageAssignment[] }
  | { phase: 'error'; message: string }

/** Local calendar day as 'YYYY-MM-DD'. Deliberately not toISOString(), which
 *  converts to UTC first and lands on the wrong day for part of every evening
 *  in UTC+7. Same helper as EmployeeFinanceItemsCard's todayISO. */
function todayISO(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/** Thai date, e.g. "1 ม.ค. 2569" — matches DatePicker's own display, so a
 *  saved date and the picker that produced it read the same way. */
function formatThaiDate(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00`).toLocaleDateString('th-TH-u-ca-buddhist', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

function formatAmount(amount: number): string {
  return amount.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const CREATED_BY_LABELS: Record<string, string> = {
  admin: 'ผู้ดูแลระบบ',
  employee: 'พนักงาน',
  system: 'ระบบ (ข้อมูลเริ่มต้น)',
}

type Draft = {
  wageType: WageType | null
  wageAmount: number
  effectiveFrom: string
  note: string | null
}

function emptyDraft(): Draft {
  return { wageType: null, wageAmount: 0, effectiveFrom: todayISO(), note: null }
}

/**
 * An employee's wage history — the only place a wage is set, since
 * 046_create_employee_wage_assignments.sql moved it out of employee_finance.
 * The Finance tab's settings form no longer has a wage field at all, the same
 * way the employment form stopped writing shift_id when ShiftHistoryCard
 * arrived.
 *
 * This card renders *inside* the finance tab's settings <form>, next to
 * EmployeeFinanceItemsCard, so the three rules that card's comment sets out
 * apply here too:
 *
 *   - no <form> of its own (a <form> inside a <form> is invalid),
 *   - every button is type="button", or it would submit the settings form,
 *   - Enter in this card's inputs is caught here, because a text input inside
 *     a form submits it on Enter — which would save the settings form instead
 *     of recording the wage.
 *
 * There is no edit and no delete. A wage that has been superseded is a fact
 * about what someone was paid, and the overtime report has already priced
 * against it; correcting a typo is a new row, which is also what leaves the
 * mistake visible in the history.
 */
export function WageHistoryCard({
  employeeId,
  canWrite,
}: {
  employeeId: number
  canWrite: boolean
}) {
  const [state, setState] = useState<HistoryState>({ phase: 'loading' })
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    getWageHistory(employeeId, controller.signal)
      .then((assignments) => setState({ phase: 'ok', assignments }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'request failed',
        })
      })
    return () => controller.abort()
  }, [employeeId])

  function reload() {
    getWageHistory(employeeId)
      .then((assignments) => setState({ phase: 'ok', assignments }))
      .catch((err: unknown) =>
        setState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'request failed',
        })
      )
  }

  async function save() {
    if (!draft.wageType) {
      notify.error('กรอกข้อมูลไม่ครบ', 'กรุณาเลือกประเภทค่าจ้าง')
      return
    }
    if (draft.wageAmount <= 0) {
      notify.error('กรอกข้อมูลไม่ครบ', 'กรุณากรอกค่าจ้างให้มากกว่า 0')
      return
    }
    setSaving(true)
    try {
      await createWageChange(employeeId, {
        wageType: draft.wageType,
        wageAmount: draft.wageAmount,
        effectiveFrom: draft.effectiveFrom,
        note: draft.note,
      })
      notify.success('บันทึกค่าจ้างสำเร็จ')
      setDraft(emptyDraft())
      reload()
    } catch (err) {
      notify.error('บันทึกค่าจ้างไม่สำเร็จ', err instanceof Error ? err.message : undefined)
    } finally {
      setSaving(false)
    }
  }

  /** Enter saves this card, and never reaches the settings <form> around it.
   *  Bound on the inputs themselves rather than an ancestor, since the date
   *  picker is a composite whose own Enter handling should not be intercepted. */
  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key !== 'Enter') return
    event.preventDefault()
    void save()
  }

  return (
    <section className={`${card} mb-4`}>
      <h2 className="mb-5 border-b border-slate-200 pb-3 text-xs font-bold tracking-wider text-slate-500 uppercase">
        ค่าจ้างและประวัติการปรับค่าจ้าง (Wage History)
      </h2>

      {state.phase === 'loading' && <p className={muted}>กำลังโหลด…</p>}
      {state.phase === 'error' && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>โหลดประวัติค่าจ้างไม่สำเร็จ</p>
          <p className={alertDetail}>{state.message}</p>
        </div>
      )}

      {state.phase === 'ok' &&
        (state.assignments.length === 0 ? (
          <p className={`mb-4 ${muted}`}>ยังไม่เคยกำหนดค่าจ้างให้พนักงานคนนี้</p>
        ) : (
          <div className="mb-4 overflow-x-auto rounded-md border border-slate-200">
            <table className="w-full border-collapse text-[0.775rem] [&_tbody_tr:last-child_td]:border-b-0">
              <thead>
                <tr>
                  {['ช่วงเวลาที่มีผล', 'ประเภท', 'ค่าจ้าง (บาท)', 'หมายเหตุ', 'บันทึกโดย'].map((h) => (
                    <th
                      key={h}
                      className="border-b border-slate-200 bg-slate-50 px-3 py-1.5 text-left text-[0.65rem] font-semibold tracking-wider text-slate-500 uppercase"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {state.assignments.map((a) => (
                  <tr key={a.id}>
                    <td className="border-b border-slate-200 px-3 py-1.5 align-middle whitespace-nowrap text-slate-700">
                      {formatThaiDate(a.effectiveFrom)} –{' '}
                      {a.effectiveTo === null ? 'ปัจจุบัน' : formatThaiDate(a.effectiveTo)}
                    </td>
                    <td className="border-b border-slate-200 px-3 py-1.5 align-middle whitespace-nowrap text-slate-700">
                      {WAGE_TYPE_LABELS[a.wageType]}
                    </td>
                    <td className="border-b border-slate-200 px-3 py-1.5 text-right align-middle whitespace-nowrap tabular-nums text-slate-900">
                      {formatAmount(a.wageAmount)}
                    </td>
                    <td className="border-b border-slate-200 px-3 py-1.5 align-middle text-slate-600">
                      {a.note ?? '—'}
                    </td>
                    <td className="border-b border-slate-200 px-3 py-1.5 align-middle whitespace-nowrap text-slate-500">
                      {CREATED_BY_LABELS[a.createdByKind] ?? a.createdByKind}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

      {canWrite && (
        <div className="flex flex-wrap items-end gap-3 border-t border-slate-200 pt-4">
          <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-slate-600">
            <span>ประเภทค่าจ้าง</span>
            <select
              className={fieldControl}
              value={draft.wageType ?? ''}
              onKeyDown={handleKeyDown}
              onChange={(e) =>
                setDraft((prev) => ({
                  ...prev,
                  wageType: (e.target.value || null) as WageType | null,
                }))
              }
            >
              <option value="" disabled>
                — โปรดระบุ —
              </option>
              {WAGE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {WAGE_TYPE_LABELS[type]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-slate-600">
            <span>ค่าจ้าง (บาท)</span>
            <input
              type="number"
              step="0.01"
              min="0.01"
              inputMode="decimal"
              className={fieldControl}
              value={draft.wageAmount || ''}
              onKeyDown={handleKeyDown}
              onChange={(e) =>
                setDraft((prev) => ({
                  ...prev,
                  wageAmount: e.target.value === '' ? 0 : Number(e.target.value),
                }))
              }
            />
          </label>
          {/* No `min`: backdating is allowed here, unlike a shift change — a
              raise agreed late still has to price the months it covers. The
              server bounds it at the employee's start date. */}
          <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-slate-600">
            <span>มีผลตั้งแต่</span>
            <DatePicker
              required
              value={draft.effectiveFrom}
              onChange={(value) => setDraft((prev) => ({ ...prev, effectiveFrom: value }))}
            />
          </label>
          <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-xs font-medium text-slate-600">
            <span>หมายเหตุ</span>
            <input
              className={fieldControl}
              value={draft.note ?? ''}
              onKeyDown={handleKeyDown}
              onChange={(e) => setDraft((prev) => ({ ...prev, note: e.target.value || null }))}
            />
          </label>
          <button
            type="button"
            className={button('primary')}
            disabled={saving}
            onClick={() => void save()}
          >
            {saving ? 'กำลังบันทึก…' : 'บันทึกค่าจ้าง'}
          </button>
        </div>
      )}
    </section>
  )
}
