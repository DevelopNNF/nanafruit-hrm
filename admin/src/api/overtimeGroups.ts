import type {
  OvertimeGroup,
  OvertimeGroupInput,
  OvertimeGroupListResponse,
  OvertimeGroupResponse,
} from '@hrm/shared'
import { apiFetch, jsonHeaders, unwrap } from './client'

export async function listOvertimeGroups(signal?: AbortSignal): Promise<OvertimeGroup[]> {
  const res = await apiFetch('/api/overtime-groups', { signal })
  const body = await unwrap<OvertimeGroupListResponse>(res)
  return body.overtimeGroups
}

export async function getOvertimeGroup(id: number, signal?: AbortSignal): Promise<OvertimeGroup> {
  const res = await apiFetch(`/api/overtime-groups/${id}`, { signal })
  const body = await unwrap<OvertimeGroupResponse>(res)
  return body.overtimeGroup
}

export async function createOvertimeGroup(input: OvertimeGroupInput): Promise<OvertimeGroup> {
  const res = await apiFetch('/api/overtime-groups', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  const body = await unwrap<OvertimeGroupResponse>(res)
  return body.overtimeGroup
}

export async function updateOvertimeGroup(
  id: number,
  input: OvertimeGroupInput
): Promise<OvertimeGroup> {
  const res = await apiFetch(`/api/overtime-groups/${id}`, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  const body = await unwrap<OvertimeGroupResponse>(res)
  return body.overtimeGroup
}
