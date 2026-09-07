import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowLeftRight,
  CalendarDays,
  Clock3,
  MapPin,
  PencilLine,
  Repeat,
  type LucideIcon,
} from 'lucide-react'
import type { DashboardPendingApprovalsSummaryResponse } from '@hrm/shared'
import { getPendingApprovalsSummary } from '../api/dashboard'
import { alert, alertDetail, alertTitle, card, muted } from '../styles'

// A static class, not fluidGrid(): fluidGrid builds its grid-cols-[...]
// utility from an interpolated string, which Tailwind can only generate CSS
// for when that exact class name already appears literally elsewhere in the
// scanned source (see styles.ts's fluidGrid — '13rem'/'20rem' happen to,
// '11rem' didn't, so this row silently rendered as ungridded stacked blocks).
// Six fixed cards read better as an explicit column count anyway.
const SUMMARY_GRID = 'grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6'

type State =
  | { phase: 'loading' }
  | { phase: 'ok'; summary: DashboardPendingApprovalsSummaryResponse }
  | { phase: 'error'; message: string }

const CARDS: {
  key: keyof Omit<DashboardPendingApprovalsSummaryResponse, 'scope'>
  label: string
  icon: LucideIcon
  to: string
}[] = [
  { key: 'leave', label: 'คำขอลา', icon: CalendarDays, to: '/leave-requests' },
  { key: 'offSite', label: 'ทำงานนอกสถานที่', icon: MapPin, to: '/off-site-work-requests' },
  { key: 'overtime', label: 'ทำงานล่วงเวลา (OT)', icon: Clock3, to: '/overtime-requests' },
  { key: 'shiftChange', label: 'เปลี่ยนกะ', icon: Repeat, to: '/shift-change-requests' },
  { key: 'dayOffSwap', label: 'สลับวันหยุด', icon: ArrowLeftRight, to: '/day-off-swap-requests' },
  { key: 'timeCorrection', label: 'แก้ไขเวลา', icon: PencilLine, to: '/time-corrections' },
]

/** Per-type pending-approval counts, scoped by resolveSupervisorScope on the
 *  server: a supervisor sees only what's waiting on them, HR/Admin sees
 *  every pending request company-wide (see the endpoint's own comment for
 *  why HR/Admin's count ignores stage). */
export function PendingApprovalsSummary() {
  const [state, setState] = useState<State>({ phase: 'loading' })

  useEffect(() => {
    const controller = new AbortController()

    getPendingApprovalsSummary(controller.signal)
      .then((summary) => setState({ phase: 'ok', summary }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'request failed',
        })
      })

    return () => controller.abort()
  }, [])

  if (state.phase === 'loading') {
    return (
      <div className={`${SUMMARY_GRID} mb-5`}>
        {CARDS.map((c) => (
          <div key={c.key} className="h-[8.5rem] rounded-lg border border-dashed border-slate-200 bg-slate-50" />
        ))}
      </div>
    )
  }

  if (state.phase === 'error') {
    return (
      <div className={alert('danger')}>
        <p className={alertTitle('danger')}>โหลดข้อมูลไม่สำเร็จ</p>
        <p className={alertDetail}>{state.message}</p>
      </div>
    )
  }

  if (state.summary.scope === 'none') {
    return (
      <div className={`${card} mb-5`}>
        <p className={muted}>คุณไม่มีคำขอที่ต้องอนุมัติ</p>
      </div>
    )
  }

  return (
    <div className={`${SUMMARY_GRID} mb-5`}>
      {CARDS.map(({ key, label, icon: IconComponent, to }) => (
        <Link key={key} to={to} className="block no-underline">
          <article className={`${card} flex flex-col gap-1 transition-colors hover:border-slate-300`}>
            <div className="mb-1 grid size-9 place-items-center rounded-md bg-amber-100 text-amber-700">
              <IconComponent size={18} />
            </div>
            <p className="text-sm text-slate-500">{label}</p>
            <p className="text-[1.875rem] leading-tight font-semibold tracking-tight text-slate-900 tabular-nums">
              {state.summary[key].toLocaleString('th-TH')}
            </p>
          </article>
        </Link>
      ))}
    </div>
  )
}
