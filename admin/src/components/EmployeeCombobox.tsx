// A single-employee type-to-filter picker. Unlike TransferList (many
// employees, checkbox rows) this resolves to exactly one employeeId — for
// forms like the admin-initiated time-correction request, where the caller
// picks one employee out of an already scope-filtered candidate list. The
// candidate list is fetched once by the caller and searched here in the
// browser, the same scale assumption Bulk OT Request's TransferList makes.

import { useEffect, useMemo, useRef, useState } from 'react'
import { fieldControl } from '../styles'

export type EmployeeComboboxCandidate = {
  employeeId: number
  employeeCode: string
  employeeName: string
  departmentName: string | null
}

function formatSelected(candidate: EmployeeComboboxCandidate): string {
  return `${candidate.employeeCode} — ${candidate.employeeName}`
}

export function EmployeeCombobox({
  candidates,
  value,
  onChange,
  placeholder = 'ค้นหาด้วยรหัสหรือชื่อพนักงาน…',
  disabled = false,
}: {
  candidates: EmployeeComboboxCandidate[]
  /** Selected employeeId, or null when nothing is picked yet. */
  value: number | null
  onChange: (employeeId: number | null) => void
  placeholder?: string
  disabled?: boolean
}) {
  const selected = useMemo(() => candidates.find((c) => c.employeeId === value) ?? null, [candidates, value])
  // What the user has typed while the dropdown is open — while closed, the
  // field instead just displays the confirmed selection (see displayValue
  // below), so there is never a stale typed string sitting behind a pick.
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const displayValue = open ? query : (selected ? formatSelected(selected) : query)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return candidates
    return candidates.filter(
      (c) => c.employeeCode.toLowerCase().includes(q) || c.employeeName.toLowerCase().includes(q)
    )
  }, [candidates, query])

  function openForEditing() {
    setQuery('')
    setOpen(true)
  }

  function pick(candidate: EmployeeComboboxCandidate) {
    onChange(candidate.employeeId)
    setOpen(false)
  }

  return (
    <div ref={rootRef} className="relative">
      <input
        type="text"
        className={`${fieldControl} w-full`}
        placeholder={placeholder}
        disabled={disabled}
        value={displayValue}
        onFocus={openForEditing}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
          if (value !== null) onChange(null)
        }}
      />
      {open && !disabled && (
        <div className="absolute z-10 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-slate-200 bg-white shadow-lg">
          {matches.length === 0 && <p className="px-3 py-3 text-center text-[0.775rem] text-slate-400">ไม่พบพนักงาน</p>}
          {matches.map((c) => (
            <div
              key={c.employeeId}
              role="option"
              aria-selected={c.employeeId === value}
              onClick={() => pick(c)}
              className="cursor-pointer border-b border-slate-100 px-3 py-1.5 text-[0.8rem] last:border-b-0 hover:bg-slate-50"
            >
              <span className="block truncate text-slate-900">
                {c.employeeCode} — {c.employeeName}
              </span>
              {c.departmentName && <span className="block truncate text-[0.7rem] text-slate-500">{c.departmentName}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
