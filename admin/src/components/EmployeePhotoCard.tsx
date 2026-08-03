import { useEffect, useRef, useState } from 'react'
import { EMPLOYEE_PHOTO_MAX_BYTES, EMPLOYEE_PHOTO_MIME_TYPES } from '@hrm/shared'
import {
  completeEmployeePhotoUpload,
  deleteEmployeePhoto,
  getEmployeePhotoUrl,
  presignEmployeePhotoUpload,
} from '../api/employees'
import { notify } from '../notifications/notify'
import { alert, alertDetail, alertTitle, button, card, muted } from '../styles'

type PhotoState =
  | { phase: 'loading' }
  | { phase: 'ok'; url: string | null }
  | { phase: 'error'; message: string }

function isAllowedMimeType(type: string): type is (typeof EMPLOYEE_PHOTO_MIME_TYPES)[number] {
  return (EMPLOYEE_PHOTO_MIME_TYPES as readonly string[]).includes(type)
}

/**
 * The employee's profile photo, stored in Cloudflare R2. Upload goes straight
 * from the browser to R2 (presign → PUT → complete) — this component never
 * sends the image bytes through our own API.
 */
export function EmployeePhotoCard({
  employeeId,
  canWrite,
}: {
  employeeId: number
  canWrite: boolean
}) {
  const [state, setState] = useState<PhotoState>({ phase: 'loading' })
  const [busy, setBusy] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const controller = new AbortController()
    getEmployeePhotoUrl(employeeId, controller.signal)
      .then((url) => setState({ phase: 'ok', url }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'request failed',
        })
      })
    return () => controller.abort()
  }, [employeeId])

  async function handleFileSelected(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null
    // Reset immediately so picking the same file again still fires onChange.
    event.target.value = ''
    if (!file) return

    if (!isAllowedMimeType(file.type)) {
      notify.error('อัปโหลดรูปไม่สำเร็จ', 'รองรับเฉพาะไฟล์ JPEG, PNG หรือ WebP')
      return
    }
    if (file.size > EMPLOYEE_PHOTO_MAX_BYTES) {
      notify.error(
        'อัปโหลดรูปไม่สำเร็จ',
        `ไฟล์ต้องมีขนาดไม่เกิน ${Math.floor(EMPLOYEE_PHOTO_MAX_BYTES / (1024 * 1024))} MB`
      )
      return
    }

    setBusy(true)
    try {
      const { uploadUrl, key } = await presignEmployeePhotoUpload(employeeId, {
        mimeType: file.type,
        sizeBytes: file.size,
      })

      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      })
      if (!putRes.ok) throw new Error('อัปโหลดไฟล์ไปยังที่จัดเก็บไม่สำเร็จ')

      await completeEmployeePhotoUpload(employeeId, key)
      const url = await getEmployeePhotoUrl(employeeId)
      setState({ phase: 'ok', url })
      notify.success('อัปโหลดรูปสำเร็จ')
    } catch (err) {
      notify.error('อัปโหลดรูปไม่สำเร็จ', err instanceof Error ? err.message : undefined)
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete() {
    if (!confirm('ลบรูปพนักงานคนนี้?')) return
    setBusy(true)
    try {
      await deleteEmployeePhoto(employeeId)
      setState({ phase: 'ok', url: null })
      notify.success('ลบรูปสำเร็จ')
    } catch (err) {
      notify.error('ลบรูปไม่สำเร็จ', err instanceof Error ? err.message : undefined)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={`${card} mb-4`}>
      <h2 className="mb-5 border-b border-slate-200 pb-3 text-xs font-bold tracking-wider text-slate-500 uppercase">
        รูปพนักงาน
      </h2>

      {state.phase === 'loading' && <p className={muted}>กำลังโหลด…</p>}
      {state.phase === 'error' && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>โหลดรูปไม่สำเร็จ</p>
          <p className={alertDetail}>{state.message}</p>
        </div>
      )}

      {state.phase === 'ok' && (
        <div className="flex items-center gap-5">
          {state.url ? (
            <img
              src={state.url}
              alt="รูปพนักงาน"
              className="h-28 w-28 rounded-md border border-slate-200 object-cover"
            />
          ) : (
            <div className="flex h-28 w-28 items-center justify-center rounded-md border border-dashed border-slate-300 text-center text-[0.7rem] text-slate-400">
              ไม่มีรูป
            </div>
          )}

          {canWrite && (
            <div className="flex flex-col items-start gap-2.5">
              <input
                ref={fileInputRef}
                type="file"
                accept={EMPLOYEE_PHOTO_MIME_TYPES.join(',')}
                className="hidden"
                onChange={(e) => void handleFileSelected(e)}
              />
              <button
                className={button()}
                type="button"
                disabled={busy}
                onClick={() => fileInputRef.current?.click()}
              >
                {busy ? 'กำลังดำเนินการ…' : state.url ? 'เปลี่ยนรูป' : 'อัปโหลดรูป'}
              </button>
              {state.url && (
                <button
                  className={button('danger')}
                  type="button"
                  disabled={busy}
                  onClick={() => void handleDelete()}
                >
                  ลบรูป
                </button>
              )}
              <p className={muted}>
                JPEG, PNG หรือ WebP ไม่เกิน {Math.floor(EMPLOYEE_PHOTO_MAX_BYTES / (1024 * 1024))} MB
              </p>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
