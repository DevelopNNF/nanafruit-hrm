import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Plus, Search } from 'lucide-react'
import type { Employee } from '@hrm/shared'
import { listEmployees } from '../api/employees'
import { useCanWrite } from '../auth/meContext'
import { alert, alertDetail, alertTitle, badge, button, cardEmpty, eyebrow, muted, pageHead, subtitle } from '../styles'

type State =
  | { phase: 'loading' }
  | { phase: 'ok'; employees: Employee[] }
  | { phase: 'error'; message: string }

/** Every field a person might type into the box, as one lowercased haystack. */
function haystack(employee: Employee): string {
  return [
    employee.employeeCode,
    employee.firstNameTh,
    employee.lastNameTh,
    employee.firstNameEn,
    employee.lastNameEn,
    employee.nickname,
    employee.employment.jobTitle,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

export function EmployeeListPage() {
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [query, setQuery] = useState('')
  const navigate = useNavigate()
  const canWrite = useCanWrite()

  useEffect(() => {
    const controller = new AbortController()

    listEmployees(controller.signal)
      .then((employees) => setState({ phase: 'ok', employees }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'request failed',
        })
      })

    return () => controller.abort()
  }, [])

  // Filtered in the browser against the list already fetched — the same reason
  // the dashboard counts here rather than asking the server.
  const visible = useMemo(() => {
    if (state.phase !== 'ok') return []
    const needle = query.trim().toLowerCase()
    if (!needle) return state.employees
    return state.employees.filter((employee) => haystack(employee).includes(needle))
  }, [state, query])

  return (
    <>
      <header className={pageHead}>
        <div>
          <p className={eyebrow}>ทะเบียนบุคลากร</p>
          <h1>พนักงาน</h1>
          <p className={subtitle}>ข้อมูลประวัติและสถานะการจ้างงาน</p>
        </div>
        {canWrite && (
          <Link className={button('primary')} to="/employees/new">
            <Plus size={16} />
            เพิ่มพนักงาน
          </Link>
        )}
      </header>

      {state.phase === 'loading' && <p className={muted}>กำลังโหลด…</p>}

      {state.phase === 'error' && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>โหลดข้อมูลไม่สำเร็จ</p>
          <p className={alertDetail}>{state.message}</p>
        </div>
      )}

      {state.phase === 'ok' && state.employees.length === 0 && (
        <div className={`rounded-lg border border-slate-200 bg-white shadow-sm ${cardEmpty}`}>
          <p className="mb-1.5 font-semibold text-slate-900">ยังไม่มีพนักงานในระบบ</p>
          <p className={muted}>
            {canWrite ? 'กด “เพิ่มพนักงาน” เพื่อเริ่มต้น' : 'สิทธิ์ของคุณดูข้อมูลได้อย่างเดียว'}
          </p>
        </div>
      )}

      {state.phase === 'ok' && state.employees.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 bg-slate-50 px-4 py-3.5">
            <div className="relative flex max-w-88 min-w-0 flex-1 items-center">
              <Search size={15} className="pointer-events-none absolute left-2.5 text-slate-500" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="ค้นหา รหัส ชื่อ ชื่อเล่น หรือตำแหน่ง"
                aria-label="ค้นหาพนักงาน"
                className="w-full rounded-md border border-slate-200 bg-white py-2 pr-3 pl-9 text-[0.825rem] text-slate-900 placeholder:text-slate-500"
              />
            </div>
            <p className="text-[0.775rem] whitespace-nowrap text-slate-500 tabular-nums">
              {query.trim()
                ? `พบ ${visible.length} จาก ${state.employees.length} คน`
                : `ทั้งหมด ${state.employees.length} คน`}
            </p>
          </div>

          {visible.length === 0 ? (
            // Not a bordered card: this already sits inside the bordered
            // container above — a second border would box the message twice.
            <div className={cardEmpty}>
              <p className="mb-1.5 font-semibold text-slate-900">ไม่พบพนักงานที่ตรงกับคำค้น</p>
              <p className={muted}>ลองใช้คำอื่น หรือล้างช่องค้นหา</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[0.825rem] [&_tbody_tr:last-child_td]:border-b-0">
                <thead>
                  <tr>
                    {['รหัส', 'ชื่อ-นามสกุล', 'ชื่อเล่น', 'ตำแหน่ง', 'ประเภท', 'สถานะ'].map((h) => (
                      <th
                        key={h}
                        className="border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-left text-[0.675rem] font-semibold tracking-wider text-slate-500 uppercase whitespace-nowrap"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((employee) => (
                    <tr
                      key={employee.id}
                      onClick={() => void navigate(`/employees/${employee.id}`)}
                      className="cursor-pointer hover:bg-slate-50"
                    >
                      <td className="border-b border-slate-200 px-4 py-2.5 align-middle font-mono text-[0.775rem] text-slate-600">
                        {employee.employeeCode}
                      </td>
                      <td className="border-b border-slate-200 px-4 py-2.5 align-middle text-slate-900">
                        {employee.title}
                        {employee.firstNameTh} {employee.lastNameTh}
                        <span className="block text-xs text-slate-500">
                          {employee.firstNameEn} {employee.lastNameEn}
                        </span>
                      </td>
                      <td className="border-b border-slate-200 px-4 py-2.5 align-middle text-slate-900">
                        {employee.nickname ?? '—'}
                      </td>
                      <td className="border-b border-slate-200 px-4 py-2.5 align-middle text-slate-900">
                        {employee.employment.jobTitle}
                      </td>
                      <td className="border-b border-slate-200 px-4 py-2.5 align-middle text-slate-900">
                        {employee.employment.employmentType}
                      </td>
                      <td className="border-b border-slate-200 px-4 py-2.5 align-middle">
                        <span
                          className={badge(
                            employee.employment.status === 'Active' ? 'active' : 'inactive'
                          )}
                        >
                          {employee.employment.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </>
  )
}
