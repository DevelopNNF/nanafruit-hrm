import { useEffect, useState } from 'react'
import type { LeaveType } from '@hrm/shared'
import { bulkGrantLeave } from '../api/leaveBalances'
import { listLeaveTypes } from '../api/leaveTypes'
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

type LeaveTypeOptionsState =
  | { phase: 'loading' }
  | { phase: 'ok'; leaveTypes: LeaveType[] }
  | { phase: 'error'; message: string }

function currentYear(): number {
  return new Date().getFullYear()
}

/**
 * Issues one year's 'grant' entry to every active employee for one leave
 * type at once — the alternative to opening each employee's own Leave
 * Balance card and doing it one at a time. Safe to run more than once: the
 * server skips anyone who already has a grant for that year/type (see
 * skippedCount in the result).
 */
export function LeaveBalanceBulkGrantPage() {
  const [leaveTypeOptions, setLeaveTypeOptions] = useState<LeaveTypeOptionsState>({
    phase: 'loading',
  })
  const [leaveTypeId, setLeaveTypeId] = useState(0)
  const [year, setYear] = useState(currentYear())
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ grantedCount: number; skippedCount: number } | null>(
    null
  )

  useEffect(() => {
    const controller = new AbortController()

    listLeaveTypes(controller.signal)
      .then((leaveTypes) =>
        setLeaveTypeOptions({
          phase: 'ok',
          leaveTypes: leaveTypes.filter((lt) => lt.isActive && lt.defaultDaysPerYear !== null),
        })
      )
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setLeaveTypeOptions({
          phase: 'error',
          message: err instanceof Error ? err.message : 'request failed',
        })
      })

    return () => controller.abort()
  }, [])

  const selectedLeaveType =
    leaveTypeOptions.phase === 'ok'
      ? leaveTypeOptions.leaveTypes.find((lt) => lt.id === leaveTypeId)
      : undefined

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (!leaveTypeId) return
    setSubmitting(true)
    setError(null)
    setResult(null)
    try {
      const response = await bulkGrantLeave({ year, leaveTypeId })
      setResult(response)
      notify.success(`ออกสิทธิ์สำเร็จ ${response.grantedCount} คน`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'bulk grant failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <header className={pageHead}>
        <div>
          <p className={eyebrow}>Leave</p>
          <h1>ออกสิทธิ์วันลาประจำปี</h1>
          <p className={subtitle}>
            ออกรายการ “ออกสิทธิ์” ให้พนักงานที่ยัง active ทุกคนพร้อมกัน ตามจำนวนวันสิทธิ์เริ่มต้นของประเภทการลานั้น
          </p>
        </div>
      </header>

      {error && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>ออกสิทธิ์ไม่สำเร็จ</p>
          <p className={alertDetail}>{error}</p>
        </div>
      )}

      {result && (
        <div className={alert('ok')}>
          <p className={alertTitle()}>ออกสิทธิ์เสร็จสิ้น</p>
          <p className={muted}>
            ออกสิทธิ์ใหม่ให้ {result.grantedCount} คน — ข้าม {result.skippedCount} คนที่มีรายการของปีนี้อยู่แล้ว
          </p>
        </div>
      )}

      <form className={`${card} max-w-xl`} onSubmit={(e) => void handleSubmit(e)}>
        <div className="flex flex-col gap-4">
          <label className={fieldLabel}>
            <span>
              ประเภทการลา <span className={requiredMark}>*</span>
            </span>
            <select
              required
              className={fieldControl}
              disabled={leaveTypeOptions.phase === 'loading'}
              value={leaveTypeId || ''}
              onChange={(e) => setLeaveTypeId(Number(e.target.value))}
            >
              <option value="" disabled>
                {leaveTypeOptions.phase === 'loading'
                  ? 'กำลังโหลด…'
                  : '— เลือกประเภทการลา —'}
              </option>
              {leaveTypeOptions.phase === 'ok' &&
                leaveTypeOptions.leaveTypes.map((lt) => (
                  <option key={lt.id} value={lt.id}>
                    {lt.leaveName} ({lt.defaultDaysPerYear} วัน/ปี)
                  </option>
                ))}
            </select>
            {leaveTypeOptions.phase === 'ok' && leaveTypeOptions.leaveTypes.length === 0 && (
              <span className="text-[0.7rem] text-slate-500">
                ยังไม่มีประเภทการลาที่กำหนดจำนวนวันสิทธิ์เริ่มต้นต่อปีไว้ — ตั้งค่าที่ Master → ประเภทการลา ก่อน
              </span>
            )}
            {leaveTypeOptions.phase === 'error' && (
              <span className="text-[0.7rem] text-red-700">
                โหลดรายการประเภทการลาไม่สำเร็จ: {leaveTypeOptions.message}
              </span>
            )}
          </label>

          <label className={`${fieldLabel} max-w-40`}>
            <span>
              ปี <span className={requiredMark}>*</span>
            </span>
            <input
              required
              type="number"
              step={1}
              className={fieldControl}
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
            />
          </label>

          {selectedLeaveType && (
            <p className={muted}>
              จะออกสิทธิ์ {selectedLeaveType.defaultDaysPerYear} วัน ให้พนักงาน active ทุกคนที่ยังไม่มีรายการ
              “ออกสิทธิ์” ของปี {year} สำหรับ {selectedLeaveType.leaveName}
            </p>
          )}
        </div>

        <button
          className={`${button('primary')} mt-5`}
          type="submit"
          disabled={submitting || !leaveTypeId}
        >
          {submitting ? 'กำลังออกสิทธิ์…' : 'ออกสิทธิ์'}
        </button>
      </form>
    </>
  )
}
