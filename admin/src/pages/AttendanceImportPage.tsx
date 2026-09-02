import { useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, Pencil, RotateCcw } from 'lucide-react'
import type {
  AttendanceEventType,
  AttendanceImportEmployeePreview,
  AttendanceImportOverride,
  AttendanceImportPreview,
  AttendanceImportPunchPreview,
} from '@hrm/shared'
import { commitAttendanceImport, previewAttendanceImport } from '../api/attendanceImport'
import { useCanWrite } from '../auth/meContext'
import { notify } from '../notifications/notify'
import { DatePicker } from '../components/DatePicker'
import { Pagination } from '../components/Pagination'
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover'
import {
  alert,
  alertDetail,
  alertTitle,
  badge,
  button,
  card,
  eyebrow,
  link,
  muted,
  pageHead,
  subtitle,
} from '../styles'

type Phase =
  | { name: 'idle' }
  | { name: 'previewing' }
  | { name: 'ready'; preview: AttendanceImportPreview; revalidating: boolean }
  | { name: 'importing'; preview: AttendanceImportPreview }

const th =
  'border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-left text-[0.675rem] font-semibold tracking-wider text-slate-500 uppercase whitespace-nowrap'
const td = 'border-b border-slate-200 px-4 py-2.5 align-top text-[0.825rem] text-slate-600'

const EMPLOYEE_PAGE_SIZE_OPTIONS = [20, 50, 100, 200] as const
const DEFAULT_EMPLOYEE_PAGE_SIZE = 20

function overrideKey(fingerprintCode: string, eventTime: string): string {
  return `${fingerprintCode}|${eventTime}`
}

function formatDate(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString('th-TH', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

function formatDateShort(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString('th-TH', {
    day: 'numeric',
    month: 'short',
  })
}

/** Calendar arithmetic only — deliberately UTC-anchored so it can't drift a
 *  day depending on the viewer's own timezone, unlike formatDate's local-time
 *  parse (which is fine there because it only ever displays, never adds). */
function addDays(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + delta)
  return d.toISOString().slice(0, 10)
}

/** Wall-clock in Thailand — the terminal's own reading, so it should show as
 *  the sheet showed it whatever the browser's timezone is. */
function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('th-TH', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Bangkok',
  })
}

function typeLabel(type: AttendanceEventType): string {
  return type === 'check_in' ? 'เข้า' : 'ออก'
}

type PunchEdit = { eventType: AttendanceEventType; workDate: string }

/**
 * The correction form inside a punch's popover.
 *
 * `base` is what the classifier itself would read this punch as — the
 * override-free answer — shown so HR can see what is being second-guessed,
 * and used as the "คืนค่าเดิม" target. It is not necessarily `punch`'s own
 * current eventType/workDate, which may already be someone's earlier
 * override.
 */
