import { useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useMsal } from '@azure/msal-react'
import {
  Activity,
  ChevronDown,
  Clock,
  Database,
  LayoutDashboard,
  LogOut,
  Menu,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react'
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

type NavItem =
  | { type: 'link'; to: string; label: string; icon: LucideIcon }
  | { type: 'group'; label: string; icon: LucideIcon; children: { to: string; label: string }[] }

// "Master" is a group rather than a link: it holds no page of its own, only
// the master-data sub-pages nested under it. Job is the first; more master
// tables (master_* in the database) join this list as they're built.
const NAV: NavItem[] = [
  { type: 'link', to: '/dashboard', label: 'ภาพรวม', icon: LayoutDashboard },
  { type: 'link', to: '/employees', label: 'พนักงาน', icon: Users },
  {
    type: 'group',
    label: 'Master',
    icon: Database,
    children: [
      { to: '/master/departments', label: 'แผนก (Department)' },
      { to: '/master/jobs', label: 'ตำแหน่งงาน (Job)' },
      { to: '/master/shifts', label: 'กะการทำงาน (Shift)' },
      { to: '/master/locations', label: 'พิกัดอนุญาต (Location)' },
      { to: '/master/leave-types', label: 'ประเภทการลา (Leave Type)' },
      { to: '/master/holidays', label: 'วันหยุด (Holiday)' },
    ],
  },
  {
    type: 'group',
    label: 'การลงเวลา',
    icon: Clock,
    children: [
      { to: '/attendance', label: 'รายละเอียดการลงเวลา'},
      { to: '/time-corrections', label: 'คำขอแก้ไขเวลา'},
      { to: '/shift-change-requests', label: 'คำขอเปลี่ยนกะ'},
      { to: '/day-off-swap-requests', label: 'คำขอสลับวันหยุด'},
    ],
  },
  {
    type: 'group',
    label: 'การลา',
    icon: Clock,
    children: [
      { to: '/leave-requests', label: 'คำขอลา'},
      { to: '/leave-balances/bulk-grant', label: 'ออกสิทธิ์วันลา'},
    ],
  },
  { type: 'link', to: '/health', label: 'สถานะระบบ', icon: Activity },
]

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  [
    'flex flex-none items-center gap-2.5 rounded-md px-3 py-2.5 text-sm transition-colors',
    isActive
      ? 'bg-shell-active font-semibold text-white'
      : 'text-shell-fg-dim hover:bg-white/6 hover:text-shell-fg',
  ].join(' ')

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
  const location = useLocation()

  // MeProvider has already turned "no roles" into its own screen, so anyone
  // rendering here holds at least one.
  const roles = me.kind === 'admin' ? me.roles : []
  const name = me.kind === 'admin' ? me.name : ''
  const upn = me.kind === 'admin' ? me.upn : ''

  // Open by default whenever the current page is one of its children, so a
  // hard refresh on /master/jobs doesn't land on a collapsed group hiding the
  // very page it's showing.
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => {
    const initial = new Set<string>()
    for (const item of NAV) {
      if (
        item.type === 'group' &&
        item.children.some((child) => location.pathname.startsWith(child.to))
      ) {
        initial.add(item.label)
      }
    }
    return initial
  })

  function toggleGroup(label: string) {
    setOpenGroups((prev) => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })
  }

  // Below the `shell` breakpoint the rail has nowhere to stand, so it becomes
  // a collapsible off-canvas drawer instead of falling back to a top bar: a
  // hamburger button opens it over the page, and it closes itself once a link
  // is picked so it never lingers over the page it just navigated to.
  const [mobileOpen, setMobileOpen] = useState(false)

  // Closes on every route change. Adjusted during render (React's documented
  // pattern for resetting state when a prop changes) rather than in an
  // effect, since an effect would commit the still-open drawer for one frame
  // before closing it on the next render.
  const [mobileOpenForPathname, setMobileOpenForPathname] = useState(location.pathname)
  if (location.pathname !== mobileOpenForPathname) {
    setMobileOpenForPathname(location.pathname)
    setMobileOpen(false)
  }

  return (
    <div className="flex flex-1 flex-col shell:flex-row">
      <div
        className="sticky top-0 z-10 flex items-center gap-3 bg-shell px-4 py-3 text-shell-fg
          shell:hidden"
      >
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          aria-label="เปิดเมนู"
          className="grid size-9 flex-none place-items-center rounded-md text-shell-fg-dim
            transition-colors hover:bg-white/6 hover:text-shell-fg"
        >
          <Menu size={20} />
        </button>
        <span className="text-base font-bold tracking-wide text-white">HRM</span>
      </div>

      {mobileOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/40 shell:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* A dark rail against the light content, always a vertical sidebar:
          fixed and off-canvas (slid out via translate-x) below the `shell`
          breakpoint so it can be toggled open over the page, sticky and
          always visible above it. Same markup and order either way — only
          how it's positioned changes. */}
      <aside
        className={`fixed inset-y-0 left-0 z-30 flex w-72 max-w-[85vw] flex-col bg-shell px-3.5
          py-5 text-shell-fg-dim shadow-2xl transition-transform duration-200 ease-out
          shell:sticky shell:top-0 shell:h-svh shell:w-62 shell:flex-none shell:translate-x-0
          shell:px-3.5 shell:py-5 shell:shadow-none
          ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}
      >
        <div className="flex items-center gap-2.5 px-2 pt-1 pb-6">
          <div className="grid size-8 flex-none place-items-center rounded-md bg-white/10 text-shell-fg">
            <Users size={17} />
          </div>
          <div className="flex min-w-0 flex-col leading-tight">
            <span className="text-base font-bold tracking-wide text-white">HRM</span>
            <span className="text-[0.7rem] text-shell-fg-dim">Nanafruit</span>
          </div>
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            aria-label="ปิดเมนู"
            className="ml-auto grid size-8 flex-none place-items-center rounded-md
              text-shell-fg-dim transition-colors hover:bg-white/6 hover:text-shell-fg shell:hidden"
          >
            <X size={18} />
          </button>
        </div>

        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto border-t border-white/10 pt-3">
          <p className="px-3 pb-2 text-[0.65rem] font-semibold tracking-widest
            text-shell-fg-dim/70 uppercase">
            เมนูหลัก
          </p>
          {NAV.map((item) =>
            item.type === 'link' ? (
              <NavLink key={item.to} to={item.to} className={navLinkClass}>
                <item.icon size={17} className="flex-none opacity-90" />
                <span>{item.label}</span>
              </NavLink>
            ) : (
              <div key={item.label} className="flex flex-none flex-col">
                <button
                  type="button"
                  onClick={() => toggleGroup(item.label)}
                  aria-expanded={openGroups.has(item.label)}
                  className="flex flex-none items-center gap-2.5 rounded-md px-3 py-2.5 text-sm
                    text-shell-fg-dim transition-colors hover:bg-white/6 hover:text-shell-fg"
                >
                  <item.icon size={17} className="flex-none opacity-90" />
                  <span>{item.label}</span>
                  <ChevronDown
                    size={15}
                    className={`ml-auto flex-none transition-transform ${
                      openGroups.has(item.label) ? 'rotate-180' : ''
                    }`}
                  />
                </button>
                {openGroups.has(item.label) && (
                  <div className="ml-3.5 flex flex-col gap-0.5 border-l border-white/10 py-0.5 pl-2.5">
                    {item.children.map((child) => (
                      <NavLink key={child.to} to={child.to} className={navLinkClass}>
                        <span>{child.label}</span>
                      </NavLink>
                    ))}
                  </div>
                )}
              </div>
            )
          )}
        </nav>

        <div className="mt-auto flex flex-col items-stretch gap-2.5 border-t border-white/10 pt-4">
          <div className="flex flex-wrap gap-1 px-1">
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
            <div className="flex min-w-0 flex-col leading-tight">
              <span className="truncate text-[0.8rem] font-semibold text-shell-fg">
                {name}
              </span>
              <span className="truncate text-[0.7rem] text-shell-fg-dim">{upn}</span>
            </div>
          </div>

          <button
            type="button"
            className={`${button('ghost')} w-full px-3.5 py-2`}
            // Naming the account for the same reason the API client does: the
            // active one is not guaranteed to be set. The redirect to Entra's
            // end-session endpoint that this would otherwise trigger is
            // suppressed globally — see onRedirectNavigate in msal.ts.
            onClick={() => void instance.logoutRedirect({ account: getSignedInAccount() })}
          >
            <LogOut size={16} />
            <span>ออกจากระบบ</span>
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 bg-slate-100 px-5 py-6 shell:px-10 shell:py-8">
        <Outlet />
      </main>
    </div>
  )
}
