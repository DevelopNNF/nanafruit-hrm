import { useEffect, useState } from 'react'
import type { PayrollSlipSummary } from '@hrm/shared'
import { downloadMyPayslipPdf, listMyPayrollSlips } from '../api/payroll'
import { ApiRequestError } from '../api/client'
import { PageHeader } from '../components/PageHeader'

type Props = {
  onBack: () => void
}

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; slips: PayrollSlipSummary[] }
  | { phase: 'error'; message: string }

function messageFor(err: unknown): string {
  if (err instanceof ApiRequestError) return err.message
  return 'เชื่อมต่อไม่สำเร็จ กรุณาลองใหม่อีกครั้ง'
}

/** Same rendering as the admin payroll screens' formatAmount — repeated
 *  locally, matching how this codebase treats small formatting helpers. */
function formatAmount(amount: number): string {
  return amount.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatThaiDate(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00`).toLocaleDateString('th-TH-u-ca-buddhist', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

/**
 * Lists this employee's own visible payslips (period status approved/paid/
 * closed — see payslipData.ts's EMPLOYEE_VISIBLE_STATUSES on the server) with
 * a download button each. The PDF itself is fetched as an authenticated blob
 * rather than linked to directly, since the session token lives only in
 * memory and a plain link would carry no Authorization header at all.
 */
export function PayslipScreen({ onBack }: Props) {
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [downloadingId, setDownloadingId] = useState<number | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    listMyPayrollSlips(controller.signal)
      .then((slips) => setState({ phase: 'ready', slips }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setState({ phase: 'error', message: messageFor(err) })
      })
    return () => controller.abort()
  }, [])

  async function handleDownload(slip: PayrollSlipSummary) {
    setDownloadingId(slip.entryId)
    setDownloadError(null)
    try {
      const blob = await downloadMyPayslipPdf(slip.payrollPeriodId)
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `payslip-${slip.periodCode}.pdf`
      link.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setDownloadError(messageFor(err))
    } finally {
      setDownloadingId(null)
    }
  }

  return (
    <main className="app">
      <PageHeader title="สลิปเงินเดือน" onBack={onBack} />

      {state.phase === 'loading' && <p className="hint">กำลังโหลด…</p>}
      {state.phase === 'error' && <p className="form-error">{state.message}</p>}
      {downloadError !== null && <p className="form-error">{downloadError}</p>}

      {state.phase === 'ready' &&
        (state.slips.length === 0 ? (
          <div className="request-empty">
            <p>ยังไม่มีสลิปที่ดูได้</p>
          </div>
        ) : (
          <ul className="request-list">
            {state.slips.map((slip) => (
              <li key={slip.entryId} className="request-item">
                <div className="request-item-head">
                  <div>
                    <p className="request-item-title">งวด {slip.periodCode}</p>
                    <p className="request-item-meta">จ่ายวันที่ {formatThaiDate(slip.payDate)}</p>
                  </div>
                </div>
                <p className="request-item-reason">สุทธิ {formatAmount(slip.netPay)} บาท</p>
                <div className="request-item-actions">
                  <button
                    type="button"
                    className="request-edit-button"
                    disabled={downloadingId === slip.entryId}
                    onClick={() => void handleDownload(slip)}
                  >
                    {downloadingId === slip.entryId ? 'กำลังสร้าง…' : 'ดาวน์โหลด'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ))}
    </main>
  )
}
