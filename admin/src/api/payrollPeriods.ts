import type {
  PayrollPeriod,
  PayrollPeriodInput,
  PayrollPeriodListResponse,
  PayrollPeriodPatch,
  PayrollPeriodPreviewResponse,
  PayrollPeriodResponse,
  PayrollPeriodStatus,
} from '@hrm/shared'
import { apiFetch, ApiRequestError, jsonHeaders, unwrap } from './client'

export async function listPayrollPeriods(
  filter: { groupId?: number; status?: PayrollPeriodStatus } = {},
  signal?: AbortSignal
): Promise<PayrollPeriod[]> {
  const params = new URLSearchParams()
  if (filter.groupId !== undefined) params.set('groupId', String(filter.groupId))
  if (filter.status !== undefined) params.set('status', filter.status)
  const query = params.toString()

  const res = await apiFetch(`/api/payroll-periods${query ? `?${query}` : ''}`, { signal })
  const body = await unwrap<PayrollPeriodListResponse>(res)
  return body.payrollPeriods
}

export async function getPayrollPeriod(id: number, signal?: AbortSignal): Promise<PayrollPeriod> {
  const res = await apiFetch(`/api/payroll-periods/${id}`, { signal })
  const body = await unwrap<PayrollPeriodResponse>(res)
  return body.payrollPeriod
}

/** The window a period would get, without creating it. The derivation lives on
 *  the server so the form does not carry a second copy of the cut-off rule. */
export async function previewPayrollPeriod(
  groupId: number,
  periodCode: string,
  signal?: AbortSignal
): Promise<PayrollPeriodPreviewResponse> {
  const params = new URLSearchParams({ groupId: String(groupId), periodCode })
  const res = await apiFetch(`/api/payroll-periods/preview?${params.toString()}`, { signal })
  return unwrap<PayrollPeriodPreviewResponse>(res)
}

export async function createPayrollPeriod(input: PayrollPeriodInput): Promise<PayrollPeriod> {
  const res = await apiFetch('/api/payroll-periods', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  const body = await unwrap<PayrollPeriodResponse>(res)
  return body.payrollPeriod
}

export async function updatePayrollPeriod(
  id: number,
  patch: PayrollPeriodPatch
): Promise<PayrollPeriod> {
  const res = await apiFetch(`/api/payroll-periods/${id}`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify(patch),
  })
  const body = await unwrap<PayrollPeriodResponse>(res)
  return body.payrollPeriod
}

export async function voidPayrollPeriod(id: number, voidReason: string): Promise<PayrollPeriod> {
  const res = await apiFetch(`/api/payroll-periods/${id}/void`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ voidReason }),
  })
  const body = await unwrap<PayrollPeriodResponse>(res)
  return body.payrollPeriod
}

/** POST /api/payroll-periods/:id/submit-for-review — 'calculating' only.
 *  Freezes the entries: calculate refuses to run again past this point. */
export async function submitPayrollPeriodForReview(id: number): Promise<PayrollPeriod> {
  const res = await apiFetch(`/api/payroll-periods/${id}/submit-for-review`, {
    method: 'POST',
    headers: jsonHeaders,
  })
  const body = await unwrap<PayrollPeriodResponse>(res)
  return body.payrollPeriod
}

/** POST /api/payroll-periods/:id/reopen — 'review' back to 'draft', so
 *  calculate is legal again after fixing something HR found while checking. */
export async function reopenPayrollPeriod(id: number): Promise<PayrollPeriod> {
  const res = await apiFetch(`/api/payroll-periods/${id}/reopen`, {
    method: 'POST',
    headers: jsonHeaders,
  })
  const body = await unwrap<PayrollPeriodResponse>(res)
  return body.payrollPeriod
}

/** POST /api/payroll-periods/:id/approve — 'review' to 'approved'. Blocked
 *  server-side if any entry is still unreviewed unless acknowledgeUnreviewed
 *  is sent; the caller shows a warning and resends with it true to proceed. */
export async function approvePayrollPeriod(
  id: number,
  acknowledgeUnreviewed = false
): Promise<PayrollPeriod> {
  const res = await apiFetch(`/api/payroll-periods/${id}/approve`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ acknowledgeUnreviewed }),
  })
  const body = await unwrap<PayrollPeriodResponse>(res)
  return body.payrollPeriod
}

/** POST /api/payroll-periods/:id/unapprove — 'approved' back to 'review'. */
export async function unapprovePayrollPeriod(id: number): Promise<PayrollPeriod> {
  const res = await apiFetch(`/api/payroll-periods/${id}/unapprove`, {
    method: 'POST',
    headers: jsonHeaders,
  })
  const body = await unwrap<PayrollPeriodResponse>(res)
  return body.payrollPeriod
}

/** GET /api/payroll-periods/:id/export — every entry in the period as a
 *  formatted .xlsx, generated server-side from the payroll report template.
 *  Rejected with a message (not just a status code) if the period hasn't
 *  been calculated yet or was voided — see the route's own guard. */
export async function exportPayrollPeriod(id: number, signal?: AbortSignal): Promise<Blob> {
  const res = await apiFetch(`/api/payroll-periods/${id}/export`, { signal })
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
