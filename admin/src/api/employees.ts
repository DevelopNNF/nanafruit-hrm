import type {
  Employee,
  EmployeeBasicInput,
  EmployeeFinance,
  EmployeeFinanceInput,
  EmployeeFinanceResponse,
  EmployeeInput,
  EmployeeListResponse,
  EmployeePhotoCompleteInput,
  EmployeePhotoPresignInput,
  EmployeePhotoPresignResponse,
  EmployeePhotoResponse,
  EmployeeResponse,
  EmploymentInput,
  LinkCodeResponse,
  ShiftAssignment,
  ShiftChangeInput,
  ShiftChangeResponse,
  ShiftHistoryResponse,
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

export async function updateEmployeeBasic(
  id: number,
  input: EmployeeBasicInput
): Promise<Employee> {
  const res = await apiFetch(`/api/employees/${id}/basic`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  const body = await unwrap<EmployeeResponse>(res)
  return body.employee
}

export async function updateEmployeeEmployment(
  id: number,
  input: EmploymentInput
): Promise<Employee> {
  const res = await apiFetch(`/api/employees/${id}/employment`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  const body = await unwrap<EmployeeResponse>(res)
  return body.employee
}

/** null means no finance data has been saved for this employee yet. */
export async function getEmployeeFinance(
  id: number,
  signal?: AbortSignal
): Promise<EmployeeFinance | null> {
  const res = await apiFetch(`/api/employees/${id}/finance`, { signal })
  const body = await unwrap<EmployeeFinanceResponse>(res)
  return body.finance
}

export async function updateEmployeeFinance(
  id: number,
  input: EmployeeFinanceInput
): Promise<EmployeeFinance> {
  const res = await apiFetch(`/api/employees/${id}/finance`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  const body = await unwrap<EmployeeFinanceResponse>(res)
  // PATCH always upserts a row, so unlike GET this can't come back null.
  if (!body.finance) throw new Error('finance update returned no data')
  return body.finance
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

export async function getShiftHistory(id: number, signal?: AbortSignal): Promise<ShiftAssignment[]> {
  const res = await apiFetch(`/api/employees/${id}/shift-history`, { signal })
  const body = await unwrap<ShiftHistoryResponse>(res)
  return body.assignments
}

export async function createShiftChange(
  id: number,
  input: ShiftChangeInput
): Promise<ShiftAssignment> {
  const res = await apiFetch(`/api/employees/${id}/shift-changes`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  const body = await unwrap<ShiftChangeResponse>(res)
  return body.assignment
}

/** Step 1 of a photo upload: a presigned PUT URL good for a few minutes. */
export async function presignEmployeePhotoUpload(
  id: number,
  input: EmployeePhotoPresignInput
): Promise<EmployeePhotoPresignResponse> {
  const res = await apiFetch(`/api/employees/${id}/photo/presign-upload`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  return unwrap<EmployeePhotoPresignResponse>(res)
}

/** Step 2: tell the server the direct-to-R2 PUT finished. */
export async function completeEmployeePhotoUpload(
  id: number,
  key: string
): Promise<Employee> {
  const input: EmployeePhotoCompleteInput = { key }
  const res = await apiFetch(`/api/employees/${id}/photo/complete`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  const body = await unwrap<EmployeeResponse>(res)
  return body.employee
}

/** A fresh presigned GET URL, or null if the employee has no photo. */
export async function getEmployeePhotoUrl(
  id: number,
  signal?: AbortSignal
): Promise<string | null> {
  const res = await apiFetch(`/api/employees/${id}/photo`, { signal })
  const body = await unwrap<EmployeePhotoResponse>(res)
  return body.url
}

export async function deleteEmployeePhoto(id: number): Promise<void> {
  const res = await apiFetch(`/api/employees/${id}/photo`, { method: 'DELETE' })
  if (!res.ok) await unwrap<never>(res)
}
