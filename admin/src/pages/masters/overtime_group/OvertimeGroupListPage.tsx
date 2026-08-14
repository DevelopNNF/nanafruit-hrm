import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Plus, Search } from 'lucide-react'
import type { OvertimeGroup } from '@hrm/shared'
import { listOvertimeGroups, updateOvertimeGroup } from '../../../api/overtimeGroups'
import { useCanWrite } from '../../../auth/meContext'
import { notify } from '../../../notifications/notify'
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
} from '../../../styles'

type State =
  | { phase: 'loading' }
  | { phase: 'ok'; overtimeGroups: OvertimeGroup[] }
  | { phase: 'error'; message: string }

function haystack(group: OvertimeGroup): string {
  return [group.groupCode, group.groupName].join(' ').toLowerCase()
}

export function OvertimeGroupListPage() {
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [query, setQuery] = useState('')
  const [togglingId, setTogglingId] = useState<number | null>(null)
  const navigate = useNavigate()
  const canWrite = useCanWrite()

  useEffect(() => {
    const controller = new AbortController()

    listOvertimeGroups(controller.signal)
      .then((overtimeGroups) => setState({ phase: 'ok', overtimeGroups }))
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
    if (!needle) return state.overtimeGroups
    return state.overtimeGroups.filter((group) => haystack(group).includes(needle))
  }, [state, query])

  // No delete route: turning a group off is the entire lifecycle a retired
  // group has, same as jobs/shifts/locations/leave types/holiday groups.
  async function toggleActive(group: OvertimeGroup) {
    if (state.phase !== 'ok') return
    setTogglingId(group.id)
    try {
      const updated = await updateOvertimeGroup(group.id, { ...group, isActive: !group.isActive })
      setState({
        phase: 'ok',
        overtimeGroups: state.overtimeGroups.map((g) => (g.id === updated.id ? updated : g)),
      })
      notify.success(`${group.groupName} ${updated.isActive ? 'เปิด' : 'ปิด'}ใช้งานแล้ว`)
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
          <h1>กลุ่มการทำงานล่วงเวลา (Overtime Group)</h1>
          <p className={subtitle}>กลุ่มอัตราค่าล่วงเวลาและการปัดเศษเวลาแต่ละกลุ่ม</p>
        </div>
        {canWrite && (
          <Link className={button('primary')} to="/master/overtime-groups/new">
            <Plus size={16} />
            เพิ่มกลุ่มการทำงานล่วงเวลา
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

      {state.phase === 'ok' && state.overtimeGroups.length === 0 && (
        <div className={`rounded-lg border border-slate-200 bg-white shadow-sm ${cardEmpty}`}>
          <p className="mb-1.5 font-semibold text-slate-900">ยังไม่มีกลุ่มการทำงานล่วงเวลาในระบบ</p>
          <p className={muted}>
            {canWrite ? 'กด “เพิ่มกลุ่มการทำงานล่วงเวลา” เพื่อเริ่มต้น' : 'สิทธิ์ของคุณดูข้อมูลได้อย่างเดียว'}
          </p>
        </div>
      )}

      {state.phase === 'ok' && state.overtimeGroups.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 bg-slate-50 px-4 py-3.5">
            <div className="relative flex max-w-88 min-w-0 flex-1 items-center">
              <Search size={15} className="pointer-events-none absolute left-2.5 text-slate-500" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="ค้นหารหัสหรือชื่อกลุ่ม"
                aria-label="ค้นหากลุ่มการทำงานล่วงเวลา"
                className="w-full rounded-md border border-slate-200 bg-white py-2 pr-3 pl-9 text-[0.825rem] text-slate-900 placeholder:text-slate-500"
              />
            </div>
            <p className="text-[0.775rem] whitespace-nowrap text-slate-500 tabular-nums">
              {query.trim()
                ? `พบ ${visible.length} จาก ${state.overtimeGroups.length} รายการ`
                : `ทั้งหมด ${state.overtimeGroups.length} รายการ`}
            </p>
          </div>

          {visible.length === 0 ? (
            <div className={cardEmpty}>
              <p className="mb-1.5 font-semibold text-slate-900">ไม่พบกลุ่มที่ตรงกับคำค้น</p>
              <p className={muted}>ลองใช้คำอื่น หรือล้างช่องค้นหา</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[0.825rem] [&_tbody_tr:last-child_td]:border-b-0">
                <thead>
                  <tr>
                    {['#', 'รหัส', 'ชื่อกลุ่ม', 'OT วันทำงาน', 'OT วันหยุด', 'การปัดเศษ', 'เปิดใช้งาน'].map(
                      (h) => (
                        <th
                          key={h}
                          className="border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-left text-[0.675rem] font-semibold tracking-wider text-slate-500 uppercase whitespace-nowrap"
                        >
                          {h}
                        </th>
                      )
                    )}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((group, index) => (
                    <tr key={group.id} className="hover:bg-slate-50">
                      <td
                        onClick={() => void navigate(`/master/overtime-groups/${group.id}`)}
                        className="w-12 cursor-pointer border-b border-slate-200 px-4 py-2.5 align-middle text-slate-500"
                      >
                        {index + 1}
                      </td>
                      <td
                        onClick={() => void navigate(`/master/overtime-groups/${group.id}`)}
                        className="cursor-pointer border-b border-slate-200 px-4 py-2.5 align-middle font-mono text-[0.775rem] text-slate-600"
                      >
                        {group.groupCode}
                      </td>
                      <td
                        onClick={() => void navigate(`/master/overtime-groups/${group.id}`)}
                        className="cursor-pointer border-b border-slate-200 px-4 py-2.5 align-middle font-medium text-slate-900"
                      >
                        {group.groupName}
                      </td>
                      <td className="border-b border-slate-200 px-4 py-2.5 align-middle text-slate-600 tabular-nums">
                        x{group.rateOtWorkday}
                      </td>
                      <td className="border-b border-slate-200 px-4 py-2.5 align-middle text-slate-600 tabular-nums">
                        x{group.rateOtHoliday}
                      </td>
                      <td className="border-b border-slate-200 px-4 py-2.5 align-middle text-slate-600">
                        {group.roundingMinutes === 0 ? 'ไม่ปัด' : `${group.roundingMinutes} นาที`}
                      </td>
                      <td className="border-b border-slate-200 px-4 py-2.5 align-middle">
                        <button
                          type="button"
                          disabled={!canWrite || togglingId === group.id}
                          onClick={() => void toggleActive(group)}
                          title={canWrite ? 'คลิกเพื่อเปิด/ปิดใช้งาน' : undefined}
                          className={`${badge(group.isActive ? 'active' : 'inactive')} disabled:opacity-60 ${
                            canWrite ? 'cursor-pointer' : 'cursor-default'
                          }`}
                        >
                          {group.isActive ? 'Active' : 'Inactive'}
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
