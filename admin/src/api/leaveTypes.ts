import type {
  LeaveType,
  LeaveTypeInput,
  LeaveTypeListResponse,
  LeaveTypeResponse,
} from '@hrm/shared'
import { apiFetch, jsonHeaders, unwrap } from './client'

export async function listLeaveTypes(signal?: AbortSignal): Promise<LeaveType[]> {
  const res = await apiFetch('/api/leave-types', { signal })
  const body = await unwrap<LeaveTypeListResponse>(res)
  return body.leaveTypes
}

export async function getLeaveType(id: number, signal?: AbortSignal): Promise<LeaveType> {
  const res = await apiFetch(`/api/leave-types/${id}`, { signal })
  const body = await unwrap<LeaveTypeResponse>(res)
  return body.leaveType
}

export async function createLeaveType(input: LeaveTypeInput): Promise<LeaveType> {
  const res = await apiFetch('/api/leave-types', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  const body = await unwrap<LeaveTypeResponse>(res)
  return body.leaveType
}

export async function updateLeaveType(id: number, input: LeaveTypeInput): Promise<LeaveType> {
  const res = await apiFetch(`/api/leave-types/${id}`, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  const body = await unwrap<LeaveTypeResponse>(res)
  return body.leaveType
}
