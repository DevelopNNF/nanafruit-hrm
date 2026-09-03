import type {
  DailyShiftAssignmentEligibleResponse,
  DailyShiftAssignmentInput,
  DailyShiftAssignmentOutcome,
  DailyShiftAssignmentResponse,
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
  EmployeeSearchResponse,
  EmployeeStatus,
  EmploymentInput,
  EmploymentType,
  WorkLocation,
  LinkCodeResponse,
  ShiftAssignment,
  WageAssignment,
  WageChangeInput,
  WageChangeResponse,
  WageHistoryResponse,
  ShiftChangeInput,
  ShiftChangeResponse,
  ShiftHistoryResponse,
} from '@hrm/shared'
import { apiFetch, ApiRequestError, jsonHeaders, unwrap } from './client'

export async function listEmployees(signal?: AbortSignal): Promise<Employee[]> {
  const res = await apiFetch('/api/employees', { signal })
  const body = await unwrap<EmployeeListResponse>(res)
  return body.employees
}

export type EmployeeSearchFilter = {
  query?: string
  /** A specific payroll group's id, or 'none' for "not in any group". */
  payrollGroupId?: number | 'none'
  /** Absent or empty means no restriction — see the server-side type's own
   *  comment on why an empty array isn't "match nothing". */
  departmentIds?: number[]
  jobIds?: number[]
  employmentTypes?: EmploymentType[]
  workLocation?: WorkLocation
  status?: EmployeeStatus
}

/** The admin employee list's paginated, server-filtered search — see
 *  listEmployees' doc for why that stays a separate, unbounded endpoint. */
export async function searchEmployees(
  filter: EmployeeSearchFilter,
  pagination: { page?: number; pageSize?: number } = {},
  signal?: AbortSignal
): Promise<EmployeeSearchResponse> {
  const params = new URLSearchParams()
  if (filter.query) params.set('q', filter.query)
  if (filter.payrollGroupId !== undefined) params.set('payrollGroupId', String(filter.payrollGroupId))
  filter.departmentIds?.forEach((id) => params.append('departmentId', String(id)))
  filter.jobIds?.forEach((id) => params.append('jobId', String(id)))
  filter.employmentTypes?.forEach((type) => params.append('employmentType', type))
  if (filter.workLocation !== undefined) params.set('workLocation', filter.workLocation)
  if (filter.status !== undefined) params.set('status', filter.status)
  if (pagination.page !== undefined) params.set('page', String(pagination.page))
  if (pagination.pageSize !== undefined) params.set('pageSize', String(pagination.pageSize))

  const query = params.toString()
  const res = await apiFetch(`/api/employees/search${query ? `?${query}` : ''}`, { signal })
  return unwrap<EmployeeSearchResponse>(res)
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

/** Severs the employee's LINE account. 409 if there isn't one linked. */
export async function unlinkLineAccount(id: number): Promise<void> {
  const res = await apiFetch(`/api/employees/${id}/line-link`, { method: 'DELETE' })
  // 204: nothing to unwrap, but a failure still needs to surface.
  if (!res.ok) await unwrap<never>(res)
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

/** Assigns a shift to several employees for one date at once — the "มอบหมายกะ
 *  รายวัน" screen for temporary daily workers who have no fixed shift. */
export async function assignDailyShifts(
  input: DailyShiftAssignmentInput
): Promise<DailyShiftAssignmentOutcome[]> {
  const res = await apiFetch('/api/employees/shift-assignments/daily-bulk', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  const body = await unwrap<DailyShiftAssignmentResponse>(res)
  return body.outcomes
}

/** The "มอบหมายกะรายวัน" picker's employee pool — 'all' active employees for
 *  HR/Admin, or the caller's own active direct reports for a supervisor.
 *  Throws (ApiRequestError, 403) if the signed-in account has neither. */
export async function fetchDailyShiftAssignmentEligibleEmployees(
  signal?: AbortSignal
): Promise<DailyShiftAssignmentEligibleResponse> {
  const res = await apiFetch('/api/employees/shift-assignments/daily-bulk/eligible-employees', {
    signal,
  })
  return unwrap<DailyShiftAssignmentEligibleResponse>(res)
}

export async function getWageHistory(id: number, signal?: AbortSignal): Promise<WageAssignment[]> {
  const res = await apiFetch(`/api/employees/${id}/wage-assignments`, { signal })
  const body = await unwrap<WageHistoryResponse>(res)
  return body.assignments
}

export async function createWageChange(
  id: number,
  input: WageChangeInput
): Promise<WageAssignment> {
  const res = await apiFetch(`/api/employees/${id}/wage-changes`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  const body = await unwrap<WageChangeResponse>(res)
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

async function fetchWorkbook(path: string, signal?: AbortSignal): Promise<Blob> {
  const res = await apiFetch(path, { ...(signal && { signal }) })
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

/** Every employee as a filled-in copy of the import template, generated
 *  server-side so it isn't capped by listEmployees' on-screen row count. */
export function exportEmployees(signal?: AbortSignal): Promise<Blob> {
  return fetchWorkbook('/api/employees/export', signal)
}

/** Only employment_type = 'ชั่วคราว' employees, in the temp-worker template's
 *  columns (fingerprint code identity, no employee code/ID card/shift). */
export function exportTempWorkerEmployees(signal?: AbortSignal): Promise<Blob> {
  return fetchWorkbook('/api/employees/export-temp-worker', signal)
}

/** A blank copy of the import template — headers and dropdowns only, no
 *  employee data. Dropdowns are generated fresh from current master data on
 *  every call, same as exportEmployees. */
export function downloadEmployeeImportTemplate(signal?: AbortSignal): Promise<Blob> {
  return fetchWorkbook('/api/employees/export-template', signal)
}

/** The temp-worker template — fingerprint code, name, department, ค่าจ้าง,
 *  no employee code/ID card/shift column. See
 *  buildTempWorkerEmployeeWorkbook's own comment server-side. */
export function downloadTempWorkerEmployeeImportTemplate(signal?: AbortSignal): Promise<Blob> {
  return fetchWorkbook('/api/employees/export-template-temp-worker', signal)
}

/** Every employee's finance settings (bank/social security/tax) and current
 *  wage, as a filled-in copy of employee-finance-template.xlsx. HRM.Payroll/
 *  HRM.Admin only — see routes/employeeFinanceExport.ts. */
export function exportEmployeeFinance(signal?: AbortSignal): Promise<Blob> {
  return fetchWorkbook('/api/employee-finance/export', signal)
}

/** A blank copy of the employee-finance template — headers and the four
 *  fixed-enum dropdowns only, no employee data. */
export function downloadEmployeeFinanceImportTemplate(signal?: AbortSignal): Promise<Blob> {
  return fetchWorkbook('/api/employee-finance/export-template', signal)
}
