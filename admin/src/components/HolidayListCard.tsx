import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import type { Holiday, HolidayInput } from '@hrm/shared'
import { createHoliday, deleteHoliday, listHolidays, updateHoliday } from '../api/holidays'
import { DatePicker } from './DatePicker'
import { notify } from '../notifications/notify'
import { alert, alertDetail, alertTitle, button, card, fieldControl, muted } from '../styles'

type State =
  | { phase: 'loading' }
  | { phase: 'ok'; holidays: Holiday[] }
  | { phase: 'error'; message: string }

const emptyDraft: HolidayInput = { holidayName: '', holidayDate: '' }

/** Thai date, e.g. "1 มกราคม 2569" — matches DatePicker's own display, so a
 *  saved date and the picker that produced it read the same way. */
function formatThaiDate(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00`)
  return date.toLocaleDateString('th-TH-u-ca-buddhist', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
}

/**
 * The list of dates within one holiday group, embedded in
 * HolidayGroupFormPage the same way LinkCodeCard is embedded in
 * EmployeeFormPage — a saved parent record's own action, not a route of its own.
 * Only rendered once the group is saved (has a real groupId): a holiday
 * can't exist before the group it belongs to does.
 */
export function HolidayListCard({
  groupId,
  canWrite,
}: {
  groupId: number
  canWrite: boolean
}) {
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [draft, setDraft] = useState<HolidayInput>(emptyDraft)
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState<HolidayInput>(emptyDraft)
  const [savingEdit, setSavingEdit] = useState(false)
  const [deletingId, setDeletingId] = useState<number | null>(null)

  useEffect(() => {
    const controller = new AbortController()

    listHolidays(groupId, controller.signal)
      .then((holidays) =>
        setState({
          phase: 'ok',
          holidays: [...holidays].sort((a, b) => a.holidayDate.localeCompare(b.holidayDate)),
        })
      )
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'request failed',
        })
      })

    return () => controller.abort()
  }, [groupId])

  function upsertLocal(holiday: Holiday) {
    setState((prev) => {
      if (prev.phase !== 'ok') return prev
      const withoutExisting = prev.holidays.filter((h) => h.id !== holiday.id)
      return {
        phase: 'ok',
        holidays: [...withoutExisting, holiday].sort((a, b) =>
          a.holidayDate.localeCompare(b.holidayDate)
        ),
      }
    })
  }

  async function handleAdd(event: React.FormEvent) {
    event.preventDefault()
    setAdding(true)
    try {
      const holiday = await createHoliday(groupId, draft)
      upsertLocal(holiday)
      setDraft(emptyDraft)
      notify.success('เพิ่มวันหยุดสำเร็จ')
    } catch (err) {
      notify.error('เพิ่มวันหยุดไม่สำเร็จ', err instanceof Error ? err.message : undefined)
    } finally {
      setAdding(false)
    }
  }

  function startEdit(holiday: Holiday) {
    setEditingId(holiday.id)
    setEditDraft({ holidayName: holiday.holidayName, holidayDate: holiday.holidayDate })
  }

  async function saveEdit(id: number) {
    setSavingEdit(true)
    try {
      const holiday = await updateHoliday(id, editDraft)
      upsertLocal(holiday)
      setEditingId(null)
      notify.success('บันทึกการแก้ไขสำเร็จ')
    } catch (err) {
      notify.error('บันทึกไม่สำเร็จ', err instanceof Error ? err.message : undefined)
    } finally {
      setSavingEdit(false)
    }
  }

  async function handleDelete(holiday: Holiday) {
    if (!confirm(`ลบ "${holiday.holidayName}" (${formatThaiDate(holiday.holidayDate)})?`)) return
    setDeletingId(holiday.id)
    try {
      await deleteHoliday(holiday.id)
      setState((prev) =>
        prev.phase === 'ok'
          ? { phase: 'ok', holidays: prev.holidays.filter((h) => h.id !== holiday.id) }
          : prev
      )
      notify.success('ลบวันหยุดสำเร็จ')
    } catch (err) {
      notify.error('ลบไม่สำเร็จ', err instanceof Error ? err.message : undefined)
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <section className={`${card} mb-4`}>
      <h2 className="mb-5 border-b border-slate-200 pb-3 text-xs font-bold tracking-wider text-slate-500 uppercase">
        รายการวันหยุด
      </h2>

      {state.phase === 'loading' && <p className={muted}>กำลังโหลด…</p>}

      {state.phase === 'error' && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>โหลดข้อมูลไม่สำเร็จ</p>
          <p className={alertDetail}>{state.message}</p>
        </div>
      )}

      {state.phase === 'ok' && (
        <>
          {state.holidays.length === 0 ? (
            <p className={`mb-4 ${muted}`}>ยังไม่มีวันหยุดในกลุ่มนี้</p>
          ) : (
            <div className="mb-4 overflow-hidden rounded-md border border-slate-200">
              <table className="w-full border-collapse text-[0.825rem] [&_tbody_tr:last-child_td]:border-b-0">
                <thead>
                  <tr>
                    {['วันที่', 'ชื่อวันหยุด', ''].map((h) => (
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
                  {state.holidays.map((holiday) => (
                    <tr key={holiday.id}>
                      {editingId === holiday.id ? (
                        <>
                          <td className="border-b border-slate-200 px-3.5 py-2 align-middle">
                            <DatePicker
                              required
                              value={editDraft.holidayDate}
                              onChange={(v) =>
                                setEditDraft((prev) => ({ ...prev, holidayDate: v }))
                              }
                            />
                          </td>
                          <td className="border-b border-slate-200 px-3.5 py-2 align-middle">
                            <input
                              required
                              className={fieldControl}
                              value={editDraft.holidayName}
                              onChange={(e) =>
                                setEditDraft((prev) => ({ ...prev, holidayName: e.target.value }))
                              }
                            />
                          </td>
                          <td className="border-b border-slate-200 px-3.5 py-2 align-middle whitespace-nowrap">
                            <button
                              type="button"
                              className={button('primary')}
                              disabled={savingEdit}
                              onClick={() => void saveEdit(holiday.id)}
                            >
                              บันทึก
                            </button>
                            <button
                              type="button"
                              className={`${button()} ml-2`}
                              disabled={savingEdit}
                              onClick={() => setEditingId(null)}
                            >
                              ยกเลิก
                            </button>
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="border-b border-slate-200 px-3.5 py-2 align-middle whitespace-nowrap text-slate-600">
                            {formatThaiDate(holiday.holidayDate)}
                          </td>
                          <td className="border-b border-slate-200 px-3.5 py-2 align-middle font-medium text-slate-900">
                            {holiday.holidayName}
                          </td>
                          <td className="border-b border-slate-200 px-3.5 py-2 align-middle whitespace-nowrap">
                            {canWrite && (
                              <div>
                                <button
                                  type="button"
                                  className={button() + "min-h-full"}
                                  onClick={() => startEdit(holiday)}
                                >
                                  แก้ไข
                                </button>
                                <button
                                  type="button"
                                  className={`${button('danger')} ml-2 min-h-full`}
                                  disabled={deletingId === holiday.id}
                                  onClick={() => void handleDelete(holiday)}
                                  aria-label={`ลบ ${holiday.holidayName}`}
                                >
                                  <Trash2 size={14} />
                                </button>
                              </div>
                            )}
                          </td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {canWrite && (
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(e) => void handleAdd(e)}
            >
              <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-slate-600">
                <span>วันที่หยุด</span>
                <DatePicker
                  required
                  value={draft.holidayDate}
                  onChange={(v) => setDraft((prev) => ({ ...prev, holidayDate: v }))}
                />
              </label>
              <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-xs font-medium text-slate-600">
                <span>ชื่อวันหยุด</span>
                <input
                  required
                  className={fieldControl}
                  value={draft.holidayName}
                  onChange={(e) => setDraft((prev) => ({ ...prev, holidayName: e.target.value }))}
                />
              </label>
              <button className={button('primary')} type="submit" disabled={adding}>
                {adding ? 'กำลังเพิ่ม…' : 'เพิ่มวันหยุด'}
              </button>
            </form>
          )}
        </>
      )}
    </section>
  )
}
