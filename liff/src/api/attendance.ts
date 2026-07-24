import type {
  AttendanceClockRequest,
  AttendanceClockResponse,
  AttendanceEvent,
  AttendanceEventType,
  AttendanceStatusResponse,
} from '@hrm/shared'
import type { Coordinates } from '../lib/geolocation'
import { apiFetch, jsonHeaders, unwrap } from './client'

/** This employee's own most recent clock event, or null if they have none. */
export async function fetchAttendanceStatus(signal?: AbortSignal): Promise<AttendanceEvent | null> {
  const res = await apiFetch('/api/attendance/me', { signal })
  const body = await unwrap<AttendanceStatusResponse>(res)
  return body.lastEvent
}

export async function clockAttendance(
  eventType: AttendanceEventType,
  coordinates: Coordinates | null,
  deviceInfo: string
): Promise<AttendanceEvent> {
  const request: AttendanceClockRequest = {
    eventType,
    latitude: coordinates?.latitude ?? null,
    longitude: coordinates?.longitude ?? null,
    accuracyMeters: coordinates?.accuracyMeters ?? null,
    deviceInfo,
  }
  const res = await apiFetch('/api/attendance/clock', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(request),
  })
  const body = await unwrap<AttendanceClockResponse>(res)
  return body.event
}
