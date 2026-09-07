import { useEffect, useState } from 'react'
import type { DashboardOnLeaveTodayItem } from '@hrm/shared'
import { listEmployeesOnLeaveToday } from '../api/dashboard'
import { alert, alertDetail, alertTitle, card, cardHead, muted } from '../styles'

type State =
  | { phase: 'loading' }
  | { phase: 'ok'; employees: DashboardOnLeaveTodayItem[] }
  | { phase: 'error'; message: string }

/** Company-wide "who's on leave today" — not filtered by supervisor scope,
 *  and deliberately shows only names, not leave type or reason (see
 *  DashboardOnLeaveTodayResponse's comment). */
export function OnLeaveTodayCard() {
  const [state, setState] = useState<State>({ phase: 'loading' })

  useEffect(() => {
    const controller = new AbortController()

    listEmployeesOnLeaveToday(controller.signal)
      .then((employees) => setState({ phase: 'ok', employees }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'request failed',
        })
      })

    return () => controller.abort()
  }, [])

  return (
    <section className={card}>
      <header className={cardHead}>
        <h2>ลาวันนี้</h2>
      </header>

      {state.phase === 'loading' && <p className={muted}>กำลังโหลด…</p>}

      {state.phase === 'error' && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>โหลดข้อมูลไม่สำเร็จ</p>
          <p className={alertDetail}>{state.message}</p>
        </div>
      )}

      {state.phase === 'ok' &&
        (state.employees.length === 0 ? (
          <p className={muted}>วันนี้ไม่มีใครลา</p>
        ) : (
          <ul className="divide-y divide-slate-200">
            {state.employees.map((employee) => (
              <li key={employee.employeeId} className='-mx-2 flex items-center gap-2.5 rounded-md px-2 py-2.5 hover:bg-slate-50'>
                  <span
                    className="grid size-7 flex-none place-items-center rounded-full bg-amber-100 text-[0.7rem] font-semibold text-amber-700"
                    aria-hidden="true"
                  >
                    {employee.employeeName[0] ?? '?'}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col leading-tight">
                    <span className="text-[0.825rem] font-medium text-slate-900">
                      {employee.employeeName}
                    </span>
                    <span className="text-xs text-slate-500">{employee.employeeCode}</span>
                  </span>
              </li>
            ))}
          </ul>
        ))}
    </section>
  )
}
