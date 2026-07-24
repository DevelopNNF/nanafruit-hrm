import { useEffect, useState } from 'react'
import type { LeaveBalanceEntry, LeaveBalanceEntryInput, LeaveBalanceSummary, LeaveType } from '@hrm/shared'
import {
  createLeaveBalanceEntry,
  listLeaveBalanceEntries,
  listLeaveBalanceSummaries,
} from '../api/leaveBalances'
import { listLeaveTypes } from '../api/leaveTypes'
import { notify } from '../notifications/notify'
import { alert, alertDetail, alertTitle, button, card, fieldControl, muted } from '../styles'

type SummaryState =
  | { phase: 'loading' }
  | { phase: 'ok'; summaries: LeaveBalanceSummary[] }
  | { phase: 'error'; message: string }

type EntryState =
  | { phase: 'loading' }
  | { phase: 'ok'; entries: LeaveBalanceEntry[] }
  | { phase: 'error'; message: string }

type LeaveTypeOptionsState =
  | { phase: 'loading' }
  | { phase: 'ok'; leaveTypes: LeaveType[] }
  | { phase: 'error'; message: string }

const ENTRY_TYPE_LABELS: Record<LeaveBalanceEntryInput['entryType'], string> = {
  grant: 'ออกสิทธิ์',
  carry_over: 'ยกยอด',
  adjustment: 'ปรับปรุง',
}

function currentYear(): number {
  return new Date().getFullYear()
}

const emptyEntryDraft: LeaveBalanceEntryInput = {
  leaveTypeId: 0,
  year: currentYear(),
  entryType: 'grant',
  amountDays: 1,
  reason: null,
}

/**
 * An employee's leave balance for one year, embedded in EmployeeFormPage the
 * same way LinkCodeCard and HolidayListCard are — a saved employee's own
 * data, not a route of its own. Summary numbers come from the server's own
 * SUM over leave_balance_entries; this component never adds them up itself.
 */
