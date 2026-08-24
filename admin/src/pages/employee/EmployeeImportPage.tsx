import { useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, Download } from 'lucide-react'
import type { EmployeeImportPreview, EmployeeImportRowAction, EmployeeImportRowPreview } from '@hrm/shared'
import { commitEmployeeImport, previewEmployeeImport } from '../../api/employeeImport'
import {
  downloadEmployeeImportTemplate,
  downloadTempWorkerEmployeeImportTemplate,
} from '../../api/employees'
import { useCanWrite } from '../../auth/meContext'
import { notify } from '../../notifications/notify'
import {
  alert,
  alertDetail,
  alertTitle,
  badge,
  button,
  card,
  eyebrow,
  muted,
  pageHead,
  subtitle,
} from '../../styles'

type Phase =
  | { name: 'idle' }
  | { name: 'previewing' }
  | { name: 'ready'; preview: EmployeeImportPreview }
  | { name: 'importing'; preview: EmployeeImportPreview }

const th =
  'border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-left text-[0.675rem] font-semibold tracking-wider text-slate-500 uppercase whitespace-nowrap'
const td = 'border-b border-slate-200 px-4 py-2.5 align-top text-[0.825rem] text-slate-600'

const ACTION_LABEL: Record<EmployeeImportRowAction, string> = {
  create: 'พนักงานใหม่',
  update: 'อัปเดต',
  blocked: 'บล็อก',
  skip: 'ข้าม',
}

