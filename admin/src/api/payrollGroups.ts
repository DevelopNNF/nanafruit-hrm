import type {
  PayrollGroup,
  PayrollGroupInput,
  PayrollGroupListResponse,
  PayrollGroupResponse,
} from '@hrm/shared'
import { apiFetch, jsonHeaders, unwrap } from './client'

export async function listPayrollGroups(signal?: AbortSignal): Promise<PayrollGroup[]> {
  const res = await apiFetch('/api/payroll-groups', { signal })
  const body = await unwrap<PayrollGroupListResponse>(res)
  return body.payrollGroups
}

export async function getPayrollGroup(id: number, signal?: AbortSignal): Promise<PayrollGroup> {
  const res = await apiFetch(`/api/payroll-groups/${id}`, { signal })
  const body = await unwrap<PayrollGroupResponse>(res)
  return body.payrollGroup
}

export async function createPayrollGroup(input: PayrollGroupInput): Promise<PayrollGroup> {
  const res = await apiFetch('/api/payroll-groups', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  const body = await unwrap<PayrollGroupResponse>(res)
  return body.payrollGroup
}

export async function updatePayrollGroup(
  id: number,
  input: PayrollGroupInput
): Promise<PayrollGroup> {
  const res = await apiFetch(`/api/payroll-groups/${id}`, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  const body = await unwrap<PayrollGroupResponse>(res)
  return body.payrollGroup
}
