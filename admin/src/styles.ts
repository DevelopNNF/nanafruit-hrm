/**
 * Shared Tailwind class recipes for the atoms every page reaches for.
 *
 * Not a component library — the markup for each still lives where it's used.
 * These exist so five pages calling the same thing "a card" end up with the
 * same classes, the way they used to share a CSS rule. A string repeated by
 * copy-paste is a string that drifts; a string imported from one place isn't.
 */

export const pageHead = 'mb-6 flex flex-wrap items-start justify-between gap-4'
export const eyebrow = 'mb-1 text-xs font-semibold tracking-wider text-slate-500 uppercase'
export const subtitle = 'mt-1 text-sm text-slate-500'
export const muted = 'text-sm text-slate-500'
export const link = 'text-sm font-semibold text-navy no-underline hover:underline'

export const card = 'rounded-lg border border-slate-200 bg-white p-5 shadow-sm'
export const cardHead = 'mb-4 flex items-center justify-between gap-4'
export const cardEmpty = 'p-14 text-center'

type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger'

export function button(variant: ButtonVariant = 'default'): string {
  const base =
    'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md border px-3.5 py-2 text-sm font-medium no-underline shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-55'
  switch (variant) {
    case 'primary':
      return `${base} border-navy bg-navy text-white hover:border-navy-hover hover:bg-navy-hover`
    case 'ghost':
      // For placement on the dark sidebar, where .button's light-surface
      // hover would disappear against the shell background.
      return `${base} border-white/10 bg-transparent text-shell-fg-dim shadow-none hover:border-white/20 hover:bg-white/8 hover:text-shell-fg`
    case 'danger':
      return `${base} ml-auto border-red-200 bg-white text-red-700 hover:border-red-700 hover:bg-red-50`
    default:
      return `${base} border-slate-300 bg-white text-slate-900 hover:border-slate-400 hover:bg-slate-50`
  }
}

export type AlertTone = 'default' | 'ok' | 'danger' | 'info'

export function alert(tone: AlertTone = 'default'): string {
  const base = 'mb-5 rounded-lg border border-l-[3px] px-4 py-3.5'
  switch (tone) {
    case 'ok':
      return `${base} border-slate-200 border-l-green-700 bg-white`
    case 'danger':
      return `${base} border-red-200 border-l-red-700 bg-red-50`
    case 'info':
      return `${base} border-navy/20 border-l-navy bg-navy/7`
    default:
      return `${base} border-slate-200 border-l-slate-300 bg-white`
  }
}

/** Same palette as alert(), sized and shadowed for a floating toast instead of
 *  an in-flow banner — no mb-5, react-hot-toast's own stack spacing owns that. */
export function toastCard(tone: AlertTone = 'default'): string {
  const base = 'rounded-lg border border-l-[3px] px-4 py-3.5 shadow-lg'
  switch (tone) {
    case 'ok':
      return `${base} border-slate-200 border-l-green-700 bg-white`
    case 'danger':
      return `${base} border-red-200 border-l-red-700 bg-red-50`
    case 'info':
      return `${base} border-navy/20 border-l-navy bg-navy/7`
    default:
      return `${base} border-slate-200 border-l-slate-300 bg-white`
  }
}

export function alertTitle(tone: AlertTone = 'default'): string {
  return tone === 'danger'
    ? 'text-sm font-semibold text-red-700'
    : 'text-sm font-semibold text-slate-900'
}

export const alertDetail = 'mt-1 font-mono text-[0.775rem] break-words text-slate-600'

type BadgeTone = 'active' | 'inactive' | 'role' | 'pending' | 'danger'

export function badge(tone: BadgeTone): string {
  const base = 'inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-[0.675rem] font-semibold'
  switch (tone) {
    case 'active':
      return `${base} border-green-700/25 bg-green-100 text-green-700`
    case 'role':
      return `${base} border-navy/20 bg-navy/7 text-navy`
    case 'pending':
      return `${base} border-amber-700/25 bg-amber-100 text-amber-700`
    case 'danger':
      return `${base} border-red-700/25 bg-red-100 text-red-700`
    default:
      return `${base} border-slate-300 bg-slate-100 text-slate-500`
  }
}

/** A fluid grid that wraps on its own width, not the viewport's — a stat row
 *  inside a narrow content area wraps sooner than the same row full-width. */
export function fluidGrid(min: string): string {
  return `grid gap-4 grid-cols-[repeat(auto-fit,minmax(${min},1fr))]`
}

export const spec = 'grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-[0.825rem]'
export const specDt = 'text-slate-500'
export const specDd = 'font-mono text-[0.775rem] text-slate-900 break-words'

/* Form ---------------------------------------------------------------------
 * A disabled field greys out by default, which reads as "broken" rather than
 * "not yours to change" — this is a record being read, so it stays legible.
 */

export const fieldLabel = 'flex min-w-0 flex-col gap-1.5 text-xs font-medium text-slate-600'

export const fieldControl =
  'min-w-0 rounded-md border border-slate-300 bg-white px-2.5 py-2 text-[0.825rem] text-slate-900 hover:enabled:border-slate-500 disabled:bg-slate-100 disabled:text-slate-900 disabled:opacity-100'

/** The "*" on a required field's label. */
export const requiredMark = 'text-[#f00]'

