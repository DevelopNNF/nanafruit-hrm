import type {
  ApiError,
  Employee,
  EmployeeInput,
  EmployeeListResponse,
  EmployeeResponse,
} from '@hrm/shared'

/**
 * Unwraps a response, turning any non-2xx into a thrown Error carrying the
 * server's own message so callers can show it verbatim.
 */
async function unwrap<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T

  let message = `HTTP ${res.status}`
  try {
    const body = (await res.json()) as ApiError
    if (body.message) message = body.message
  } catch {
    // Non-JSON error body (a proxy error page, say) — the status is all we have.
  }
  throw new Error(message)
}

const jsonHeaders = { 'Content-Type': 'application/json' }

export async function listEmployees(signal?: AbortSignal): Promise<Employee[]> {
  const res = await fetch('/api/employees', { signal })
  const body = await unwrap<EmployeeListResponse>(res)
  return body.employees
}

export async function getEmployee(id: number, signal?: AbortSignal): Promise<Employee> {
  const res = await fetch(`/api/employees/${id}`, { signal })
  const body = await unwrap<EmployeeResponse>(res)
  return body.employee
}

export async function createEmployee(input: EmployeeInput): Promise<Employee> {
  const res = await fetch('/api/employees', {
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
  const res = await fetch(`/api/employees/${id}`, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  const body = await unwrap<EmployeeResponse>(res)
  return body.employee
}

export async function deleteEmployee(id: number): Promise<void> {
  const res = await fetch(`/api/employees/${id}`, { method: 'DELETE' })
  // 204: nothing to unwrap, but a failure still needs to surface.
  if (!res.ok) await unwrap<never>(res)
}
