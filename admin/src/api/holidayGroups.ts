import type {
  HolidayGroup,
  HolidayGroupInput,
  HolidayGroupListResponse,
  HolidayGroupResponse,
} from '@hrm/shared'
import { apiFetch, jsonHeaders, unwrap } from './client'

export async function listHolidayGroups(signal?: AbortSignal): Promise<HolidayGroup[]> {
  const res = await apiFetch('/api/holiday-groups', { signal })
  const body = await unwrap<HolidayGroupListResponse>(res)
  return body.holidayGroups
}

export async function getHolidayGroup(id: number, signal?: AbortSignal): Promise<HolidayGroup> {
  const res = await apiFetch(`/api/holiday-groups/${id}`, { signal })
  const body = await unwrap<HolidayGroupResponse>(res)
  return body.holidayGroup
}

export async function createHolidayGroup(input: HolidayGroupInput): Promise<HolidayGroup> {
  const res = await apiFetch('/api/holiday-groups', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  const body = await unwrap<HolidayGroupResponse>(res)
  return body.holidayGroup
}

export async function updateHolidayGroup(
  id: number,
  input: HolidayGroupInput
): Promise<HolidayGroup> {
  const res = await apiFetch(`/api/holiday-groups/${id}`, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  const body = await unwrap<HolidayGroupResponse>(res)
  return body.holidayGroup
}