function actionBadgeTone(action: EmployeeImportRowAction): 'active' | 'role' | 'danger' | 'inactive' {
  switch (action) {
    case 'create':
      return 'active'
    case 'update':
      return 'role'
    case 'blocked':
      return 'danger'
    case 'skip':
      return 'inactive'
  }
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

function ImportRow({ row, isTempWorkerTemplate }: { row: EmployeeImportRowPreview; isTempWorkerTemplate: boolean }) {
  // The temp-worker template has no employeeCode column at all — a `create`
  // row's code isn't decided until commit (see employeeCodeGenerator.ts on
  // the server), so fingerprintCode is what identifies the row here instead.
  const identity = isTempWorkerTemplate ? row.fingerprintCode : row.employeeCode
  return (
    <tr className="hover:bg-slate-50">
      <td className={`${td} tabular-nums text-slate-400`}>{row.rowNumber}</td>
      <td className={`${td} whitespace-nowrap`}>
        <span className={badge(actionBadgeTone(row.action))}>{ACTION_LABEL[row.action]}</span>
      </td>
      <td className={`${td} font-mono whitespace-nowrap text-slate-900`}>{identity ?? '—'}</td>
      <td className={`${td} whitespace-nowrap`}>{row.name ?? '—'}</td>
      <td className={td}>
        {row.reasons.length === 0 ? (
          <span className={muted}>—</span>
        ) : (
          <ul className="list-inside list-disc space-y-0.5">
            {row.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )}
      </td>
    </tr>
  )
}

/**
 * Loading a filled-in copy of the employee import template.
 *
 * Two steps with a full preview in between, same reasoning as
 * AttendanceImportPage: a row that looks fine to Excel can still fail to
 * resolve against master data, collide with another employee, or hit a
 * leaver's code, and that only shows up once the file is checked against the
 * database — so nothing is ever written before HR has seen exactly what will
 * happen to every row.
 */
export function EmployeeImportPage() {
  const canWrite = useCanWrite()
  const navigate = useNavigate()
  const fileInput = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [phase, setPhase] = useState<Phase>({ name: 'idle' })
  const [error, setError] = useState<string | null>(null)
  const [downloadingTemplate, setDownloadingTemplate] = useState<'standard' | 'temp_worker' | null>(
    null
  )

  function chooseFile(chosen: File | null) {
    setFile(chosen)
    setPhase({ name: 'idle' })
    setError(null)
  }

  async function handleDownloadTemplate(kind: 'standard' | 'temp_worker') {
    setDownloadingTemplate(kind)
    try {
      const blob =
        kind === 'standard'
          ? await downloadEmployeeImportTemplate()
          : await downloadTempWorkerEmployeeImportTemplate()
      downloadBlob(
        blob,
        kind === 'standard' ? 'employee-import-template.xlsx' : 'employee-temporary-import-template.xlsx'
      )
    } catch (err) {
      notify.error('ดาวน์โหลดเทมเพลตไม่สำเร็จ', err instanceof Error ? err.message : undefined)
    } finally {
      setDownloadingTemplate(null)
    }
  }

  async function handlePreview() {
    if (!file) return
    setPhase({ name: 'previewing' })
    setError(null)
    try {
      const preview = await previewEmployeeImport(file)
      setPhase({ name: 'ready', preview })
    } catch (err) {
      setPhase({ name: 'idle' })
      setError(err instanceof Error ? err.message : 'อ่านไฟล์ไม่สำเร็จ')
    }
  }

  async function handleImport(preview: EmployeeImportPreview) {
    if (!file) return
    setPhase({ name: 'importing', preview })
    setError(null)
    try {
      const result = await commitEmployeeImport(file)
      notify.success(
        'นำเข้าข้อมูลพนักงานสำเร็จ',
        `เพิ่มพนักงานใหม่ ${result.createdCount} คน อัปเดต ${result.updatedCount} คน` +
          (result.blockedCount > 0 ? ` — บล็อก ${result.blockedCount} แถว` : '') +
          (result.skippedCount > 0 ? ` — ข้าม ${result.skippedCount} แถว` : '')
      )
      navigate('/employees')
    } catch (err) {
      setPhase({ name: 'ready', preview })
      setError(err instanceof Error ? err.message : 'นำเข้าไม่สำเร็จ')
    }
  }

  const preview = phase.name === 'ready' || phase.name === 'importing' ? phase.preview : null
  const busy = phase.name === 'previewing' || phase.name === 'importing'
  const writableCount = preview ? preview.createCount + preview.updateCount : 0

  if (!canWrite) {
    return (
      <>
        <header className={pageHead}>
          <div>
            <p className={eyebrow}>ทะเบียนบุคลากร</p>
            <h1>นำเข้าข้อมูลพนักงาน</h1>
          </div>
          <Link className={button()} to="/employees">
            <ArrowLeft size={16} /> กลับไปหน้าพนักงาน
          </Link>
        </header>
        <div className={alert('default')}>
          <p className={alertTitle()}>ไม่มีสิทธิ์นำเข้าข้อมูลพนักงาน</p>
          <p className={muted}>เฉพาะ HR และผู้ดูแลระบบเท่านั้นที่นำเข้าข้อมูลได้</p>
        </div>
      </>
    )
  }

  return (
    <>
      <header className={pageHead}>
        <div>
          <p className={eyebrow}>ทะเบียนบุคลากร</p>
          <h1>นำเข้าข้อมูลพนักงาน</h1>
          <p className={subtitle}>นำเข้าไฟล์ Excel (.xlsx) ตามเทมเพลตข้อมูลพนักงาน</p>
        </div>
        <Link className={button()} to="/employees">
          <ArrowLeft size={16} /> กลับไปหน้าพนักงาน
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
          <button
            type="button"
            className={button()}
            disabled={downloadingTemplate !== null}
            onClick={() => void handleDownloadTemplate('standard')}
          >
            <Download size={16} />
            {downloadingTemplate === 'standard' ? 'กำลังดาวน์โหลด…' : 'ดาวน์โหลดเทมเพลตเปล่า'}
          </button>
          <button
            type="button"
            className={button()}
            disabled={downloadingTemplate !== null}
            onClick={() => void handleDownloadTemplate('temp_worker')}
          >
            <Download size={16} />
            {downloadingTemplate === 'temp_worker'
              ? 'กำลังดาวน์โหลด…'
              : 'ดาวน์โหลดเทมเพลตพนักงานรายวันชั่วคราว'}
          </button>
        </div>
        <p className={`${muted} mt-3`}>
          ระบบจะรู้เองว่าไฟล์ที่อัปโหลดเป็นเทมเพลตแบบไหน — รหัสพนักงานที่มีอยู่แล้วในระบบจะถูกอัปเดตข้อมูล
          รหัสที่ยังไม่เคยมีจะถูกเพิ่มเป็นพนักงานใหม่ (เทมเพลตพนักงานรายวันชั่วคราวใช้รหัสลายนิ้วมือแทน
          เพราะไม่มีรหัสพนักงาน — ระบบจะสร้างรหัสรูปแบบ TEMP-XXXX ให้เอง) รหัสที่ซ้ำกับพนักงานที่ลาออกไปแล้วจะถูกบล็อก
          และแจ้งเตือน แผนก/ตำแหน่ง/กะงาน/กลุ่มวันหยุด/กลุ่มเงินเดือน ต้องตรงกับชื่อในระบบเป๊ะ (เลือกจาก dropdown ในไฟล์ได้เลย)
          ไม่เช่นนั้นแถวนั้นจะถูกข้าม
        </p>
      </section>

      {preview && (
        <>
          <section className={`${card} mb-4`}>
            <p className={`${eyebrow} mb-2`}>
              {preview.templateCode === 'TEMP-EMP-IMP'
                ? 'ตรวจพบ: เทมเพลตพนักงานรายวันชั่วคราว'
                : 'ตรวจพบ: เทมเพลตพนักงานทั่วไป'}
            </p>
            <div className="flex flex-wrap gap-x-10 gap-y-3 text-[0.825rem]">
              <div>
                <p className={eyebrow}>พนักงานใหม่</p>
                <p className="font-semibold text-slate-900 tabular-nums">{preview.createCount} คน</p>
              </div>
              <div>
                <p className={eyebrow}>อัปเดต</p>
                <p className="font-semibold text-slate-900 tabular-nums">{preview.updateCount} คน</p>
              </div>
              <div>
                <p className={eyebrow}>บล็อก (ลาออกไปแล้ว)</p>
                <p className="text-slate-900 tabular-nums">{preview.blockedCount} แถว</p>
              </div>
              <div>
                <p className={eyebrow}>ข้าม (ข้อมูลไม่ถูกต้อง)</p>
                <p className="text-slate-900 tabular-nums">{preview.skipCount} แถว</p>
              </div>
            </div>
          </section>

          <div className="mb-4 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse [&_tbody_tr:last-child_td]:border-b-0">
                <thead>
                  <tr>
                    {[
                      'แถว',
                      'การกระทำ',
                      preview.templateCode === 'TEMP-EMP-IMP' ? 'รหัสลายนิ้วมือ' : 'รหัสพนักงาน',
                      'ชื่อ',
                      'หมายเหตุ',
                    ].map((h) => (
                      <th key={h} className={th}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row) => (
                    <ImportRow
                      key={row.rowNumber}
                      row={row}
                      isTempWorkerTemplate={preview.templateCode === 'TEMP-EMP-IMP'}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex items-center gap-3 pb-2">
            <button
              type="button"
              className={button('primary')}
              disabled={busy || writableCount === 0}
              onClick={() => void handleImport(preview)}
            >
              {phase.name === 'importing' ? 'กำลังนำเข้า…' : `ยืนยันนำเข้า ${writableCount} คน`}
            </button>
            {writableCount === 0 && (
              <span className={muted}>ไม่มีแถวที่นำเข้าได้ในไฟล์นี้ — ตรวจสอบหมายเหตุในตารางด้านบน</span>
            )}
          </div>
        </>
      )}
    </>
  )
}
