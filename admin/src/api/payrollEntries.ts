import type {
  PayrollCalculateResponse,
  PayrollEntry,
  PayrollEntryListResponse,
  PayrollEntryResponse,
  PayrollEntryWithLines,
  PayrollPeriod,
} from '@hrm/shared'
import { apiFetch, jsonHeaders, unwrap } from './client'

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
