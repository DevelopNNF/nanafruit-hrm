import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { CalendarDays, Plus, UserCheck, UserX, Users, type LucideIcon } from 'lucide-react'
import { EMPLOYMENT_TYPES, type Employee } from '@hrm/shared'
import { listEmployees } from '../api/employees'
import { useCanWrite, useMe } from '../auth/meContext'
import {
  alert,
  alertDetail,
  alertTitle,
  button,
  card,
  cardHead,
  eyebrow,
  fluidGrid,
  link,
  muted,
  pageHead,
  subtitle,
} from '../styles'

/**
 * Counted here rather than asked of the server: the employee list is one
 * request the admin already makes, and at this size summing it in the browser
 * costs nothing a query would save. If the headcount ever outgrows a single
 * list response, this is the thing to replace with a /api/stats endpoint.
 */

/** Calendar date `n` days before today, as YYYY-MM-DD — the same shape hireDate
 *  is stored in, so the two compare as plain strings. */
function daysAgo(n: number): string {
  const date = new Date()
  date.setDate(date.getDate() - n)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('th-TH', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

type Summary = {
  total: number
  active: number
  inactive: number
  recentHires: number
  byType: { type: string; count: number }[]
  latest: Employee[]
}

function summarise(employees: Employee[]): Summary {
  const cutoff = daysAgo(30)

  return {
    total: employees.length,
    active: employees.filter((e) => e.employment.status === 'Active').length,
    inactive: employees.filter((e) => e.employment.status === 'Inactive').length,
    recentHires: employees.filter((e) => e.employment.hireDate >= cutoff).length,
    // Driven off the constant, not off the data, so a type nobody holds still
    // shows as a zero instead of vanishing from the breakdown.
    byType: EMPLOYMENT_TYPES.map((type) => ({
      type,
      count: employees.filter((e) => e.employment.employmentType === type).length,
    })),
    latest: [...employees]
      .sort((a, b) => b.employment.hireDate.localeCompare(a.employment.hireDate))
      .slice(0, 5),
  }
}

type State =
  | { phase: 'loading' }
  | { phase: 'ok'; employees: Employee[] }
  | { phase: 'error'; message: string }

export function DashboardPage() {
  const [state, setState] = useState<State>({ phase: 'loading' })
  const canWrite = useCanWrite()
  const me = useMe()

  useEffect(() => {
    const controller = new AbortController()

    listEmployees(controller.signal)
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

  const summary = useMemo(
    () => (state.phase === 'ok' ? summarise(state.employees) : null),
    [state]
  )

  const firstName = me.kind === 'admin' ? me.name.split(/\s+/)[0] : ''

  return (
    <>
      <header className={pageHead}>
        <div>
          <p className={eyebrow}>ภาพรวม</p>
          <h1>สวัสดี {firstName}</h1>
          <p className={subtitle}>สรุปข้อมูลทะเบียนพนักงาน ณ วันนี้</p>
        </div>
        {canWrite && (
          <Link className={button('primary')} to="/employees/new">
            <Plus size={16} />
            เพิ่มพนักงาน
          </Link>
        )}
      </header>

      {state.phase === 'loading' && (
        <div className={`${fluidGrid('13rem')} mb-5`}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-[8.5rem] rounded-lg border border-dashed border-slate-200 bg-slate-50" />
          ))}
        </div>
      )}

      {state.phase === 'error' && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>โหลดข้อมูลไม่สำเร็จ</p>
          <p className={alertDetail}>{state.message}</p>
        </div>
      )}

      {summary && (
        <>
          <section className={`${fluidGrid('13rem')} mb-5`}>
            <StatCard
              icon={Users}
              label="พนักงานทั้งหมด"
              value={summary.total}
              tone="navy"
            />
            <StatCard
              icon={UserCheck}
              label="ปฏิบัติงานอยู่"
              value={summary.active}
              tone="ok"
              note={
                summary.total > 0
                  ? `${Math.round((summary.active / summary.total) * 100)}% ของทั้งหมด`
                  : undefined
              }
            />
            <StatCard
              icon={UserX}
              label="พ้นสภาพ"
              value={summary.inactive}
              tone="muted"
            />
            <StatCard
              icon={CalendarDays}
              label="เข้าใหม่ (30 วัน)"
              value={summary.recentHires}
              tone="warn"
            />
          </section>

          <div className={fluidGrid('20rem')}>
            <section className={card}>
              <header className={cardHead}>
                <h2>สัดส่วนประเภทการจ้าง</h2>
              </header>

              {summary.total === 0 ? (
                <p className={muted}>ยังไม่มีข้อมูล</p>
              ) : (
                <ul className="flex flex-col gap-3.5">
                  {summary.byType.map(({ type, count }) => (
                    <li key={type}>
                      <div className="mb-1 flex items-baseline justify-between">
                        <span className="text-sm text-slate-600">{type}</span>
                        <span className="text-sm font-semibold tabular-nums text-slate-900">
                          {count}
                        </span>
                      </div>
                      <div
                        className="h-2 overflow-hidden rounded-full bg-slate-100"
                        role="img"
                        aria-label={`${type}: ${count} จาก ${summary.total} คน`}
                      >
                        {/* Against the headcount, not the largest bar: these are
                            shares of the whole, and scaling to the leader would
                            show the top type as 100% of a company it is a slice of. */}
                        <div
                          className="h-full min-w-0.5 rounded-full bg-navy"
                          style={{ width: `${(count / summary.total) * 100}%` }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className={card}>
              <header className={cardHead}>
                <h2>เข้าใหม่ล่าสุด</h2>
                <Link className={link} to="/employees">
                  ดูทั้งหมด
                </Link>
              </header>

              {summary.latest.length === 0 ? (
                <p className={muted}>ยังไม่มีพนักงานในระบบ</p>
              ) : (
                <ul className="divide-y divide-slate-200">
                  {summary.latest.map((employee) => (
                    <li key={employee.id}>
                      <Link
                        to={`/employees/${employee.id}`}
                        className="-mx-2 flex items-center gap-2.5 rounded-md px-2 py-2.5 no-underline hover:bg-slate-50"
                      >
                        <span
                          className="grid size-7 flex-none place-items-center rounded-full bg-navy/7 text-[0.7rem] font-semibold text-navy"
                          aria-hidden="true"
                        >
                          {employee.firstNameTh[0] ?? '?'}
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col leading-tight">
                          <span className="text-[0.825rem] font-medium text-slate-900">
                            {employee.firstNameTh} {employee.lastNameTh}
                          </span>
                          <span className="text-xs text-slate-500">
                            {employee.employment.jobTitle}
                          </span>
                        </span>
                        <span className="flex-none text-xs whitespace-nowrap text-slate-500">
                          {formatDate(employee.employment.hireDate)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      )}
    </>
  )
}

const STAT_TONES = {
  navy: 'bg-navy/7 text-navy',
  ok: 'bg-green-100 text-green-700',
  warn: 'bg-amber-100 text-amber-700',
  muted: 'bg-slate-100 text-slate-500',
} as const

function StatCard({
  icon: IconComponent,
  label,
  value,
  tone,
  note,
}: {
  icon: LucideIcon
  label: string
  value: number
  tone: keyof typeof STAT_TONES
  note?: string
}) {
  return (
    <article className={`${card} flex flex-col gap-1`}>
      <div className={`mb-1 grid size-9 place-items-center rounded-md ${STAT_TONES[tone]}`}>
        <IconComponent size={18} />
      </div>
      <p className="text-sm text-slate-500">{label}</p>
      <p className="text-[1.875rem] leading-tight font-semibold tracking-tight text-slate-900 tabular-nums">
        {value.toLocaleString('th-TH')}
      </p>
      {note && <p className="mt-0.5 text-[0.725rem] text-slate-500">{note}</p>}
    </article>
  )
}
