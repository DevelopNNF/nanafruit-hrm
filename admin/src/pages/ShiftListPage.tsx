import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Plus, Search } from 'lucide-react'
import { WORKDAYS, type Shift } from '@hrm/shared'
import { listShifts, updateShift } from '../api/shifts'
import { computeWorkMinutes, formatWorkMinutes } from '../shiftHours'
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
  | { phase: 'ok'; shifts: Shift[] }
  | { phase: 'error'; message: string }

/** Short glyph per day, for a workdays cell that has to fit a table column. */
const SHORT_LABEL: Record<(typeof WORKDAYS)[number]['key'], string> = {
  mon: 'จ',
  tue: 'อ',
  wed: 'พ',
  thu: 'พฤ',
  fri: 'ศ',
  sat: 'ส',
  sun: 'อา',
}

function formatWorkdays(mask: number): string {
  const days = WORKDAYS.filter((day) => (mask & day.bit) !== 0).map((day) => SHORT_LABEL[day.key])
  return days.length > 0 ? days.join(' ') : '—'
}

/** 'HH:MM:SS' -> 'HH:MM'; drop the seconds a round-trip through Postgres adds. */
function formatTime(time: string): string {
  return time.slice(0, 5)
}

function haystack(shift: Shift): string {
  return [shift.shiftCode, shift.shiftName].filter(Boolean).join(' ').toLowerCase()
}

