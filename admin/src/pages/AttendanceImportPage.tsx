import { useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import type { AttendanceImportEmployeePreview, AttendanceImportPreview } from '@hrm/shared'
import { commitAttendanceImport, previewAttendanceImport } from '../api/attendanceImport'
import { useCanWrite } from '../auth/meContext'
import { notify } from '../notifications/notify'
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
  | { name: 'ready'; preview: AttendanceImportPreview }
  | { name: 'importing'; preview: AttendanceImportPreview }

const th =
  'border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-left text-[0.675rem] font-semibold tracking-wider text-slate-500 uppercase whitespace-nowrap'
const td = 'border-b border-slate-200 px-4 py-2.5 align-top text-[0.825rem] text-slate-600'

function formatDate(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString('th-TH', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
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

/** One employee's punches, grouped by the work-date they were attributed to —
 *  which for an overnight shift is not the day they happened on, and that is
 *  precisely what HR is here to check. */
function EmployeePunches({ employee }: { employee: AttendanceImportEmployeePreview }) {
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
            <span
              key={`${punch.eventTime}-${punch.eventType}`}
              className={`inline-flex items-baseline gap-1 rounded px-1.5 py-0.5 text-[0.775rem] tabular-nums ${
                punch.duplicate
                  ? 'text-slate-400 line-through'
                  : punch.eventType === 'check_in'
                    ? 'bg-green-50 text-green-800'
                    : 'bg-slate-100 text-slate-700'
              }`}
              title={
                punch.duplicate
                  ? 'มีรายการนี้อยู่แล้ว จะถูกข้าม'
                  : punch.matchedShift
                    ? undefined
                    : 'ไม่ตรงกับกะใด — ตีความจากวันปฏิทิน'
              }
            >
              {formatTime(punch.eventTime)}
              <span className="text-[0.675rem] opacity-70">
                {punch.eventType === 'check_in' ? 'เข้า' : 'ออก'}
              </span>
              {!punch.matchedShift && <span className="text-[0.675rem] text-amber-700">*</span>}
            </span>
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
 */
export function AttendanceImportPage() {
  const canWrite = useCanWrite()
  const navigate = useNavigate()
  const fileInput = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [phase, setPhase] = useState<Phase>({ name: 'idle' })
  const [error, setError] = useState<string | null>(null)

  function chooseFile(chosen: File | null) {
    setFile(chosen)
    setPhase({ name: 'idle' })
    setError(null)
  }

  async function handlePreview() {
    if (!file) return
    setPhase({ name: 'previewing' })
    setError(null)
    try {
      const preview = await previewAttendanceImport(file)
      setPhase({ name: 'ready', preview })
    } catch (err) {
      setPhase({ name: 'idle' })
      setError(err instanceof Error ? err.message : 'อ่านไฟล์ไม่สำเร็จ')
    }
  }

  async function handleImport(preview: AttendanceImportPreview) {
    if (!file) return
    setPhase({ name: 'importing', preview })
    setError(null)
    try {
      const result = await commitAttendanceImport(file)
      notify.success(
        'นำเข้าการลงเวลาสำเร็จ',
        `บันทึก ${result.importedCount} รายการ สำหรับพนักงาน ${result.employeeCount} คน` +
          (result.skippedDuplicateCount > 0 ? ` (ข้ามรายการซ้ำ ${result.skippedDuplicateCount})` : '') +
          (result.recomputed ? '' : ' — รายงานการลงเวลาจะคำนวณใหม่ในรอบถัดไป')
      )
      navigate('/attendance')
    } catch (err) {
      setPhase({ name: 'ready', preview })
      setError(err instanceof Error ? err.message : 'นำเข้าไม่สำเร็จ')
    }
  }

  const preview = phase.name === 'ready' || phase.name === 'importing' ? phase.preview : null
  const busy = phase.name === 'previewing' || phase.name === 'importing'

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
            <div className="border-b border-slate-200 bg-slate-50 px-4 py-3.5">
              <p className="text-[0.775rem] text-slate-500">
                ตรวจสอบการตีความเวลาเข้า/ออกก่อนยืนยัน — เครื่องสแกนบันทึกเฉพาะเวลา
                ระบบเป็นผู้ตัดสินว่าครั้งไหนคือเข้าหรือออกจากกะของพนักงาน
                <span className="ml-1 text-amber-700">*</span> = ไม่ตรงกับกะใด
              </p>
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
                  {preview.employees.map((employee) => (
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
                          <EmployeePunches employee={employee} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex items-center gap-3 pb-2">
            <button
              type="button"
              className={button('primary')}
              disabled={busy || preview.totalNewCount === 0}
              onClick={() => void handleImport(preview)}
            >
              {phase.name === 'importing'
                ? 'กำลังนำเข้า…'
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
