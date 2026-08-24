// A two-pane picker: all items on the left, chosen items on the right.
// Check rows and use the arrow buttons (or double-click a row) to move them
// between panes. Each pane has its own search filter since the source list
// can run into the hundreds of rows.

import { type ReactNode, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Search } from 'lucide-react'
import { cn } from '../lib/utils'

export type TransferListItem = {
  id: number
  label: string
  sublabel?: string
}

type PaneProps = {
  title: string
  items: TransferListItem[]
  checked: Set<number>
  onToggle: (id: number) => void
  onToggleAll: (ids: number[]) => void
  onActivate: (id: number) => void
  search: string
  onSearchChange: (value: string) => void
  renderStatus?: (id: number) => ReactNode
}

function Pane({
  title,
  items,
  checked,
  onToggle,
  onToggleAll,
  onActivate,
  search,
  onSearchChange,
  renderStatus,
}: PaneProps) {
  const visibleIds = items.map((item) => item.id)
  const allVisibleChecked = visibleIds.length > 0 && visibleIds.every((id) => checked.has(id))

  return (
    <div className="flex min-w-0 flex-1 flex-col rounded-md border border-slate-200">
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2">
        <label className="flex items-center gap-2 text-[0.775rem] font-semibold text-slate-600">
          <input
            type="checkbox"
            checked={allVisibleChecked}
            disabled={visibleIds.length === 0}
            onChange={() => onToggleAll(visibleIds)}
            className="size-3.5"
          />
          {title}
        </label>
        <span className="text-[0.7rem] text-slate-500">
          {checked.size > 0 ? `เลือก ${checked.size}/` : ''}
          {items.length} คน
        </span>
      </div>

      <div className="relative border-b border-slate-200 px-2 py-1.5">
        <Search className="pointer-events-none absolute top-1/2 left-4 size-3.5 -translate-y-1/2 text-slate-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="ค้นหา…"
          className="w-full rounded-md border border-slate-200 bg-white py-1 pr-2 pl-7 text-[0.775rem] text-slate-900 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none"
        />
      </div>

      <div className="h-72 overflow-y-auto">
        {items.length === 0 && (
          <p className="px-3 py-4 text-center text-[0.775rem] text-slate-400">ไม่มีรายการ</p>
        )}
        {items.map((item) => (
          <div
            key={item.id}
            role="option"
            aria-selected={checked.has(item.id)}
            onDoubleClick={() => onActivate(item.id)}
            className="flex cursor-pointer items-center gap-2 border-b border-slate-100 px-3 py-1.5 text-[0.8rem] last:border-b-0 hover:bg-slate-50"
            onClick={() => onToggle(item.id)}
          >
            <input
              type="checkbox"
              checked={checked.has(item.id)}
              onChange={() => onToggle(item.id)}
              onClick={(e) => e.stopPropagation()}
              className="size-3.5 shrink-0"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-slate-900">{item.label}</span>
              {item.sublabel && <span className="block truncate text-[0.7rem] text-slate-500">{item.sublabel}</span>}
            </span>
            {renderStatus?.(item.id)}
          </div>
        ))}
      </div>
    </div>
  )
}

export function TransferList({
  items,
  value,
  onChange,
  leftTitle,
  rightTitle,
  renderStatus,
}: {
  items: TransferListItem[]
  /** ids currently on the right (chosen) side. */
  value: number[]
  onChange: (next: number[]) => void
  leftTitle: string
  rightTitle: string
  /** Renders a status badge next to a right-side row, e.g. after submit. */
  renderStatus?: (id: number) => ReactNode
}) {
  const [leftSearch, setLeftSearch] = useState('')
  const [rightSearch, setRightSearch] = useState('')
  const [checkedLeft, setCheckedLeft] = useState<Set<number>>(new Set())
  const [checkedRight, setCheckedRight] = useState<Set<number>>(new Set())

  const valueSet = useMemo(() => new Set(value), [value])

  const leftItems = useMemo(() => {
    const q = leftSearch.trim().toLowerCase()
    return items.filter((item) => {
      if (valueSet.has(item.id)) return false
      if (!q) return true
      return item.label.toLowerCase().includes(q) || item.sublabel?.toLowerCase().includes(q)
    })
  }, [items, valueSet, leftSearch])

  const rightItems = useMemo(() => {
    const q = rightSearch.trim().toLowerCase()
    return items.filter((item) => {
      if (!valueSet.has(item.id)) return false
      if (!q) return true
      return item.label.toLowerCase().includes(q) || item.sublabel?.toLowerCase().includes(q)
    })
  }, [items, valueSet, rightSearch])

  function toggle(set: Set<number>, setSet: (next: Set<number>) => void, id: number) {
    const next = new Set(set)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSet(next)
  }

  function toggleAll(set: Set<number>, setSet: (next: Set<number>) => void, ids: number[]) {
    const allChecked = ids.length > 0 && ids.every((id) => set.has(id))
    setSet(allChecked ? new Set() : new Set(ids))
  }

  function moveRight(ids: number[]) {
    onChange([...value, ...ids])
    setCheckedLeft(new Set())
  }

  function moveLeft(ids: number[]) {
    const removed = new Set(ids)
    onChange(value.filter((id) => !removed.has(id)))
    setCheckedRight(new Set())
  }

  return (
    <div className="flex items-stretch gap-2">
      <Pane
        title={leftTitle}
        items={leftItems}
        checked={checkedLeft}
        onToggle={(id) => toggle(checkedLeft, setCheckedLeft, id)}
        onToggleAll={(ids) => toggleAll(checkedLeft, setCheckedLeft, ids)}
        onActivate={(id) => moveRight([id])}
        search={leftSearch}
        onSearchChange={setLeftSearch}
      />

      <div className="flex flex-col justify-center gap-2">
        <button
          type="button"
          disabled={checkedLeft.size === 0}
          onClick={() => moveRight(Array.from(checkedLeft))}
          className={cn(
            'flex size-8 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-600 hover:enabled:border-slate-400 hover:enabled:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40',
          )}
          aria-label="ย้ายไปฝั่งขวา"
        >
          <ChevronRight className="size-4" />
        </button>
        <button
          type="button"
          disabled={checkedRight.size === 0}
          onClick={() => moveLeft(Array.from(checkedRight))}
          className={cn(
            'flex size-8 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-600 hover:enabled:border-slate-400 hover:enabled:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40',
          )}
          aria-label="ย้ายไปฝั่งซ้าย"
        >
          <ChevronLeft className="size-4" />
        </button>
      </div>

      <Pane
        title={rightTitle}
        items={rightItems}
        checked={checkedRight}
        onToggle={(id) => toggle(checkedRight, setCheckedRight, id)}
        onToggleAll={(ids) => toggleAll(checkedRight, setCheckedRight, ids)}
        onActivate={(id) => moveLeft([id])}
        search={rightSearch}
        onSearchChange={setRightSearch}
        renderStatus={renderStatus}
      />
    </div>
  )
}
