import { useEffect, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import type { JobInput } from '@hrm/shared'
import { createJob, getJob, updateJob } from '../api/jobs'
import { RichTextEditor } from '../components/RichTextEditor'
import { useCanWrite } from '../auth/meContext'
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

const emptyDraft: JobInput = {
  jobTitle: '',
  jobDescription: null,
  workInstruction: null,
  isActive: true,
}

export function JobFormPage() {
  const params = useParams()
  const navigate = useNavigate()
  const canWrite = useCanWrite()

  // The route is /master/jobs/new or /master/jobs/:id — the param tells us which.
  const idParam = params['id']
  const isNew = idParam === undefined
  const id = isNew ? null : Number(idParam)

  const [draft, setDraft] = useState<JobInput>(emptyDraft)
  const [loading, setLoading] = useState(!isNew)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (id === null) return
    const controller = new AbortController()

    getJob(id, controller.signal)
      .then((job) => {
        setDraft({
          jobTitle: job.jobTitle,
          jobDescription: job.jobDescription,
          workInstruction: job.workInstruction,
          isActive: job.isActive,
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

  function set<K extends keyof JobInput>(key: K, value: JobInput[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      if (id === null) await createJob(draft)
      else await updateJob(id, draft)
      void navigate('/master/jobs')
    } catch (err) {
      // Server-side rejections (duplicate title) land here — keep the user's
      // input on screen and show why it was refused.
      setError(err instanceof Error ? err.message : 'save failed')
      setSaving(false)
    }
  }

  // A viewer has no business on the "new job" route at all — there is nothing
  // on it they could finish. The edit route still shows them the record,
  // read-only, because reading is exactly what their role is for.
  if (isNew && !canWrite) return <Navigate to="/master/jobs" replace />

  if (loading) return <p className={muted}>กำลังโหลด…</p>

  return (
    <>
      <header className={pageHead}>
        <div>
          <p className={eyebrow}>
            <Link
              className="inline-flex items-center gap-1.5 text-slate-500 no-underline normal-case tracking-normal hover:text-navy"
              to="/master/jobs"
            >
              <ArrowLeft size={13} />
              กลับไปรายการตำแหน่งงาน
            </Link>
          </p>
          <h1>{isNew ? 'เพิ่มตำแหน่งงาน' : canWrite ? 'แก้ไขตำแหน่งงาน' : 'ข้อมูลตำแหน่งงาน'}</h1>
          <p className={subtitle}>
            {isNew ? 'กรอกข้อมูลให้ครบทุกช่องที่มีเครื่องหมาย *' : draft.jobTitle}
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
            later is read-only by default instead of by remembering. The rich
            text editor is the exception — its `editable` prop below, since
            fieldset only reaches native form controls. */}
        <fieldset disabled={!canWrite} className="min-w-0 border-0 p-0">
          <section className={`${card} mb-4`}>
            <div className="flex flex-col gap-4">
              <label className={fieldLabel}>
                <span>
                  Job Title <span className={requiredMark}>*</span>
                </span>
                <input
                  required
                  className={fieldControl}
                  value={draft.jobTitle}
                  onChange={(e) => set('jobTitle', e.target.value)}
                />
              </label>
              <label className={fieldLabel}>
                <span>Job Description</span>
                <textarea
                  rows={3}
                  className={fieldControl}
                  value={draft.jobDescription ?? ''}
                  onChange={(e) => set('jobDescription', e.target.value || null)}
                />
              </label>
              <label className={fieldLabel}>
                <span>Work Instruction</span>
                <RichTextEditor
                  value={draft.workInstruction ?? ''}
                  onChange={(html) => set('workInstruction', html === '<p></p>' ? null : html)}
                  editable={canWrite}
                />
              </label>
              <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
                <input
                  type="checkbox"
                  checked={draft.isActive}
                  onChange={(e) => set('isActive', e.target.checked)}
                />
                <span>Is Active</span>
              </label>
            </div>
          </section>
        </fieldset>

        {canWrite ? (
          <div className="flex items-center gap-2.5 pt-1">
            <button className={button('primary')} type="submit" disabled={saving}>
              {saving ? 'กำลังบันทึก…' : 'บันทึก'}
            </button>
            <button
              className={button()}
              type="button"
              onClick={() => void navigate('/master/jobs')}
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
              onClick={() => void navigate('/master/jobs')}
            >
              กลับ
            </button>
          </div>
        )}
      </form>
    </>
  )
}
