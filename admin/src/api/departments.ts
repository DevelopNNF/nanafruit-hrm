import type {
  Department,
  DepartmentInput,
  DepartmentListResponse,
  DepartmentResponse,
} from '@hrm/shared'
import { apiFetch, jsonHeaders, unwrap } from './client'

export async function listDepartments(signal?: AbortSignal): Promise<Department[]> {
  const res = await apiFetch('/api/departments', { signal })
  const body = await unwrap<DepartmentListResponse>(res)
  return body.departments
}

export async function getDepartment(id: number, signal?: AbortSignal): Promise<Department> {
  const res = await apiFetch(`/api/departments/${id}`, { signal })
  const body = await unwrap<DepartmentResponse>(res)
  return body.department
}

export async function createDepartment(input: DepartmentInput): Promise<Department> {
  const res = await apiFetch('/api/departments', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  const body = await unwrap<DepartmentResponse>(res)
  return body.department
}

export async function updateDepartment(id: number, input: DepartmentInput): Promise<Department> {
  const res = await apiFetch(`/api/departments/${id}`, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  const body = await unwrap<DepartmentResponse>(res)
  return body.department
}
