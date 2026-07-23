import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Plus, Search } from 'lucide-react'
import type { LeaveType } from '@hrm/shared'
import { listLeaveTypes, updateLeaveType } from '../api/leaveTypes'
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
  | { phase: 'ok'; leaveTypes: LeaveType[] }
  | { phase: 'error'; message: string }

const GENDER_LABELS: Record<LeaveType['gender'], string> = {
  all: 'ทุกเพศ',
  male: 'ชาย',
  female: 'หญิง',
}

function haystack(leaveType: LeaveType): string {
  return [leaveType.leaveCode, leaveType.leaveName].join(' ').toLowerCase()
}

export function LeaveTypeListPage() {
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [query, setQuery] = useState('')
  const [togglingId, setTogglingId] = useState<number | null>(null)
  const navigate = useNavigate()
  const canWrite = useCanWrite()

  useEffect(() => {
    const controller = new AbortController()

    listLeaveTypes(controller.signal)
      .then((leaveTypes) => setState({ phase: 'ok', leaveTypes }))
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
    const matching = needle
      ? state.leaveTypes.filter((lt) => haystack(lt).includes(needle))
      : state.leaveTypes
    return [...matching].sort((a, b) => a.sortOrder - b.sortOrder)
  }, [state, query])

  // No delete route: turning a leave type off is the entire lifecycle a
  // retired type has, same as jobs/shifts/locations.
  async function toggleActive(leaveType: LeaveType) {
    if (state.phase !== 'ok') return
    setTogglingId(leaveType.id)
    try {
      const updated = await updateLeaveType(leaveType.id, {
        ...leaveType,
        isActive: !leaveType.isActive,
      })
      setState({
        phase: 'ok',
        leaveTypes: state.leaveTypes.map((lt) => (lt.id === updated.id ? updated : lt)),
      })
      notify.success(`${leaveType.leaveName} ${updated.isActive ? 'เปิด' : 'ปิด'}ใช้งานแล้ว`)
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
          <h1>ประเภทการลา (Leave Type)</h1>
          <p className={subtitle}>รายการประเภทการลาและเงื่อนไขการลาแต่ละประเภท</p>
        </div>
        {canWrite && (
          <Link className={button('primary')} to="/master/leave-types/new">
            <Plus size={16} />
            เพิ่มประเภทการลา
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

      {state.phase === 'ok' && state.leaveTypes.length === 0 && (
        <div className={`rounded-lg border border-slate-200 bg-white shadow-sm ${cardEmpty}`}>
          <p className="mb-1.5 font-semibold text-slate-900">ยังไม่มีประเภทการลาในระบบ</p>
          <p className={muted}>
            {canWrite ? 'กด “เพิ่มประเภทการลา” เพื่อเริ่มต้น' : 'สิทธิ์ของคุณดูข้อมูลได้อย่างเดียว'}
          </p>
        </div>
      )}

      {state.phase === 'ok' && state.leaveTypes.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 bg-slate-50 px-4 py-3.5">
            <div className="relative flex max-w-88 min-w-0 flex-1 items-center">
              <Search size={15} className="pointer-events-none absolute left-2.5 text-slate-500" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="ค้นหารหัสหรือชื่อประเภทการลา"
                aria-label="ค้นหาประเภทการลา"
                className="w-full rounded-md border border-slate-200 bg-white py-2 pr-3 pl-9 text-[0.825rem] text-slate-900 placeholder:text-slate-500"
              />
            </div>
            <p className="text-[0.775rem] whitespace-nowrap text-slate-500 tabular-nums">
              {query.trim()
                ? `พบ ${visible.length} จาก ${state.leaveTypes.length} รายการ`
                : `ทั้งหมด ${state.leaveTypes.length} รายการ`}
            </p>
          </div>

          {visible.length === 0 ? (
            <div className={cardEmpty}>
              <p className="mb-1.5 font-semibold text-slate-900">ไม่พบประเภทการลาที่ตรงกับคำค้น</p>
              <p className={muted}>ลองใช้คำอื่น หรือล้างช่องค้นหา</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[0.825rem] [&_tbody_tr:last-child_td]:border-b-0">
                <thead>
                  <tr>
                    {['#', 'รหัส', 'ชื่อประเภทการลา', 'จ่ายค่าจ้าง', 'เพศ', 'เปิดใช้งาน'].map((h) => (
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
                  {visible.map((leaveType, index) => (
                    <tr key={leaveType.id} className="hover:bg-slate-50">
                      <td
                        onClick={() => void navigate(`/master/leave-types/${leaveType.id}`)}
                        className="w-12 cursor-pointer border-b border-slate-200 px-4 py-2.5 align-middle text-slate-500"
                      >
                        {index + 1}
                      </td>
                      <td
                        onClick={() => void navigate(`/master/leave-types/${leaveType.id}`)}
                        className="cursor-pointer border-b border-slate-200 px-4 py-2.5 align-middle font-mono text-[0.775rem] text-slate-600"
                      >
                        {leaveType.leaveCode}
                      </td>
                      <td
                        onClick={() => void navigate(`/master/leave-types/${leaveType.id}`)}
                        className="cursor-pointer border-b border-slate-200 px-4 py-2.5 align-middle font-medium text-slate-900"
                      >
                        {leaveType.leaveName}
                      </td>
                      <td className="border-b border-slate-200 px-4 py-2.5 align-middle">
                        <span className={badge(leaveType.isPaid ? 'active' : 'inactive')}>
                          {leaveType.isPaid ? 'จ่าย' : 'ไม่จ่าย'}
                        </span>
                      </td>
                      <td className="border-b border-slate-200 px-4 py-2.5 align-middle text-slate-600">
                        {GENDER_LABELS[leaveType.gender]}
                      </td>
                      <td className="border-b border-slate-200 px-4 py-2.5 align-middle">
                        <button
                          type="button"
                          disabled={!canWrite || togglingId === leaveType.id}
                          onClick={() => void toggleActive(leaveType)}
                          title={canWrite ? 'คลิกเพื่อเปิด/ปิดใช้งาน' : undefined}
                          className={`${badge(leaveType.isActive ? 'active' : 'inactive')} disabled:opacity-60 ${
                            canWrite ? 'cursor-pointer' : 'cursor-default'
                          }`}
                        >
                          {leaveType.isActive ? 'Active' : 'Inactive'}
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
