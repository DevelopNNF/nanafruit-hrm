import { useEffect, useState } from 'react'
import type { CalendarDay, CalendarDayStatus } from '@hrm/shared'
import { fetchMonthCalendar } from '../api/calendar'
import { ApiRequestError } from '../api/client'
import { PageHeader } from '../components/PageHeader'

type Props = {
  onBack: () => void
}

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; days: CalendarDay[] }
  | { phase: 'error'; message: string }

// Hardcoded Thai arrays, same convention as admin's calendar.tsx — no date
// locale library anywhere in this repo.
const WEEKDAYS_TH = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส']
const WEEKDAYS_FULL_TH = [
  'วันอาทิตย์', 'วันจันทร์', 'วันอังคาร', 'วันพุธ', 'วันพฤหัสบดี', 'วันศุกร์', 'วันเสาร์',
]
const MONTHS_TH = [
  'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม',
]

const STATUS_LABEL: Record<CalendarDayStatus, string> = {
  workday: 'วันทำงาน',
  weekly_off: 'วันหยุดประจำสัปดาห์',
  holiday: 'Holiday',
  leave: 'ลา',
}

function messageFor(err: unknown): string {
  if (err instanceof ApiRequestError) return err.message
  return 'เชื่อมต่อไม่สำเร็จ กรุณาลองใหม่อีกครั้ง'
}

function today(): { year: number; month: number; date: number } {
  const now = new Date()
  return { year: now.getFullYear(), month: now.getMonth() + 1, date: now.getDate() }
}

export function CalendarScreen({ onBack }: Props) {
  const initial = today()
  const [year, setYear] = useState(initial.year)
  const [month, setMonth] = useState(initial.month)
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    setState({ phase: 'loading' })
    setSelected(null)
    const controller = new AbortController()
    fetchMonthCalendar(year, month, controller.signal)
      .then((days) => setState({ phase: 'ready', days }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setState({ phase: 'error', message: messageFor(err) })
      })
    return () => controller.abort()
  }, [year, month])

  function changeMonth(delta: number) {
    let nextMonth = month + delta
    let nextYear = year
    if (nextMonth < 1) {
      nextMonth = 12
      nextYear -= 1
    } else if (nextMonth > 12) {
      nextMonth = 1
      nextYear += 1
    }
    setYear(nextYear)
    setMonth(nextMonth)
  }

  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay()
  const now = today()
  const isCurrentMonth = now.year === year && now.month === month

  const selectedDay =
    state.phase === 'ready' ? (state.days.find((d) => d.date === selected) ?? null) : null

  return (
    <main className="app">
      <PageHeader title="ปฏิทินการทำงาน" onBack={onBack} />

      <div className="calendar-nav">
        <button
          type="button"
          className="calendar-nav-button"
          onClick={() => changeMonth(-1)}
          aria-label="เดือนก่อนหน้า"
        >
          ‹
        </button>
        <span className="calendar-month-label">
          {MONTHS_TH[month - 1]} {year}
        </span>
        <button
          type="button"
          className="calendar-nav-button"
          onClick={() => changeMonth(1)}
          aria-label="เดือนถัดไป"
        >
          ›
        </button>
      </div>

      <div className="calendar-legend">
        <span className="calendar-legend-item">
          <span className="calendar-dot workday" />
          วันทำงาน
        </span>
        <span className="calendar-legend-item">
          <span className="calendar-dot weekly_off" />
          วันหยุดประจำสัปดาห์
        </span>
        <span className="calendar-legend-item">
          <span className="calendar-dot holiday" />
          Holiday
        </span>
        <span className="calendar-legend-item">
          <span className="calendar-dot leave" />
          ลา
        </span>
      </div>

      {state.phase === 'loading' && <p className="hint">กำลังโหลดปฏิทิน…</p>}
      {state.phase === 'error' && <p className="form-error">{state.message}</p>}

      {state.phase === 'ready' && (
        <>
          <div className="calendar-grid">
            {WEEKDAYS_TH.map((w) => (
              <span key={w} className="calendar-weekday">
                {w}
              </span>
            ))}
            {Array.from({ length: firstWeekday }).map((_, i) => (
              <span key={`pad-${i}`} className="calendar-day empty" aria-hidden="true" />
            ))}
            {state.days.map((day) => {
              const dateNum = Number(day.date.slice(8, 10))
              const isToday = isCurrentMonth && dateNum === now.date
              const classes = ['calendar-day', day.status]
              if (isToday) classes.push('today')
              if (day.date === selected) classes.push('selected')
              return (
                <button
                  key={day.date}
                  type="button"
                  className={classes.join(' ')}
                  onClick={() => setSelected(day.date)}
                >
                  {dateNum}
                </button>
              )
            })}
          </div>

          {selectedDay && (
            <div className="card ok calendar-detail">
              <p className="headline">
                {WEEKDAYS_FULL_TH[new Date(`${selectedDay.date}T00:00:00Z`).getUTCDay()]}ที่{' '}
                {Number(selectedDay.date.slice(8, 10))} {MONTHS_TH[month - 1]} {year}
                {isCurrentMonth && Number(selectedDay.date.slice(8, 10)) === now.date
                  ? ' (วันนี้)'
                  : ''}
              </p>
              <p className="hint">
                {STATUS_LABEL[selectedDay.status]}
                {selectedDay.label ? ` · ${selectedDay.label}` : ''}
              </p>
            </div>
          )}
        </>
      )}
    </main>
  )
}
