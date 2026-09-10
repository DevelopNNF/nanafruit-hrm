import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { DashboardAttendanceIssueItem, DashboardAttendanceIssuesResponse } from '@hrm/shared'
import { getAttendanceIssues } from '../api/dashboard'
import { alert, alertDetail, alertTitle, card, cardHead, fluidGrid, link, muted } from '../styles'

type State =
  | { phase: 'loading' }
  | { phase: 'ok'; summary: DashboardAttendanceIssuesResponse }
  | { phase: 'error'; message: string }

/** Rows beyond this many are still counted, just not listed — "ดูทั้งหมด"
 *  points at the full report instead of growing the card indefinitely. */
const MAX_ROWS = 8

function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' })
}

function IssueList({
  items,
  avatarTone,
  emptyText,
}: {
  items: DashboardAttendanceIssueItem[]
  avatarTone: string
  emptyText: string
}) {
  if (items.length === 0) return <p className={muted}>{emptyText}</p>

  return (
    <ul className="divide-y divide-slate-200">
      {items.slice(0, MAX_ROWS).map((item) => (
        <li key={item.employeeId}>
          <Link
            to={`/employees/${item.employeeId}`}
            className="-mx-2 flex items-center gap-2.5 rounded-md px-2 py-2.5 no-underline hover:bg-slate-50"
          >
            <span
              className={`grid size-7 flex-none place-items-center rounded-full text-[0.7rem] font-semibold ${avatarTone}`}
              aria-hidden="true"
            >
              {item.employeeName[0] ?? '?'}
            </span>
            <span className="flex min-w-0 flex-1 flex-col leading-tight">
              <span className="text-[0.825rem] font-medium text-slate-900">{item.employeeName}</span>
              <span className="text-xs text-slate-500">{item.employeeCode}</span>
            </span>
            <span className="flex-none text-xs whitespace-nowrap text-slate-500">
              {item.count} วัน ({item.dates.map(formatDate).join(', ')})
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

/** Two dashboard cards — who was absent, and who had an incomplete check-in/
 *  out — over the rolling 7-day window attendanceDailyJob.ts's defaultRange()
 *  already uses for the batch recompute. Deliberately not "today": that row
 *  doesn't exist in attendance_daily until tomorrow's batch run (see the
 *  server route's comment), so showing it here would just be misleadingly
 *  empty for most of the day. */
export function AttendanceIssuesCards() {
  const [state, setState] = useState<State>({ phase: 'loading' })

  useEffect(() => {
    const controller = new AbortController()

    getAttendanceIssues(controller.signal)
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
      <div className={fluidGrid('20rem')}>
        {[0, 1].map((i) => (
          <div key={i} className="h-34 rounded-lg border border-dashed border-slate-200 bg-slate-50" />
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

  const { summary } = state
  const rangeLabel = `${formatDate(summary.fromDate)} – ${formatDate(summary.toDate)}`

  if (summary.scope === 'none') {
    return (
      <div className={card}>
        <p className={muted}>ไม่มีลูกทีมที่ต้องตรวจสอบการลงเวลา</p>
      </div>
    )
  }

  return (
    <div className={fluidGrid('20rem')}>
      <section className={card}>
        <header className={cardHead}>
          <div>
            <h2>ขาดงาน</h2>
            <p className={muted}>{rangeLabel}</p>
          </div>
          <Link className={link} to="/report/attendance">
            ดูทั้งหมด
          </Link>
        </header>
        <IssueList items={summary.absent} avatarTone="bg-red-100 text-red-700" emptyText="ไม่มีพนักงานขาดงานในช่วงนี้" />
      </section>

      <section className={card}>
        <header className={cardHead}>
          <div>
            <h2>ลงเวลาไม่ครบ</h2>
            <p className={muted}>{rangeLabel}</p>
          </div>
          <Link className={link} to="/report/attendance">
            ดูทั้งหมด
          </Link>
        </header>
        <IssueList
          items={summary.incomplete}
          avatarTone="bg-amber-100 text-amber-700"
          emptyText="ไม่มีพนักงานลงเวลาไม่ครบในช่วงนี้"
        />
      </section>
    </div>
  )
}