export function LeaveBalanceCard({
  employeeId,
  canWrite,
}: {
  employeeId: number
  canWrite: boolean
}) {
  const [year, setYear] = useState(currentYear())
  const [summaryState, setSummaryState] = useState<SummaryState>({ phase: 'loading' })
  const [entryState, setEntryState] = useState<EntryState>({ phase: 'loading' })
  const [leaveTypeOptions, setLeaveTypeOptions] = useState<LeaveTypeOptionsState>({
    phase: 'loading',
  })
  const [draft, setDraft] = useState<LeaveBalanceEntryInput>(emptyEntryDraft)
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    const controller = new AbortController()

    listLeaveTypes(controller.signal)
      .then((leaveTypes) =>
        setLeaveTypeOptions({
          phase: 'ok',
          leaveTypes: leaveTypes.filter((lt) => lt.isActive),
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

  useEffect(() => {
    const controller = new AbortController()
    setSummaryState({ phase: 'loading' })

    listLeaveBalanceSummaries(employeeId, year, controller.signal)
      .then((summaries) => setSummaryState({ phase: 'ok', summaries }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setSummaryState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'request failed',
        })
      })

    return () => controller.abort()
  }, [employeeId, year])

  useEffect(() => {
    const controller = new AbortController()
    setEntryState({ phase: 'loading' })

    listLeaveBalanceEntries(employeeId, year, controller.signal)
      .then((entries) => setEntryState({ phase: 'ok', entries }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setEntryState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'request failed',
        })
      })

    return () => controller.abort()
  }, [employeeId, year])

  function reload() {
    // Cheapest correct way to reflect a new entry everywhere it shows: ask
    // the server again rather than guessing how one row changes two
    // independently-derived views (the summary is a SUM, not a local total).
    setSummaryState({ phase: 'loading' })
    setEntryState({ phase: 'loading' })
    listLeaveBalanceSummaries(employeeId, year)
      .then((summaries) => setSummaryState({ phase: 'ok', summaries }))
      .catch((err: unknown) =>
        setSummaryState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'request failed',
        })
      )
    listLeaveBalanceEntries(employeeId, year)
      .then((entries) => setEntryState({ phase: 'ok', entries }))
      .catch((err: unknown) =>
        setEntryState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'request failed',
        })
      )
  }

  async function handleAdd(event: React.FormEvent) {
    event.preventDefault()
    setAdding(true)
    try {
      // year always comes from the viewing selector at submit time, not from
      // stale state on the draft — the entry is always "for the year I'm
      // currently looking at".
      await createLeaveBalanceEntry(employeeId, { ...draft, year })
      notify.success('เพิ่มรายการสิทธิ์วันลาสำเร็จ')
      setDraft(emptyEntryDraft)
      reload()
    } catch (err) {
      notify.error('เพิ่มรายการไม่สำเร็จ', err instanceof Error ? err.message : undefined)
    } finally {
      setAdding(false)
    }
  }

  const yearOptions = [year - 1, year, year + 1, year + 2]

  return (
    <section className={`${card} mb-4`}>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3">
        <h2 className="text-xs font-bold tracking-wider text-slate-500 uppercase">
          สิทธิ์วันลา (Leave Balance)
        </h2>
        <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
          <span>ปี</span>
          <select
            className={`${fieldControl} w-auto`}
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
          >
            {yearOptions.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
      </div>

      {summaryState.phase === 'loading' && <p className={muted}>กำลังโหลด…</p>}

      {summaryState.phase === 'error' && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>โหลดข้อมูลไม่สำเร็จ</p>
          <p className={alertDetail}>{summaryState.message}</p>
        </div>
      )}

      {summaryState.phase === 'ok' && (
        <div className="mb-5 overflow-hidden rounded-md border border-slate-200">
          <table className="w-full border-collapse text-[0.825rem] [&_tbody_tr:last-child_td]:border-b-0">
            <thead>
              <tr>
                {['ประเภทการลา', 'ได้รับ', 'ใช้ไป', 'ปรับปรุง', 'คงเหลือ'].map((h) => (
                  <th
                    key={h}
                    className="border-b border-slate-200 bg-slate-50 px-3.5 py-2 text-left text-[0.675rem] font-semibold tracking-wider text-slate-500 uppercase"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {summaryState.summaries.map((summary) => (
                <tr key={summary.leaveTypeId}>
                  <td className="border-b border-slate-200 px-3.5 py-2 align-middle font-medium text-slate-900">
                    {summary.leaveName}
                  </td>
                  <td className="border-b border-slate-200 px-3.5 py-2 align-middle tabular-nums text-slate-600">
                    {summary.grantedDays}
                  </td>
                  <td className="border-b border-slate-200 px-3.5 py-2 align-middle tabular-nums text-slate-600">
                    {summary.usedDays}
                  </td>
                  <td className="border-b border-slate-200 px-3.5 py-2 align-middle tabular-nums text-slate-600">
                    {summary.adjustmentDays}
                  </td>
                  <td className="border-b border-slate-200 px-3.5 py-2 align-middle font-semibold tabular-nums text-slate-900">
                    {summary.remainingDays}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="mb-2.5 text-[0.7rem] font-semibold tracking-wider text-slate-500 uppercase">
        ประวัติรายการ
      </h3>

      {entryState.phase === 'loading' && <p className={muted}>กำลังโหลด…</p>}
      {entryState.phase === 'error' && (
        <p className="mb-4 font-mono text-[0.775rem] break-words text-red-700">
          {entryState.message}
        </p>
      )}
      {entryState.phase === 'ok' && (
        <>
          {entryState.entries.length === 0 ? (
            <p className={`mb-4 ${muted}`}>ยังไม่มีรายการในปีนี้</p>
          ) : (
            <div className="mb-4 overflow-hidden rounded-md border border-slate-200">
              <table className="w-full border-collapse text-[0.775rem] [&_tbody_tr:last-child_td]:border-b-0">
                <thead>
                  <tr>
                    {['วันที่บันทึก', 'ประเภทรายการ', 'จำนวนวัน', 'เหตุผล', 'โดย'].map((h) => (
                      <th
                        key={h}
                        className="border-b border-slate-200 bg-slate-50 px-3 py-1.5 text-left text-[0.65rem] font-semibold tracking-wider text-slate-500 uppercase"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {entryState.entries.map((entry) => (
                    <tr key={entry.id}>
                      <td className="border-b border-slate-200 px-3 py-1.5 align-middle whitespace-nowrap text-slate-500">
                        {new Date(entry.createdAt).toLocaleDateString('th-TH-u-ca-buddhist')}
                      </td>
                      <td className="border-b border-slate-200 px-3 py-1.5 align-middle text-slate-700">
                        {entry.entryType === 'usage' ? 'ใช้ไป' : ENTRY_TYPE_LABELS[entry.entryType]}
                      </td>
                      <td className="border-b border-slate-200 px-3 py-1.5 align-middle tabular-nums text-slate-900">
                        {entry.amountDays > 0 ? `+${entry.amountDays}` : entry.amountDays}
                      </td>
                      <td className="border-b border-slate-200 px-3 py-1.5 align-middle text-slate-600">
                        {entry.reason ?? '—'}
                      </td>
                      <td className="border-b border-slate-200 px-3 py-1.5 align-middle whitespace-nowrap text-slate-500">
                        {entry.createdByName}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {canWrite && (
        <form
          className="flex flex-wrap items-end gap-3 border-t border-slate-200 pt-4"
          onSubmit={(e) => void handleAdd(e)}
        >
          <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-xs font-medium text-slate-600">
            <span>ประเภทการลา</span>
            <select
              required
              className={fieldControl}
              disabled={leaveTypeOptions.phase === 'loading'}
              value={draft.leaveTypeId || ''}
              onChange={(e) =>
                setDraft((prev) => ({ ...prev, leaveTypeId: Number(e.target.value) }))
              }
            >
              <option value="" disabled>
                — เลือกประเภทการลา —
              </option>
              {leaveTypeOptions.phase === 'ok' &&
                leaveTypeOptions.leaveTypes.map((lt) => (
                  <option key={lt.id} value={lt.id}>
                    {lt.leaveName}
                  </option>
                ))}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-slate-600">
            <span>ประเภทรายการ</span>
            <select
              className={fieldControl}
              value={draft.entryType}
              onChange={(e) =>
                setDraft((prev) => ({
                  ...prev,
                  entryType: e.target.value as LeaveBalanceEntryInput['entryType'],
                }))
              }
            >
              {(Object.keys(ENTRY_TYPE_LABELS) as LeaveBalanceEntryInput['entryType'][]).map(
                (type) => (
                  <option key={type} value={type}>
                    {ENTRY_TYPE_LABELS[type]}
                  </option>
                )
              )}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-slate-600">
            <span>จำนวนวัน</span>
            <input
              required
              type="number"
              step={0.5}
              className={`${fieldControl} w-24`}
              value={draft.amountDays}
              onChange={(e) =>
                setDraft((prev) => ({ ...prev, amountDays: Number(e.target.value) }))
              }
            />
          </label>
          <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-xs font-medium text-slate-600">
            <span>
              เหตุผล {draft.entryType === 'adjustment' && <span className="text-[#f00]">*</span>}
            </span>
            <input
              required={draft.entryType === 'adjustment'}
              className={fieldControl}
              value={draft.reason ?? ''}
              onChange={(e) =>
                setDraft((prev) => ({ ...prev, reason: e.target.value || null }))
              }
            />
          </label>
          <button className={button('primary')} type="submit" disabled={adding}>
            {adding ? 'กำลังเพิ่ม…' : 'เพิ่มรายการ'}
          </button>
        </form>
      )}
    </section>
  )
}
