// A button that opens a small menu of choices instead of acting directly —
// e.g. picking which of several export formats to download. Built on the
// same Radix popover DatePicker/TreeSelect already use, not a one-off.

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { button } from '../styles'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

export type DropdownMenuItem = {
  label: string
  description?: string
  onClick: () => void
  disabled?: boolean
}

type Props = {
  label: string
  icon?: React.ReactNode
  items: DropdownMenuItem[]
  disabled?: boolean
  variant?: Parameters<typeof button>[0]
}

export function DropdownMenuButton({ label, icon, items, disabled, variant }: Props) {
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={button(variant)} disabled={disabled}>
          {icon}
          {label}
          <ChevronDown size={14} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-1">
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            disabled={item.disabled}
            onClick={() => {
              setOpen(false)
              item.onClick()
            }}
            className="w-full rounded-md px-3 py-2 text-left text-[0.825rem] text-slate-900 hover:enabled:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-55"
          >
            <div className="font-medium">{item.label}</div>
            {item.description && <div className="mt-0.5 text-[0.75rem] text-slate-500">{item.description}</div>}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}
