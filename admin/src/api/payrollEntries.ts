import type {
  PayrollCalculateResponse,
  PayrollEntry,
  PayrollEntryListResponse,
  PayrollEntryResponse,
  PayrollEntryWithLines,
  PayrollPeriod,
} from '@hrm/shared'
import { apiFetch, ApiRequestError, jsonHeaders, unwrap } from './client'

export async function listPayrollEntries(periodId: number, signal?: AbortSignal): Promise<PayrollEntry[]> {
  const res = await apiFetch(`/api/payroll-periods/${periodId}/entries`, { signal })
  const body = await unwrap<PayrollEntryListResponse>(res)
  return body.payrollEntries
}

export async function getPayrollEntry(id: number, signal?: AbortSignal): Promise<PayrollEntryWithLines> {
  const res = await apiFetch(`/api/payroll-entries/${id}`, { signal })
  const body = await unwrap<PayrollEntryResponse>(res)
  return body.payrollEntry
}

/** POST /api/payroll-periods/:id/calculate — rebuilds every entry for the
 *  period from scratch. Safe to call again on a still-draft/calculating
 *  period; blocked once it has moved past review. */
export async function calculatePayrollPeriod(
  periodId: number
): Promise<{ payrollPeriod: PayrollPeriod; entryCount: number; needsReviewCount: number }> {
  const res = await apiFetch(`/api/payroll-periods/${periodId}/calculate`, {
    method: 'POST',
    headers: jsonHeaders,
  })
  return unwrap<PayrollCalculateResponse>(res)
}

/** PATCH /api/payroll-entries/:id/review — only legal while the entry's
 *  period is 'review'; the server rejects it otherwise. */
export async function reviewPayrollEntry(
  id: number,
  reviewed: boolean
): Promise<PayrollEntryWithLines> {
  const res = await apiFetch(`/api/payroll-entries/${id}/review`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify({ reviewed }),
  })
  const body = await unwrap<PayrollEntryResponse>(res)
  return body.payrollEntry
}

/** GET /api/payroll-entries/:id/pdf — no status gate on the server side, so
 *  this works at any point in the entry's life, not just after approval. */
export async function downloadPayrollEntryPdf(id: number): Promise<Blob> {
  const res = await apiFetch(`/api/payroll-entries/${id}/pdf`)
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as { message?: string }
      if (body.message) message = body.message
    } catch {
      // Non-JSON error body — the status is all we have.
    }
    throw new ApiRequestError(message)
  }
  return res.blob()
}
