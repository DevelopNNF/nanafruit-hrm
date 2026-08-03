import { useEffect, useState } from 'react'
import type { Shift, ShiftAssignment, ShiftChangeInput } from '@hrm/shared'
import { createShiftChange, getShiftHistory } from '../api/employees'
import { listShifts } from '../api/shifts'
import { DatePicker } from './DatePicker'
import { notify } from '../notifications/notify'
import { alert, alertDetail, alertTitle, button, card, fieldControl, muted } from '../styles'

type HistoryState =
  | { phase: 'loading' }
  | { phase: 'ok'; assignments: ShiftAssignment[] }
  | { phase: 'error'; message: string }

type ShiftOptionsState =
  | { phase: 'loading' }
  | { phase: 'ok'; shifts: Shift[] }
  | { phase: 'error'; message: string }

/** Local calendar date as YYYY-MM-DD — same reasoning as EmployeeFormPage's
 *  own `today`: toISOString would shift the day west of UTC. */
function today(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

const CREATED_BY_LABELS: Record<string, string> = {
  admin: 'ผู้ดูแลระบบ',
  employee: 'พนักงาน',
  system: 'ระบบ (ข้อมูลเริ่มต้น)',
}

function emptyDraft(): ShiftChangeInput {
  return { shiftId: null, effectiveFrom: today(), effectiveTo: null, note: null }
}

/**
 * An employee's shift assignment history, embedded in EmployeeFormPage the
 * same way LeaveBalanceCard is. The general employee form no longer writes
 * shift_id after creation — every change after that goes through this
 * card's own form, which is the only thing that calls
 * POST /employees/:id/shift-changes.
 */
export function ShiftHistoryCard({
  employeeId,
  canWrite,
  onChanged,
}: {
  employeeId: number
  canWrite: boolean
  /** Lets the parent re-fetch the employee so its own "current shift"
   *  display (loadedShiftName) reflects the change immediately. */
  onChanged?: () => void
}) {
  const [historyState, setHistoryState] = useState<HistoryState>({ phase: 'loading' })
  const [shiftOptions, setShiftOptions] = useState<ShiftOptionsState>({ phase: 'loading' })
  const [draft, setDraft] = useState<ShiftChangeInput>(emptyDraft)
  const [temporary, setTemporary] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const controller = new AbortController()

    // Unfiltered: a past assignment can point at a shift that's since been
    // deactivated, and the history table still needs its name.
    listShifts(controller.signal)
      .then((shifts) => setShiftOptions({ phase: 'ok', shifts }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setShiftOptions({
          phase: 'error',
          message: err instanceof Error ? err.message : 'request failed',
        })
      })

    return () => controller.abort()
  }, [])

  function reload() {
    setHistoryState({ phase: 'loading' })
    getShiftHistory(employeeId)
      .then((assignments) => setHistoryState({ phase: 'ok', assignments }))
      .catch((err: unknown) =>
        setHistoryState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'request failed',
        })
      )
  }

  useEffect(() => {
    const controller = new AbortController()
    getShiftHistory(employeeId, controller.signal)
      .then((assignments) => setHistoryState({ phase: 'ok', assignments }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setHistoryState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'request failed',
        })
      })
    return () => controller.abort()
  }, [employeeId])

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setSaving(true)
    try {
      await createShiftChange(employeeId, {
        ...draft,
        effectiveTo: temporary ? draft.effectiveTo : null,
      })
      notify.success(temporary ? 'สลับกะชั่วคราวสำเร็จ' : 'เปลี่ยนกะสำเร็จ')
      setDraft(emptyDraft())
      setTemporary(false)
      reload()
      onChanged?.()
    } catch (err) {
      notify.error('เปลี่ยนกะไม่สำเร็จ', err instanceof Error ? err.message : undefined)
    } finally {
      setSaving(false)
    }
  }

  const shiftNameById = new Map(
    shiftOptions.phase === 'ok' ? shiftOptions.shifts.map((s) => [s.id, s.shiftName]) : []
  )
  const activeShifts = shiftOptions.phase === 'ok' ? shiftOptions.shifts.filter((s) => s.isActive) : []

  return (
    <section className={`${card} mb-4`}>
      <h2 className="mb-5 border-b border-slate-200 pb-3 text-xs font-bold tracking-wider text-slate-500 uppercase">
        ประวัติการเปลี่ยนกะ (Shift History)
      </h2>

      {historyState.phase === 'loading' && <p className={muted}>กำลังโหลด…</p>}
      {historyState.phase === 'error' && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>โหลดประวัติไม่สำเร็จ</p>
          <p className={alertDetail}>{historyState.message}</p>
        </div>
      )}

      {historyState.phase === 'ok' && (
        <>
          {historyState.assignments.length === 0 ? (
            <p className={`mb-4 ${muted}`}>ยังไม่มีการกำหนดกะให้พนักงานคนนี้</p>
          ) : (
            <div className="mb-4 overflow-hidden rounded-md border border-slate-200">
              <table className="w-full border-collapse text-[0.775rem] [&_tbody_tr:last-child_td]:border-b-0">
                <thead>
                  <tr>
                    {['ช่วงเวลาที่มีผล', 'กะ', 'หมายเหตุ', 'บันทึกโดย'].map((h) => (
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
                  {historyState.assignments.map((a) => (
                    <tr key={a.id}>
                      <td className="border-b border-slate-200 px-3 py-1.5 align-middle whitespace-nowrap text-slate-700">
                        {a.effectiveFrom} – {a.effectiveTo ?? 'ปัจจุบัน'}
                      </td>
                      <td className="border-b border-slate-200 px-3 py-1.5 align-middle text-slate-900">
                        {a.shiftId === null
                          ? '— ไม่ระบุกะ —'
                          : (shiftNameById.get(a.shiftId) ?? `#${a.shiftId}`)}
                      </td>
                      <td className="border-b border-slate-200 px-3 py-1.5 align-middle text-slate-600">
                        {a.note ?? '—'}
                      </td>
                      <td className="border-b border-slate-200 px-3 py-1.5 align-middle whitespace-nowrap text-slate-500">
                        {CREATED_BY_LABELS[a.createdByKind] ?? a.createdByKind}
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
          onSubmit={(e) => void handleSubmit(e)}
        >
          <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-xs font-medium text-slate-600">
            <span>กะใหม่</span>
            <select
              className={fieldControl}
              disabled={shiftOptions.phase === 'loading'}
              value={draft.shiftId ?? ''}
              onChange={(e) =>
                setDraft((prev) => ({
                  ...prev,
                  shiftId: e.target.value ? Number(e.target.value) : null,
                }))
              }
            >
              <option value="">— ไม่ระบุกะ —</option>
              {activeShifts.map((shift) => (
                <option key={shift.id} value={shift.id}>
                  {shift.shiftName}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-slate-600">
            <span>มีผลตั้งแต่</span>
            <DatePicker
              required
              min={today()}
              value={draft.effectiveFrom}
              onChange={(value) => setDraft((prev) => ({ ...prev, effectiveFrom: value }))}
            />
          </label>
          <label className="flex items-center gap-2 pb-2 text-xs font-medium text-slate-600">
            <input
              type="checkbox"
              checked={temporary}
              onChange={(e) => {
                setTemporary(e.target.checked)
                if (!e.target.checked) {
                  setDraft((prev) => ({ ...prev, effectiveTo: null }))
                }
              }}
            />
            สลับชั่วคราว
          </label>
          {temporary && (
            <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-slate-600">
              <span>ถึงวันที่</span>
              <DatePicker
                required
                min={draft.effectiveFrom}
                value={draft.effectiveTo ?? ''}
                onChange={(value) => setDraft((prev) => ({ ...prev, effectiveTo: value }))}
              />
            </label>
          )}
          <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-xs font-medium text-slate-600">
            <span>หมายเหตุ</span>
            <input
              className={fieldControl}
              value={draft.note ?? ''}
              onChange={(e) =>
                setDraft((prev) => ({ ...prev, note: e.target.value || null }))
              }
            />
          </label>
          <button className={button('primary')} type="submit" disabled={saving}>
            {saving ? 'กำลังบันทึก…' : temporary ? 'สลับกะชั่วคราว' : 'เปลี่ยนกะ'}
          </button>
        </form>
      )}
      {temporary && (
        <p className={`mt-2 ${muted}`}>
          หลังจากวันที่สิ้นสุด ระบบจะสลับกลับไปใช้กะเดิมก่อนหน้าให้อัตโนมัติ
        </p>
      )}
    </section>
  )
}
