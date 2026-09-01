import { useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, Download } from 'lucide-react'
import type {
  EmployeeFinanceImportPreview,
  EmployeeFinanceImportRowAction,
  EmployeeFinanceImportRowPreview,
} from '@hrm/shared'
import {
  commitEmployeeFinanceImport,
  previewEmployeeFinanceImport,
} from '../../api/employeeFinanceImport'
import { downloadEmployeeFinanceImportTemplate } from '../../api/employees'
import { useCanWritePayroll } from '../../auth/meContext'
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
  | { name: 'ready'; preview: EmployeeFinanceImportPreview }
  | { name: 'importing'; preview: EmployeeFinanceImportPreview }

const th =
  'border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-left text-[0.675rem] font-semibold tracking-wider text-slate-500 uppercase whitespace-nowrap'
const td = 'border-b border-slate-200 px-4 py-2.5 align-top text-[0.825rem] text-slate-600'

const ACTION_LABEL: Record<EmployeeFinanceImportRowAction, string> = {
  update: 'อัปเดต',
  not_found: 'ไม่พบพนักงาน',
  skip: 'ข้าม',
}

function actionBadgeTone(action: EmployeeFinanceImportRowAction): 'active' | 'danger' | 'inactive' {
  switch (action) {
    case 'update':
      return 'active'
    case 'not_found':
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

function ImportRow({ row }: { row: EmployeeFinanceImportRowPreview }) {
  return (
    <tr className="hover:bg-slate-50">
      <td className={`${td} tabular-nums text-slate-400`}>{row.rowNumber}</td>
      <td className={`${td} whitespace-nowrap`}>
        <span className={badge(actionBadgeTone(row.action))}>{ACTION_LABEL[row.action]}</span>
      </td>
      <td className={`${td} font-mono whitespace-nowrap text-slate-900`}>{row.employeeCode ?? '—'}</td>
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
 * Loading a filled-in copy of the employee-finance import template. Same
 * two-step preview-then-commit flow as EmployeeImportPage — a row that looks
 * fine to Excel can still name a code the system doesn't have, or trip a
 * consistency rule between an enum column and its amount, and that only
 * shows up once the file is checked, so nothing is ever written before HR has
 * seen exactly what will happen to every row.
 */
export function EmployeeFinanceImportPage() {
  const canImport = useCanWritePayroll()
  const navigate = useNavigate()
  const fileInput = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [phase, setPhase] = useState<Phase>({ name: 'idle' })
  const [error, setError] = useState<string | null>(null)
  const [downloadingTemplate, setDownloadingTemplate] = useState(false)

  function chooseFile(chosen: File | null) {
    setFile(chosen)
    setPhase({ name: 'idle' })
    setError(null)
  }

  async function handleDownloadTemplate() {
    setDownloadingTemplate(true)
    try {
      const blob = await downloadEmployeeFinanceImportTemplate()
      downloadBlob(blob, 'employee-finance-import-template.xlsx')
    } catch (err) {
      notify.error('ดาวน์โหลดเทมเพลตไม่สำเร็จ', err instanceof Error ? err.message : undefined)
    } finally {
      setDownloadingTemplate(false)
    }
  }

  async function handlePreview() {
    if (!file) return
    setPhase({ name: 'previewing' })
    setError(null)
    try {
      const preview = await previewEmployeeFinanceImport(file)
      setPhase({ name: 'ready', preview })
    } catch (err) {
      setPhase({ name: 'idle' })
      setError(err instanceof Error ? err.message : 'อ่านไฟล์ไม่สำเร็จ')
    }
  }

  async function handleImport(preview: EmployeeFinanceImportPreview) {
    if (!file) return
    setPhase({ name: 'importing', preview })
    setError(null)
    try {
      const result = await commitEmployeeFinanceImport(file)
      notify.success(
        'นำเข้าข้อมูลการเงินพนักงานสำเร็จ',
        `อัปเดต ${result.updatedCount} คน` +
          (result.notFoundCount > 0 ? ` — ไม่พบพนักงาน ${result.notFoundCount} แถว` : '') +
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
  const writableCount = preview ? preview.updateCount : 0

  if (!canImport) {
    return (
      <>
        <header className={pageHead}>
          <div>
            <p className={eyebrow}>ทะเบียนบุคลากร</p>
            <h1>นำเข้าข้อมูลการเงินพนักงาน</h1>
          </div>
          <Link className={button()} to="/employees">
            <ArrowLeft size={16} /> กลับไปหน้าพนักงาน
          </Link>
        </header>
        <div className={alert('default')}>
          <p className={alertTitle()}>ไม่มีสิทธิ์นำเข้าข้อมูลการเงินพนักงาน</p>
          <p className={muted}>เฉพาะฝ่ายเงินเดือนและผู้ดูแลระบบเท่านั้นที่นำเข้าได้</p>
        </div>
      </>
    )
  }

  return (
    <>
      <header className={pageHead}>
        <div>
          <p className={eyebrow}>ทะเบียนบุคลากร</p>
          <h1>นำเข้าข้อมูลการเงินพนักงาน</h1>
          <p className={subtitle}>นำเข้าไฟล์ Excel (.xlsx) ตามเทมเพลตข้อมูลการเงินพนักงาน (EMP-FIN-IMP)</p>
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
            disabled={downloadingTemplate}
            onClick={() => void handleDownloadTemplate()}
          >
            <Download size={16} />
            {downloadingTemplate ? 'กำลังดาวน์โหลด…' : 'ดาวน์โหลดเทมเพลตเปล่า'}
          </button>
        </div>
        <p className={`${muted} mt-3`}>
          คอลัมน์รหัสพนักงาน/คำนำหน้า/ชื่อ/นามสกุล/วันที่จ้าง/กลุ่มต่าง ๆ มีไว้แสดงผลเพื่อยืนยันตัวตนพนักงาน
          เท่านั้น — ใช้รหัสพนักงานจับคู่กับพนักงานในระบบ ไม่มีผลต่อข้อมูลการจ้างงาน มีเฉพาะข้อมูลการเงิน
          (ค่าจ้าง ช่องทางจ่ายเงิน ธนาคาร ประกันสังคม ภาษี) เท่านั้นที่จะถูกบันทึก รหัสพนักงานที่ไม่พบในระบบ
          จะถูกข้ามและแจ้งเตือน
        </p>
      </section>

      {preview && (
        <>
          <section className={`${card} mb-4`}>
            <div className="flex flex-wrap gap-x-10 gap-y-3 text-[0.825rem]">
              <div>
                <p className={eyebrow}>อัปเดต</p>
                <p className="font-semibold text-slate-900 tabular-nums">{preview.updateCount} คน</p>
              </div>
              <div>
                <p className={eyebrow}>ไม่พบพนักงาน</p>
                <p className="text-slate-900 tabular-nums">{preview.notFoundCount} แถว</p>
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
                    {['แถว', 'การกระทำ', 'รหัสพนักงาน', 'ชื่อ', 'หมายเหตุ'].map((h) => (
                      <th key={h} className={th}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row) => (
                    <ImportRow key={row.rowNumber} row={row} />
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
