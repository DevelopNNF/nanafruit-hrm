import { useEffect, useState } from 'react'
import type { Employee, LeaveBalanceSummary, LeaveType } from '@hrm/shared'
import { fetchActiveLeaveTypes } from '../api/leaveTypes'
import { fetchMyLeaveBalances } from '../api/leaveBalances'
import { LeaveBalanceGauge } from './LeaveBalanceGauge'

type Props = {
  employee: Employee
  onViewAll: () => void
}

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; leaveTypes: LeaveType[]; balances: LeaveBalanceSummary[] }
  | { phase: 'error' }

/** Read-only preview of this year's leave balances, shown on the home
 *  screen — the full editable request flow lives in LeaveScreen. Renders
 *  nothing on loading/error/no-eligible-types: this is a convenience
 *  summary, not something worth a skeleton or an error banner fighting for
 *  attention with the clock-in card above it. */
export function HomeLeaveBalances({ employee, onViewAll }: Props) {
  const [state, setState] = useState<State>({ phase: 'loading' })

  useEffect(() => {
    const controller = new AbortController()
    const year = new Date().getFullYear()
    Promise.all([
      fetchActiveLeaveTypes(controller.signal),
      fetchMyLeaveBalances(year, controller.signal),
    ])
      .then(([leaveTypes, balances]) => setState({ phase: 'ready', leaveTypes, balances }))
      .catch(() => {
        if (controller.signal.aborted) return
        setState({ phase: 'error' })
      })
    return () => controller.abort()
  }, [])

  if (state.phase !== 'ready') return null

  const eligible = state.leaveTypes.filter(
    (lt) => lt.gender === 'all' || lt.gender === employee.gender
  )
  if (eligible.length === 0) return null

  return (
    <div className="surface-card home-balances">
      <div className="home-balances-head">
        <p className="headline">วันลาคงเหลือ ปี {new Date().getFullYear() + 543}</p>
        <button type="button" className="text-link-button" onClick={onViewAll}>
          ดูทั้งหมด →
        </button>
      </div>
      {eligible.map((lt) => {
        const summary = state.balances.find((b) => b.leaveTypeId === lt.id)
        return (
          <div key={lt.id} className="home-balance-row">
            <p className="leave-gauge-row-label">{lt.leaveName}</p>
            <LeaveBalanceGauge
              usedDays={summary?.usedDays ?? 0}
              pendingDays={summary?.pendingDays ?? 0}
              remainingDays={summary?.remainingDays ?? 0}
            />
          </div>
        )
      })}
    </div>
  )
}
