// A calendar-popup date picker, dd/mm/yyyy, replacing <input type="date"> —
// whose displayed order (mm/dd/yyyy vs dd/mm/yyyy) follows the browser/OS
// locale and can't be forced from the page, the same ambiguity TimeInput
// exists to remove for times. Value stays 'YYYY-MM-DD' so it's a drop-in
// swap for the API and any surrounding form state.

import { useState } from 'react'
import { Calendar as CalendarIcon } from 'lucide-react'
import { Calendar } from './ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

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

const triggerClass =
  'flex min-w-0 items-center gap-2 rounded-md border border-slate-300 bg-white px-2.5 py-2 text-left text-[0.825rem] text-slate-900 hover:enabled:border-slate-500 disabled:bg-slate-100 disabled:text-slate-900 disabled:opacity-100'

function parseISODate(value: string): Date | undefined {
  if (!value) return undefined
  const [y, m, d] = value.split('-').map(Number)
  if (!y || !m || !d) return undefined
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

export function DatePicker({ value, onChange, required, disabled, min, max, className }: Props) {
  const [open, setOpen] = useState(false)

  const selected = parseISODate(value)
  const today = new Date()
  const minDate = parseISODate(min ?? '')
  const maxDate = parseISODate(max ?? '')

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className="relative">
        <PopoverTrigger asChild>
          <button type="button" disabled={disabled} className={`${triggerClass} ${className ?? ''}`}>
            <CalendarIcon className="size-4 shrink-0 text-slate-400" />
            <span className={value ? '' : 'text-slate-400'}>{value ? formatDisplay(value) : 'วว/ดด/ปปปป'}</span>
          </button>
        </PopoverTrigger>

        {/* Keeps the surrounding <form>'s required/validity behavior working
            without needing the trigger itself to be a form control. */}
        {required && (
          <input
            tabIndex={-1}
            aria-hidden
            required
            value={value}
            onChange={() => {}}
            className="pointer-events-none absolute inset-x-0 bottom-0 h-0 w-full opacity-0"
          />
        )}
      </div>

      <PopoverContent>
        <Calendar
          mode="single"
          selected={selected}
          onSelect={(date) => {
            if (!date) return
            onChange(toISODate(date))
            setOpen(false)
          }}
          defaultMonth={selected ?? today}
          startMonth={minDate ?? new Date(today.getFullYear() - 100, 0, 1)}
          endMonth={maxDate ?? new Date(today.getFullYear() + 10, 11, 31)}
          disabled={[...(minDate ? [{ before: minDate }] : []), ...(maxDate ? [{ after: maxDate }] : [])]}
        />
        <div className="mt-2 flex items-center justify-between border-t border-slate-100 pt-2">
          <button
            type="button"
            onClick={() => {
              onChange(toISODate(today))
              setOpen(false)
            }}
            disabled={(minDate !== undefined && today < minDate) || (maxDate !== undefined && today > maxDate)}
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
      </PopoverContent>
    </Popover>
  )
}
