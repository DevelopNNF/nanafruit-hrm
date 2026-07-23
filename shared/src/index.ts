// The API contract, shared by server (producer) and admin/liff (consumers).
//
// This package emits runtime code, so it must be built before server can start
// and before admin/liff can typecheck. `prepare` covers the fresh-clone case;
// while editing this file, run `npm run dev -w shared` to rebuild on save.

/**
 * The App roles declared on the Entra app registration. These strings are the
 * contract with Entra, not with us: they must match the role values in the
 * manifest exactly, because they arrive verbatim in the `roles` claim.
 *
 * Ordered least- to most-privileged. Nothing depends on that order yet — the
 * checks name the roles they allow rather than comparing ranks — but it is the
 * order a reader expects.
 */
export const ROLES = ['HRM.Viewer', 'HRM.HR', 'HRM.Admin'] as const
export type Role = (typeof ROLES)[number]

/**
 * Who the caller is, as the server resolved them. The two arms come in through
 * different front doors and can never be the same request: `admin` is an Entra
 * token from admin/, `employee` is a LINE-backed session from liff/.
 */
export type AuthUser =
  | {
      kind: 'admin'
      /** Entra object id — the only identifier that is stable across renames. */
      oid: string
      /** Display name, for greeting the user. Not an identifier. */
      name: string
      /** userPrincipalName, e.g. someone@nanafruit.com. */
      upn: string
      roles: Role[]
    }
  | { kind: 'employee'; employeeId: number }

/** GET /api/me — "who am I, and what may I do?" */
export type MeResponse = { user: AuthUser }

/** Prefix on the Thai name. Free-form in the database — this is the picker list. */
export const TITLES = ['นาย', 'นาง', 'นางสาว'] as const
export type Title = (typeof TITLES)[number]

export const EMPLOYEE_STATUSES = ['Active', 'Inactive'] as const
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number]

export const EMPLOYMENT_TYPES = [
  'Permanent',
  'Contract',
  'Daily',
  'Regularly',
] as const
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number]

/**
 * `employment` is nested rather than flattened so the shape matches both the
 * two tables behind it and the two cards in front of it.
 */
export type Employee = {
  id: number
  employeeCode: string
  title: Title
  firstNameTh: string
  lastNameTh: string
  firstNameEn: string
  lastNameEn: string
  nickname: string | null
  employment: EmploymentDetails
}

export type EmploymentDetails = {
  status: EmployeeStatus
  /** Calendar date, `YYYY-MM-DD`. No time, no timezone. */
  hireDate: string
  employmentType: EmploymentType
  /** FK to master_jobs.id. */
  jobId: number
  /** master_jobs.job_title as of now, joined in for display. Derived from
   *  jobId, not writable directly — absent from EmploymentDetailsInput. */
  jobTitle: string
  /** FK to master_shifts.id. Nullable — not every employee has a shift
   *  assigned yet, unlike jobId. */
  shiftId: number | null
  /** master_shifts.shift_name as of now, joined in for display. Derived from
   *  shiftId, not writable directly — absent from EmploymentDetailsInput.
   *  Null exactly when shiftId is null. */
  shiftName: string | null
}

/** Body of the employment half of POST/PUT — jobTitle and shiftName are
 *  read-only, so they're the fields on EmploymentDetails that aren't also
 *  inputs. */
export type EmploymentDetailsInput = Omit<EmploymentDetails, 'jobTitle' | 'shiftName'>

/** Body of POST /api/employees and PATCH /api/employees/:id */
export type EmployeeInput = Omit<Employee, 'id' | 'employment'> & {
  employment: EmploymentDetailsInput
}

/** GET /api/employees */
export type EmployeeListResponse = { employees: Employee[] }

/** GET /api/employees/:id, POST, PATCH */
export type EmployeeResponse = { employee: Employee }

