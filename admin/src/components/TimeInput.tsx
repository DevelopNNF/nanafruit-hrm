// A 24-hour HH:MM field: type digits directly ('0900' formats itself into
// '09:00' as you go) instead of hunting through two <select>s, plus a row of
// quick-pick chips for the times a shift actually uses. Never shows AM/PM —
// unlike <input type="time">, whose displayed format follows the browser/OS
// locale and can't be forced from the page — so there's nothing to misread.

import { useState } from 'react'

type Props = {
  /** '' for unset, otherwise 'HH:MM'. */
  value: string
  onChange: (value: string) => void
  required?: boolean
  /** Preset times shown as quick-pick chips under the input. */
  quickTimes?: readonly string[]
}

const DEFAULT_QUICK_TIMES = ['08:00', '09:00', '12:00', '13:00', '17:00', '18:00'] as const

/** Keeps only digits and caps the length at 4 ('HHMM') — that's all a time
 *  needs, anything typed past it is the user just retyping over. */
function digitsOnly(text: string): string {
  return text.replace(/\D/g, '').slice(0, 4)
}

/** '0900' -> '09:00', '9' -> '9', '' -> ''. Inserts the colon as soon as
 *  there are enough digits for an hour, so the field reads as a clock while
 *  the user is still typing rather than only once they're done. */
function formatDigits(digits: string): string {
  if (digits.length <= 2) return digits
  return `${digits.slice(0, 2)}:${digits.slice(2)}`
}

/** Clamps an out-of-range typed time (hour 25, minute 99) back into a valid
 *  HH:MM once the user leaves the field, instead of quietly accepting a time
 *  that can't exist. Only meaningful once all 4 digits are in. */
function clampDigits(digits: string): string {
  if (digits.length !== 4) return digits
  const hour = Math.min(23, Number(digits.slice(0, 2)))
  const minute = Math.min(59, Number(digits.slice(2)))
  return `${String(hour).padStart(2, '0')}${String(minute).padStart(2, '0')}`
}

function toDigits(value: string): string {
  return value.replace(':', '')
}

export function TimeInput({ value, onChange, required, quickTimes = DEFAULT_QUICK_TIMES }: Props) {
  // Local, not derived straight from `value`: while the user is mid-type
  // ('09' with no minute yet) there's no complete HH:MM to report, so
  // onChange('') fires and `value` stays '' — deriving the input's own
  // display from that prop would snap what they just typed back to blank.
  const [digits, setDigits] = useState(() => toDigits(value))

  // Re-syncs when `value` changes for a reason other than this component's
  // own onChange — loading an existing shift, a quick-pick click, or a
  // parent-level reset/cancel. Adjusted during render (React's documented
  // pattern for resetting state when a prop changes) so the new value lands
  // in the same commit instead of flashing the stale digits for one frame.
  const [prevValue, setPrevValue] = useState(value)
  if (value !== prevValue) {
    setPrevValue(value)
    setDigits(toDigits(value))
  }

  function commit(nextDigits: string) {
    setDigits(nextDigits)
    onChange(nextDigits.length === 4 ? formatDigits(nextDigits) : '')
  }

  function handleBlur() {
    const clamped = clampDigits(digits)
    if (clamped !== digits) commit(clamped)
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <input
        type="text"
        inputMode="numeric"
        autoComplete="off"
        required={required}
        pattern="[0-9]{2}:[0-9]{2}"
        title="กรอกเวลาเป็นตัวเลข 4 หลัก เช่น 0900 สำหรับ 09:00"
        placeholder="--:--"
        value={formatDigits(digits)}
        onChange={(e) => commit(digitsOnly(e.target.value))}
        onBlur={handleBlur}
        aria-label="เวลา (24 ชม.) พิมพ์ตัวเลข 4 หลัก"
        className="w-20 rounded-md border border-slate-300 bg-white px-2 py-2 text-center text-[0.825rem] text-slate-900 tabular-nums hover:enabled:border-slate-500 disabled:bg-slate-100 disabled:text-slate-900 disabled:opacity-100"
      />
      <span className="text-[0.7rem] text-slate-400">(24 ชม.)</span>
      {quickTimes.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {quickTimes.map((time) => (
            <button
              key={time}
              type="button"
              onClick={() => commit(toDigits(time))}
              className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[0.7rem] text-slate-600 hover:enabled:border-slate-400 hover:enabled:bg-slate-100 disabled:opacity-50"
            >
              {time}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
