import { NavLink, Outlet } from 'react-router-dom'
import { useMsal } from '@azure/msal-react'
import { Activity, LayoutDashboard, LogOut, Users, type LucideIcon } from 'lucide-react'
import type { Role } from '@hrm/shared'
import { useMe } from '../auth/meContext'
import { getSignedInAccount } from '../auth/msal'
import { button } from '../styles'

/** Entra's role strings are the contract with Entra; these are for people. */
const ROLE_LABELS: Record<Role, string> = {
  'HRM.Admin': 'Admin',
  'HRM.HR': 'HR',
  'HRM.Viewer': 'ผู้ดูข้อมูล',
}

const NAV: { to: string; label: string; icon: LucideIcon }[] = [
  { to: '/dashboard', label: 'ภาพรวม', icon: LayoutDashboard },
  { to: '/employees', label: 'พนักงาน', icon: Users },
  { to: '/health', label: 'สถานะระบบ', icon: Activity },
]

/** First letters of the first two words — the avatar stand-in. Thai names have
 *  no case, so this is a glyph, not an acronym. */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0] ?? '')
    .join('')
}

export function AppLayout() {
  const { instance } = useMsal()
  const me = useMe()

  // MeProvider has already turned "no roles" into its own screen, so anyone
  // rendering here holds at least one.
  const roles = me.kind === 'admin' ? me.roles : []
  const name = me.kind === 'admin' ? me.name : ''
  const upn = me.kind === 'admin' ? me.upn : ''

  return (
    <div className="flex flex-1 flex-col shell:flex-row">
      {/* A dark rail against the light content on wide screens; a top bar on
          narrow ones, where a full-height rail would cost more width than it
          earns. Same markup and order either way — only the direction and a
          few sizes change. */}
      <aside
        className="sticky top-0 z-10 flex flex-row flex-wrap items-center gap-x-4 gap-y-2
          bg-shell px-4 py-3 text-shell-fg-dim
          shell:h-svh shell:w-62 shell:flex-none shell:flex-col shell:flex-nowrap
          shell:items-stretch shell:gap-0 shell:px-3.5 shell:py-5"
      >
        <div className="flex items-center gap-2.5 shell:px-2 shell:pt-1 shell:pb-6">
          <div className="grid size-8 flex-none place-items-center rounded-md bg-white/10 text-shell-fg">
            <Users size={17} />
          </div>
          <div className="flex min-w-0 flex-col leading-tight">
            <span className="text-base font-bold tracking-wide text-white">HRM</span>
            <span className="text-[0.7rem] text-shell-fg-dim">Nanafruit</span>
          </div>
        </div>

        <nav className="order-3 mt-3 flex basis-full flex-row gap-1 overflow-x-auto border-t
          border-white/10 pt-3 [scrollbar-width:none]
          shell:order-none shell:mt-0 shell:basis-auto shell:flex-col shell:overflow-visible
          shell:border-t-0 shell:pt-0">
          <p className="hidden px-3 pb-2 text-[0.65rem] font-semibold tracking-widest
            text-shell-fg-dim/70 uppercase shell:block">
            เมนูหลัก
          </p>
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                [
                  'flex flex-none items-center gap-2.5 rounded-md px-3 py-2.5 text-sm transition-colors',
                  isActive
                    ? 'bg-shell-active font-semibold text-white'
                    : 'text-shell-fg-dim hover:bg-white/6 hover:text-shell-fg',
                ].join(' ')
              }
            >
              <item.icon size={17} className="flex-none opacity-90" />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2 shell:ml-0 shell:mt-auto shell:flex-col
          shell:items-stretch shell:gap-2.5 shell:border-t shell:border-white/10 shell:pt-4">
          <div className="hidden flex-wrap gap-1 px-1 shell:flex">
            {roles.map((role) => (
              <span
                key={role}
                className="rounded-full border border-white/10 bg-white/8 px-2 py-0.5
                  text-[0.675rem] font-semibold whitespace-nowrap text-shell-fg"
              >
                {ROLE_LABELS[role]}
              </span>
            ))}
          </div>

          <div className="flex min-w-0 items-center gap-2.5 px-1">
            <div
              className="grid size-8 flex-none place-items-center overflow-hidden rounded-full
                bg-shell-active text-xs font-semibold text-shell-fg"
              aria-hidden="true"
            >
              {initials(name)}
            </div>
            <div className="hidden min-w-0 flex-col leading-tight shell:flex">
              <span className="truncate text-[0.8rem] font-semibold text-shell-fg">
                {name}
              </span>
              <span className="truncate text-[0.7rem] text-shell-fg-dim">{upn}</span>
            </div>
          </div>

          <button
            type="button"
            className={`${button('ghost')} px-2.5 py-1.5 shell:w-full shell:px-3.5 shell:py-2`}
            // Naming the account for the same reason the API client does: the
            // active one is not guaranteed to be set. The redirect to Entra's
            // end-session endpoint that this would otherwise trigger is
            // suppressed globally — see onRedirectNavigate in msal.ts.
            onClick={() => void instance.logoutRedirect({ account: getSignedInAccount() })}
          >
            <LogOut size={16} />
            <span className="hidden shell:inline">ออกจากระบบ</span>
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 bg-slate-100 px-5 py-6 shell:px-10 shell:py-8">
        <Outlet />
      </main>
    </div>
  )
}