/**
 * Machine-readable reason on an ApiError, for the cases where the client has to
 * *do* something different rather than just show the message.
 *
 * `UNAUTHENTICATED` (401) means "no usable token" — the client should re-login.
 * `FORBIDDEN` (403) means the token is fine but the caller is not allowed;
 * re-login would just yield the same answer, so the client shows the message.
 * `NOT_LINKED` (403) means LINE vouched for this person but no employee record
 * claims them yet; liff/ turns it into the link screen rather than an error.
 */
export const API_ERROR_CODES = ['UNAUTHENTICATED', 'FORBIDDEN', 'NOT_LINKED'] as const
export type ApiErrorCode = (typeof API_ERROR_CODES)[number]

/**
 * Any 4xx/5xx from the API. `code` is absent on the plain validation errors,
 * whose message is the whole story.
 */
export type ApiError = { status: 'error'; message: string; code?: ApiErrorCode }

/* LINE identity ----------------------------------------------------------- */

/**
 * POST /api/auth/line/session — trades a LINE ID token for an HRM session.
 *
 * The ID token is sent rather than a LINE user id because a client can claim any
 * id it likes; only LINE can say whose token this is. The server asks LINE, then
 * looks up which employee that answer belongs to.
 */
export type LineSessionRequest = { idToken: string }

/**
 * A session token and the record it speaks for.
 *
 * The employee comes back with the token because it is the entire first screen
 * of liff/ — a second round trip to fetch it would only cost a phone a beat.
 */
export type LineSessionResponse = {
  token: string
  /** ISO 8601. When the token stops working and liff/ must exchange again. */
  expiresAt: string
  employee: Employee
}

/**
 * POST /api/auth/line/link — claims an employee record with a code from HR.
 *
 * Succeeds into a session: someone who just proved who they are should not then
 * be asked to sign in.
 */
export type LineLinkRequest = { idToken: string; code: string }
export type LineLinkResponse = LineSessionResponse

/** POST /api/employees/:id/link-code — HR issues a code for one employee. */
export type LinkCodeResponse = {
  /** Shown to HR once, at creation. The server keeps only a hash of it. */
  code: string
  /** ISO 8601. */
  expiresAt: string
}

/* Job Master --------------------------------------------------------------- */

/** A row in master_jobs. Row order in the list is the id's stand-in in the UI. */
export type Job = {
  id: number
  jobTitle: string
  jobDescription: string | null
  /** HTML from the Work Instruction rich text editor, or null if left blank. */
  workInstruction: string | null
  isActive: boolean
}

/** Body of POST /api/jobs and PUT /api/jobs/:id */
export type JobInput = Omit<Job, 'id'>

/** GET /api/jobs */
export type JobListResponse = { jobs: Job[] }

/** GET /api/jobs/:id, POST, PUT */
export type JobResponse = { job: Job }

/* Shift Master --------------------------------------------------------------- */

/**
 * The 7 workdays a shift's `workdays` bitmask is built from, Monday first
 * (ISO week order). `bit` values are already the shifted powers of two, so a
 * shift's mask is just `WORKDAYS.filter(...).reduce((m, d) => m | d.bit, 0)`.
 */
export const WORKDAYS = [
  { bit: 1 << 0, key: 'mon', label: 'จันทร์' },
  { bit: 1 << 1, key: 'tue', label: 'อังคาร' },
  { bit: 1 << 2, key: 'wed', label: 'พุธ' },
  { bit: 1 << 3, key: 'thu', label: 'พฤหัสบดี' },
  { bit: 1 << 4, key: 'fri', label: 'ศุกร์' },
  { bit: 1 << 5, key: 'sat', label: 'เสาร์' },
  { bit: 1 << 6, key: 'sun', label: 'อาทิตย์' },
] as const

/** The OR of every bit in WORKDAYS — the only values workdays may legally hold. */
export const WORKDAYS_MASK = WORKDAYS.reduce((mask, day) => mask | day.bit, 0)

