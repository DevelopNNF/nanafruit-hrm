import type {
  PayrollPeriod,
  PayrollPeriodInput,
  PayrollPeriodListResponse,
  PayrollPeriodPatch,
  PayrollPeriodPreviewResponse,
  PayrollPeriodResponse,
  PayrollPeriodStatus,
} from '@hrm/shared'
import { apiFetch, jsonHeaders, unwrap } from './client'

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
