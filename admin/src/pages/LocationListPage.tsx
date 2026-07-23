import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Plus, Search } from 'lucide-react'
import type { Location } from '@hrm/shared'
import { listLocations, updateLocation } from '../api/locations'
import { useIsAdmin } from '../auth/meContext'
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
  | { phase: 'ok'; locations: Location[] }
  | { phase: 'error'; message: string }

function haystack(location: Location): string {
  return location.locationName.toLowerCase()
}

export function LocationListPage() {
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [query, setQuery] = useState('')
  const [togglingId, setTogglingId] = useState<number | null>(null)
  const navigate = useNavigate()
  // Admin-only, not useCanWrite: a wrong radius here is a security control
  // (who may clock in from where), not a scheduling detail like Job/Shift.
  const isAdmin = useIsAdmin()

  useEffect(() => {
    const controller = new AbortController()

    listLocations(controller.signal)
      .then((locations) => setState({ phase: 'ok', locations }))
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
    if (!needle) return state.locations
    return state.locations.filter((location) => haystack(location).includes(needle))
  }, [state, query])

  // No delete route: turning a location off is the entire lifecycle a
  // retired location has, matching master_shifts/master_jobs.
  async function toggleActive(location: Location) {
    if (state.phase !== 'ok') return
    setTogglingId(location.id)
    try {
      const updated = await updateLocation(location.id, {
        locationName: location.locationName,
        latitude: location.latitude,
        longitude: location.longitude,
        radiusMeters: location.radiusMeters,
        isActive: !location.isActive,
      })
      setState({
        phase: 'ok',
        locations: state.locations.map((l) => (l.id === updated.id ? updated : l)),
      })
      notify.success(`${location.locationName} ${updated.isActive ? 'เปิด' : 'ปิด'}ใช้งานแล้ว`)
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
          <h1>พิกัดอนุญาตให้ลงเวลา (Location)</h1>
          <p className={subtitle}>จุดที่พนักงานสามารถลงเวลาเข้า-ออกงานได้ และขอบเขตระยะทางที่อนุญาต</p>
        </div>
        {isAdmin && (
          <Link className={button('primary')} to="/master/locations/new">
            <Plus size={16} />
            เพิ่มพิกัด
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

      {state.phase === 'ok' && state.locations.length === 0 && (
        <div className={`rounded-lg border border-slate-200 bg-white shadow-sm ${cardEmpty}`}>
          <p className="mb-1.5 font-semibold text-slate-900">ยังไม่มีพิกัดในระบบ</p>
          <p className={muted}>
            {isAdmin
              ? 'กด "เพิ่มพิกัด" เพื่อเริ่มต้น — ก่อนตั้งค่าอย่างน้อย 1 จุด พนักงานลงเวลาผ่าน LIFF ได้ตามปกติโดยไม่ตรวจพิกัด'
              : 'สิทธิ์ของคุณดูข้อมูลได้อย่างเดียว'}
          </p>
        </div>
      )}

      {state.phase === 'ok' && state.locations.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 bg-slate-50 px-4 py-3.5">
            <div className="relative flex max-w-88 min-w-0 flex-1 items-center">
              <Search size={15} className="pointer-events-none absolute left-2.5 text-slate-500" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="ค้นหาชื่อพิกัด"
                aria-label="ค้นหาพิกัด"
                className="w-full rounded-md border border-slate-200 bg-white py-2 pr-3 pl-9 text-[0.825rem] text-slate-900 placeholder:text-slate-500"
              />
            </div>
            <p className="text-[0.775rem] whitespace-nowrap text-slate-500 tabular-nums">
              {query.trim()
                ? `พบ ${visible.length} จาก ${state.locations.length} รายการ`
                : `ทั้งหมด ${state.locations.length} รายการ`}
            </p>
          </div>

          {visible.length === 0 ? (
            <div className={cardEmpty}>
              <p className="mb-1.5 font-semibold text-slate-900">ไม่พบพิกัดที่ตรงกับคำค้น</p>
              <p className={muted}>ลองใช้คำอื่น หรือล้างช่องค้นหา</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[0.825rem] [&_tbody_tr:last-child_td]:border-b-0">
                <thead>
                  <tr>
                    {['#', 'ชื่อพิกัด', 'ละติจูด, ลองจิจูด', 'ขอบเขต (ม.)', 'เปิดใช้งาน'].map((h) => (
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
                  {visible.map((location, index) => (
                    <tr key={location.id} className="hover:bg-slate-50">
                      <td
                        onClick={() => void navigate(`/master/locations/${location.id}`)}
                        className="w-12 cursor-pointer border-b border-slate-200 px-4 py-2.5 align-middle text-slate-500"
                      >
                        {index + 1}
                      </td>
                      <td
                        onClick={() => void navigate(`/master/locations/${location.id}`)}
                        className="cursor-pointer border-b border-slate-200 px-4 py-2.5 align-middle font-medium text-slate-900"
                      >
                        {location.locationName}
                      </td>
                      <td
                        onClick={() => void navigate(`/master/locations/${location.id}`)}
                        className="cursor-pointer border-b border-slate-200 px-4 py-2.5 align-middle font-mono text-[0.775rem] text-slate-600 tabular-nums"
                      >
                        {location.latitude.toFixed(6)}, {location.longitude.toFixed(6)}
                      </td>
                      <td
                        onClick={() => void navigate(`/master/locations/${location.id}`)}
                        className="cursor-pointer border-b border-slate-200 px-4 py-2.5 align-middle text-slate-600 tabular-nums"
                      >
                        {location.radiusMeters}
                      </td>
                      <td className="border-b border-slate-200 px-4 py-2.5 align-middle">
                        <button
                          type="button"
                          disabled={!isAdmin || togglingId === location.id}
                          onClick={() => void toggleActive(location)}
                          title={isAdmin ? 'คลิกเพื่อเปิด/ปิดใช้งาน' : undefined}
                          className={`${badge(location.isActive ? 'active' : 'inactive')} disabled:opacity-60 ${
                            isAdmin ? 'cursor-pointer' : 'cursor-default'
                          }`}
                        >
                          {location.isActive ? 'Active' : 'Inactive'}
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
