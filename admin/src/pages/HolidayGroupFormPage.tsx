import { useEffect, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import type { HolidayGroupInput } from '@hrm/shared'
import { createHolidayGroup, getHolidayGroup, updateHolidayGroup } from '../api/holidayGroups'
import { HolidayListCard } from '../components/HolidayListCard'
import { useCanWrite } from '../auth/meContext'
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

const emptyDraft: HolidayGroupInput = {
  groupCode: '',
  groupName: '',
  isActive: true,
}

export function HolidayGroupFormPage() {
  const params = useParams()
  const navigate = useNavigate()
  const canWrite = useCanWrite()

  // The route is /master/holidays/new or /master/holidays/:id.
  const idParam = params['id']
  const isNew = idParam === undefined
  const id = isNew ? null : Number(idParam)

  const [draft, setDraft] = useState<HolidayGroupInput>(emptyDraft)
  const [loading, setLoading] = useState(!isNew)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (id === null) return
    const controller = new AbortController()

    getHolidayGroup(id, controller.signal)
      .then((group) => {
        setDraft({ groupCode: group.groupCode, groupName: group.groupName, isActive: group.isActive })
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setError(err instanceof Error ? err.message : 'request failed')
        setLoading(false)
      })

    return () => controller.abort()
  }, [id])

  function set<K extends keyof HolidayGroupInput>(key: K, value: HolidayGroupInput[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      if (id === null) {
        const created = await createHolidayGroup(draft)
        notify.success('เพิ่มกลุ่มวันหยุดสำเร็จ')
        // To the new group's own edit page, not back to the list: adding
        // holidays needs a real groupId, which only exists after this save.
        void navigate(`/master/holidays/${created.id}`, { replace: true })
        return
      }
      await updateHolidayGroup(id, draft)
      notify.success('บันทึกการแก้ไขสำเร็จ')
      setSaving(false)
    } catch (err) {
      // Server-side rejections (duplicate code) land here — keep the user's
      // input on screen and show why it was refused.
      setError(err instanceof Error ? err.message : 'save failed')
      setSaving(false)
    }
  }

  // A viewer has no business on the "new group" route at all — there is
  // nothing on it they could finish. The edit route still shows them the
  // record, read-only, because reading is exactly what their role is for.
  if (isNew && !canWrite) return <Navigate to="/master/holidays" replace />

  if (loading) return <p className={muted}>กำลังโหลด…</p>

  return (
    <>
      <header className={pageHead}>
        <div>
          <p className={eyebrow}>
            <Link
              className="inline-flex items-center gap-1.5 text-slate-500 no-underline normal-case tracking-normal hover:text-navy"
              to="/master/holidays"
            >
              <ArrowLeft size={13} />
              กลับไปรายการกลุ่มวันหยุด
            </Link>
          </p>
          <h1>{isNew ? 'เพิ่มกลุ่มวันหยุด' : canWrite ? 'แก้ไขกลุ่มวันหยุด' : 'ข้อมูลกลุ่มวันหยุด'}</h1>
          <p className={subtitle}>
            {isNew ? 'กรอกข้อมูลให้ครบทุกช่องที่มีเครื่องหมาย *' : draft.groupName}
          </p>
        </div>
      </header>

      {!canWrite && (
        <div className={alert('info')}>
          <p className={alertTitle()}>โหมดอ่านอย่างเดียว</p>
          <p className={muted}>สิทธิ์ของคุณดูข้อมูลได้อย่างเดียว จึงแก้ไขข้อมูลนี้ไม่ได้</p>
        </div>
      )}

      {error && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>บันทึกไม่สำเร็จ</p>
          <p className={alertDetail}>{error}</p>
        </div>
      )}

      <form className="max-w-3xl" onSubmit={(e) => void handleSubmit(e)}>
        {/* One fieldset rather than a `disabled` on each control: a field added
            later is read-only by default instead of by remembering. */}
        <fieldset disabled={!canWrite} className="min-w-0 border-0 p-0">
          <section className={`${card} mb-4`}>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className={fieldLabel}>
                <span>
                  Group Code <span className={requiredMark}>*</span>
                </span>
                <input
                  required
                  className={fieldControl}
                  value={draft.groupCode}
                  onChange={(e) => set('groupCode', e.target.value)}
                />
              </label>
              <label className={fieldLabel}>
                <span>
                  ชื่อกลุ่มวันหยุด <span className={requiredMark}>*</span>
                </span>
                <input
                  required
                  className={fieldControl}
                  value={draft.groupName}
                  onChange={(e) => set('groupName', e.target.value)}
                />
              </label>
            </div>
            <label className="mt-4 flex items-center gap-2 text-xs font-medium text-slate-600">
              <input
                type="checkbox"
                checked={draft.isActive}
                onChange={(e) => set('isActive', e.target.checked)}
              />
              <span>เปิดใช้งาน</span>
            </label>
          </section>
        </fieldset>

        <div className="mb-4 flex items-center gap-2.5">
          <button className={button('primary')} type="submit" disabled={saving || !canWrite}>
            {saving ? 'กำลังบันทึก…' : 'บันทึก'}
          </button>
          <button
            className={button()}
            type="button"
            onClick={() => void navigate('/master/holidays')}
            disabled={saving}
          >
            {canWrite ? 'ยกเลิก' : 'กลับ'}
          </button>
        </div>
      </form>

      {/* Adding holidays needs a real groupId, which only exists once the
          group above has been saved at least once. */}
      {id !== null && <HolidayListCard groupId={id} canWrite={canWrite} />}
    </>
  )
}