function PunchEditorForm({
  punch,
  base,
  onCancel,
  onSave,
}: {
  punch: AttendanceImportPunchPreview
  base: PunchEdit
  onCancel: () => void
  onSave: (next: PunchEdit) => void
}) {
  const [draft, setDraft] = useState<PunchEdit>({ eventType: punch.eventType, workDate: punch.workDate })
  const [customDate, setCustomDate] = useState(false)

  const prevDate = addDays(punch.workDate, -1)
  const nextDate = addDays(punch.workDate, 1)
  const dateOptions = [
    { value: prevDate, label: 'วันก่อนหน้า', sub: formatDateShort(prevDate) },
    { value: punch.workDate, label: 'วันเดิม', sub: formatDateShort(punch.workDate) },
    { value: nextDate, label: 'วันถัดไป', sub: formatDateShort(nextDate) },
  ]
  const isCustomDate = customDate || !dateOptions.some((o) => o.value === draft.workDate)
  const isDirty = draft.eventType !== base.eventType || draft.workDate !== base.workDate

  return (
    <div className="flex w-72 flex-col gap-3">
      <div>
        <p className="text-[0.825rem] font-bold text-slate-900">
          แก้ไขการตีความ · {formatTime(punch.eventTime)} น.
        </p>
        <p className="mt-0.5 text-[0.75rem] text-slate-500">
          อ่านจากไฟล์ว่าเป็น <span className="font-semibold text-slate-700">{typeLabel(base.eventType)}</span>{' '}
          ของกะวันที่ <span className="font-semibold text-slate-700">{formatDate(base.workDate)}</span>
        </p>
      </div>

      <div>
        <p className={eyebrow}>ย้ายไปวันที่</p>
        <div className="flex overflow-hidden rounded-md border border-slate-300">
          {dateOptions.map((option, i) => (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                setDraft((d) => ({ ...d, workDate: option.value }))
                setCustomDate(false)
              }}
              className={`flex-1 px-1 py-1.5 text-center text-[0.75rem] leading-tight font-medium ${
                i > 0 ? 'border-l border-slate-300' : ''
              } ${
                !isCustomDate && draft.workDate === option.value
                  ? 'bg-navy text-white'
                  : 'bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              {option.label}
              <span className="block text-[0.65rem] opacity-75">{option.sub}</span>
            </button>
          ))}
        </div>
        <div className="mt-1.5">
          {isCustomDate ? (
            <DatePicker
              value={draft.workDate}
              onChange={(value) => setDraft((d) => ({ ...d, workDate: value }))}
              className="w-full"
            />
          ) : (
            <button
              type="button"
              className="text-[0.75rem] font-semibold text-navy hover:underline"
              onClick={() => setCustomDate(true)}
            >
              เลือกวันที่อื่น…
            </button>
          )}
        </div>
      </div>

      <div>
        <p className={eyebrow}>ประเภท</p>
        <div className="flex overflow-hidden rounded-md border border-slate-300">
          {(['check_in', 'check_out'] as const).map((type, i) => (
            <button
              key={type}
              type="button"
              onClick={() => setDraft((d) => ({ ...d, eventType: type }))}
              className={`flex-1 px-2 py-1.5 text-[0.75rem] font-medium ${i > 0 ? 'border-l border-slate-300' : ''} ${
                draft.eventType === type ? 'bg-navy text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              {typeLabel(type)}
            </button>
          ))}
        </div>
      </div>

      <p className="rounded-md border border-navy/15 bg-navy/7 px-2.5 py-2 text-[0.775rem] text-slate-700">
        จะบันทึกเป็น: <span className="font-semibold text-navy">{typeLabel(draft.eventType)}</span> ของกะวันที่{' '}
        <span className="font-semibold text-navy">{formatDate(draft.workDate)}</span>
      </p>

      <div className="flex items-center gap-3">
        {isDirty && (
          <button
            type="button"
            className="flex items-center gap-1 text-[0.775rem] text-slate-500 hover:text-slate-700"
            onClick={() => {
              setDraft(base)
              setCustomDate(false)
            }}
          >
            <RotateCcw size={12} /> คืนค่าเดิม
          </button>
        )}
        <span className="flex-1" />
        <button type="button" className={button()} onClick={onCancel}>
          ยกเลิก
        </button>
        <button type="button" className={button('primary')} onClick={() => onSave(draft)}>
          บันทึก
        </button>
      </div>

      <p className="text-[0.7rem] leading-relaxed text-slate-400">
        เวลาที่บันทึกจริง ({formatTime(punch.eventTime)} น.) จะไม่เปลี่ยน — เปลี่ยนแค่การตีความว่าเป็นเข้าหรือออกของกะวันไหน
      </p>
    </div>
  )
}

/** One punch chip. A duplicate is plain text — it will be skipped on import
 *  regardless of how it is read, so there is nothing here worth correcting.
 *  Everything else opens a popover to correct the system's in/out or
 *  work-date reading. */
