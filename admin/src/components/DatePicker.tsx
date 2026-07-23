// A calendar-popup date picker, dd/mm/yyyy, replacing <input type="date"> —
// whose displayed order (mm/dd/yyyy vs dd/mm/yyyy) follows the browser/OS
// locale and can't be forced from the page, the same ambiguity TimeInput
// exists to remove for times. Value stays 'YYYY-MM-DD' so it's a drop-in
// swap for the API and any surrounding form state.

import { useEffect, useRef, useState } from 'react'
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react'

type Props = {
  /** '' for unset, otherwise 'YYYY-MM-DD'. */
  value: string
  onChange: (value: string) => void
  required?: boolean
  disabled?: boolean
  /** 'YYYY-MM-DD' bounds, inclusive. */
  min?: string
  max?: string
  className?: string
}

const WEEKDAYS = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส']
const MONTHS = [
  'มกราคม',
  'กุมภาพันธ์',
  'มีนาคม',
  'เมษายน',
  'พฤษภาคม',
  'มิถุนายน',
  'กรกฎาคม',
  'สิงหาคม',
  'กันยายน',
  'ตุลาคม',
  'พฤศจิกายน',
  'ธันวาคม',
]

const triggerClass =
  'flex min-w-0 items-center gap-2 rounded-md border border-slate-300 bg-white px-2.5 py-2 text-left text-[0.825rem] text-slate-900 hover:enabled:border-slate-500 disabled:bg-slate-100 disabled:text-slate-900 disabled:opacity-100'

function parseISODate(value: string): Date | null {
  if (!value) return null
  const [y, m, d] = value.split('-').map(Number)
  if (!y || !m || !d) return null
  return new Date(y, m - 1, d)
}

function toISODate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function formatDisplay(value: string): string {
  const date = parseISODate(value)
  if (!date) return ''
  return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function isOutOfRange(date: Date, min?: string, max?: string): boolean {
  const iso = toISODate(date)
  if (min && iso < min) return true
  if (max && iso > max) return true
  return false
}

function buildCalendarDays(viewYear: number, viewMonth: number): Date[] {
  const firstOfMonth = new Date(viewYear, viewMonth, 1)
  const start = new Date(viewYear, viewMonth, 1 - firstOfMonth.getDay())
  return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i))
}

export function DatePicker({ value, onChange, required, disabled, min, max, className }: Props) {
  const [open, setOpen] = useState(false)
  const [viewDate, setViewDate] = useState(() => parseISODate(value) ?? new Date())
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return

    function onPointerDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  function openCalendar() {
    if (disabled) return
    setViewDate(parseISODate(value) ?? new Date())
    setOpen(true)
  }

  function pick(date: Date) {
    if (isOutOfRange(date, min, max)) return
    onChange(toISODate(date))
    setOpen(false)
  }

  const selected = parseISODate(value)
  const today = new Date()
  const viewYear = viewDate.getFullYear()
  const viewMonth = viewDate.getMonth()
  const days = buildCalendarDays(viewYear, viewMonth)

  const minYear = (min ? parseISODate(min)?.getFullYear() : undefined) ?? today.getFullYear() - 100
  const maxYear = (max ? parseISODate(max)?.getFullYear() : undefined) ?? today.getFullYear() + 10
  const years = Array.from({ length: maxYear - minYear + 1 }, (_, i) => minYear + i)

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openCalendar())}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`${triggerClass} ${className ?? ''}`}
      >
        <Calendar className="size-4 shrink-0 text-slate-400" />
        <span className={value ? '' : 'text-slate-400'}>{value ? formatDisplay(value) : 'วว/ดด/ปปปป'}</span>
      </button>

      {/* Keeps the surrounding <form>'s required/validity behavior working
          without needing the button itself to be a form control. */}
      {required && (
        <input
          tabIndex={-1}
          aria-hidden
          required
          value={value}
          onChange={() => {}}
          className="absolute inset-x-0 bottom-0 h-0 w-full opacity-0"
        />
      )}

      {open && (
        <div
          role="dialog"
          className="absolute z-20 mt-1 w-[17.5rem] rounded-lg border border-slate-200 bg-white p-3 shadow-lg"
        >
          <div className="mb-2 flex items-center gap-1.5">
            <button
              type="button"
              aria-label="เดือนก่อนหน้า"
              onClick={() => setViewDate(new Date(viewYear, viewMonth - 1, 1))}
              className="rounded-md p-1 text-slate-500 hover:bg-slate-100"
            >
              <ChevronLeft className="size-4" />
            </button>
            <select
              aria-label="เดือน"
              value={viewMonth}
              onChange={(e) => setViewDate(new Date(viewYear, Number(e.target.value), 1))}
              className="min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-1.5 py-1 text-[0.8rem] text-slate-900 hover:border-slate-500"
            >
              {MONTHS.map((m, i) => (
                <option key={m} value={i}>
                  {m}
                </option>
              ))}
            </select>
            <select
              aria-label="ปี"
              value={viewYear}
              onChange={(e) => setViewDate(new Date(Number(e.target.value), viewMonth, 1))}
              className="min-w-0 rounded-md border border-slate-300 bg-white px-1.5 py-1 text-[0.8rem] text-slate-900 tabular-nums hover:border-slate-500"
            >
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
            <button
              type="button"
              aria-label="เดือนถัดไป"
              onClick={() => setViewDate(new Date(viewYear, viewMonth + 1, 1))}
              className="rounded-md p-1 text-slate-500 hover:bg-slate-100"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>

          <div className="grid grid-cols-7 gap-y-1 text-center">
            {WEEKDAYS.map((w) => (
              <span key={w} className="text-[0.675rem] font-semibold text-slate-400">
                {w}
              </span>
            ))}
            {days.map((day) => {
              const outOfMonth = day.getMonth() !== viewMonth
              const outOfRange = isOutOfRange(day, min, max)
              const isSelected = selected !== null && isSameDay(day, selected)
              const isToday = isSameDay(day, today)
              return (
                <button
                  key={day.toISOString()}
                  type="button"
                  disabled={outOfRange}
                  onClick={() => pick(day)}
                  className={[
                    'aspect-square rounded-md text-[0.8rem] tabular-nums',
                    isSelected
                      ? 'bg-navy text-white'
                      : isToday
                        ? 'border border-navy text-navy'
                        : 'text-slate-900 hover:bg-slate-100',
                    outOfMonth && !isSelected ? 'text-slate-300' : '',
                    outOfRange ? 'cursor-not-allowed opacity-40 hover:bg-transparent' : '',
                  ].join(' ')}
                >
                  {day.getDate()}
                </button>
              )
            })}
          </div>

          <div className="mt-2 flex items-center justify-between border-t border-slate-100 pt-2">
            <button
              type="button"
              onClick={() => pick(today)}
              disabled={isOutOfRange(today, min, max)}
              className="text-[0.775rem] font-medium text-navy hover:underline disabled:cursor-not-allowed disabled:text-slate-300 disabled:no-underline"
            >
              วันนี้
            </button>
            {!required && (
              <button
                type="button"
                onClick={() => {
                  onChange('')
                  setOpen(false)
                }}
                className="text-[0.775rem] text-slate-500 hover:underline"
              >
                ล้าง
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
