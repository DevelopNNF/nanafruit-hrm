import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Download, Plus, Search, Upload } from 'lucide-react'
import type { PayrollGroup, Employee } from '@hrm/shared'
import { exportEmployees, exportTempWorkerEmployees, searchEmployees } from '../../api/employees'
import { listPayrollGroups } from '../../api/payrollGroups'
import { useCanWrite } from '../../auth/meContext'
import { notify } from '../../notifications/notify'
import { DropdownMenuButton } from '../../components/DropdownMenuButton'
import { Pagination } from '../../components/Pagination'
import { alert, alertDetail, alertTitle, badge, button, cardEmpty, eyebrow, fieldControl, muted, pageHead, subtitle } from '../../styles'

type ExportKind = 'standard' | 'temp_worker'

/** The payroll-group filter's own value space: a group id, everybody, or the
 *  people no group covers — which during the parallel run with the previous
 *  HRM is the set HR is working through, and the reason this filter exists. */
type GroupFilter = 'all' | 'none' | number

type State =
  | { phase: 'loading' }
  | { phase: 'ok'; employees: Employee[]; total: number }
  | { phase: 'error'; message: string }

/** Matches the server's own default in employeeQueries.ts. */
const DEFAULT_PAGE_SIZE = 50

export function EmployeeListPage() {
  const [state, setState] = useState<State>({ phase: 'loading' })
  // `query` tracks the search box as the user types; `appliedQuery` is what
  // was last submitted and is the only one the fetch effect depends on — so
  // typing no longer fires a request until ค้นหา is pressed (or Enter).
  const [query, setQuery] = useState('')
  const [appliedQuery, setAppliedQuery] = useState('')
  const [payrollGroups, setPayrollGroups] = useState<PayrollGroup[]>([])
  const [groupFilter, setGroupFilter] = useState<GroupFilter>('all')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE)
  // True while a search/filter/page request is in flight — used to disable
  // <Pagination> rather than resetting `state` to 'loading'.
  const [fetching, setFetching] = useState(true)
  const navigate = useNavigate()
  const canWrite = useCanWrite()
  const [exporting, setExporting] = useState(false)

  async function handleExport(kind: ExportKind) {
    setExporting(true)
    try {
      const blob = kind === 'standard' ? await exportEmployees() : await exportTempWorkerEmployees()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      const today = new Date().toISOString().slice(0, 10)
      link.download = kind === 'standard' ? `employees-${today}.xlsx` : `employees-temp-worker-${today}.xlsx`
      link.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      notify.error('ส่งออกข้อมูลไม่สำเร็จ', err instanceof Error ? err.message : undefined)
    } finally {
      setExporting(false)
    }
  }

  useEffect(() => {
    const controller = new AbortController()
    listPayrollGroups(controller.signal)
      .then(setPayrollGroups)
      .catch(() => {
        // Only used to label a filter — not worth failing the whole page over.
      })
    return () => controller.abort()
  }, [])

  // No setState({ phase: 'loading' }) at the top: a search/filter/page change
  // just leaves the old table in place until the new one is ready, rather
  // than flashing blank — same reasoning as every other paginated list page.
  useEffect(() => {
    const controller = new AbortController()

    searchEmployees(
      {
        ...(appliedQuery.trim() !== '' && { query: appliedQuery.trim() }),
        ...(groupFilter !== 'all' && { payrollGroupId: groupFilter }),
      },
      { page, pageSize },
      controller.signal
    )
      .then((body) => {
        setState({ phase: 'ok', employees: body.employees, total: body.total })
        setFetching(false)
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'request failed',
        })
        setFetching(false)
      })

    return () => controller.abort()
  }, [appliedQuery, groupFilter, page, pageSize])

  function handleSearchSubmit(e: FormEvent) {
    e.preventDefault()
    setFetching(true)
    setAppliedQuery(query)
    setPage(1)
  }

  function handleGroupFilterChange(value: GroupFilter) {
    setFetching(true)
    setGroupFilter(value)
    setPage(1)
  }

  function goToPage(next: number) {
    setFetching(true)
    setPage(next)
  }

  function handlePageSizeChange(next: number) {
    setFetching(true)
    setPageSize(next)
    setPage(1)
  }

  const filtering = appliedQuery.trim() !== '' || groupFilter !== 'all'

  return (
    <>
      <header className={pageHead}>
        <div>
          <p className={eyebrow}>ทะเบียนบุคลากร</p>
          <h1>พนักงาน</h1>
          <p className={subtitle}>ข้อมูลประวัติและสถานะการจ้างงาน</p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <DropdownMenuButton
            label={exporting ? 'กำลังส่งออก…' : 'ส่งออก Excel'}
            icon={<Download size={16} />}
            disabled={exporting}
            items={[
              {
                label: 'พนักงานทั่วไป (EMP-IMP)',
                description: 'พนักงานทุกคน ตามเทมเพลตข้อมูลพนักงานมาตรฐาน',
                onClick: () => void handleExport('standard'),
              },
              {
                label: 'พนักงานรายวันชั่วคราว (TEMP-EMP-IMP)',
                description: 'เฉพาะพนักงานประเภท “ชั่วคราว” ตามเทมเพลตพนักงานรายวันชั่วคราว',
                onClick: () => void handleExport('temp_worker'),
              },
            ]}
          />
          {canWrite && (
            <Link className={button()} to="/employees/import">
              <Upload size={16} />
              นำเข้า Excel
            </Link>
          )}
          {canWrite && (
            <Link className={button('primary')} to="/employees/new">
              <Plus size={16} />
              เพิ่มพนักงาน
            </Link>
          )}
        </div>
      </header>

      {state.phase === 'loading' && <p className={muted}>กำลังโหลด…</p>}

      {state.phase === 'error' && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>โหลดข้อมูลไม่สำเร็จ</p>
          <p className={alertDetail}>{state.message}</p>
        </div>
      )}

      {state.phase === 'ok' && state.total === 0 && !filtering && (
        <div className={`rounded-lg border border-slate-200 bg-white shadow-sm ${cardEmpty}`}>
          <p className="mb-1.5 font-semibold text-slate-900">ยังไม่มีพนักงานในระบบ</p>
          <p className={muted}>
            {canWrite ? 'กด “เพิ่มพนักงาน” เพื่อเริ่มต้น' : 'สิทธิ์ของคุณดูข้อมูลได้อย่างเดียว'}
          </p>
        </div>
      )}

      {state.phase === 'ok' && (state.total > 0 || filtering) && (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 bg-slate-50 px-4 py-3.5">
            <form onSubmit={handleSearchSubmit} className="flex max-w-108 min-w-0 flex-1 items-center gap-2">
              <div className="relative flex min-w-0 flex-1 items-center">
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
              <button type="submit" className={button('default')} disabled={fetching}>
                ค้นหา
              </button>
            </form>
            <label className="flex min-w-0 items-center gap-2 text-xs font-medium text-slate-600">
              <span className="whitespace-nowrap">กลุ่มเงินเดือน</span>
              <select
                className={`${fieldControl} max-w-52`}
                value={typeof groupFilter === 'number' ? String(groupFilter) : groupFilter}
                onChange={(e) => {
                  const value = e.target.value
                  handleGroupFilterChange(value === 'all' || value === 'none' ? value : Number(value))
                }}
              >
                <option value="all">— ทั้งหมด —</option>
                <option value="none">ยังไม่อยู่กลุ่มใด</option>
                {payrollGroups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.groupName}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-[0.775rem] whitespace-nowrap text-slate-500 tabular-nums">
              {filtering ? `พบ ${state.total} คน` : `ทั้งหมด ${state.total} คน`}
            </p>
          </div>

          {state.employees.length === 0 ? (
            // Not a bordered card: this already sits inside the bordered
            // container above — a second border would box the message twice.
            <div className={cardEmpty}>
              <p className="mb-1.5 font-semibold text-slate-900">ไม่พบพนักงานที่ตรงกับเงื่อนไข</p>
              <p className={muted}>ลองใช้คำอื่น ล้างช่องค้นหา หรือเปลี่ยนตัวกรองกลุ่มเงินเดือน</p>
            </div>
          ) : (
            <>
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
                    {state.employees.map((employee) => (
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

              <Pagination
                page={page}
                pageSize={pageSize}
                totalItems={state.total}
                onPageChange={goToPage}
                onPageSizeChange={handlePageSizeChange}
                disabled={fetching}
              />
            </>
          )}
        </div>
      )}
    </>
  )
}
