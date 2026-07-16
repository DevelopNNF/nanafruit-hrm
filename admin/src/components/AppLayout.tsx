import { NavLink, Outlet } from 'react-router-dom'

export function AppLayout() {
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">HRM</div>
        <nav>
          <NavLink to="/employees">พนักงาน</NavLink>
          <NavLink to="/health">สถานะระบบ</NavLink>
        </nav>
      </aside>
      <main className="content">
        <Outlet />
      </main>
    </div>
  )
}
