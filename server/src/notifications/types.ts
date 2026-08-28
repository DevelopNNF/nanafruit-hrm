// Two families of event. RequestActionEvent is one event per approval-
// workflow transition, symmetric across all five request types — mirrors
// AuditAction in audit.ts one level up, but as a discriminated union of
// payloads instead of a string, since dispatch.ts needs to branch on shape,
// not just log a label. AttendanceDigestEvent is the once-a-day summary from
// notifications/attendanceDigest.ts instead — see there for why it's a
// digest rather than a per-event push.
//
// Deliberately carries only IDs, not resolved identities: every field here
// (an employee id, a resource, a reason) is something the route handler
// already has in hand from its own request row — resolving a name from an
// id, a line_user_id from an employee, the HR channel, all of that happens
// inside dispatch.ts/recipients.ts. That keeps a route's only job "describe
// what happened", never "look up who should hear about it".

import type { AttendanceIssue } from '../attendanceDailyQueries.js'

export type RequestResourceType =
  | 'leave_request'
  | 'overtime_request'
  | 'shift_change_request'
  | 'day_off_swap_request'
  | 'time_correction_request'
  | 'off_site_work_request'

export type RequestActionEvent =
  | {
      kind: 'created'
      resource: RequestResourceType
      requestId: number
      requesterEmployeeId: number
      /** Null means the request skipped the supervisor stage entirely
       *  (requiresSupervisorApproval was false) and is already waiting on
       *  HR — dispatch.ts notifies HR by email in that case instead of a
       *  supervisor by LINE. */
      supervisorEmployeeId: number | null
    }
  | {
      kind: 'supervisor_approved'
      resource: RequestResourceType
      requestId: number
      requesterEmployeeId: number
    }
  | {
      kind: 'approved'
      resource: RequestResourceType
      requestId: number
      requesterEmployeeId: number
    }
  | {
      kind: 'rejected'
      resource: RequestResourceType
      requestId: number
      requesterEmployeeId: number
      reason: string
    }
  | {
      kind: 'cancelled'
      resource: RequestResourceType
      requestId: number
      requesterEmployeeId: number
      /** Null (never reached a supervisor, or already past that stage) means
       *  no one was actually waiting on this — dispatch.ts skips silently. */
      supervisorEmployeeId: number | null
    }

/** One supervisor's own team, for the LINE digest — see attendanceDigest.ts,
 *  which groups listAttendanceIssuesForDate's flat list by
 *  supervisorEmployeeId before building one of these per group. */
export type AttendanceDigestEvent =
  | { kind: 'attendance_digest_supervisor'; workDate: string; supervisorEmployeeId: number; issues: AttendanceIssue[] }
  | { kind: 'attendance_digest_hr'; workDate: string; issues: AttendanceIssue[] }

export type NotificationEvent = RequestActionEvent | AttendanceDigestEvent