function PunchChip({
  employee,
  punch,
  disabled,
  onSave,
}: {
  employee: AttendanceImportEmployeePreview
  punch: AttendanceImportPunchPreview
  disabled: boolean
  onSave: (fingerprintCode: string, punch: AttendanceImportPunchPreview, next: PunchEdit) => void
}) {
  const [open, setOpen] = useState(false)
  const base: PunchEdit =
    punch.overridden && punch.original ? punch.original : { eventType: punch.eventType, workDate: punch.workDate }

  const chipClass = `inline-flex items-baseline gap-1 rounded px-1.5 py-0.5 text-[0.775rem] tabular-nums border ${
    punch.duplicate
      ? 'border-transparent text-slate-400 line-through'
      : punch.eventType === 'check_in'
        ? 'bg-green-50 text-green-800'
        : 'bg-slate-100 text-slate-700'
  } ${punch.overridden ? 'border-dashed border-navy' : 'border-transparent'}`

  const content = (
    <>
      {formatTime(punch.eventTime)}
      <span className="text-[0.675rem] opacity-70">{typeLabel(punch.eventType)}</span>
      {!punch.matchedShift && !punch.overridden && <span className="text-[0.675rem] text-amber-700">*</span>}
      {punch.overridden && <Pencil size={10} className="ml-0.5 text-navy" />}
    </>
  )

  if (punch.duplicate) {
    return (
      <span className={chipClass} title="มีรายการนี้อยู่แล้ว จะถูกข้าม">
        {content}
      </span>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={`${chipClass} cursor-pointer hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-70`}
          title={
            punch.overridden
              ? `แก้ไขแล้ว — เดิม ${typeLabel(base.eventType)} · ${formatDateShort(base.workDate)}`
              : punch.matchedShift
                ? 'คลิกเพื่อแก้ไขการตีความ'
                : 'ไม่ตรงกับกะใด — ตีความจากวันปฏิทิน · คลิกเพื่อแก้ไข'
          }
        >
          {content}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start">
        <PunchEditorForm
          punch={punch}
          base={base}
          onCancel={() => setOpen(false)}
          onSave={(next) => {
            onSave(employee.fingerprintCode, punch, next)
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

/** One employee's punches, grouped by the work-date they were attributed to —
 *  which for an overnight shift is not the day they happened on, and that is
 *  precisely what HR is here to check (and, now, to correct). */
function EmployeePunches({
  employee,
  disabled,
  onSavePunch,
}: {
  employee: AttendanceImportEmployeePreview
  disabled: boolean
  onSavePunch: (fingerprintCode: string, punch: AttendanceImportPunchPreview, next: PunchEdit) => void
}) {
  const byWorkDate = new Map<string, AttendanceImportEmployeePreview['punches']>()
  for (const punch of employee.punches) {
    const group = byWorkDate.get(punch.workDate) ?? []
    group.push(punch)
    byWorkDate.set(punch.workDate, group)
  }

  return (
    <div className="flex flex-col gap-1.5">
      {[...byWorkDate.entries()].map(([workDate, punches]) => (
        <div key={workDate} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="w-28 shrink-0 text-[0.775rem] text-slate-500 tabular-nums">
            {formatDate(workDate)}
          </span>
          {punches.map((punch) => (
            <PunchChip
              key={punch.eventTime}
              employee={employee}
              punch={punch}
              disabled={disabled}
              onSave={onSavePunch}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

/**
 * Loading a fingerprint terminal's Excel export.
 *
 * Deliberately two steps with a full preview in between. Nothing in the sheet
 * says whether a punch is an arrival or a departure — the server infers it from
 * the employee's shift, and for an overnight shift the answer is genuinely
 * surprising (a 02:00 punch closes the previous work-date). This screen is the
 * only place that inference is visible before the events are in an append-only
 * ledger for good.
 *
 * The classifier's own buffer (MATCH_BUFFER_MINUTES) only reaches so far —
 * OT that runs past it gets attributed to the wrong work-date or the wrong
 * in/out, and no amount of buffer tuning covers every case (a forgotten
 * clock-out throws off everything after it in the same session). So punches
 * are editable here: HR's correction is sent back as an `overrides` list
 * alongside the file on both preview and confirm, re-applied on top of a
 * fresh classification each time rather than trusted as a finished answer —
 * see attendanceImport.ts's module comment for why.
 */
export function AttendanceImportPage() {
  const canWrite = useCanWrite()
  const navigate = useNavigate()
  const fileInput = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [phase, setPhase] = useState<Phase>({ name: 'idle' })
  const [error, setError] = useState<string | null>(null)
  const [overrides, setOverrides] = useState<Map<string, AttendanceImportOverride>>(new Map())
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(DEFAULT_EMPLOYEE_PAGE_SIZE)

  function chooseFile(chosen: File | null) {
    setFile(chosen)
    setPhase({ name: 'idle' })
    setError(null)
    setOverrides(new Map())
    setPage(1)
  }

  async function handlePreview() {
    if (!file) return
    setPhase({ name: 'previewing' })
    setError(null)
    try {
      const preview = await previewAttendanceImport(file, [...overrides.values()])
      setPhase({ name: 'ready', preview, revalidating: false })
      setPage(1)
    } catch (err) {
      setPhase({ name: 'idle' })
      setError(err instanceof Error ? err.message : 'อ่านไฟล์ไม่สำเร็จ')
    }
  }

  /** Re-runs the preview against a changed overrides list — the server stays
   *  the single source of truth for duplicate/matched-shift status, which can
   *  itself change once a punch's eventType is corrected, so this is a real
   *  re-derivation rather than a client-side patch of the existing table. */
  async function applyOverrideChange(next: Map<string, AttendanceImportOverride>) {
    if (!file || phase.name !== 'ready') return
    const previous = overrides
    setOverrides(next)
    setPhase({ name: 'ready', preview: phase.preview, revalidating: true })
    setError(null)
    try {
      const preview = await previewAttendanceImport(file, [...next.values()])
      setPhase({ name: 'ready', preview, revalidating: false })
    } catch (err) {
      setOverrides(previous)
      setPhase({ name: 'ready', preview: phase.preview, revalidating: false })
      setError(err instanceof Error ? err.message : 'บันทึกการแก้ไขไม่สำเร็จ')
    }
  }

  function handleSavePunch(fingerprintCode: string, punch: AttendanceImportPunchPreview, next: PunchEdit) {
    const base: PunchEdit =
      punch.overridden && punch.original ? punch.original : { eventType: punch.eventType, workDate: punch.workDate }
    const key = overrideKey(fingerprintCode, punch.eventTime)
    const nextOverrides = new Map(overrides)
    if (next.eventType === base.eventType && next.workDate === base.workDate) {
      nextOverrides.delete(key)
    } else {
      nextOverrides.set(key, { fingerprintCode, eventTime: punch.eventTime, ...next })
    }
    void applyOverrideChange(nextOverrides)
  }

  async function handleImport(preview: AttendanceImportPreview) {
    if (!file) return
    setPhase({ name: 'importing', preview })
    setError(null)
    try {
      const result = await commitAttendanceImport(file, [...overrides.values()])
      notify.success(
        'นำเข้าการลงเวลาสำเร็จ',
        `บันทึก ${result.importedCount} รายการ สำหรับพนักงาน ${result.employeeCount} คน` +
          (result.skippedDuplicateCount > 0 ? ` (ข้ามรายการซ้ำ ${result.skippedDuplicateCount})` : '') +
          (result.recomputed ? '' : ' — รายงานการลงเวลาจะคำนวณใหม่ในรอบถัดไป')
      )
      navigate('/attendance')
    } catch (err) {
      setPhase({ name: 'ready', preview, revalidating: false })
      setError(err instanceof Error ? err.message : 'นำเข้าไม่สำเร็จ')
    }
  }

  const preview = phase.name === 'ready' || phase.name === 'importing' ? phase.preview : null
  const revalidating = phase.name === 'ready' && phase.revalidating
  const busy = phase.name === 'previewing' || phase.name === 'importing'

  const pageStart = (page - 1) * pageSize
  const pageEmployees = preview ? preview.employees.slice(pageStart, pageStart + pageSize) : []

  // Unlike most screens, there is nothing here to read without the right to
  // write — even the preview is an HR/Admin route, so a Viewer would only ever
  // get a 403 out of the upload button.
  if (!canWrite) {
    return (
      <>
        <header className={pageHead}>
          <div>
            <p className={eyebrow}>Time Attendance</p>
            <h1>นำเข้าการลงเวลา</h1>
          </div>
          <Link className={button()} to="/attendance">
            <ArrowLeft size={16} /> กลับไปหน้าการลงเวลา
          </Link>
        </header>
        <div className={alert('default')}>
          <p className={alertTitle()}>ไม่มีสิทธิ์นำเข้าการลงเวลา</p>
          <p className={muted}>เฉพาะ HR และผู้ดูแลระบบเท่านั้นที่นำเข้าข้อมูลได้</p>
        </div>
      </>
    )
  }

  return (
    <>
      <header className={pageHead}>
        <div>
          <p className={eyebrow}>Time Attendance</p>
          <h1>นำเข้าการลงเวลา</h1>
          <p className={subtitle}>
            นำเข้าไฟล์รายงานการลงเวลา (.xlsx) จากเครื่องสแกนลายนิ้วมือ
          </p>
        </div>
        <Link className={button()} to="/attendance">
          <ArrowLeft size={16} /> กลับไปหน้าการลงเวลา
        </Link>
      </header>

      {error && (
        <div className={alert('danger')}>
          <p className={alertTitle('danger')}>ทำรายการไม่สำเร็จ</p>
          <p className={alertDetail}>{error}</p>
        </div>
      )}

      <section className={`${card} mb-4`}>
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={fileInput}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="text-[0.825rem] text-slate-600 file:mr-3 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-3.5 file:py-2 file:text-sm file:font-medium file:text-slate-900 hover:file:bg-slate-50"
            onChange={(e) => chooseFile(e.target.files?.[0] ?? null)}
            disabled={busy}
          />
          <button
            type="button"
            className={button('primary')}
            disabled={!file || busy}
            onClick={() => void handlePreview()}
          >
            {phase.name === 'previewing' ? 'กำลังอ่านไฟล์…' : 'ตรวจสอบไฟล์'}
          </button>
        </div>
        <p className={`${muted} mt-3`}>
          เคล็ดลับ: สำหรับพนักงานกะข้ามคืน เวลาออกงานของคืนสุดท้ายจะไปอยู่ในไฟล์รอบถัดไป
          แนะนำให้ export ช่วงวันที่คาบเกี่ยวกับรอบก่อนหน้า 1 วันเสมอ — รายการที่ซ้ำจะถูกข้ามให้อัตโนมัติ
          คลิกที่เวลาใดก็ได้ในตารางด้านล่างเพื่อแก้ไขการตีความ เข้า/ออก หรือย้ายวันที่ — ใช้เมื่อ OT
          ยาวเกินกว่าที่ระบบเดาให้อัตโนมัติได้
        </p>
      </section>

      {preview && (
        <>
          <section className={`${card} mb-4`}>
            <div className="flex flex-wrap gap-x-10 gap-y-3 text-[0.825rem]">
              <div>
                <p className={eyebrow}>ช่วงวันที่ในไฟล์</p>
                <p className="text-slate-900 tabular-nums">
                  {formatDate(preview.rangeFrom)} – {formatDate(preview.rangeTo)}
                </p>
              </div>
              <div>
                <p className={eyebrow}>วันที่ออกรายงาน</p>
                <p className="text-slate-900 tabular-nums">
                  {preview.generatedOn ? formatDate(preview.generatedOn) : '—'}
                </p>
              </div>
              <div>
                <p className={eyebrow}>จะบันทึกใหม่</p>
                <p className="font-semibold text-slate-900 tabular-nums">
                  {preview.totalNewCount} รายการ
                </p>
              </div>
              <div>
                <p className={eyebrow}>ข้ามเพราะซ้ำ</p>
                <p className="text-slate-900 tabular-nums">{preview.totalDuplicateCount} รายการ</p>
              </div>
              <div>
                <p className={eyebrow}>แก้ไขการตีความ</p>
                <p className={preview.totalOverriddenCount > 0 ? 'font-semibold text-navy tabular-nums' : 'text-slate-400 tabular-nums'}>
                  {preview.totalOverriddenCount > 0 ? `${preview.totalOverriddenCount} รายการ` : 'ยังไม่มี'}
                </p>
              </div>
            </div>
          </section>

          {preview.unmatchedCodes.length > 0 && (
            <div className={alert('danger')}>
              <p className={alertTitle('danger')}>
                ไม่พบพนักงานสำหรับรหัสลายนิ้วมือ {preview.unmatchedCodes.length} รหัส
              </p>
              <p className={alertDetail}>{preview.unmatchedCodes.join(', ')}</p>
              <p className={`${muted} mt-2`}>
                นำเข้าต่อได้ โดยรหัสเหล่านี้จะถูกข้ามไป — หากต้องการข้อมูลของคนเหล่านี้ด้วย
                ให้กรอกรหัสลายนิ้วมือในหน้าข้อมูลพนักงาน (แท็บข้อมูลพื้นฐาน) แล้วนำเข้าไฟล์เดิมซ้ำอีกครั้ง
              </p>
            </div>
          )}

          {preview.warnings.length > 0 && (
            <div className={alert('default')}>
              <p className={alertTitle()}>ข้อสังเกตจากไฟล์</p>
              <ul className="mt-1 list-inside list-disc">
                {preview.warnings.map((warning) => (
                  <li key={warning} className={muted}>
                    {warning}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mb-4 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
            <div className="flex items-center justify-between gap-4 border-b border-slate-200 bg-slate-50 px-4 py-3.5">
              <p className="text-[0.775rem] text-slate-500">
                ตรวจสอบการตีความเวลาเข้า/ออกก่อนยืนยัน — เครื่องสแกนบันทึกเฉพาะเวลา
                ระบบเป็นผู้ตัดสินว่าครั้งไหนคือเข้าหรือออกจากกะของพนักงาน คลิกที่เวลาเพื่อแก้ไข
                <span className="ml-1 text-amber-700">*</span> = ไม่ตรงกับกะใด &nbsp;·&nbsp;
                <span className="font-semibold text-navy">เส้นประ</span> = แก้ไขการตีความแล้ว
              </p>
              {revalidating && (
                <span className={`${muted} shrink-0 whitespace-nowrap`}>กำลังบันทึกการแก้ไข…</span>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse [&_tbody_tr:last-child_td]:border-b-0">
                <thead>
                  <tr>
                    {['รหัสลายนิ้วมือ', 'พนักงาน', 'ใหม่ / ซ้ำ', 'การลงเวลา'].map((h) => (
                      <th key={h} className={th}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pageEmployees.map((employee) => (
                    <tr key={employee.fingerprintCode} className="hover:bg-slate-50">
                      <td className={`${td} font-medium whitespace-nowrap text-slate-900 tabular-nums`}>
                        {employee.fingerprintCode}
                      </td>
                      <td className={`${td} whitespace-nowrap`}>
                        {employee.employeeId === null ? (
                          <span className={badge('danger')}>ไม่พบพนักงาน</span>
                        ) : (
                          <>
                            <span className="text-slate-900">{employee.employeeName}</span>
                            <span className="ml-1.5 text-slate-400">{employee.employeeCode}</span>
                          </>
                        )}
                        {employee.nameInFile && (
                          <span className="ml-1.5 text-slate-400">({employee.nameInFile})</span>
                        )}
                      </td>
                      <td className={`${td} whitespace-nowrap tabular-nums`}>
                        <span className="font-semibold text-slate-900">{employee.newCount}</span>
                        <span className="text-slate-400"> / {employee.duplicateCount}</span>
                      </td>
                      <td className={td}>
                        {employee.punches.length === 0 ? (
                          <span className={muted}>ไม่มีข้อมูลการลงเวลาในไฟล์</span>
                        ) : (
                          <EmployeePunches
                            employee={employee}
                            disabled={revalidating}
                            onSavePunch={handleSavePunch}
                          />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={page}
              pageSize={pageSize}
              totalItems={preview.employees.length}
              onPageChange={setPage}
              onPageSizeChange={(nextPageSize) => {
                setPageSize(nextPageSize)
                setPage(1)
              }}
              pageSizeOptions={EMPLOYEE_PAGE_SIZE_OPTIONS}
            />
          </div>

          <div className="flex items-center gap-3 pb-2">
            <button
              type="button"
              className={button('primary')}
              disabled={busy || revalidating || preview.totalNewCount === 0}
              onClick={() => void handleImport(preview)}
            >
              {phase.name === 'importing'
                ? 'กำลังนำเข้า…'
                : preview.totalOverriddenCount > 0
                  ? `ยืนยันนำเข้า ${preview.totalNewCount} รายการ (รวมแก้ไข ${preview.totalOverriddenCount})`
                  : `ยืนยันนำเข้า ${preview.totalNewCount} รายการ`}
            </button>
            {preview.totalNewCount === 0 && (
              <span className={muted}>ไม่มีรายการใหม่ในไฟล์นี้ — นำเข้าไปแล้วทั้งหมด</span>
            )}
            <Link className={link} to="/attendance/imports">
              ประวัติการนำเข้า
            </Link>
          </div>
        </>
      )}
    </>
  )
}