/** A row in master_shifts. */
export type Shift = {
  id: number
  shiftCode: string
  shiftName: string
  /** Wall-clock time, `HH:MM:SS`. May be later than shiftEndTime — see workdays. */
  shiftStartTime: string
  /** Earlier than shiftStartTime means the shift runs past midnight. */
  shiftEndTime: string
  /** Both null, or both set — never just one. */
  breakStartTime: string | null
  breakEndTime: string | null
  /** Bitmask over WORKDAYS: which days this shift applies to. */
  workdays: number
  isActive: boolean
}

/** Body of POST /api/shifts and PUT /api/shifts/:id */
export type ShiftInput = Omit<Shift, 'id'>

/** GET /api/shifts */
export type ShiftListResponse = { shifts: Shift[] }

/** GET /api/shifts/:id, POST, PUT */
export type ShiftResponse = { shift: Shift }

/* Location Master --------------------------------------------------------------- */

/** A row in master_locations: one clock-in-allowed point and its radius,
 *  for attendance geofencing. */
export type Location = {
  id: number
  locationName: string
  latitude: number
  longitude: number
  /** Meters. A clock event's own coordinates must fall within this distance
   *  of (latitude, longitude) to be accepted while this location is active. */
  radiusMeters: number
  isActive: boolean
}

/** Body of POST /api/locations and PUT /api/locations/:id */
export type LocationInput = Omit<Location, 'id'>

/** GET /api/locations */
export type LocationListResponse = { locations: Location[] }

/** GET /api/locations/:id, POST, PUT */
export type LocationResponse = { location: Location }

/* Attendance ---------------------------------------------------------------- */

/**
 * Phase 1 of Time Attendance: a raw clock event, nothing derived from it yet.
 * No "late"/"early"/OT here — that reads attendance_events against
 * master_shifts and doesn't exist yet.
 */
export const ATTENDANCE_EVENT_TYPES = ['check_in', 'check_out'] as const
export type AttendanceEventType = (typeof ATTENDANCE_EVENT_TYPES)[number]

/**
 * Where the event came from: the LIFF app (GPS-backed), or an admin-approved
 * time correction request inserting the event on the employee's behalf.
 */
export const ATTENDANCE_SOURCES = ['liff_gps', 'admin_correction'] as const
export type AttendanceSource = (typeof ATTENDANCE_SOURCES)[number]

/** A row in attendance_events. */
export type AttendanceEvent = {
  id: number
  employeeId: number
  eventType: AttendanceEventType
  /** ISO 8601. Set by the server on receipt, never trusted from the client. */
  eventTime: string
  source: AttendanceSource
  /** Both null together — absent whenever the browser had no fix or the
   *  employee denied location permission. Once at least one master_locations
   *  row is active, a clock event with no coordinates is rejected before it
   *  reaches this shape at all — see matchedLocationId. */
  latitude: number | null
  longitude: number | null
  accuracyMeters: number | null
  /** FK to master_shifts.id, snapshotting employment_details.shiftId as of
   *  this event — null exactly when the employee had no shift assigned yet. */
  shiftId: number | null
  /** master_shifts.shift_name as of now, joined in for display. Null exactly
   *  when shiftId is null. */
  shiftName: string | null
  /** FK to master_locations.id — which geofence this event was validated
   *  against, snapshotted at clock time. Null exactly when the event was
   *  recorded while zero locations were active (geofencing not configured
   *  yet); once any location is active, every event either matches one or is
   *  rejected before insert, so this is never null "by mistake". */
  matchedLocationId: number | null
  /** master_locations.location_name as of now, joined in for display. Null
   *  exactly when matchedLocationId is null. */
  matchedLocationName: string | null
  /** Distance in meters from the matched location at clock time. Null
   *  exactly when matchedLocationId is null. */
  distanceMeters: number | null
  /** OS/client info from the LIFF app, e.g. "ios inClient=true ua=...".
   *  Debugging aid, not shown to the employee — see e.g. the LINE in-app
   *  browser silently declining a geolocation permission it was never asked
   *  to grant, which this is what would have named directly. */
  deviceInfo: string | null
}

/** Body of POST /api/attendance/clock. employeeId, eventTime and shiftId are
 *  not inputs — the server derives them from the caller's session and current
 *  employment_details, never from the client. */