export function ShiftListPage() {
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [query, setQuery] = useState('')
  const [togglingId, setTogglingId] = useState<number | null>(null)
  const navigate = useNavigate()
  const canWrite = useCanWrite()

  useEffect(() => {
    const controller = new AbortController()

    listShifts(controller.signal)
      .then((shifts) => setState({ phase: 'ok', shifts }))
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
    if (!needle) return state.shifts
    return state.shifts.filter((shift) => haystack(shift).includes(needle))
  }, [state, query])

  // No delete route: turning a shift off is the entire lifecycle a retired
  // shift has, so it's one click here rather than a trip through the edit form.
  async function toggleActive(shift: Shift) {
    if (state.phase !== 'ok') return
    setTogglingId(shift.id)
    try {
      const updated = await updateShift(shift.id, {
        shiftCode: shift.shiftCode,
        shiftName: shift.shiftName,
        shiftStartTime: shift.shiftStartTime,
        shiftEndTime: shift.shiftEndTime,
        breakStartTime: shift.breakStartTime,
        breakEndTime: shift.breakEndTime,
        workdays: shift.workdays,
        isActive: !shift.isActive,
      })
      setState({
        phase: 'ok',
        shifts: state.shifts.map((s) => (s.id === updated.id ? updated : s)),
      })
      notify.success(`${shift.shiftName} ${updated.isActive ? 'เปิด' : 'ปิด'}ใช้งานแล้ว`)
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
          <h1>กะการทำงาน (Shift)</h1>
          <p className={subtitle}>รายการกะการทำงานและวันที่ปฏิบัติงาน</p>
        </div>
        {canWrite && (
          <Link className={button('primary')} to="/master/shifts/new">
            <Plus size={16} />
            เพิ่มกะการทำงาน
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

      {state.phase === 'ok' && state.shifts.length === 0 && (
        <div className={`rounded-lg border border-slate-200 bg-white shadow-sm ${cardEmpty}`}>
          <p className="mb-1.5 font-semibold text-slate-900">ยังไม่มีกะการทำงานในระบบ</p>
          <p className={muted}>
            {canWrite ? 'กด “เพิ่มกะการทำงาน” เพื่อเริ่มต้น' : 'สิทธิ์ของคุณดูข้อมูลได้อย่างเดียว'}
          </p>
        </div>
      )}

      {state.phase === 'ok' && state.shifts.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 bg-slate-50 px-4 py-3.5">
            <div className="relative flex max-w-88 min-w-0 flex-1 items-center">
              <Search size={15} className="pointer-events-none absolute left-2.5 text-slate-500" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="ค้นหารหัสหรือชื่อกะ"
                aria-label="ค้นหากะการทำงาน"
                className="w-full rounded-md border border-slate-200 bg-white py-2 pr-3 pl-9 text-[0.825rem] text-slate-900 placeholder:text-slate-500"
              />
            </div>
            <p className="text-[0.775rem] whitespace-nowrap text-slate-500 tabular-nums">
              {query.trim()
                ? `พบ ${visible.length} จาก ${state.shifts.length} รายการ`
                : `ทั้งหมด ${state.shifts.length} รายการ`}
            </p>
          </div>

          {visible.length === 0 ? (
            <div className={cardEmpty}>
              <p className="mb-1.5 font-semibold text-slate-900">ไม่พบกะการทำงานที่ตรงกับคำค้น</p>
              <p className={muted}>ลองใช้คำอื่น หรือล้างช่องค้นหา</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[0.825rem] [&_tbody_tr:last-child_td]:border-b-0">
                <thead>
                  <tr>
                    {[
                      '#',
                      'Shift Code',
                      'Shift Name',
                      'เวลาเข้า-ออกกะ',
                      'ชั่วโมงทำงาน',
                      'วันทำงาน',
                      'เปิดใช้งาน',
                    ].map(
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
                  {visible.map((shift, index) => {
                    const workMinutes = computeWorkMinutes(shift)
                    return (
                    <tr key={shift.id} className="hover:bg-slate-50">
                      <td
                        onClick={() => void navigate(`/master/shifts/${shift.id}`)}
                        className="w-12 cursor-pointer border-b border-slate-200 px-4 py-2.5 align-middle text-slate-500"
                      >
                        {index + 1}
                      </td>
                      <td
                        onClick={() => void navigate(`/master/shifts/${shift.id}`)}
                        className="cursor-pointer border-b border-slate-200 px-4 py-2.5 align-middle font-medium text-slate-900"
                      >
                        {shift.shiftCode}
                      </td>
                      <td
                        onClick={() => void navigate(`/master/shifts/${shift.id}`)}
                        className="cursor-pointer border-b border-slate-200 px-4 py-2.5 align-middle text-slate-600"
                      >
                        {shift.shiftName}
                      </td>
                      <td
                        onClick={() => void navigate(`/master/shifts/${shift.id}`)}
                        className="cursor-pointer border-b border-slate-200 px-4 py-2.5 align-middle text-slate-600 whitespace-nowrap tabular-nums"
                      >
                        {formatTime(shift.shiftStartTime)} - {formatTime(shift.shiftEndTime)}
                      </td>
                      <td
                        onClick={() => void navigate(`/master/shifts/${shift.id}`)}
                        className="cursor-pointer border-b border-slate-200 px-4 py-2.5 align-middle text-slate-600 whitespace-nowrap tabular-nums"
                      >
                        {workMinutes === null ? '—' : formatWorkMinutes(workMinutes)}
                      </td>
                      <td
                        onClick={() => void navigate(`/master/shifts/${shift.id}`)}
                        className="cursor-pointer border-b border-slate-200 px-4 py-2.5 align-middle text-slate-600 whitespace-nowrap"
                      >
                        {formatWorkdays(shift.workdays)}
                      </td>
                      <td className="border-b border-slate-200 px-4 py-2.5 align-middle">
                        <button
                          type="button"
                          disabled={!canWrite || togglingId === shift.id}
                          onClick={() => void toggleActive(shift)}
                          title={canWrite ? 'คลิกเพื่อเปิด/ปิดใช้งาน' : undefined}
                          className={`${badge(shift.isActive ? 'active' : 'inactive')} disabled:opacity-60 ${
                            canWrite ? 'cursor-pointer' : 'cursor-default'
                          }`}
                        >
                          {shift.isActive ? 'Active' : 'Inactive'}
                        </button>
                      </td>
                    </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </>
  )
}
