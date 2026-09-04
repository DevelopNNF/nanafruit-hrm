import type { ApiError, PayrollSlipListResponse, PayrollSlipSummary } from '@hrm/shared'
import { apiFetch, ApiRequestError, unwrap } from './client'

export async function listMyPayrollSlips(signal?: AbortSignal): Promise<PayrollSlipSummary[]> {
  const res = await apiFetch('/api/payroll-entries/me', { signal })
  const body = await unwrap<PayrollSlipListResponse>(res)
  return body.slips
}

/** GET /api/payroll-entries/me/:periodId/pdf — fetched as a blob rather than
 *  navigated to directly: the session token lives only in memory
 *  (client.ts), so a plain <a href> here would hit the route with no
 *  Authorization header at all. */
export async function downloadMyPayslipPdf(periodId: number): Promise<Blob> {
  const res = await apiFetch(`/api/payroll-entries/me/${periodId}/pdf`)
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    let code: ApiError['code']
    try {
      const body = (await res.json()) as ApiError
      if (body.message) message = body.message
      code = body.code
    } catch {
      // Non-JSON error body — the status is all we have.
    }
    throw new ApiRequestError(message, res.status, code)
  }
  return res.blob()
}
