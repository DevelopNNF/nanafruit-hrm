import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Download, Plus, Upload } from 'lucide-react'
import { type Employee } from '@hrm/shared'
import {
  exportEmployeeFinance,
  exportEmployees,
  exportProductionTracking,
  exportTempWorkerEmployees,
  searchEmployees,
} from '../../api/employees'
import { useCanWrite, useCanWritePayroll } from '../../auth/meContext'
import { notify } from '../../notifications/notify'
import { DropdownMenuButton } from '../../components/DropdownMenuButton'
import { EmployeeFilterBar } from '../../components/EmployeeFilterBar'
import { Pagination } from '../../components/Pagination'
import { useEmployeeFilters } from '../../hooks/useEmployeeFilters'
import { alert, alertDetail, alertTitle, badge, button, cardEmpty, eyebrow, muted, pageHead, subtitle } from '../../styles'

type ExportKind = 'standard' | 'temp_worker'

type State =
  | { phase: 'loading' }
  | { phase: 'ok'; employees: Employee[]; total: number }
  | { phase: 'error'; message: string }

/** Matches the server's own default in employeeQueries.ts. */
const DEFAULT_PAGE_SIZE = 50

export function EmployeeListPage() {
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE)
  // True while a search/filter/page request is in flight — used to disable
  // <Pagination> rather than resetting `state` to 'loading'.
  const [fetching, setFetching] = useState(true)
  const navigate = useNavigate()
  const canWrite = useCanWrite()
  const canWritePayroll = useCanWritePayroll()
  const [exporting, setExporting] = useState(false)
  const [exportingFinance, setExportingFinance] = useState(false)
  const [exportingProductionTracking, setExportingProductionTracking] = useState(false)

  const employeeFilters = useEmployeeFilters({
    // Unlike the other filters, 'Active' rather than 'all' is the default
    // here — HR's day-to-day view of "the employees" is the ones still
    // working.
    defaultStatus: 'Active',
    canWritePayroll,
    onApply: () => {
      setFetching(true)
      setPage(1)
    },
  })

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

  async function handleExportFinance() {
    setExportingFinance(true)
    try {
      const blob = await exportEmployeeFinance()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      const today = new Date().toISOString().slice(0, 10)
      link.download = `employee-finance-${today}.xlsx`
      link.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      notify.error('ส่งออกข้อมูลการเงินไม่สำเร็จ', err instanceof Error ? err.message : undefined)
    } finally {
      setExportingFinance(false)
    }
  }

  async function handleExportProductionTracking() {
    setExportingProductionTracking(true)
    try {
      const blob = await exportProductionTracking()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      const today = new Date().toISOString().slice(0, 10)
      link.download = `production-tracking-${today}.txt`
      link.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      notify.error('ส่งออกข้อมูลสำหรับ Production Tracking System ไม่สำเร็จ', err instanceof Error ? err.message : undefined)
    } finally {
      setExportingProductionTracking(false)
    }
  }

  // No setState({ phase: 'loading' }) at the top: a search/filter/page change
  // just leaves the old table in place until the new one is ready, rather
  // than flashing blank — same reasoning as every other paginated list page.
  useEffect(() => {
    const controller = new AbortController()

    searchEmployees(employeeFilters.filter, { page, pageSize }, controller.signal)
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
  }, [employeeFilters.filter, page, pageSize])

  function goToPage(next: number) {
    setFetching(true)
    setPage(next)
  }

  function handlePageSizeChange(next: number) {
    setFetching(true)
    setPageSize(next)
    setPage(1)
  }

  const filtering = employeeFilters.filtering

  return (
    <>
      <header className={pageHead}>
        <div>
          <p className={eyebrow}>ทะเบียนบุคลากร</p>
          <h1>พนักงาน</h1>
          <p className={subtitle}>ข้อมูลประวัติและสถานะการจ้างงาน</p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          {canWrite && (
            <DropdownMenuButton
              label={
                exporting || exportingFinance || exportingProductionTracking ? 'กำลังส่งออก…' : 'ส่งออก Excel'
              }
              icon={<Download size={16} />}
              disabled={exporting || exportingFinance || exportingProductionTracking}
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
                // เฉพาะฝ่ายเงินเดือน/ผู้ดูแลระบบ — ข้อมูลบัญชีธนาคาร/ภาษี/ประกันสังคม
                // ของพนักงานทุกคนในไฟล์เดียว ไม่ใช่สิ่งที่ HR ทั่วไปควรดึงออกมาได้
                ...(canWritePayroll
                  ? [
                      {
                        label: 'ข้อมูลการเงินพนักงาน (EMP-FIN-IMP)',
                        description: 'ค่าจ้าง ช่องทางจ่ายเงิน ธนาคาร ประกันสังคม ภาษี ของพนักงานทุกคน',
                        onClick: () => void handleExportFinance(),
                      },
                      {
                        label: 'ข้อมูลสำหรับนำเข้า Production Tracking System',
                        description: 'รหัสพนักงาน ชื่อ-นามสกุล ประเภทการจ้าง ค่าจ้าง ของพนักงานที่ยังทำงานอยู่ (.txt)',
                        onClick: () => void handleExportProductionTracking(),
                      },
                    ]
                  : []),
              ]}
            />
          )}
          {canWrite && (
            <Link className={button()} to="/employees/import">
              <Upload size={16} />
              นำเข้า Excel
            </Link>
          )}
          {canWritePayroll && (
            <Link className={button()} to="/employees/finance-import">
              <Upload size={16} />
              นำเข้าข้อมูลการเงิน
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
          <div className="border-b border-slate-200 bg-slate-50 px-4 py-3.5">
            <EmployeeFilterBar {...employeeFilters.barProps} fetching={fetching} />
            <p className="mt-2 w-full text-right text-[0.775rem] whitespace-nowrap text-slate-500 tabular-nums">
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
