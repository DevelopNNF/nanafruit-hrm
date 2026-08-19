import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Plus } from 'lucide-react'
import {
  PAYROLL_PERIOD_STATUSES,
  type PayrollGroup,
  type PayrollPeriod,
  type PayrollPeriodStatus,
} from '@hrm/shared'
import { listPayrollGroups } from '../../api/payrollGroups'
import { listPayrollPeriods } from '../../api/payrollPeriods'
import { useCanWritePayroll } from '../../auth/meContext'
import {
  PAYROLL_PERIOD_STATUS_LABELS,
  formatThaiDate,
  windowDayCount,
} from '../../components/payrollLabels'
import {
  alert,
  alertDetail,
  alertTitle,
  badge,
  button,
  cardEmpty,
  eyebrow,
  fieldControl,
  muted,
  pageHead,
  subtitle,
} from '../../styles'

type State =
  | { phase: 'loading' }
  | { phase: 'ok'; payrollPeriods: PayrollPeriod[] }
  | { phase: 'error'; message: string }

/** Draft is the only status that means "nothing has happened yet"; voided is
 *  the only one that means "ignore this row". Everything between is in flight. */
function statusTone(status: PayrollPeriodStatus): 'active' | 'pending' | 'danger' | 'inactive' {
  if (status === 'closed' || status === 'paid') return 'active'
  if (status === 'voided') return 'danger'
  if (status === 'draft') return 'inactive'
  return 'pending'
}

export function PayrollPeriodListPage() {
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [groups, setGroups] = useState<PayrollGroup[]>([])
  const [groupId, setGroupId] = useState<number | null>(null)
  const [status, setStatus] = useState<PayrollPeriodStatus | null>(null)
  const navigate = useNavigate()
  const canWrite = useCanWritePayroll()

  useEffect(() => {
    const controller = new AbortController()
    listPayrollGroups(controller.signal)
      .then(setGroups)
      .catch(() => {
        // The group list is only used to label the filter; a failure here is
        // not worth replacing the page with an error.
      })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const controller = new AbortController()

    // Deliberately not flipping back to 'loading' here: changing a filter
    // re-runs this effect, and setState in an effect body is both a cascading
    // render and the thing react-hooks/set-state-in-effect exists to catch.
    // The previous rows stay on screen for the moment the next fetch takes.
    const filter: { groupId?: number; status?: PayrollPeriodStatus } = {}
    if (groupId !== null) filter.groupId = groupId
    if (status !== null) filter.status = status

    listPayrollPeriods(filter, controller.signal)
      .then((payrollPeriods) => setState({ phase: 'ok', payrollPeriods }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'request failed',
        })
      })

    return () => controller.abort()
  }, [groupId, status])

  const periods = useMemo(() => (state.phase === 'ok' ? state.payrollPeriods : []), [state])

  return (
    <>
      <header className={pageHead}>
        <div>
          <p className={eyebrow}>เงินเดือน</p>
          <h1>งวดเงินเดือน (Payroll Period)</h1>
          <p className={subtitle}>รอบการจ่ายเงินเดือนของแต่ละกลุ่ม และสถานะของแต่ละงวด</p>
        </div>
        {canWrite && (
          <Link className={button('primary')} to="/payroll/periods/new">
            <Plus size={16} />
            สร้างงวดเงินเดือน
          </Link>
        )}
      </header>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1.5 text-xs font-medium text-slate-600">
          <span>กลุ่มเงินเดือน</span>
          <select
            className={`${fieldControl} max-w-56`}
            value={groupId ?? ''}
            onChange={(e) => setGroupId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">— ทุกกลุ่ม —</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.groupName}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-xs font-medium text-slate-600">
          <span>สถานะ</span>
          <select
            className={`${fieldControl} max-w-44`}
            value={status ?? ''}
            onChange={(e) => setStatus(e.target.value ? (e.target.value as PayrollPeriodStatus) : null)}
          >
            <option value="">— ทุกสถานะ —</option>
            {PAYROLL_PERIOD_STATUSES.map((value) => (
              <option key={value} value={value}>
                {PAYROLL_PERIOD_STATUS_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {state.phase === 'loading' && <p className={muted}>กำลังโหลด…</p>}

      {state.phase === 'error' && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>โหลดข้อมูลไม่สำเร็จ</p>
          <p className={alertDetail}>{state.message}</p>
        </div>
      )}

      {state.phase === 'ok' && periods.length === 0 && (
        <div className={`rounded-lg border border-slate-200 bg-white shadow-sm ${cardEmpty}`}>
          <p className="mb-1.5 font-semibold text-slate-900">ยังไม่มีงวดเงินเดือน</p>
          <p className={muted}>
            {canWrite ? 'กด “สร้างงวดเงินเดือน” เพื่อเริ่มต้น' : 'สิทธิ์ของคุณดูข้อมูลได้อย่างเดียว'}
          </p>
        </div>
      )}

      {state.phase === 'ok' && periods.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[0.825rem] [&_tbody_tr:last-child_td]:border-b-0">
              <thead>
                <tr>
                  {['งวด', 'กลุ่ม', 'ช่วงเวลา', 'จำนวนวัน', 'วันจ่าย', 'สถานะ'].map((h) => (
                    <th
                      key={h}
                      className="border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-left text-[0.675rem] font-semibold tracking-wider text-slate-500 uppercase whitespace-nowrap"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {periods.map((period) => (
                  <tr
                    key={period.id}
                    className="cursor-pointer hover:bg-slate-50"
                    onClick={() => void navigate(`/payroll/periods/${period.id}`)}
                  >
                    <td className="border-b border-slate-200 px-4 py-2.5 align-middle font-mono text-[0.775rem] font-medium text-slate-900">
                      {period.periodCode}
                    </td>
                    <td className="border-b border-slate-200 px-4 py-2.5 align-middle text-slate-700">
                      {period.payrollGroupName}
                    </td>
                    <td className="border-b border-slate-200 px-4 py-2.5 align-middle whitespace-nowrap text-slate-600">
                      {formatThaiDate(period.periodStart)} – {formatThaiDate(period.periodEnd)}
                    </td>
                    {/* Spelled out because a 26th-to-25th cycle is 28, 30 or 31
                        days and nobody expects the March one. */}
                    <td className="border-b border-slate-200 px-4 py-2.5 align-middle text-slate-600 tabular-nums">
                      {windowDayCount(period.periodStart, period.periodEnd)} วัน
                    </td>
                    <td className="border-b border-slate-200 px-4 py-2.5 align-middle whitespace-nowrap text-slate-600">
                      {formatThaiDate(period.payDate)}
                    </td>
                    <td className="border-b border-slate-200 px-4 py-2.5 align-middle">
                      <span className={badge(statusTone(period.status))}>
                        {PAYROLL_PERIOD_STATUS_LABELS[period.status]}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  )
}
