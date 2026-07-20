import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Plus, Search } from 'lucide-react'
import type { Job } from '@hrm/shared'
import { listJobs, updateJob } from '../api/jobs'
import { useCanWrite } from '../auth/meContext'
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
  | { phase: 'ok'; jobs: Job[] }
  | { phase: 'error'; message: string }

function haystack(job: Job): string {
  return [job.jobTitle, job.jobDescription].filter(Boolean).join(' ').toLowerCase()
}

export function JobListPage() {
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [query, setQuery] = useState('')
  const [toggleError, setToggleError] = useState<string | null>(null)
  const [togglingId, setTogglingId] = useState<number | null>(null)
  const navigate = useNavigate()
  const canWrite = useCanWrite()

  useEffect(() => {
    const controller = new AbortController()

    listJobs(controller.signal)
      .then((jobs) => setState({ phase: 'ok', jobs }))
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
    if (!needle) return state.jobs
    return state.jobs.filter((job) => haystack(job).includes(needle))
  }, [state, query])

  // No delete route: turning a job off is the entire lifecycle a retired job
  // has, so it's one click here rather than a trip through the edit form.
  async function toggleActive(job: Job) {
    if (state.phase !== 'ok') return
    setToggleError(null)
    setTogglingId(job.id)
    try {
      const updated = await updateJob(job.id, {
        jobTitle: job.jobTitle,
        jobDescription: job.jobDescription,
        workInstruction: job.workInstruction,
        isActive: !job.isActive,
      })
      setState({
        phase: 'ok',
        jobs: state.jobs.map((j) => (j.id === updated.id ? updated : j)),
      })
    } catch (err) {
      setToggleError(err instanceof Error ? err.message : 'บันทึกไม่สำเร็จ')
    } finally {
      setTogglingId(null)
    }
  }

  return (
    <>
      <header className={pageHead}>
        <div>
          <p className={eyebrow}>Master Data</p>
          <h1>ตำแหน่งงาน (Job)</h1>
          <p className={subtitle}>รายการตำแหน่งงานและคำแนะนำการทำงาน</p>
        </div>
        {canWrite && (
          <Link className={button('primary')} to="/master/jobs/new">
            <Plus size={16} />
            เพิ่มตำแหน่งงาน
          </Link>
        )}
      </header>

      {toggleError && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>บันทึกไม่สำเร็จ</p>
          <p className={alertDetail}>{toggleError}</p>
        </div>
      )}

      {state.phase === 'loading' && <p className={muted}>กำลังโหลด…</p>}

      {state.phase === 'error' && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>โหลดข้อมูลไม่สำเร็จ</p>
          <p className={alertDetail}>{state.message}</p>
        </div>
      )}

      {state.phase === 'ok' && state.jobs.length === 0 && (
        <div className={`rounded-lg border border-slate-200 bg-white shadow-sm ${cardEmpty}`}>
          <p className="mb-1.5 font-semibold text-slate-900">ยังไม่มีตำแหน่งงานในระบบ</p>
          <p className={muted}>
            {canWrite ? 'กด “เพิ่มตำแหน่งงาน” เพื่อเริ่มต้น' : 'สิทธิ์ของคุณดูข้อมูลได้อย่างเดียว'}
          </p>
        </div>
      )}

      {state.phase === 'ok' && state.jobs.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 bg-slate-50 px-4 py-3.5">
            <div className="relative flex max-w-88 min-w-0 flex-1 items-center">
              <Search size={15} className="pointer-events-none absolute left-2.5 text-slate-500" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="ค้นหาชื่อตำแหน่งหรือคำอธิบาย"
                aria-label="ค้นหาตำแหน่งงาน"
                className="w-full rounded-md border border-slate-200 bg-white py-2 pr-3 pl-9 text-[0.825rem] text-slate-900 placeholder:text-slate-500"
              />
            </div>
            <p className="text-[0.775rem] whitespace-nowrap text-slate-500 tabular-nums">
              {query.trim()
                ? `พบ ${visible.length} จาก ${state.jobs.length} รายการ`
                : `ทั้งหมด ${state.jobs.length} รายการ`}
            </p>
          </div>

          {visible.length === 0 ? (
            <div className={cardEmpty}>
              <p className="mb-1.5 font-semibold text-slate-900">ไม่พบตำแหน่งงานที่ตรงกับคำค้น</p>
              <p className={muted}>ลองใช้คำอื่น หรือล้างช่องค้นหา</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[0.825rem] [&_tbody_tr:last-child_td]:border-b-0">
                <thead>
                  <tr>
                    {['#', 'Job Title', 'Job Description', 'Is Active'].map((h) => (
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
                  {visible.map((job, index) => (
                    <tr key={job.id} className="hover:bg-slate-50">
                      <td
                        onClick={() => void navigate(`/master/jobs/${job.id}`)}
                        className="w-12 cursor-pointer border-b border-slate-200 px-4 py-2.5 align-middle text-slate-500"
                      >
                        {index + 1}
                      </td>
                      <td
                        onClick={() => void navigate(`/master/jobs/${job.id}`)}
                        className="cursor-pointer border-b border-slate-200 px-4 py-2.5 align-middle font-medium text-slate-900"
                      >
                        {job.jobTitle}
                      </td>
                      <td
                        onClick={() => void navigate(`/master/jobs/${job.id}`)}
                        className="cursor-pointer border-b border-slate-200 px-4 py-2.5 align-middle text-slate-600"
                      >
                        {job.jobDescription ?? '—'}
                      </td>
                      <td className="border-b border-slate-200 px-4 py-2.5 align-middle">
                        <button
                          type="button"
                          disabled={!canWrite || togglingId === job.id}
                          onClick={() => void toggleActive(job)}
                          title={canWrite ? 'คลิกเพื่อเปิด/ปิดใช้งาน' : undefined}
                          className={`${badge(job.isActive ? 'active' : 'inactive')} disabled:opacity-60 ${
                            canWrite ? 'cursor-pointer' : 'cursor-default'
                          }`}
                        >
                          {job.isActive ? 'Active' : 'Inactive'}
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
