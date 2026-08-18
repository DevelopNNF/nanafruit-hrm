import { useEffect, useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import type { EmployeeFinanceItem, EmployeeFinanceItemInput, FinanceItem } from '@hrm/shared'
import {
  createEmployeeFinanceItem,
  listEmployeeFinanceItems,
  updateEmployeeFinanceItem,
} from '../api/employeeFinanceItems'
import { listFinanceItems } from '../api/financeItems'
import { DatePicker } from './DatePicker'
import { FINANCE_ITEM_TYPE_LABELS, FINANCE_ITEM_TYPE_TONE } from './financeItemLabels'
import { notify } from '../notifications/notify'
import { alert, alertDetail, alertTitle, badge, button, card, fieldControl, muted } from '../styles'

type State =
  | { phase: 'loading' }
  | { phase: 'ok'; lines: EmployeeFinanceItem[]; masters: FinanceItem[] }
  | { phase: 'error'; message: string }

const emptyDraft: EmployeeFinanceItemInput = {
  financeItemId: 0,
  amount: 0,
  effectiveFrom: '',
  effectiveTo: null,
  note: null,
}

/** Thai date, e.g. "1 ม.ค. 2569" — matches DatePicker's own display, so a
 *  saved date and the picker that produced it read the same way. */
function formatThaiDate(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00`).toLocaleDateString('th-TH-u-ca-buddhist', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

function formatAmount(amount: number): string {
  return amount.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** Local calendar day as 'YYYY-MM-DD'. Deliberately not toISOString(), which
 *  converts to UTC first and lands on the wrong day for part of every
 *  evening in UTC+7. */
function todayISO(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/** Used only to total up what is in force right now, for the footer. There is
 *  deliberately no per-row status badge: the dates are what payroll reads, and
 *  a second rendering of them invites the reading that the badge is the thing
 *  being stored. */
function appliesOn(line: EmployeeFinanceItem, date: string): boolean {
  if (line.effectiveFrom > date) return false
  return line.effectiveTo === null || line.effectiveTo >= date
}

const cellClass = 'border-b border-slate-200 px-3.5 py-2 align-middle'
const headClass =
  'border-b border-slate-200 bg-slate-50 px-3.5 py-2 text-left text-[0.675rem] font-semibold tracking-wider text-slate-500 uppercase whitespace-nowrap'

const COLUMNS = ['รายการ', 'ประเภท', 'ยอดเงิน', 'วันที่เริ่ม', 'วันที่สิ้นสุด', 'หมายเหตุ', '']

function missingFields(draft: EmployeeFinanceItemInput): string[] {
  const missing: string[] = []
  if (draft.financeItemId <= 0) missing.push('รายการ')
  if (draft.amount <= 0) missing.push('ยอดเงิน')
  if (!draft.effectiveFrom) missing.push('วันที่เริ่ม')
  return missing
}

function draftFrom(line: EmployeeFinanceItem): EmployeeFinanceItemInput {
  return {
    financeItemId: line.financeItemId,
    amount: line.amount,
    effectiveFrom: line.effectiveFrom,
    effectiveTo: line.effectiveTo,
    note: line.note,
  }
}

function sortLines(lines: EmployeeFinanceItem[]): EmployeeFinanceItem[] {
  const rank: Record<EmployeeFinanceItem['itemType'], number> = {
    income: 1,
    deduction: 2,
    tax: 3,
  }
  return [...lines].sort(
    (a, b) =>
      rank[a.itemType] - rank[b.itemType] ||
      a.itemCode.localeCompare(b.itemCode) ||
      a.effectiveFrom.localeCompare(b.effectiveFrom)
  )
}

/**
 * Card 3 of the employee finance tab: the dated income and deduction lines
 * that feed payroll, on top of the wage and tax settings in the two cards
 * above.
 *
 * Adding and editing are the same thing here — both are a row of inputs in
 * the table, so a new line is entered in the columns it will live in rather
 * than in a separate form laid out differently.
 *
 * This card renders *inside* the finance tab's wage <form>, so that tab's
 * save button can sit at the bottom of the page. Three things are what make
 * that safe, and all three have to stay true:
 *   - it contains no <form> of its own (a <form> inside a <form> is invalid),
 *   - every button in it is type="button", or it would submit the wage form,
 *   - Enter in a row's own inputs is caught here (see DraftCells), because a
 *     text input inside a form submits it on Enter — which would save the
 *     wage card while the row being typed stayed unsaved.
 */
export function EmployeeFinanceItemsCard({
  employeeId,
  canWrite,
}: {
  employeeId: number
  canWrite: boolean
}) {
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [addDraft, setAddDraft] = useState<EmployeeFinanceItemInput>(emptyDraft)
  const [addingRow, setAddingRow] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState<EmployeeFinanceItemInput>(emptyDraft)

  useEffect(() => {
    const controller = new AbortController()

    Promise.all([
      listEmployeeFinanceItems(employeeId, controller.signal),
      listFinanceItems(controller.signal),
    ])
      .then(([lines, masters]) => setState({ phase: 'ok', lines, masters }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'request failed',
        })
      })

    return () => controller.abort()
  }, [employeeId])

  const today = useMemo(() => todayISO(), [])

  // Totals count only what is in force today: a figure that included a line
  // which ended last year would not be a number anyone could act on.
  const totals = useMemo(() => {
    if (state.phase !== 'ok') return { income: 0, outgoing: 0 }
    let income = 0
    let outgoing = 0
    for (const line of state.lines) {
      if (!appliesOn(line, today)) continue
      if (line.itemType === 'income') income += line.amount
      else outgoing += line.amount
    }
    return { income, outgoing }
  }, [state, today])

  function upsertLocal(line: EmployeeFinanceItem) {
    setState((prev) => {
      if (prev.phase !== 'ok') return prev
      const others = prev.lines.filter((l) => l.id !== line.id)
      return { ...prev, lines: sortLines([...others, line]) }
    })
  }

  // Only one row is ever open for input. Starting one closes the other, so
  // there is never a screen with two sets of บันทึก buttons and no way to tell
  // which one a keystroke is going into.
  function startAdd() {
    setEditingId(null)
    setAddDraft(emptyDraft)
    setAddingRow(true)
  }

  function startEdit(line: EmployeeFinanceItem) {
    setAddingRow(false)
    setEditingId(line.id)
    setEditDraft(draftFrom(line))
  }

  async function saveAdd() {
    const missing = missingFields(addDraft)
    if (missing.length > 0) {
      notify.error('กรอกข้อมูลไม่ครบ', `กรุณากรอก: ${missing.join(', ')}`)
      return
    }
    setSaving(true)
    try {
      const line = await createEmployeeFinanceItem(employeeId, addDraft)
      upsertLocal(line)
      setAddingRow(false)
      setAddDraft(emptyDraft)
      notify.success('เพิ่มรายการสำเร็จ')
    } catch (err) {
      // The overlap rejection (409) arrives here with the server's Thai
      // sentence, which is the whole reason that constraint has one. The row
      // stays open so the dates can be corrected rather than retyped.
      notify.error('เพิ่มรายการไม่สำเร็จ', err instanceof Error ? err.message : undefined)
    } finally {
      setSaving(false)
    }
  }

  async function saveEdit(lineId: number) {
    const missing = missingFields(editDraft)
    if (missing.length > 0) {
      notify.error('กรอกข้อมูลไม่ครบ', `กรุณากรอก: ${missing.join(', ')}`)
      return
    }
    setSaving(true)
    try {
      const line = await updateEmployeeFinanceItem(employeeId, lineId, editDraft)
      upsertLocal(line)
      setEditingId(null)
      notify.success('บันทึกการแก้ไขสำเร็จ')
    } catch (err) {
      notify.error('บันทึกไม่สำเร็จ', err instanceof Error ? err.message : undefined)
    } finally {
      setSaving(false)
    }
  }

  const ready = state.phase === 'ok'
  const showTable = ready && (state.lines.length > 0 || addingRow)

  return (
    <section className={`${card} mb-4`}>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3">
        <h2 className="text-xs font-bold tracking-wider text-slate-500 uppercase">
          รายรับรายจ่าย (Income &amp; deductions)
        </h2>
        {ready && canWrite && (
          <button
            type="button"
            className={button('primary')}
            disabled={addingRow}
            onClick={startAdd}
          >
            <Plus size={16} />
            เพิ่มรายการ
          </button>
        )}
      </div>

      {state.phase === 'loading' && <p className={muted}>กำลังโหลด…</p>}

      {state.phase === 'error' && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>โหลดรายรับรายจ่ายไม่สำเร็จ</p>
          <p className={alertDetail}>{state.message}</p>
        </div>
      )}

      {ready && (
        <>
          <p className={`mb-4 ${muted}`}>
            ช่วงวันที่เป็นตัวกำหนดว่ารายการนั้นจะถูกคำนวณในงวดใดบ้าง เว้นวันที่สิ้นสุดไว้ได้ถ้ายังไม่มีกำหนด
            รายการเดียวกันมีช่วงเวลาทับซ้อนกันไม่ได้
          </p>

          {!showTable && (
            <p className={muted}>
              ยังไม่มีรายการรายรับรายจ่ายของพนักงานคนนี้
              {canWrite && ' — กด “เพิ่มรายการ” เพื่อเริ่มต้น'}
            </p>
          )}

          {showTable && (
            <div className="overflow-x-auto rounded-md border border-slate-200">
              <table className="w-full border-collapse text-[0.825rem]">
                <thead>
                  <tr>
                    {COLUMNS.map((h, i) => (
                      <th key={h || `blank-${i}`} className={headClass}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {state.lines.map((line) =>
                    editingId === line.id ? (
                      <tr key={line.id}>
                        <DraftCells
                          masters={state.masters}
                          draft={editDraft}
                          saving={saving}
                          onChange={setEditDraft}
                          onEnterSave={() => void saveEdit(line.id)}
                        />
                        <td className={`${cellClass} whitespace-nowrap`}>
                          <RowActions
                            saving={saving}
                            onSave={() => void saveEdit(line.id)}
                            onCancel={() => setEditingId(null)}
                          />
                        </td>
                      </tr>
                    ) : (
                      <tr key={line.id}>
                        <td className={`${cellClass} font-medium text-slate-900`}>
                          {line.itemName}
                          <span className="ml-2 font-mono text-[0.7rem] text-slate-500">
                            {line.itemCode}
                          </span>
                        </td>
                        <td className={cellClass}>
                          <span className={badge(FINANCE_ITEM_TYPE_TONE[line.itemType])}>
                            {FINANCE_ITEM_TYPE_LABELS[line.itemType]}
                          </span>
                        </td>
                        <td className={`${cellClass} text-slate-900 tabular-nums`}>
                          {formatAmount(line.amount)}
                        </td>
                        <td className={`${cellClass} whitespace-nowrap text-slate-600`}>
                          {formatThaiDate(line.effectiveFrom)}
                        </td>
                        <td className={`${cellClass} whitespace-nowrap text-slate-600`}>
                          {line.effectiveTo === null ? (
                            <span className="text-slate-400">ไม่มีกำหนด</span>
                          ) : (
                            formatThaiDate(line.effectiveTo)
                          )}
                        </td>
                        <td className={`${cellClass} max-w-56 text-slate-600`}>
                          {line.note ?? <span className="text-slate-400">—</span>}
                        </td>
                        <td className={`${cellClass} whitespace-nowrap`}>
                          {canWrite && (
                            <button
                              type="button"
                              className={button()}
                              onClick={() => startEdit(line)}
                            >
                              แก้ไข
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  )}

                  {addingRow && (
                    <tr className="bg-navy/4">
                      <DraftCells
                        masters={state.masters}
                        draft={addDraft}
                        saving={saving}
                        onChange={setAddDraft}
                        onEnterSave={() => void saveAdd()}
                      />
                      <td className={`${cellClass} whitespace-nowrap`}>
                        <RowActions
                          saving={saving}
                          onSave={() => void saveAdd()}
                          onCancel={() => setAddingRow(false)}
                        />
                      </td>
                    </tr>
                  )}
                </tbody>

                {state.lines.length > 0 && (
                  <tfoot>
                    <tr>
                      <td
                        colSpan={COLUMNS.length}
                        className="bg-slate-50 px-3.5 py-2 text-[0.775rem] text-slate-600"
                      >
                        ยอดรวมที่มีผล ณ วันนี้ — รายรับ{' '}
                        <span className="font-semibold text-slate-900 tabular-nums">
                          {formatAmount(totals.income)}
                        </span>{' '}
                        / รายการหักและภาษี{' '}
                        <span className="font-semibold text-slate-900 tabular-nums">
                          {formatAmount(totals.outgoing)}
                        </span>
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
        </>
      )}
    </section>
  )
}

/** The six input cells shared by the add row and an edit row — one definition
 *  so the two can never drift into offering different fields. */
function DraftCells({
  masters,
  draft,
  saving,
  onChange,
  onEnterSave,
}: {
  masters: FinanceItem[]
  draft: EmployeeFinanceItemInput
  saving: boolean
  onChange: (update: (prev: EmployeeFinanceItemInput) => EmployeeFinanceItemInput) => void
  onEnterSave: () => void
}) {
  /**
   * Enter saves this row, and never reaches the wage <form> this card sits
   * inside — where it would otherwise trigger implicit submission and save
   * the wage card instead, leaving the row still unsaved.
   *
   * Bound to the individual controls rather than a wrapping element on
   * purpose: React events bubble through the component tree, not the DOM
   * one, so a handler on an ancestor would also catch Enter pressed on a day
   * inside DatePicker's portalled calendar and save the row half-typed.
   */
  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key !== 'Enter') return
    event.preventDefault()
    if (saving) return
    onEnterSave()
  }

  return (
    <>
      <td className={cellClass}>
        <ItemSelect
          masters={masters}
          value={draft.financeItemId}
          onKeyDown={handleKeyDown}
          onChange={(v) => onChange((prev) => ({ ...prev, financeItemId: v }))}
        />
      </td>
      <td className={cellClass}>
        {/* Read-only on purpose: the type is whatever the chosen item's is. */}
        <TypeBadge masters={masters} financeItemId={draft.financeItemId} />
      </td>
      <td className={cellClass}>
        <input
          type="number"
          step="0.01"
          min="0.01"
          inputMode="decimal"
          aria-label="ยอดเงิน"
          className={`${fieldControl} w-28`}
          value={draft.amount || ''}
          onKeyDown={handleKeyDown}
          onChange={(e) =>
            onChange((prev) => ({
              ...prev,
              amount: e.target.value === '' ? 0 : Number(e.target.value),
            }))
          }
        />
      </td>
      <td className={cellClass}>
        <DatePicker
          value={draft.effectiveFrom}
          onChange={(v) => onChange((prev) => ({ ...prev, effectiveFrom: v }))}
        />
      </td>
      <td className={cellClass}>
        <DatePicker
          value={draft.effectiveTo ?? ''}
          min={draft.effectiveFrom || undefined}
          onChange={(v) => onChange((prev) => ({ ...prev, effectiveTo: v || null }))}
        />
      </td>
      <td className={cellClass}>
        <input
          aria-label="หมายเหตุ"
          className={`${fieldControl} w-44`}
          value={draft.note ?? ''}
          onKeyDown={handleKeyDown}
          onChange={(e) => onChange((prev) => ({ ...prev, note: e.target.value || null }))}
        />
      </td>
    </>
  )
}

function RowActions({
  saving,
  onSave,
  onCancel,
}: {
  saving: boolean
  onSave: () => void
  onCancel: () => void
}) {
  return (
    <>
      <button type="button" className={button('primary')} disabled={saving} onClick={onSave}>
        {saving ? 'กำลังบันทึก…' : 'บันทึก'}
      </button>
      <button type="button" className={`${button()} ml-2`} disabled={saving} onClick={onCancel}>
        ยกเลิก
      </button>
    </>
  )
}

/** Offers the active master items, plus whichever one this row already points
 *  at — otherwise editing a line whose item was later retired would silently
 *  swap it for something else the moment the select rendered. */
function ItemSelect({
  masters,
  value,
  onChange,
  onKeyDown,
}: {
  masters: FinanceItem[]
  value: number
  onChange: (value: number) => void
  onKeyDown?: (event: React.KeyboardEvent) => void
}) {
  const options = masters.filter((m) => m.isActive || m.id === value)
  return (
    <select
      aria-label="รายการ"
      className={`${fieldControl} w-44`}
      value={value || ''}
      onKeyDown={onKeyDown}
      onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))}
    >
      <option value="" disabled>
        — โปรดระบุ —
      </option>
      {options.map((item) => (
        <option key={item.id} value={item.id}>
          {item.itemName}
          {item.isActive ? '' : ' (ปิดใช้งาน)'}
        </option>
      ))}
    </select>
  )
}

function TypeBadge({ masters, financeItemId }: { masters: FinanceItem[]; financeItemId: number }) {
  const item = masters.find((m) => m.id === financeItemId)
  if (!item) return <span className="text-slate-400">—</span>
  return (
    <span className={badge(FINANCE_ITEM_TYPE_TONE[item.itemType])}>
      {FINANCE_ITEM_TYPE_LABELS[item.itemType]}
    </span>
  )
}