export type AttendanceClockRequest = {
  eventType: AttendanceEventType
  latitude?: number | null
  longitude?: number | null
  accuracyMeters?: number | null
  /** Free-form OS/client string the caller reports about itself — not
   *  verified, so it's a debugging aid only, never something to branch logic
   *  on server-side. */
  deviceInfo?: string | null
}

/** POST /api/attendance/clock */
export type AttendanceClockResponse = { event: AttendanceEvent }

/** GET /api/attendance/me — null means this employee has no events yet. */
export type AttendanceStatusResponse = { lastEvent: AttendanceEvent | null }

/** An attendance event as admin/ sees it: the employee it belongs to, joined
 *  in for display, since one caller's list spans every employee. */
export type AttendanceListItem = AttendanceEvent & {
  employeeCode: string
  /** Thai full name, e.g. "นายสมชาย ใจดี" — display only, not an identifier. */
  employeeName: string
}

/** GET /api/attendance */
export type AttendanceListResponse = { events: AttendanceListItem[] }

/* Time Correction Requests --------------------------------------------------- */

/**
 * A request goes through exactly one decision. `pending` is the only status
 * that can change; `approved`/`rejected` are terminal — see the DB's
 * decision_consistency CHECK, which is the actual source of truth for which
 * fields accompany which status.
 */
export const TIME_CORRECTION_STATUSES = ['pending', 'approved', 'rejected'] as const
export type TimeCorrectionStatus = (typeof TIME_CORRECTION_STATUSES)[number]

/** A row in time_correction_requests: one employee asking to add one
 *  check-in or check-out that liff's clock-in flow missed. */
export type TimeCorrectionRequest = {
  id: number
  employeeId: number
  eventType: AttendanceEventType
  /** ISO 8601 — the wall-clock moment being requested, combined from the
   *  liff form's separate date and time fields at submission, not re-derived
   *  on approval. */
  requestedEventTime: string
  reason: string
  status: TimeCorrectionStatus
  /** The admin's display name at decision time. Null while pending. */
  decidedByName: string | null
  /** ISO 8601. Null while pending. */
  decidedAt: string | null
  /** Required when status is 'rejected', null otherwise. */
  decisionReason: string | null
  /** FK to the attendance_events row this request created. Null unless
   *  approved. */
  resultingEventId: number | null
  /** ISO 8601. */
  createdAt: string
}

/** A request as admin/ sees it: the employee joined in for display, since
 *  one caller's list spans every employee — same shape as AttendanceListItem. */
export type TimeCorrectionListItem = TimeCorrectionRequest & {
  employeeCode: string
  employeeName: string
}

/** Body of POST /api/time-corrections. employeeId is not an input — the
 *  server derives it from the caller's employee session, never the client. */
export type TimeCorrectionInput = {
  eventType: AttendanceEventType
  requestedEventTime: string
  reason: string
}

/** POST /api/time-corrections */
export type TimeCorrectionResponse = { request: TimeCorrectionRequest }

/** GET /api/time-corrections/me — an employee's own requests, no employee
 *  join needed since it's implicitly them. */
export type TimeCorrectionMineResponse = { requests: TimeCorrectionRequest[] }

/** GET /api/time-corrections */
export type TimeCorrectionListResponse = { requests: TimeCorrectionListItem[] }

/** GET /api/time-corrections/:id, POST .../approve, POST .../reject */
export type TimeCorrectionDetailResponse = { request: TimeCorrectionListItem }

/** Body of POST /api/time-corrections/:id/reject — a reason is required
 *  every time, never optional. */
export type TimeCorrectionRejectRequest = { reason: string }

/* Health ------------------------------------------------------------------ */

/** GET /api/health */
export type HealthResponse = HealthOk | HealthError

export type HealthOk = {
  status: 'ok'
  database: string
  /** ISO 8601, as produced by Date.prototype.toISOString */
  serverTime: string
}

export type HealthError = {
  status: 'error'
  message: string
}
