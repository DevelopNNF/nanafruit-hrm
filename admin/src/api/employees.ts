import type {
  Employee,
  EmployeeInput,
  EmployeeListResponse,
  EmployeeResponse,
  LinkCodeResponse,
} from '@hrm/shared'
import { apiFetch, jsonHeaders, unwrap } from './client'

export async function listEmployees(signal?: AbortSignal): Promise<Employee[]> {
  const res = await apiFetch('/api/employees', { signal })
  const body = await unwrap<EmployeeListResponse>(res)
  return body.employees
}

export async function getEmployee(id: number, signal?: AbortSignal): Promise<Employee> {
  const res = await apiFetch(`/api/employees/${id}`, { signal })
  const body = await unwrap<EmployeeResponse>(res)
  return body.employee
}

export async function createEmployee(input: EmployeeInput): Promise<Employee> {
  const res = await apiFetch('/api/employees', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  const body = await unwrap<EmployeeResponse>(res)
  return body.employee
}

export async function updateEmployee(
  id: number,
  input: EmployeeInput
): Promise<Employee> {
  const res = await apiFetch(`/api/employees/${id}`, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  const body = await unwrap<EmployeeResponse>(res)
  return body.employee
}

/**
 * Issues a one-time code for the employee to claim their record in liff/.
 *
 * The plaintext code is in this response and nowhere else — the server stores
 * only a hash — so a caller that drops it has to issue another one.
 */
export async function createLinkCode(id: number): Promise<LinkCodeResponse> {
  const res = await apiFetch(`/api/employees/${id}/link-code`, { method: 'POST' })
  return unwrap<LinkCodeResponse>(res)
}

export async function deleteEmployee(id: number): Promise<void> {
  const res = await apiFetch(`/api/employees/${id}`, { method: 'DELETE' })
  // 204: nothing to unwrap, but a failure still needs to surface.
  if (!res.ok) await unwrap<never>(res)
}
