import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Plus, Search } from 'lucide-react'
import type { Department } from '@hrm/shared'
import { listDepartments, updateDepartment } from '../api/departments'
import { useCanWrite } from '../auth/meContext'
import { notify } from '../notifications/notify'
import {
  alert,
  alertDetail,
  alertTitle,
  badge,
  button,
  cardEmpty,
  eyebrow,
  muted,
  pageHead,
  subtitle,
} from '../styles'

type State =
  | { phase: 'loading' }
  | { phase: 'ok'; departments: Department[] }
  | { phase: 'error'; message: string }

function haystack(department: Department): string {
  return [department.deptCode, department.deptName, department.parentDepartmentName]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

export function DepartmentListPage() {
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [query, setQuery] = useState('')
  const [togglingId, setTogglingId] = useState<number | null>(null)
  const navigate = useNavigate()
  const canWrite = useCanWrite()

  useEffect(() => {
    const controller = new AbortController()

    listDepartments(controller.signal)
      .then((departments) => setState({ phase: 'ok', departments }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'request failed',
        })
      })

    return () => controller.abort()
  }, [])

  const visible = useMemo(() => {
    if (state.phase !== 'ok') return []
    const needle = query.trim().toLowerCase()
    if (!needle) return state.departments
    return state.departments.filter((department) => haystack(department).includes(needle))
  }, [state, query])

  // No delete route: turning a department off is the entire lifecycle a
  // retired department has, so it's one click here rather than a trip
  // through the edit form — same as Job.
  async function toggleActive(department: Department) {
    if (state.phase !== 'ok') return
    setTogglingId(department.id)
    try {
      const updated = await updateDepartment(department.id, {
        deptCode: department.deptCode,
        deptName: department.deptName,
        parentDepartmentId: department.parentDepartmentId,
        isActive: !department.isActive,
      })
      setState({
        phase: 'ok',
        departments: state.departments.map((d) => (d.id === updated.id ? updated : d)),
      })
      notify.success(`${department.deptName} ${updated.isActive ? 'เปิด' : 'ปิด'}ใช้งานแล้ว`)
    } catch (err) {
      notify.error('บันทึกไม่สำเร็จ', err instanceof Error ? err.message : undefined)
    } finally {
      setTogglingId(null)
    }
  }

  return (
    <>
      <header className={pageHead}>
        <div>
          <p className={eyebrow}>Master Data</p>
          <h1>แผนก (Department)</h1>
          <p className={subtitle}>รายการแผนกและหน่วยงานต้นสังกัด</p>
        </div>
        {canWrite && (
          <Link className={button('primary')} to="/master/departments/new">
            <Plus size={16} />
            เพิ่มแผนก
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

      {state.phase === 'ok' && state.departments.length === 0 && (
        <div className={`rounded-lg border border-slate-200 bg-white shadow-sm ${cardEmpty}`}>
          <p className="mb-1.5 font-semibold text-slate-900">ยังไม่มีแผนกในระบบ</p>
          <p className={muted}>
            {canWrite ? 'กด “เพิ่มแผนก” เพื่อเริ่มต้น' : 'สิทธิ์ของคุณดูข้อมูลได้อย่างเดียว'}
          </p>
        </div>
      )}

      {state.phase === 'ok' && state.departments.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 bg-slate-50 px-4 py-3.5">
            <div className="relative flex max-w-88 min-w-0 flex-1 items-center">
              <Search size={15} className="pointer-events-none absolute left-2.5 text-slate-500" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="ค้นหารหัสแผนก ชื่อแผนก หรือหน่วยงานต้นสังกัด"
                aria-label="ค้นหาแผนก"
                className="w-full rounded-md border border-slate-200 bg-white py-2 pr-3 pl-9 text-[0.825rem] text-slate-900 placeholder:text-slate-500"
              />
            </div>
            <p className="text-[0.775rem] whitespace-nowrap text-slate-500 tabular-nums">
              {query.trim()
                ? `พบ ${visible.length} จาก ${state.departments.length} รายการ`
                : `ทั้งหมด ${state.departments.length} รายการ`}
            </p>
          </div>

          {visible.length === 0 ? (
            <div className={cardEmpty}>
              <p className="mb-1.5 font-semibold text-slate-900">ไม่พบแผนกที่ตรงกับคำค้น</p>
              <p className={muted}>ลองใช้คำอื่น หรือล้างช่องค้นหา</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[0.825rem] [&_tbody_tr:last-child_td]:border-b-0">
                <thead>
                  <tr>
                    {['#', 'รหัสแผนก', 'ชื่อแผนก', 'หน่วยงานต้นสังกัด', 'เปิดใช้งาน'].map((h) => (
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
                  {visible.map((department, index) => (
                    <tr key={department.id} className="hover:bg-slate-50">
                      <td
                        onClick={() => void navigate(`/master/departments/${department.id}`)}
                        className="w-12 cursor-pointer border-b border-slate-200 px-4 py-2.5 align-middle text-slate-500"
                      >
                        {index + 1}
                      </td>
                      <td
                        onClick={() => void navigate(`/master/departments/${department.id}`)}
                        className="cursor-pointer border-b border-slate-200 px-4 py-2.5 align-middle font-medium text-slate-900"
                      >
                        {department.deptCode}
                      </td>
                      <td
                        onClick={() => void navigate(`/master/departments/${department.id}`)}
                        className="cursor-pointer border-b border-slate-200 px-4 py-2.5 align-middle text-slate-900"
                      >
                        {department.deptName}
                      </td>
                      <td
                        onClick={() => void navigate(`/master/departments/${department.id}`)}
                        className="cursor-pointer border-b border-slate-200 px-4 py-2.5 align-middle text-slate-600"
                      >
                        {department.parentDepartmentName ?? '—'}
                      </td>
                      <td className="border-b border-slate-200 px-4 py-2.5 align-middle">
                        <button
                          type="button"
                          disabled={!canWrite || togglingId === department.id}
                          onClick={() => void toggleActive(department)}
                          title={canWrite ? 'คลิกเพื่อเปิด/ปิดใช้งาน' : undefined}
                          className={`${badge(department.isActive ? 'active' : 'inactive')} disabled:opacity-60 ${
                            canWrite ? 'cursor-pointer' : 'cursor-default'
                          }`}
                        >
                          {department.isActive ? 'Active' : 'Inactive'}
                        </button>
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
