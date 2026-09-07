import type { LucideIcon } from 'lucide-react'
import { card } from '../styles'

const STAT_TONES = {
  navy: 'bg-navy/7 text-navy',
  ok: 'bg-green-100 text-green-700',
  warn: 'bg-amber-100 text-amber-700',
  muted: 'bg-slate-100 text-slate-500',
} as const

export function StatCard({
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
