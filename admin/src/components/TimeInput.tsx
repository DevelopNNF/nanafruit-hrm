// A 24-hour HH:MM picker built from two <select>s instead of
// <input type="time">, whose displayed format — 12-hour with AM/PM, or
// 24-hour — follows the browser/OS locale and can't be forced from the page.
// That's exactly the ambiguity ("10 PM" read as 10 in the morning) this exists
// to remove: these dropdowns never show AM/PM, so there's nothing to misread.

import { useEffect, useState } from 'react'

type Props = {
  /** '' for unset, otherwise 'HH:MM'. */
  value: string
  onChange: (value: string) => void
  required?: boolean
}

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'))
const MINUTES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'))

const selectClass =
  'min-w-0 rounded-md border border-slate-300 bg-white px-2 py-2 text-center text-[0.825rem] text-slate-900 tabular-nums hover:enabled:border-slate-500 disabled:bg-slate-100 disabled:text-slate-900 disabled:opacity-100'

function splitValue(value: string): [string, string] {
  if (!value) return ['', '']
  const [hour = '', minute = ''] = value.split(':')
  return [hour, minute]
}

export function TimeInput({ value, onChange, required }: Props) {
  // Local, not derived straight from `value`: picking only the hour has no
  // complete 'HH:MM' to report yet, so onChange('') fires and `value` stays ''
  // — deriving the select's own display from that prop would then snap the
  // hour the user just picked back to blank before they can reach the minute.
  const [hour, setHour] = useState(() => splitValue(value)[0])
  const [minute, setMinute] = useState(() => splitValue(value)[1])

  // Re-sync when `value` changes for a reason other than this component's own
  // onChange — loading an existing shift, or a parent-level reset/cancel.
  useEffect(() => {
    const [nextHour, nextMinute] = splitValue(value)
    setHour(nextHour)
    setMinute(nextMinute)
  }, [value])

  function commit(nextHour: string, nextMinute: string) {
    setHour(nextHour)
    setMinute(nextMinute)
    onChange(nextHour && nextMinute ? `${nextHour}:${nextMinute}` : '')
  }

  return (
    <div className="flex items-center gap-1">
      <select
        required={required}
        value={hour}
        onChange={(e) => commit(e.target.value, minute)}
        aria-label="ชั่วโมง"
        className={`${selectClass} w-16`}
      >
        <option value="">--</option>
        {HOURS.map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </select>
      <span className="text-slate-400">:</span>
      <select
        required={required}
        value={minute}
        onChange={(e) => commit(hour, e.target.value)}
        aria-label="นาที"
        className={`${selectClass} w-16`}
      >
        <option value="">--</option>
        {MINUTES.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
      <span className="text-[0.7rem] text-slate-400">(24 ชม.)</span>
    </div>
  )
}
