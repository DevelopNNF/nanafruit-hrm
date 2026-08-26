import { useEffect, useState } from 'react'
import type { CarryOverPreviewRow, LeaveType } from '@hrm/shared'
import { commitLeaveCarryOver, previewLeaveCarryOver } from '../api/leaveBalances'
import { listLeaveTypes } from '../api/leaveTypes'
import { notify } from '../notifications/notify'
import {
  alert,
  alertDetail,
  alertTitle,
  badge,
  button,
  card,
  cardEmpty,
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

type PreviewState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ok'; rows: CarryOverPreviewRow[] }
  | { phase: 'error'; message: string }

function currentYear(): number {
  return new Date().getFullYear()
}

function formatDays(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

/**
 * Bulk-inserts one 'carry_over' entry per active employee, carrying unused
 * leave from one year into the next for a single leave type at a time.
 * Mirrors LeaveBalanceBulkGrantPage's shape: form on top, a preview the HR
 * user must fetch before the commit button appears, result banner after.
 * The preview must be re-fetched any time a form field changes, so what's
 * on screen when "ยืนยันยกยอด" is pressed always matches what commit will
 * actually insert.
 */
export function LeaveBalanceCarryOverPage() {
  const [leaveTypeOptions, setLeaveTypeOptions] = useState<LeaveTypeOptionsState>({
    phase: 'loading',
  })
  const [fromYear, setFromYear] = useState(currentYear() - 1)
  const [toYear, setToYear] = useState(currentYear())
  const [leaveTypeId, setLeaveTypeId] = useState(0)
  const [requestedDays, setRequestedDays] = useState(0)
  const [maxDays, setMaxDays] = useState(0)

  const [preview, setPreview] = useState<PreviewState>({ phase: 'idle' })
  const [committing, setCommitting] = useState(false)
  const [commitError, setCommitError] = useState<string | null>(null)
  const [commitResult, setCommitResult] = useState<{
    carriedOverCount: number
    skippedCount: number
  } | null>(null)

  useEffect(() => {
    const controller = new AbortController()

    listLeaveTypes(controller.signal)
      .then((leaveTypes) =>
        setLeaveTypeOptions({ phase: 'ok', leaveTypes: leaveTypes.filter((lt) => lt.isActive) })
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

  const formValid =
    leaveTypeId > 0 && fromYear > 0 && toYear > fromYear && requestedDays > 0 && maxDays > 0

  // Any change to the form invalidates whatever preview is on screen — commit
  // always acts on the rows currently shown, never on a stale table left over
  // from a previous set of inputs.
  function resetPreview() {
    setPreview({ phase: 'idle' })
    setCommitResult(null)
    setCommitError(null)
  }

  async function handlePreview() {
    if (!formValid) return
    setPreview({ phase: 'loading' })
    setCommitResult(null)
    setCommitError(null)
    try {
      const rows = await previewLeaveCarryOver({ fromYear, toYear, leaveTypeId, requestedDays, maxDays })
      setPreview({ phase: 'ok', rows })
    } catch (err) {
      setPreview({
        phase: 'error',
        message: err instanceof Error ? err.message : 'request failed',
      })
    }
  }

  async function handleCommit() {
    if (preview.phase !== 'ok') return
    setCommitting(true)
    setCommitError(null)
    try {
      const result = await commitLeaveCarryOver({ fromYear, toYear, leaveTypeId, requestedDays, maxDays })
      setCommitResult(result)
      notify.success(`ยกยอดสำเร็จ ${result.carriedOverCount} คน`)
      // Refresh the table so it reflects what just happened (everyone
      // committed now shows as "ยกยอดแล้ว" instead of "จะยกยอด").
      const rows = await previewLeaveCarryOver({ fromYear, toYear, leaveTypeId, requestedDays, maxDays })
      setPreview({ phase: 'ok', rows })
    } catch (err) {
      setCommitError(err instanceof Error ? err.message : 'commit failed')
    } finally {
      setCommitting(false)
    }
  }

  const eligibleCount =
    preview.phase === 'ok' ? preview.rows.filter((r) => !r.alreadyCarriedOver && r.carryOverAmount > 0).length : 0

  return (
    <>
      <header className={pageHead}>
        <div>
          <p className={eyebrow}>Leave</p>
          <h1>ยกยอดวันลาจากปีก่อนหน้า</h1>
          <p className={subtitle}>
            ยกยอดวันลาคงเหลือของประเภทการลาหนึ่งประเภท จากปีต้นทางไปเป็นสิทธิ์เพิ่มเติมในปีปลายทาง
            ให้พนักงานที่ยัง active ทุกคนพร้อมกัน
          </p>
        </div>
      </header>

      <form
        className={`${card} max-w-3xl`}
        onSubmit={(e) => {
          e.preventDefault()
          void handlePreview()
        }}
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className={fieldLabel}>
            <span>
              ปีต้นทาง <span className={requiredMark}>*</span>
            </span>
            <input
              required
              type="number"
              step={1}
              className={fieldControl}
              value={fromYear}
              onChange={(e) => {
                setFromYear(Number(e.target.value))
                resetPreview()
              }}
            />
          </label>

          <label className={fieldLabel}>
            <span>
              ปีปลายทาง <span className={requiredMark}>*</span>
            </span>
            <input
              required
              type="number"
              step={1}
              className={fieldControl}
              value={toYear}
              onChange={(e) => {
                setToYear(Number(e.target.value))
                resetPreview()
              }}
            />
          </label>

          <label className={`${fieldLabel} sm:col-span-2`}>
            <span>
              ประเภทการลา <span className={requiredMark}>*</span>
            </span>
            <select
              required
              className={fieldControl}
              disabled={leaveTypeOptions.phase === 'loading'}
              value={leaveTypeId || ''}
              onChange={(e) => {
                setLeaveTypeId(Number(e.target.value))
                resetPreview()
              }}
            >
              <option value="" disabled>
                {leaveTypeOptions.phase === 'loading' ? 'กำลังโหลด…' : '— เลือกประเภทการลา —'}
              </option>
              {leaveTypeOptions.phase === 'ok' &&
                leaveTypeOptions.leaveTypes.map((lt) => (
                  <option key={lt.id} value={lt.id}>
                    {lt.leaveName}
                  </option>
                ))}
            </select>
            {leaveTypeOptions.phase === 'error' && (
              <span className="text-[0.7rem] text-red-700">
                โหลดรายการประเภทการลาไม่สำเร็จ: {leaveTypeOptions.message}
              </span>
            )}
          </label>

          <label className={fieldLabel}>
            <span>
              จำนวนวันที่ต้องการยกยอด <span className={requiredMark}>*</span>
            </span>
            <input
              required
              type="number"
              min={0}
              step={0.5}
              className={fieldControl}
              value={requestedDays}
              onChange={(e) => {
                setRequestedDays(Number(e.target.value))
                resetPreview()
              }}
            />
          </label>

          <label className={fieldLabel}>
            <span>
              สิทธิคงเหลือสูงสุดหลังยกยอด (เพดานต่อคน) <span className={requiredMark}>*</span>
            </span>
            <input
              required
              type="number"
              min={0}
              step={0.5}
              className={fieldControl}
              value={maxDays}
              onChange={(e) => {
                setMaxDays(Number(e.target.value))
                resetPreview()
              }}
            />
          </label>
        </div>

        {selectedLeaveType && (
          <p className={`${muted} mt-4`}>
            จะยกยอดวันลาคงเหลือของปี {fromYear} ({selectedLeaveType.leaveName}) เป็นสิทธิ์เพิ่มในปี {toYear} คนละไม่เกิน{' '}
            {formatDays(requestedDays)} วัน โดยยกยอดเท่าที่ทำให้สิทธิ์คงเหลือของปี {toYear} รวมแล้วไม่เกิน{' '}
            {formatDays(maxDays)} วันต่อคน และไม่เกินสิทธิ์คงเหลือจริงของปี {fromYear} ของแต่ละคน
          </p>
        )}

        <button className={`${button('primary')} mt-5`} type="submit" disabled={!formValid || preview.phase === 'loading'}>
          {preview.phase === 'loading' ? 'กำลังดึงข้อมูล…' : 'แสดงตัวอย่าง'}
        </button>
      </form>

      {preview.phase === 'error' && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>แสดงตัวอย่างไม่สำเร็จ</p>
          <p className={alertDetail}>{preview.message}</p>
        </div>
      )}

      {commitError && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>ยกยอดไม่สำเร็จ</p>
          <p className={alertDetail}>{commitError}</p>
        </div>
      )}

      {commitResult && (
        <div className={alert('ok')}>
          <p className={alertTitle()}>ยกยอดเสร็จสิ้น</p>
          <p className={muted}>
            ยกยอดใหม่ให้ {commitResult.carriedOverCount} คน — ข้าม {commitResult.skippedCount} คนที่ไม่มีสิทธิ์คงเหลือ
            หรือมีรายการยกยอดของปีนี้อยู่แล้ว
          </p>
        </div>
      )}

      {preview.phase === 'ok' && (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm mt-6">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 bg-slate-50 px-4 py-3.5">
            <p className="text-[0.825rem] font-semibold text-slate-900">
              ตัวอย่างผลการยกยอด — พนักงาน {preview.rows.length} คน จะยกยอดจริง {eligibleCount} คน
            </p>
            <button
              type="button"
              className={button('primary')}
              disabled={committing || eligibleCount === 0}
              onClick={() => void handleCommit()}
            >
              {committing ? 'กำลังยกยอด…' : 'ยืนยันยกยอด'}
            </button>
          </div>

          {preview.rows.length === 0 ? (
            <div className={cardEmpty}>
              <p className="mb-1.5 font-semibold text-slate-900">ไม่มีพนักงาน active ในระบบ</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[0.825rem] [&_tbody_tr:last-child_td]:border-b-0">
                <thead>
                  <tr>
                    {[
                      '#',
                      'รหัส',
                      'ชื่อพนักงาน',
                      `สิทธิคงเหลือปี ${fromYear}`,
                      'จะยกยอด',
                      `สิทธิคงเหลือปี ${toYear} (ก่อน → หลัง)`,
                      'สถานะ',
                    ].map((h) => (
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
                  {preview.rows.map((row, index) => {
                    const willCarryOver = !row.alreadyCarriedOver && row.carryOverAmount > 0
                    return (
                      <tr key={row.employeeId} className="hover:bg-slate-50">
                        <td className="w-12 border-b border-slate-200 px-4 py-2.5 align-middle text-slate-500">
                          {index + 1}
                        </td>
                        <td className="border-b border-slate-200 px-4 py-2.5 align-middle font-mono text-[0.775rem] text-slate-600">
                          {row.employeeCode}
                        </td>
                        <td className="border-b border-slate-200 px-4 py-2.5 align-middle font-medium text-slate-900">
                          {row.employeeName}
                        </td>
                        <td className="border-b border-slate-200 px-4 py-2.5 align-middle tabular-nums text-slate-600">
                          {formatDays(row.sourceRemainingDays)}
                        </td>
                        <td className="border-b border-slate-200 px-4 py-2.5 align-middle tabular-nums font-semibold text-slate-900">
                          {formatDays(row.carryOverAmount)}
                        </td>
                        <td className="border-b border-slate-200 px-4 py-2.5 align-middle tabular-nums text-slate-600">
                          {formatDays(row.destRemainingBeforeDays)} → {formatDays(row.destRemainingAfterDays)}
                        </td>
                        <td className="border-b border-slate-200 px-4 py-2.5 align-middle">
                          {row.alreadyCarriedOver ? (
                            <span className={badge('inactive')}>ยกยอดแล้ว</span>
                          ) : willCarryOver ? (
                            <span className={badge('active')}>จะยกยอด</span>
                          ) : (
                            <span className={badge('inactive')}>ไม่มีสิทธิ์เหลือ</span>
                          )}
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
