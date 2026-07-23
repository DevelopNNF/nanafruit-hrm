import type { Location, LocationInput, LocationListResponse, LocationResponse } from '@hrm/shared'
import { apiFetch, jsonHeaders, unwrap } from './client'

export async function listLocations(signal?: AbortSignal): Promise<Location[]> {
  const res = await apiFetch('/api/locations', { signal })
  const body = await unwrap<LocationListResponse>(res)
  return body.locations
}

export async function getLocation(id: number, signal?: AbortSignal): Promise<Location> {
  const res = await apiFetch(`/api/locations/${id}`, { signal })
  const body = await unwrap<LocationResponse>(res)
  return body.location
}

export async function createLocation(input: LocationInput): Promise<Location> {
  const res = await apiFetch('/api/locations', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  const body = await unwrap<LocationResponse>(res)
  return body.location
}

export async function updateLocation(id: number, input: LocationInput): Promise<Location> {
  const res = await apiFetch(`/api/locations/${id}`, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  const body = await unwrap<LocationResponse>(res)
  return body.location
}
