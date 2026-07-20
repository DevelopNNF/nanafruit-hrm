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
}

/** Body of the employment half of POST/PUT — jobTitle is read-only, so it's
 *  the one field on EmploymentDetails that isn't also an input. */
export type EmploymentDetailsInput = Omit<EmploymentDetails, 'jobTitle'>

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
