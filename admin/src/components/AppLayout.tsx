import { NavLink, Outlet } from 'react-router-dom'
import { useMsal } from '@azure/msal-react'
import type { Role } from '@hrm/shared'
import { useMe } from '../auth/meContext'
import { getSignedInAccount } from '../auth/msal'

/** Entra's role strings are the contract with Entra; these are for people. */
const ROLE_LABELS: Record<Role, string> = {
  'HRM.Admin': 'ผู้ดูแลระบบ',
  'HRM.HR': 'ฝ่ายบุคคล',
  'HRM.Viewer': 'ผู้ดูข้อมูล',
}

export function AppLayout() {
  const { instance } = useMsal()
  const me = useMe()

  // MeProvider has already turned "no roles" into its own screen, so anyone
  // rendering here holds at least one.
  const roles = me.kind === 'admin' ? me.roles : []

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">HRM</div>
        <nav>
          <NavLink to="/employees">พนักงาน</NavLink>
          <NavLink to="/health">สถานะระบบ</NavLink>
        </nav>

        <div className="account">
          <div className="account-name">{me.kind === 'admin' ? me.name : ''}</div>
          <div className="account-roles">
            {roles.map((role) => (
              <span key={role} className="badge role">
                {ROLE_LABELS[role]}
              </span>
            ))}
          </div>
          <button
            type="button"
            className="button"
            // Naming the account for the same reason the API client does: the
            // active one is not guaranteed to be set.
            onClick={() => void instance.logoutRedirect({ account: getSignedInAccount() })}
          >
            ออกจากระบบ
          </button>
        </div>
      </aside>
      <main className="content">
        <Outlet />
      </main>
    </div>
  )
}
