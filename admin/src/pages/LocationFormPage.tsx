import { useEffect, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import type { LocationInput } from '@hrm/shared'
import { createLocation, getLocation, updateLocation } from '../api/locations'
import { useIsAdmin } from '../auth/meContext'
import { notify } from '../notifications/notify'
import {
  alert,
  alertDetail,
  alertTitle,
  button,
  card,
  eyebrow,
  fieldControl,
  fieldLabel,
  muted,
  pageHead,
  requiredMark,
  subtitle,
} from '../styles'

const emptyDraft: LocationInput = {
  locationName: '',
  latitude: 0,
  longitude: 0,
  radiusMeters: 50,
  isActive: true,
}

export function LocationFormPage() {
  const params = useParams()
  const navigate = useNavigate()
  // Admin-only, not useCanWrite: see LocationListPage for why this master is
  // narrower than Job/Shift.
  const isAdmin = useIsAdmin()

  // The route is /master/locations/new or /master/locations/:id.
  const idParam = params['id']
  const isNew = idParam === undefined
  const id = isNew ? null : Number(idParam)

  const [draft, setDraft] = useState<LocationInput>(emptyDraft)
  const [loading, setLoading] = useState(!isNew)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (id === null) return
    const controller = new AbortController()

    getLocation(id, controller.signal)
      .then((location) => {
        setDraft({
          locationName: location.locationName,
          latitude: location.latitude,
          longitude: location.longitude,
          radiusMeters: location.radiusMeters,
          isActive: location.isActive,
        })
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setError(err instanceof Error ? err.message : 'request failed')
        setLoading(false)
      })

    return () => controller.abort()
  }, [id])

  function set<K extends keyof LocationInput>(key: K, value: LocationInput[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      if (id === null) await createLocation(draft)
      else await updateLocation(id, draft)
      notify.success(isNew ? 'เพิ่มพิกัดสำเร็จ' : 'บันทึกการแก้ไขสำเร็จ')
      void navigate('/master/locations')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed')
      setSaving(false)
    }
  }

  // Someone without Admin has no business on the "new location" route at
  // all — there is nothing on it they could finish. The edit route still
  // shows them the record, read-only, same reasoning as ShiftFormPage.
  if (isNew && !isAdmin) return <Navigate to="/master/locations" replace />

  if (loading) return <p className={muted}>กำลังโหลด…</p>

  return (
    <>
      <header className={pageHead}>
        <div>
          <p className={eyebrow}>
            <Link
              className="inline-flex items-center gap-1.5 text-slate-500 no-underline normal-case tracking-normal hover:text-navy"
              to="/master/locations"
            >
              <ArrowLeft size={13} />
              กลับไปรายการพิกัด
            </Link>
          </p>
          <h1>{isNew ? 'เพิ่มพิกัด' : isAdmin ? 'แก้ไขพิกัด' : 'ข้อมูลพิกัด'}</h1>
          <p className={subtitle}>
            {isNew ? 'กรอกข้อมูลให้ครบทุกช่องที่มีเครื่องหมาย *' : draft.locationName}
          </p>
        </div>
      </header>

      {!isAdmin && (
        <div className={alert('info')}>
          <p className={alertTitle()}>โหมดอ่านอย่างเดียว</p>
          <p className={muted}>เฉพาะ Admin เท่านั้นที่แก้ไขพิกัดอนุญาตให้ลงเวลาได้</p>
        </div>
      )}

      {error && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>บันทึกไม่สำเร็จ</p>
          <p className={alertDetail}>{error}</p>
        </div>
      )}

      <form className="max-w-3xl" onSubmit={(e) => void handleSubmit(e)}>
        <fieldset disabled={!isAdmin} className="min-w-0 border-0 p-0">
          <section className={`${card} mb-4`}>
            <div className="flex flex-col gap-4">
              <label className={fieldLabel}>
                <span>
                  ชื่อพิกัด <span className={requiredMark}>*</span>
                </span>
                <input
                  required
                  className={fieldControl}
                  value={draft.locationName}
                  onChange={(e) => set('locationName', e.target.value)}
                />
              </label>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <label className={fieldLabel}>
                  <span>
                    ละติจูด (Latitude) <span className={requiredMark}>*</span>
                  </span>
                  <input
                    required
                    type="number"
                    step="any"
                    min={-90}
                    max={90}
                    className={fieldControl}
                    value={draft.latitude}
                    onChange={(e) => set('latitude', Number(e.target.value))}
                  />
                </label>
                <label className={fieldLabel}>
                  <span>
                    ลองจิจูด (Longitude) <span className={requiredMark}>*</span>
                  </span>
                  <input
                    required
                    type="number"
                    step="any"
                    min={-180}
                    max={180}
                    className={fieldControl}
                    value={draft.longitude}
                    onChange={(e) => set('longitude', Number(e.target.value))}
                  />
                </label>
              </div>

              <label className={fieldLabel}>
                <span>
                  ขอบเขตที่อนุญาต (เมตร) <span className={requiredMark}>*</span>
                </span>
                <input
                  required
                  type="number"
                  step="any"
                  min={0.01}
                  className={`${fieldControl} max-w-40`}
                  value={draft.radiusMeters}
                  onChange={(e) => set('radiusMeters', Number(e.target.value))}
                />
                <span className="font-normal text-slate-400">
                  ระยะห่างสูงสุดจากจุดนี้ที่ยังอนุญาตให้ลงเวลาได้ เช่น 20 หมายถึงไม่เกิน 20 เมตร
                </span>
              </label>

              <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
                <input
                  type="checkbox"
                  checked={draft.isActive}
                  onChange={(e) => set('isActive', e.target.checked)}
                />
                <span>เปิดใช้งาน</span>
              </label>
            </div>
          </section>
        </fieldset>

        {isAdmin ? (
          <div className="flex items-center gap-2.5 pt-1">
            <button className={button('primary')} type="submit" disabled={saving}>
              {saving ? 'กำลังบันทึก…' : 'บันทึก'}
            </button>
            <button
              className={button()}
              type="button"
              onClick={() => void navigate('/master/locations')}
              disabled={saving}
            >
              ยกเลิก
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2.5 pt-1">
            <button
              className={button()}
              type="button"
              onClick={() => void navigate('/master/locations')}
            >
              กลับ
            </button>
          </div>
        )}
      </form>
    </>
  )
}
