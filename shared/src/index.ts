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
 *
 * 'HRM.Payroll' is the exception to that ladder: it is not "more than HR", it
 * is sideways. HR can hire someone and change their shift without ever seeing
 * what anybody is paid, and the payroll screens check for this role rather
 * than for HR precisely so that stays true.
 */
export const ROLES = ['HRM.Viewer', 'HRM.HR', 'HRM.Payroll', 'HRM.Admin'] as const
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

/** Distinct from Title: title is a Thai honorific that conflates marital
 *  status with gender, but master_leave_types.gender needs a real answer to
 *  restrict a leave type (e.g. ลาคลอด) against. */
export const GENDERS = ['male', 'female'] as const
export type Gender = (typeof GENDERS)[number]

export const EMPLOYEE_STATUSES = ['Active', 'Inactive'] as const
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number]

export const EMPLOYMENT_TYPES = [
  'ประจำ (รายเดือน)',
  'ประจำ (รายวัน)',
  'สัญญาจ้าง',
  'ชั่วคราว',
] as const
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number]

/** Fixed pair of office locations, same reasoning as TITLES/GENDERS: not
 *  something HR manages via CRUD, so a const array rather than a master
 *  table. */
export const WORK_LOCATIONS = ['เชียงใหม่', 'ลำพูน'] as const
export type WorkLocation = (typeof WORK_LOCATIONS)[number]

/** Why an employment ended. English slugs, not the Thai wording admin/ shows
 *  — สปส.6-09 reports leavers by category, so code will branch on these, and
 *  the Thai labels live in admin/src/components/employmentLabels.ts. The
 *  values mirror the CHECK in 047_add_end_working_date_to_employment_details.sql;
 *  they are a first pass at the categories the company actually uses, which is
 *  why the column is text + CHECK and not an ENUM. */
export const TERMINATION_REASONS = [
  'resigned',
  'terminated',
  'retired',
  'contract_ended',
  'deceased',
  'other',
] as const
export type TerminationReason = (typeof TERMINATION_REASONS)[number]

/**
 * `employment` is nested rather than flattened so the shape matches both the
 * two tables behind it and the two cards in front of it.
 */
/** Mirrors the length CHECK on employees.fingerprint_code. Shared so the admin
 *  input caps typing at the same point the API rejects, rather than letting
 *  someone fill a field that can only ever fail to save. */
export const FINGERPRINT_CODE_MAX_LENGTH = 20

export type Employee = {
  id: number
  employeeCode: string
  /** 13-digit Thai national ID, checksum-validated. Nullable: existing
   *  employees have never recorded this, and there is no honest default to
   *  invent for them — same reasoning as GENDERS. */
  idCardNumber: string | null
  /** The ID a fingerprint terminal knows this employee by — the join key for
   *  importing a scanner's attendance export. Deliberately separate from
   *  employeeCode: the terminals were enrolled independently and number
   *  people differently. Null for anyone not enrolled on a terminal, which is
   *  most staff, since the usual channel is clocking in through LINE. */
  fingerprintCode: string | null
  /** The Entra userPrincipalName this employee signs into admin/ with, e.g.
   *  someone@nanafruit.com. Null for the vast majority of employees, who
   *  never get an admin/ account at all. HR fills this in by hand (no Entra
   *  Graph sync) for the minority who do — today, that's supervisors who
   *  need to file bulk OT requests for their own direct reports; see
   *  resolveBulkOtScope in routes/overtimeRequests.ts, which resolves an
   *  Entra session back to this column to find out whose supervisor they
   *  are. Compared case-insensitively at lookup time. */
  entraUpn: string | null
  title: Title
  firstNameTh: string
  lastNameTh: string
  /** Nullable: HR may not have the English name on file yet for every
   *  employee, unlike the Thai name, which stays required. */
  firstNameEn: string | null
  lastNameEn: string | null
  nickname: string | null
  /** Null until HR records it — see the comment on GENDERS. Only meaningful
   *  once set: a gender-restricted leave type simply can't be matched
   *  against an employee whose gender is still null. */
  gender: Gender | null
  employment: EmploymentDetails
}

export type EmploymentDetails = {
  status: EmployeeStatus
  /** Calendar date, `YYYY-MM-DD`. No time, no timezone. */
  hireDate: string
  /** Calendar date, `YYYY-MM-DD`. Distinct from hireDate — HR tracks a
   *  contract/hire date separately from the day work actually starts.
   *  Nullable for the same reason idCardNumber is: existing employees have
   *  never recorded it. */
  startWorkingDate: string | null
  /** Calendar date, `YYYY-MM-DD`. The employee's last working day. Null for
   *  anyone still employed — and deliberately independent of `status`: a
   *  resignation handed in on the 1st sets this to the end of the month while
   *  the employee stays Active for all of it. Payroll prorates a monthly wage
   *  against this, so it is the date and not the status flag that decides
   *  what a leaver's final period is worth. */
  endWorkingDate: string | null
  /** Null until HR categorises the departure — allowed even once
   *  endWorkingDate is set, since the last day is usually known first. A
   *  reason without a date is not allowed (DB CHECK). */
  terminationReason: TerminationReason | null
  employmentType: EmploymentType
  /** Nullable for the same reason startWorkingDate is. */
  workLocation: WorkLocation | null
  /** FK to master_jobs.id. */
  jobId: number
  /** master_jobs.job_title as of now, joined in for display. Derived from
   *  jobId, not writable directly — absent from EmploymentDetailsInput. */
  jobTitle: string
  /** FK to master_departments.id. Required from day one, unlike shiftId/
   *  holidayGroupId — every employee belongs to some department, even if
   *  that's the UNASSIGNED placeholder seeded by the link migration. */
  departmentId: number
  /** master_departments.dept_name as of now, joined in for display. Derived
   *  from departmentId, not writable directly — absent from EmploymentDetailsInput. */
  departmentName: string
  /** FK to master_shifts.id, as of *today* — resolved from
   *  employee_shift_assignments, not stored directly. Nullable — not every
   *  employee has a shift assigned yet, unlike jobId. Writable on
   *  EmploymentDetailsInput only for POST /api/employees (the employee's
   *  first assignment); PUT /api/employees/:id ignores it; shift changes
   *  after creation go through POST /api/employees/:id/shift-changes. */
  shiftId: number | null
  /** master_shifts.shift_name as of now, joined in for display. Derived from
   *  shiftId, not writable directly — absent from EmploymentDetailsInput.
   *  Null exactly when shiftId is null. */
  shiftName: string | null
  /** FK to master_holiday_groups.id. Nullable — same reasoning as shiftId:
   *  not every employee has a holiday calendar assigned yet. */
  holidayGroupId: number | null
  /** master_holiday_groups.group_name as of now, joined in for display.
   *  Derived from holidayGroupId, not writable directly — absent from
   *  EmploymentDetailsInput. Null exactly when holidayGroupId is null. */
  holidayGroupName: string | null
  /** FK to master_overtime_groups.id. Nullable — same reasoning as
   *  holidayGroupId: not every employee has an OT rate schedule assigned yet. */
  overtimeGroupId: number | null
  /** master_overtime_groups.group_name as of now, joined in for display.
   *  Derived from overtimeGroupId, not writable directly — absent from
   *  EmploymentDetailsInput. Null exactly when overtimeGroupId is null. */
  overtimeGroupName: string | null
  /** FK to master_payroll_groups.id. Null means "not paid by this system
   *  yet" — not "nobody has filled this in". During the parallel run with the
   *  previous HRM that is the default for everybody, and a payroll period
   *  only ever covers employees who are in its group. */
  payrollGroupId: number | null
  /** master_payroll_groups.group_name as of now, joined in for display.
   *  Derived from payrollGroupId, not writable directly — absent from
   *  EmploymentDetailsInput. Null exactly when payrollGroupId is null. */
  payrollGroupName: string | null
  /** FK to employees.id — a real reference to another employee row, not a
   *  free-text label, so the admin form can offer a dropdown of active
   *  employees and stay in sync if that person's name changes. Nullable:
   *  HR fills this in manually and most employees won't have one set. Not
   *  validated against employmentType/department — any active employee can
   *  be named supervisor of any other. */
  supervisorEmployeeId: number | null
  /** employees.employee_code of supervisorEmployeeId as of now, joined in
   *  for display and for round-tripping through the Excel import template
   *  (HR types the code back in manually — see employeeImportParse.ts).
   *  Derived from supervisorEmployeeId, not writable directly — absent from
   *  EmploymentDetailsInput. Null exactly when supervisorEmployeeId is null. */
  supervisorEmployeeCode: string | null
  /** supervisorEmployeeId's Thai name as of now, joined in for display only.
   *  Derived from supervisorEmployeeId, not writable directly — absent from
   *  EmploymentDetailsInput. Null exactly when supervisorEmployeeId is null. */
  supervisorEmployeeName: string | null
  /** master_shifts.shift_start_time/shift_end_time as of now, joined in
   *  purely so liff's leave-request form can prefill a default time range
   *  without needing its own route into master_shifts (which is admin-only).
   *  Derived from shiftId, not writable directly — absent from
   *  EmploymentDetailsInput. Null exactly when shiftId is null. Wall-clock
   *  'HH:MM:SS', same as the column itself — see master_shifts' comment on
   *  why these are `time` and not `timestamptz`. */
  shiftStartTime: string | null
  shiftEndTime: string | null
}

/** Body of the employment half of POST/PUT — jobTitle, departmentName,
 *  shiftName, holidayGroupName, overtimeGroupName, payrollGroupName,
 *  supervisorEmployeeCode, supervisorEmployeeName, shiftStartTime and
 *  shiftEndTime are read-only, so they're the fields on EmploymentDetails
 *  that aren't also inputs. */
export type EmploymentDetailsInput = Omit<
  EmploymentDetails,
  | 'jobTitle'
  | 'departmentName'
  | 'shiftName'
  | 'holidayGroupName'
  | 'overtimeGroupName'
  | 'payrollGroupName'
  | 'supervisorEmployeeCode'
  | 'supervisorEmployeeName'
  | 'shiftStartTime'
  | 'shiftEndTime'
>

/** Body of POST /api/employees */
export type EmployeeInput = Omit<Employee, 'id' | 'employment'> & {
  employment: EmploymentDetailsInput
}

/** Body of PATCH /api/employees/:id/basic */
export type EmployeeBasicInput = Omit<Employee, 'id' | 'employment'>

/** Body of PATCH /api/employees/:id/employment. shiftId is absent — shift
 *  changes always go through POST /api/employees/:id/shift-changes, which is
 *  the only writer of "current shift". */
export type EmploymentInput = Omit<EmploymentDetailsInput, 'shiftId'>

/** GET /api/employees */
export type EmployeeListResponse = { employees: Employee[] }

/** GET /api/employees/:id, POST, PATCH */
export type EmployeeResponse = { employee: Employee }

/* Employee Photo -------------------------------------------------------------
 * Stored in Cloudflare R2, never inline on Employee: photo_key is an internal
 * R2 object key, not a URL, and it's private — the only way to reach the
 * image is a presigned URL minted by GET /api/employees/:id/photo.
 */

export const EMPLOYEE_PHOTO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
export type EmployeePhotoMimeType = (typeof EMPLOYEE_PHOTO_MIME_TYPES)[number]
export const EMPLOYEE_PHOTO_MAX_BYTES = 5 * 1024 * 1024

/** Body of POST /api/employees/:id/photo/presign-upload */
export type EmployeePhotoPresignInput = {
  mimeType: EmployeePhotoMimeType
  sizeBytes: number
}
/** Response of the same — uploadUrl is a presigned PUT, good for a few minutes. */
export type EmployeePhotoPresignResponse = { uploadUrl: string; key: string }

/** Body of POST /api/employees/:id/photo/complete */
export type EmployeePhotoCompleteInput = { key: string }

/** GET /api/employees/:id/photo — url is a presigned GET, or null if the
 *  employee has no photo. Regenerated on every call, nothing to cache. */
export type EmployeePhotoResponse = { url: string | null }

/* Shift History ------------------------------------------------------------- */

/** A row in employee_shift_assignments: one interval during which a given
 *  shift applied to an employee. The source of truth for "what shift was in
 *  effect on date X" — see that migration's comment for why
 *  employment_details.shift_id stopped being it. */
export type ShiftAssignment = {
  id: number
  shiftId: number | null
  /** 'YYYY-MM-DD'. */
  effectiveFrom: string
  /** 'YYYY-MM-DD', or null if this is the currently open-ended assignment. */
  effectiveTo: string | null
  note: string | null
  createdByKind: string
  createdById: string
  /** ISO 8601. */
  createdAt: string
}

/**
 * Body of POST /api/employees/:id/shift-changes.
 *
 * `effectiveTo` absent or null means a permanent change (HR/Admin, from the
 * employee edit screen). Set, it's a temporary swap: the employee's
 * previous shift resumes automatically the day after, no separate action
 * needed. Either way `effectiveFrom` must be today or later — backdating is
 * not allowed, since attendance already snapshots the shift that applied at
 * clock-in time and doesn't need correcting after the fact.
 */
export type ShiftChangeInput = {
  shiftId: number | null
  effectiveFrom: string
  effectiveTo?: string | null
  note?: string | null
}

/** POST /api/employees/:id/shift-changes */
export type ShiftChangeResponse = { assignment: ShiftAssignment }

/** GET /api/employees/:id/shift-history — most recent interval first. */
export type ShiftHistoryResponse = { assignments: ShiftAssignment[] }

/**
 * Body of POST /api/employees/shift-assignments/daily-bulk — assigns a shift
 * to several employees for exactly one calendar date at once. For employees
 * with no fixed/recurring shift (temporary daily workers), whose shift a
 * supervisor picks day by day rather than through
 * POST /api/employees/:id/shift-changes' permanent/temporary-swap model.
 */
export type DailyShiftAssignmentInput = {
  /** 'YYYY-MM-DD'. */
  date: string
  assignments: { employeeId: number; shiftId: number }[]
}

/** One row's result. `conflict` means something wider than a single day
 *  already covers that employee's date (an open-ended baseline, or a
 *  multi-day swap) — nothing was written for that employee; resolve it via
 *  their own shift history instead. `error` is anything unexpected (e.g. a
 *  stale employeeId) — each row runs in its own savepoint, so one row's
 *  error never rolls back the rest of the batch. */
export type DailyShiftAssignmentOutcome =
  | { employeeId: number; kind: 'ok' }
  | {
      employeeId: number
      kind: 'conflict'
      existingEffectiveFrom: string
      existingEffectiveTo: string | null
    }
  | { employeeId: number; kind: 'error'; message: string }

export type DailyShiftAssignmentResponse = { outcomes: DailyShiftAssignmentOutcome[] }

/** GET /api/employees/shift-assignments/daily-bulk/eligible-employees
 *
 *  The employee picker's pool for "มอบหมายกะรายวัน", scoped the same way
 *  Bulk OT Request's eligible-employees endpoint is (see
 *  server/src/supervisorScope.ts): 'all' for HR/Admin, 'team' for a
 *  supervisor resolved from their Entra UPN. A caller in neither gets 403,
 *  not an empty 'team' list. */
export type DailyShiftAssignmentEligibleResponse = { scope: 'all' | 'team'; employees: Employee[] }

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

/* Employee Finance ------------------------------------------------------------
 *
 * Wage, bank, social security and withholding-tax settings for one employee.
 * A separate tab/table from Employee/EmploymentDetails, and read/written
 * through its own routes rather than nested onto Employee — canRead there is
 * every HRM role, but this is salary data, so its routes require HR/Admin for
 * both read and write (see server/src/routes/employees.ts).
 */

/* The four enums below are English slugs, not the Thai wording admin/ shows.
 * They were Thai until 044_englishify_employee_finance_enums.sql moved them,
 * for the reason master_finance_items was built that way from the start:
 * server code branches on these values, and a branch reads better in the same
 * language as the code around it — but mainly so rewording the Thai on screen
 * stays a frontend change instead of a migration that rewrites every row and
 * its CHECK constraint with it.
 *
 * The Thai labels live in admin/src/components/employeeFinanceLabels.ts.
 * Nothing here should ever be rendered to a user directly. */

/** Belongs to WageAssignment, not EmployeeFinance — the wage moved out of
 *  that table in 046_create_employee_wage_assignments.sql. Left in this group
 *  because it is still one of the finance tab's enums. */
export const WAGE_TYPES = ['monthly', 'daily'] as const
export type WageType = (typeof WAGE_TYPES)[number]

export const PAYMENT_METHODS = ['cash', 'transfer', 'cheque'] as const
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]

export const SOCIAL_SECURITY_TYPES = [
  'none',
  'actual_wage_employee_paid',
  'actual_wage_company_paid',
  'section_39',
  'fixed_monthly',
  'formula',
] as const
export type SocialSecurityType = (typeof SOCIAL_SECURITY_TYPES)[number]

export const TAX_TYPES = [
  'none',
  'monthly_recalc_employee_paid',
  'monthly_recalc_company_paid',
  'fixed_monthly',
  'percent_of_income',
] as const
export type TaxType = (typeof TAX_TYPES)[number]

/** A row in employee_finance. Absent (no row saved yet) is represented as
 *  `null` on EmployeeFinanceResponse, not as this type with empty fields —
 *  there is no honest default to invent for wageAmount/bankAccountNumber. */
export type EmployeeFinance = {
  paymentMethod: PaymentMethod
  /** Fixed to 'ไทยพาณิชย์ (SCB)' for now — the company uses one bank today,
   *  so this is a stored default rather than a picker. Read-only: absent
   *  from EmployeeFinanceInput. */
  bankName: string
  bankBranchCode: string | null
  bankAccountNumber: string
  socialSecurityType: SocialSecurityType
  /** Required exactly when socialSecurityType is 'fixed_monthly', null
   *  otherwise — enforced by a DB CHECK, not just convention, same as
   *  taxFixedAmount below. */
  socialSecurityFixedAmount: number | null
  taxType: TaxType
  /** Required exactly when taxType is 'fixed_monthly', null otherwise.
   *  Shares the slug with socialSecurityType's fixed value but is a
   *  different enum — the two CHECKs are separate. */
  taxFixedAmount: number | null
  /** Calendar date, `YYYY-MM-DD`, always the 1st of the month — the month
   *  withholding tax starts being calculated from. A real date rather than a
   *  bare 1-12 month number so it doesn't go silently ambiguous across
   *  years. Null if not set. */
  taxStartMonth: string | null
}

/** Body of PATCH /api/employees/:id/finance — bankName is read-only, so it's
 *  the field on EmployeeFinance that isn't also an input. */
export type EmployeeFinanceInput = Omit<EmployeeFinance, 'bankName'>

/** GET /api/employees/:id/finance, PATCH — null means no finance data has
 *  been saved for this employee yet. */
export type EmployeeFinanceResponse = { finance: EmployeeFinance | null }

/* Wage assignments ----------------------------------------------------------
 *
 * What an employee was paid, and over which dates. The same interval shape as
 * ShiftAssignment, and for the same reason — see
 * 046_create_employee_wage_assignments.sql. This is the only source of truth
 * for a wage; employee_finance's old wage columns are dead.
 */

/** A row in employee_wage_assignments. */
export type WageAssignment = {
  id: number
  wageType: WageType
  wageAmount: number
  /** Inclusive start, 'YYYY-MM-DD'. */
  effectiveFrom: string
  /** Inclusive end, 'YYYY-MM-DD', or null for the currently open-ended row.
   *  There is at most one of those per employee — enforced by the EXCLUDE
   *  constraint, since two unbounded ranges always overlap. */
  effectiveTo: string | null
  note: string | null
  createdByKind: string
  createdById: string
  /** ISO 8601. */
  createdAt: string
}

/**
 * Body of POST /api/employees/:id/wage-changes.
 *
 * Unlike ShiftChangeInput, `effectiveFrom` MAY be in the past. A raise agreed
 * in April and effective from 1 March is ordinary, and the whole point of
 * this table is that the March payroll then prices March correctly. A shift
 * change can refuse backdating because attendance already snapshots the shift
 * at clock-in; a wage has no such snapshot until a payslip is issued.
 *
 * There is no `effectiveTo`: a wage runs until the next one supersedes it.
 * The open row is closed automatically at effectiveFrom - 1.
 */
export type WageChangeInput = {
  wageType: WageType
  wageAmount: number
  effectiveFrom: string
  note?: string | null
}

/** GET /api/employees/:id/wage-assignments — most recent interval first. */
export type WageHistoryResponse = { assignments: WageAssignment[] }

/** POST /api/employees/:id/wage-changes */
export type WageChangeResponse = { assignment: WageAssignment }

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

/* Department Master ---------------------------------------------------------- */

/** A row in master_departments. parentDepartmentId is a self-reference for
 *  the department hierarchy — null for a top-level department. */
export type Department = {
  id: number
  deptCode: string
  deptName: string
  /** FK to master_departments.id, or null if this is a top-level department. */
  parentDepartmentId: number | null
  /** master_departments.dept_name of parentDepartmentId, joined in for
   *  display. Derived, not writable directly — absent from DepartmentInput.
   *  Null exactly when parentDepartmentId is null. */
  parentDepartmentName: string | null
  isActive: boolean
}

/** Body of POST /api/departments and PUT /api/departments/:id —
 *  parentDepartmentName is read-only, so it's the field on Department that
 *  isn't also an input. */
export type DepartmentInput = Omit<Department, 'id' | 'parentDepartmentName'>

/** GET /api/departments */
export type DepartmentListResponse = { departments: Department[] }

/** GET /api/departments/:id, POST, PUT */
export type DepartmentResponse = { department: Department }

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
  /** Minutes after shiftStartTime a check-in is still on-time. 0 = no grace. */
  lateGraceMinutes: number
  /** Minutes before shiftEndTime a check-out still counts as on-time. 0 = no grace. */
  earlyLeaveGraceMinutes: number
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

/* Leave Type Master ----------------------------------------------------------- */

/** A row in master_leave_types: configuration rules for one type of leave.
 *  Not a request and not a balance — actual entitlement/usage per employee
 *  lives in LeaveBalanceEntry (leave_balance_entries), which this type only
 *  suggests a default amount for. */
export type LeaveType = {
  id: number
  leaveCode: string
  leaveName: string
  isPaid: boolean
  allowHalfDay: boolean
  allowHourly: boolean
  /** Smallest amount a single request may be for, in days (0.5 = half day). */
  minLeaveDays: number
  /** Largest amount a single request may be for, in days. Null = uncapped —
   *  this is a per-request ceiling, not an annual quota. */
  maxLeaveDays: number | null
  /** How many days ahead of the leave date a request must be submitted. */
  advanceNoticeDays: number
  /** 'all' unless the type is restricted to one sex (ลาคลอด, ลาบวช) —
   *  compared against Employee.gender, which can be null. */
  gender: 'all' | Gender
  /** Whether a public holiday (per the employee's HolidayGroup) inside the
   *  leave range counts toward LeaveRequest.totalDays. Read by the
   *  day-counting logic in leaveRequestQueries.ts. */
  isCountHoliday: boolean
  /** Whether a non-workday (per the employee's shift `workdays` bitmask)
   *  inside the leave range counts toward LeaveRequest.totalDays. Same
   *  caveat as isCountHoliday. */
  isCountWeekend: boolean
  /** Suggested amount for a year's 'grant' entry in LeaveBalanceEntry — see
   *  that migration's comment. Null means this type has no banked
   *  entitlement (e.g. ลาไม่รับค่าจ้าง) and never gets a grant. */
  defaultDaysPerYear: number | null
  /** Whether LeaveRequestInput.reason is mandatory for this type on the
   *  liff leave-request form. Checked in application code, not a DB CHECK —
   *  same split as leave_balance_entries_adjustment_reason. */
  requireReason: boolean
  /** Display order in lists/forms — lower first. */
  sortOrder: number
  isActive: boolean
}

/** Body of POST /api/leave-types and PUT /api/leave-types/:id */
export type LeaveTypeInput = Omit<LeaveType, 'id'>

/** GET /api/leave-types */
export type LeaveTypeListResponse = { leaveTypes: LeaveType[] }

/** GET /api/leave-types/:id, POST, PUT */
export type LeaveTypeResponse = { leaveType: LeaveType }

/* Leave Balance -------------------------------------------------------------- */

/**
 * A row in leave_balance_entries — one transaction against an employee's
 * leave-type balance for one year. The balance itself is never stored; it is
 * SUM(amountDays) over every entry for the same (employeeId, leaveTypeId,
 * year) — see the migration's comment for why this is a ledger rather than
 * a mutable snapshot.
 */
export const LEAVE_BALANCE_ENTRY_TYPES = ['grant', 'carry_over', 'adjustment', 'usage'] as const
export type LeaveBalanceEntryType = (typeof LEAVE_BALANCE_ENTRY_TYPES)[number]

export type LeaveBalanceEntry = {
  id: number
  employeeId: number
  leaveTypeId: number
  year: number
  entryType: LeaveBalanceEntryType
  /** Positive for grant/carry_over, negative for usage, either sign for
   *  adjustment — enforced by a DB CHECK, not just convention. */
  amountDays: number
  /** Required when entryType is 'adjustment', null otherwise. */
  reason: string | null
  /** The admin's display name at the time this entry was made. */
  createdByName: string
  /** ISO 8601. */
  createdAt: string
}

/** Body of POST /api/employees/:employeeId/leave-balances/entries. employeeId
 *  itself is not an input — it's the route param that says whose balance
 *  this is. entryType is restricted to the kinds HR can create by hand —
 *  'usage' has no route yet (see the migration's comment), so it's excluded
 *  here rather than merely discouraged. */
export type LeaveBalanceEntryInput = {
  leaveTypeId: number
  year: number
  entryType: Exclude<LeaveBalanceEntryType, 'usage'>
  amountDays: number
  reason: string | null
}

/** GET /api/employees/:employeeId/leave-balances/entries */
export type LeaveBalanceEntryListResponse = { entries: LeaveBalanceEntry[] }

/** POST /api/employees/:employeeId/leave-balances/entries */
export type LeaveBalanceEntryResponse = { entry: LeaveBalanceEntry }

/** One leave type's balance summary for one employee/year, derived by
 *  summing leave_balance_entries grouped by entryType. remainingDays is the
 *  total of all of them combined, not merely granted minus used — an
 *  adjustment can move it either way. pendingDays is not part of that sum:
 *  a pending leave_requests row hasn't posted a 'usage' entry yet (only
 *  approval does), so it's summed in separately, from leave_requests rather
 *  than the ledger. */
export type LeaveBalanceSummary = {
  leaveTypeId: number
  leaveCode: string
  leaveName: string
  year: number
  grantedDays: number
  usedDays: number
  adjustmentDays: number
  remainingDays: number
  /** SUM(totalDays) over this employee/type/year's leave_requests still
   *  awaiting a decision. The liff gauge's yellow segment; also what a new
   *  request's balance check subtracts from remainingDays before comparing
   *  against the requested amount, so two pending requests can't both be
   *  approved past the same limit. */
  pendingDays: number
}

/** GET /api/employees/:employeeId/leave-balances */
export type LeaveBalanceSummaryListResponse = { summaries: LeaveBalanceSummary[] }

/** POST /api/leave-balances/bulk-grant — issues one 'grant' entry, amount
 *  taken from LeaveType.defaultDaysPerYear, to every active employee who
 *  doesn't already have a 'grant' entry for this leaveTypeId/year. */
export type BulkGrantLeaveRequest = { year: number; leaveTypeId: number }

export type BulkGrantLeaveResponse = {
  /** How many employees received a new grant entry. */
  grantedCount: number
  /** How many active employees already had one for this year/type and were
   *  left untouched — bulk-grant is safe to run more than once. */
  skippedCount: number
}

/* Leave Requests -------------------------------------------------------------- */

/**
 * A request goes through exactly one decision, same as TimeCorrectionStatus —
 * except a request may also be withdrawn by the employee before that decision
 * is made. 'pending' is the only status that can change away from itself;
 * 'approved'/'rejected'/'cancelled' are all terminal — see the DB's
 * decision_consistency CHECK, which is the actual source of truth for which
 * fields accompany which status.
 */
export const LEAVE_REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const
export type LeaveRequestStatus = (typeof LEAVE_REQUEST_STATUSES)[number]

/** Who needs to act next on a pending request. Null once status leaves
 *  'pending' — see the migration's comment on why 'hr' covers both "never
 *  needed a supervisor" and "supervisor already forwarded it". */
export const LEAVE_REQUEST_STAGES = ['supervisor', 'hr'] as const
export type LeaveRequestStage = (typeof LEAVE_REQUEST_STAGES)[number]

/** A row in leave_requests: one employee's request for one leave type over
 *  one date range. leaveTypeName/leaveTypeCode are joined in for display —
 *  every screen that shows a request needs them, the same reasoning as
 *  EmploymentDetails.jobTitle being joined onto every Employee. */
export type LeaveRequest = {
  id: number
  employeeId: number
  leaveTypeId: number
  leaveTypeCode: string
  leaveTypeName: string
  /** Calendar date, `YYYY-MM-DD`. */
  startDate: string
  endDate: string
  /** Wall-clock 'HH:MM:SS'. Set only for a leave type's hourly range or a
   *  half day taken as a custom time; null for a plain full-day or AM/PM
   *  half-day request. */
  startTime: string | null
  endTime: string | null
  /** Computed once at submission from the leave type's rules, the
   *  employee's shift workdays and their holiday group, then frozen — see
   *  the migration's comment on why this isn't recomputed at approval. */
  totalDays: number
  /** Required when the leave type has requireReason set, null otherwise. */
  reason: string | null
  status: LeaveRequestStatus
  /** Snapshot of employment_details.supervisor_employee_id (via
   *  employee.employment.supervisorEmployeeId) at submission time — same
   *  snapshot reasoning as everything else on this request. False/null when
   *  the employee had no supervisor, in which case the request skips
   *  straight to the HR/Admin stage. */
  requiresSupervisorApproval: boolean
  supervisorEmployeeId: number | null
  /** Joined in for display, same reasoning as leaveTypeName. Null exactly
   *  when supervisorEmployeeId is null. */
  supervisorEmployeeName: string | null
  /** Who must act next; null once the request is no longer pending. */
  currentStage: LeaveRequestStage | null
  /** Set only when a supervisor approved and forwarded this request to HR —
   *  a supervisor's rejection is terminal and recorded in decidedByName/
   *  decisionReason below instead, same as HR/Admin's decision. Null when
   *  requiresSupervisorApproval is false, or when HR/Admin decided before
   *  the supervisor acted. */
  supervisorApprovedByName: string | null
  /** ISO 8601. Null under the same conditions as supervisorApprovedByName. */
  supervisorApprovedAt: string | null
  /** The final decision maker — a supervisor (if they rejected), or
   *  HR/Admin. Null while pending/cancelled. */
  decidedByName: string | null
  /** ISO 8601. Null while pending/cancelled. */
  decidedAt: string | null
  /** Required when status is 'rejected', null otherwise. */
  decisionReason: string | null
  /** FK to the leave_balance_entries 'usage' row this request posted. Null
   *  unless approved. */
  leaveBalanceEntryId: number | null
  /** ISO 8601. */
  createdAt: string
}

/** A request as admin/ sees it: the employee joined in for display, since
 *  one caller's list spans every employee — same shape as
 *  TimeCorrectionListItem. */
export type LeaveRequestListItem = LeaveRequest & {
  employeeCode: string
  employeeName: string
}

/** Body of POST /api/leave-requests. employeeId is not an input — the
 *  server derives it from the caller's employee session, never the client.
 *  totalDays is not an input either — the server computes and validates it,
 *  never trusting a client-supplied day count. */
export type LeaveRequestInput = {
  leaveTypeId: number
  startDate: string
  endDate: string
  startTime: string | null
  endTime: string | null
  reason: string | null
}

/** POST /api/leave-requests */
export type LeaveRequestResponse = { request: LeaveRequest }

/** GET /api/leave-requests/me — an employee's own requests, no employee
 *  join needed since it's implicitly them. */
export type LeaveRequestMineResponse = { requests: LeaveRequest[] }

/** GET /api/leave-requests */
export type LeaveRequestListResponse = { requests: LeaveRequestListItem[] }

/** GET /api/leave-requests/:id, POST .../approve, POST .../reject.
 *  canDecide is caller-relative, not a property of the request — the same
 *  reasoning as OvertimeWeeklyCapResponse being its own endpoint rather than
 *  a field on the request. True only while status is 'pending' and the
 *  caller is either HR/Admin (any stage) or the snapshotted
 *  supervisorEmployeeId while currentStage is 'supervisor'. The server
 *  checks this again on every write; it exists so the UI can decide whether
 *  to show the approve/reject controls at all without guessing. */
export type LeaveRequestDetailResponse = { request: LeaveRequestListItem; canDecide: boolean }

/** Body of POST /api/leave-requests/:id/reject — a reason is required every
 *  time, never optional. */
export type LeaveRequestRejectRequest = { reason: string }

/* Holiday Group Master ------------------------------------------------------- */

/** A row in master_holiday_groups: which holiday calendar an employee is
 *  assigned to (e.g. Office vs Factory). The dates themselves live one level
 *  down, in Holiday/master_holidays. */
export type HolidayGroup = {
  id: number
  groupCode: string
  groupName: string
  isActive: boolean
}

/** Body of POST /api/holiday-groups and PUT /api/holiday-groups/:id */
export type HolidayGroupInput = Omit<HolidayGroup, 'id'>

/** GET /api/holiday-groups */
export type HolidayGroupListResponse = { holidayGroups: HolidayGroup[] }

/** GET /api/holiday-groups/:id, POST, PUT */
export type HolidayGroupResponse = { holidayGroup: HolidayGroup }

/** A row in master_holidays: one calendar date within one group. Unlike every
 *  other master table, there is no isActive here and a real DELETE route —
 *  see the migration's comment for why (nothing holds a foreign key to a
 *  single holiday row). */
export type Holiday = {
  id: number
  /** FK to master_holiday_groups.id. */
  groupId: number
  holidayName: string
  /** Calendar date, `YYYY-MM-DD`. No time, no timezone. */
  holidayDate: string
}

/** Body of POST /api/holiday-groups/:groupId/holidays and PUT /api/holidays/:id.
 *  groupId is not an input on the PUT body — which group a holiday belongs to
 *  is fixed at creation, set from the route param, not the body. */
export type HolidayInput = Omit<Holiday, 'id' | 'groupId'>

/** GET /api/holiday-groups/:groupId/holidays */
export type HolidayListResponse = { holidays: Holiday[] }

/** POST /api/holiday-groups/:groupId/holidays, PUT /api/holidays/:id */
export type HolidayResponse = { holiday: Holiday }

/* Overtime Group Master ------------------------------------------------------
 *
 * Which OT rate schedule an employee is assigned to. Unlike Holiday Group,
 * there is no child table: the five rate multipliers and the rounding rule
 * are a fixed set of columns per group, not a list of variable length, so
 * they live directly on this one row rather than one level down.
 */

/** Minutes an OT period is rounded to before it's calculated — see the
 *  migration's comment for why this is a closed set rather than a numeric
 *  range. 0 = ไม่ปัด (no rounding). */
export const OVERTIME_ROUNDING_MINUTES = [0, 15, 30, 60] as const
export type OvertimeRoundingMinutes = (typeof OVERTIME_ROUNDING_MINUTES)[number]

/** A row in master_overtime_groups. Every rate is a multiplier of the
 *  employee's normal hourly wage (1.0, 1.5, 2.0, 3.0, ...), matching the
 *  Thai Labor Protection Act's OT categories — see the migration's comment
 *  for what each of the five covers. */
export type OvertimeGroup = {
  id: number
  groupCode: string
  groupName: string
  /** นอกเวลา วันทำงานปกติ — OT after hours on a normal workday. */
  rateOtWorkday: number
  /** ในเวลา นอกวันทำงาน — in-hours pay on a scheduled day off. */
  rateNormalDayoff: number
  /** นอกเวลา นอกวันทำงานปกติ — OT on a scheduled day off. */
  rateOtDayoff: number
  /** ในเวลา วันหยุดพิเศษ — in-hours pay on a holiday (see master_holidays). */
  rateNormalHoliday: number
  /** นอกเวลา วันหยุดพิเศษ — OT on a holiday. */
  rateOtHoliday: number
  roundingMinutes: OvertimeRoundingMinutes
  isActive: boolean
}

/** Body of POST /api/overtime-groups and PUT /api/overtime-groups/:id */
export type OvertimeGroupInput = Omit<OvertimeGroup, 'id'>

/** GET /api/overtime-groups */
export type OvertimeGroupListResponse = { overtimeGroups: OvertimeGroup[] }

/** GET /api/overtime-groups/:id, POST, PUT */
export type OvertimeGroupResponse = { overtimeGroup: OvertimeGroup }

/* Payroll Group Master -------------------------------------------------------
 *
 * Which employees a payroll run covers, and on what cycle. See
 * 048_create_master_payroll_groups.sql for why this is a group and not a
 * boolean flag on the employee.
 */

/** How a group's pay date is derived once its period window is known.
 *  'last_day_of_month' — the last day of the period_code month, which is what
 *  Nanafruit does. 'fixed_day' — PayrollGroup.payDayOfMonth of that month. */
export const PAY_DAY_RULES = ['last_day_of_month', 'fixed_day'] as const
export type PayDayRule = (typeof PAY_DAY_RULES)[number]

/** A row in master_payroll_groups. */
export type PayrollGroup = {
  id: number
  groupCode: string
  groupName: string
  /** Day of the month the period ends on: 25 means a period runs from the
   *  26th of the previous month to the 25th of this one. Capped at 28 by the
   *  table's CHECK — see that migration for why. */
  cutoffDay: number
  payDayRule: PayDayRule
  /** Only meaningful when payDayRule is 'fixed_day', and null exactly when it
   *  is not — the table enforces the pairing. */
  payDayOfMonth: number | null
  isActive: boolean
}

/** Body of POST /api/payroll-groups and PUT /api/payroll-groups/:id */
export type PayrollGroupInput = Omit<PayrollGroup, 'id'>

/** GET /api/payroll-groups */
export type PayrollGroupListResponse = { payrollGroups: PayrollGroup[] }

/** GET /api/payroll-groups/:id, POST, PUT */
export type PayrollGroupResponse = { payrollGroup: PayrollGroup }

/* Payroll Period -------------------------------------------------------------
 *
 * One pay run for one group. Phase 1 only builds the container: nothing
 * calculates against it yet.
 */

/** The pay-run lifecycle. Only 'draft' and 'voided' are reachable today — the
 *  rest arrive with the phases that give them meaning, and are listed now
 *  because the allowed transitions are one table (canTransition in
 *  server/src/payrollPeriod.ts) rather than a rule per route. */
export const PAYROLL_PERIOD_STATUSES = [
  'draft',
  'calculating',
  'review',
  'approved',
  'paid',
  'closed',
  'voided',
] as const
export type PayrollPeriodStatus = (typeof PAYROLL_PERIOD_STATUSES)[number]

/** A row in payroll_periods. */
export type PayrollPeriod = {
  id: number
  payrollGroupId: number
  /** master_payroll_groups.group_name, joined in for display. */
  payrollGroupName: string
  /** The month the salary is FOR, 'YYYY-MM'. Not the window — period '2026-08'
   *  on a 25th cut-off runs 2026-07-26 to 2026-08-25. */
  periodCode: string
  /** Both inclusive, 'YYYY-MM-DD'. Derived from the group's cutoffDay when the
   *  period is created, then stored: changing a group's cut-off must not move
   *  a period that has already been paid. */
  periodStart: string
  periodEnd: string
  payDate: string
  status: PayrollPeriodStatus
  note: string | null
  closedAt: string | null
  voidedAt: string | null
  voidReason: string | null
  createdAt: string
}

/** Body of POST /api/payroll-periods. The window is optional: send just the
 *  group and the period code and the server derives it. Send dates as well and
 *  they are used as given — which is what the form does after HR edits the
 *  derived values. */
export type PayrollPeriodInput = {
  payrollGroupId: number
  periodCode: string
  periodStart?: string
  periodEnd?: string
  payDate?: string
  note?: string | null
}

/** Body of PATCH /api/payroll-periods/:id. Only accepted while the period is
 *  still 'draft'; the group and the period code are not editable at all, since
 *  changing either is creating a different period. */
export type PayrollPeriodPatch = {
  periodStart: string
  periodEnd: string
  payDate: string
  note: string | null
}

/** Body of POST /api/payroll-periods/:id/void. The reason is required: a
 *  period that vanished with no explanation is the thing this status exists
 *  to avoid. */
export type PayrollPeriodVoidInput = { voidReason: string }

/** GET /api/payroll-periods */
export type PayrollPeriodListResponse = { payrollPeriods: PayrollPeriod[] }

/** GET /api/payroll-periods/:id, POST, PATCH, void */
export type PayrollPeriodResponse = { payrollPeriod: PayrollPeriod }

/** GET /api/payroll-periods/preview — the window a period would get, without
 *  creating anything. Exists so the form does not reimplement the derivation
 *  the server already owns. */
export type PayrollPeriodPreviewResponse = {
  periodStart: string
  periodEnd: string
  payDate: string
  /** Inclusive day count of the window. Shown on the form because a
   *  26th-to-25th cycle is 28, 30 or 31 days depending on the month, and that
   *  surprises people. */
  dayCount: number
}

/* Finance Item Master --------------------------------------------------------
 *
 * The vocabulary of money that can appear on a payslip — ค่ากะ, ค่าตำแหน่ง,
 * ค่า กยศ. and so on. Deliberately carries no amount: what an item is worth
 * varies per employee, so that lives on the per-employee table a later phase
 * adds, not on the item itself.
 */

/** What a finance item does to a payslip: 'income' adds, 'deduction' and
 *  'tax' subtract. English slugs rather than the Thai labels admin/ shows,
 *  because payroll code branches on them — see the migration's comment.
 *
 *  'tax' is split out from 'deduction' because ภงด.1 wants the tax lines
 *  reported on their own. It covers manually-recorded tax only; the automatic
 *  withholding still comes from EmployeeFinance.taxType. */
export const FINANCE_ITEM_TYPES = ['income', 'deduction', 'tax'] as const
export type FinanceItemType = (typeof FINANCE_ITEM_TYPES)[number]

/** A row in master_finance_items. */
export type FinanceItem = {
  id: number
  itemCode: string
  itemName: string
  itemType: FinanceItemType
  /** Free-text note for HR. Nothing reads it but a person. */
  description: string | null
  /** Display order on the payslip and the per-employee settings screen. */
  sortOrder: number
  isActive: boolean
}

/** Body of POST /api/finance-items and PUT /api/finance-items/:id */
export type FinanceItemInput = Omit<FinanceItem, 'id'>

/** GET /api/finance-items */
export type FinanceItemListResponse = { financeItems: FinanceItem[] }

/** GET /api/finance-items/:id, POST, PUT */
export type FinanceItemResponse = { financeItem: FinanceItem }

/* Employee Finance Items -----------------------------------------------------
 *
 * What a given finance item is worth for one employee, and over which dates.
 * The master says ค่าตำแหน่ง exists; this says this person gets 2,000 of it
 * from January until further notice.
 *
 * The date range is what decides which payroll period an item lands in, so
 * two rows for the same item may not overlap — enforced by an EXCLUDE
 * constraint, see the migration.
 */

/** A row in employee_finance_items, with the item it points at resolved.
 *
 *  itemCode/itemName/itemType come from master_finance_items by join and are
 *  read-only: the type in particular is shown as something the system fills
 *  in from the chosen item, never typed by HR. Only financeItemId is sent
 *  back on a write — see EmployeeFinanceItemInput. */
export type EmployeeFinanceItem = {
  id: number
  /** FK to master_finance_items.id. */
  financeItemId: number
  itemCode: string
  itemName: string
  itemType: FinanceItemType
  /** Always positive. The sign is itemType's job: 'income' adds, 'deduction'
   *  and 'tax' subtract. */
  amount: number
  /** Inclusive start, `YYYY-MM-DD`. */
  effectiveFrom: string
  /** Inclusive end, `YYYY-MM-DD`. null means "until further notice", the same
   *  convention as a shift assignment's effectiveTo. */
  effectiveTo: string | null
  note: string | null
}

/** Body of POST /api/employees/:id/finance-items and
 *  PUT /api/employees/:id/finance-items/:lineId. Which employee a line
 *  belongs to is fixed by the route, not the body. */
export type EmployeeFinanceItemInput = Pick<
  EmployeeFinanceItem,
  'financeItemId' | 'amount' | 'effectiveFrom' | 'effectiveTo' | 'note'
>

/** GET /api/employees/:id/finance-items */
export type EmployeeFinanceItemListResponse = { employeeFinanceItems: EmployeeFinanceItem[] }

/** POST and PUT /api/employees/:id/finance-items */
export type EmployeeFinanceItemResponse = { employeeFinanceItem: EmployeeFinanceItem }

/* Payroll Entry ---------------------------------------------------------------
 *
 * The frozen result of running "calculate" for one employee in one payroll
 * period — see 055_create_payroll_entries.sql / 056_create_payroll_entry_lines.sql.
 * Phase 2 only ever produces basic-wage lines; OT (Phase 3) and statutory
 * deductions (Phase 4/5) add their own line codes to the same shape later.
 */

/** The payslip lines this system can price without asking HR to configure an
 *  item first — Phase 2's four wage/attendance lines plus Phase 3's five
 *  overtime buckets, one per master_overtime_groups rate (see
 *  overtimeRatesFor in overtimeCalculation.ts for what each pays). Not
 *  master_finance_items rows: these are core payroll lines every employee can
 *  have, not HR-configured per-employee allowances. See 056's comment for why
 *  Phase 3's finance-item-backed lines are a separate column (finance_item_id,
 *  058) instead of a tenth code here — their item_code is
 *  master_finance_items.item_code itself, which is why PayrollEntryLine.itemCode
 *  below is `string`, not this union: only the writer (payrollEntryQueries.ts)
 *  needs the closed set. */
export const PAYROLL_ENTRY_LINE_CODES = [
  'BASIC_WAGE',
  'ABSENCE_DEDUCT',
  'LATE_DEDUCT',
  'EARLY_LEAVE_DEDUCT',
  /** Extra minutes on an ordinary working day — group.rateOtWorkday. No
   *  "normal" counterpart: isWorkingDay days never carry normalMinutes, see
   *  overtimeRatesFor's comment. */
  'OT_WORKDAY',
  /** First 8 hours of approved OT on a weekly off / swap day-off —
   *  group.rateNormalDayoff. */
  'OT_NORMAL_DAYOFF',
  /** Anything past 8 hours on the same day-off — group.rateOtDayoff. */
  'OT_EXTRA_DAYOFF',
  /** First 8 hours of approved OT on a holiday — group.rateNormalHoliday. */
  'OT_NORMAL_HOLIDAY',
  /** Anything past 8 hours on the same holiday — group.rateOtHoliday. */
  'OT_EXTRA_HOLIDAY',
  /** Social security deduction — only for employee_finance.socialSecurityType
   *  'actual_wage_employee_paid' (5% of actual wage received this period,
   *  clamped and rounded to a whole baht) or 'fixed_monthly' (uses
   *  socialSecurityFixedAmount directly). 'none', 'actual_wage_company_paid',
   *  'section_39' and 'formula' never produce this line — see
   *  buildSocialSecurityLine() in payrollEntryQueries.ts. */
  'SOCIAL_SECURITY_DEDUCT',
] as const
export type PayrollEntryLineCode = (typeof PAYROLL_ENTRY_LINE_CODES)[number]

/** Why calculatePayrollEntries flagged an entry needs_review — see
 *  057_add_review_reasons_to_payroll_entries.sql. English slugs; the Thai
 *  wording is PAYROLL_ENTRY_REVIEW_REASON_LABELS in admin/. */
export const PAYROLL_ENTRY_REVIEW_REASON_CODES = [
  /** A day with only one of check-in/check-out punched. */
  'incomplete_day',
  /** Work punched on a day with no shift expected — Phase 2 does not guess
   *  whether it should be paid as ordinary time or OT. */
  'unscheduled_work_day',
  /** A 'present' day with no wage assignment covering it. */
  'missing_wage',
  /** A late/early deduction was owed but could not be priced (no shift
   *  assigned that day, so its working minutes are unknown). */
  'unpriceable_deduction',
  /** Approved overtime existed on a day (attendance_daily.approved_ot_minutes
   *  > 0) but could not be priced — either no overtime group resolved for
   *  that day (no approved request's snapshot, no current group assignment),
   *  or overtimeAmount() returned null because no hourly wage could be
   *  derived (no shift assigned, or the wage on file that day was zero).
   *  Phase 3's counterpart to unpriceable_deduction, kept separate: the two
   *  point HR at different tables to fix and mean opposite things for the
   *  payslip (less owed vs. more owed). */
  'unpriceable_overtime',
  /** wage_type (monthly/daily) changed partway through the period — Phase 2
   *  does not attempt a split calculation. */
  'mixed_wage_type',
] as const
export type PayrollEntryReviewReasonCode = (typeof PAYROLL_ENTRY_REVIEW_REASON_CODES)[number]

/** One triggered reason, and which dates it applies to. workDates is empty
 *  for a period-level reason (mixed_wage_type has no single date to name). */
export type PayrollEntryReviewReason = {
  code: PayrollEntryReviewReasonCode
  /** 'YYYY-MM-DD', ascending. */
  workDates: string[]
}

/** A row in payroll_entry_lines. No fields to join out to resolve — everything
 *  a payslip line needs is snapshotted onto the row itself. */
export type PayrollEntryLine = {
  id: number
  /** master_finance_items.item_code when financeItemId is set; one of
   *  PAYROLL_ENTRY_LINE_CODES otherwise. string rather than the narrower
   *  union because a finance-item line's code is whatever HR typed into the
   *  master, not one this codebase enumerates. */
  itemCode: string
  itemName: string
  itemType: FinanceItemType
  quantity: number | null
  rate: number | null
  /** Always positive; itemType's job is the sign. */
  amount: number
  sortOrder: number
  /** FK to master_finance_items — set only for a line built from
   *  employee_finance_items (buildFinanceItemLines). null for every core
   *  line (Phase 2's four, Phase 3's five OT buckets). See 058's migration
   *  comment. */
  financeItemId: number | null
}

/** A row in payroll_entries: one employee's result for one period.
 *  employeeCode/employeeName/wageType are snapshots taken at calculate time —
 *  see the migration's comment on why they are copied rather than joined. */
export type PayrollEntry = {
  id: number
  payrollPeriodId: number
  employeeId: number
  employeeCode: string
  employeeName: string
  wageType: WageType
  /** Monthly only — null for a daily entry. */
  employedDays: number | null
  isFullPeriod: boolean | null
  /** Daily only — null for a monthly entry. */
  workDays: number | null
  paidLeaveDays: number | null
  absentDays: number
  lateMinutesTotal: number
  lateMinutesDeducted: number
  earlyLeaveMinutesTotal: number
  earlyLeaveMinutesDeducted: number
  grossEarnings: number
  totalDeductions: number
  netPay: number
  /** True when reviewReasons is non-empty — a day Phase 2 does not guess a
   *  wage for landed in this period, or its wage_type changed mid-period. HR
   *  reviews these instead of the system silently deciding. */
  needsReview: boolean
  /** Empty when needsReview is false. See PayrollEntryReviewReason for what
   *  each code means. */
  reviewReasons: PayrollEntryReviewReason[]
  calculatedAt: string
}

/** A payroll_entries row together with its lines — the shape the payslip
 *  screen renders. */
export type PayrollEntryWithLines = PayrollEntry & { lines: PayrollEntryLine[] }

/** GET /api/payroll-periods/:id/entries */
export type PayrollEntryListResponse = { payrollEntries: PayrollEntry[] }

/** GET /api/payroll-entries/:id */
export type PayrollEntryResponse = { payrollEntry: PayrollEntryWithLines }

/** POST /api/payroll-periods/:id/calculate */
export type PayrollCalculateResponse = {
  payrollPeriod: PayrollPeriod
  entryCount: number
  needsReviewCount: number
}

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
export const ATTENDANCE_SOURCES = ['liff_gps', 'admin_correction', 'fingerprint_import'] as const
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

/**
 * The employee's own attendance for whichever shift is currently relevant —
 * not just their single most recent event. "Relevant" resolves overnight
 * shifts correctly: past midnight, still inside last night's shift window,
 * this reports *last night's* pair rather than an empty "today". See
 * chooseAttendanceWindow in attendanceMatchingQueries.ts (server) for the
 * selection rule.
 */
export type AttendanceTodayStatus = {
  /** The work-date this status is reported against — yesterday's, not
   *  today's, whenever "now" is still inside an overnight shift that started
   *  the evening before. */
  workDate: string
  shiftId: number | null
  shiftName: string | null
  /** ISO 8601. Both null exactly when shiftId is null. */
  shiftStartAt: string | null
  shiftEndAt: string | null
  isOvernight: boolean
  /** ISO 8601, from a matched attendance_events row — null when nothing has
   *  been punched yet for this window. */
  checkInAt: string | null
  checkInEventId: number | null
  checkOutAt: string | null
  checkOutEventId: number | null
}

/** GET /api/attendance/me */
export type AttendanceStatusResponse = { today: AttendanceTodayStatus }

/** An attendance event as admin/ sees it: the employee it belongs to, joined
 *  in for display, since one caller's list spans every employee. */
export type AttendanceListItem = AttendanceEvent & {
  employeeCode: string
  /** Thai full name, e.g. "นายสมชาย ใจดี" — display only, not an identifier. */
  employeeName: string
}

/** GET /api/attendance */
export type AttendanceListResponse = { events: AttendanceListItem[] }

/* Attendance Import ----------------------------------------------------------
 *
 * Loading a fingerprint terminal's Excel export into attendance_events, for
 * the staff who clock at a machine rather than through LINE.
 *
 * Two steps on purpose. The preview parses, matches fingerprint codes to
 * employees and works out which punch is a check-in — but writes nothing, so
 * HR can see what the file will do before it does it. That matters more than
 * usual here: nothing in the sheet says whether 02:00 is an arrival or an
 * overnight departure, the server infers it from the employee's shift, and the
 * preview is the only place a wrong inference is visible before the events are
 * in the ledger for good.
 *
 * Both endpoints take the .xlsx bytes as the raw request body, with the file
 * name in the `fileName` query parameter. The confirm step re-sends the file
 * rather than posting back the preview's rows: what gets written is then what
 * the file says, not what a browser round-trip claims it said.
 */

/** One punch, as the preview explains it back to HR. */
export type AttendanceImportPunchPreview = {
  /** ISO 8601. */
  eventTime: string
  eventType: AttendanceEventType
  /** The work-date the punch was attributed to — not always the calendar day
   *  it happened on, for an overnight shift. */
  workDate: string
  /** False when no shift window claimed this punch, so its type came from the
   *  calendar-day fallback. Worth surfacing: it is the case most likely to be
   *  read the wrong way round. */
  matchedShift: boolean
  /** Already present in attendance_events — it will be skipped, not written
   *  twice. Re-uploading an overlapping period is expected, not a mistake. */
  duplicate: boolean
}

export type AttendanceImportEmployeePreview = {
  fingerprintCode: string
  /** The name the sheet carried, when it carried one. Display only. */
  nameInFile: string | null
  /** Null when no employee has this fingerprint code — the punches below are
   *  then empty and the code appears in unmatchedCodes. */
  employeeId: number | null
  employeeCode: string | null
  employeeName: string | null
  punches: AttendanceImportPunchPreview[]
  newCount: number
  duplicateCount: number
  /** How many of the punches fell outside every expected shift window. */
  unmatchedShiftCount: number
}

/** POST /api/attendance/import/preview */
export type AttendanceImportPreview = {
  fileName: string
  /** The period the file itself declares, inclusive, 'YYYY-MM-DD'. */
  rangeFrom: string
  rangeTo: string
  /** The terminal's own export date, when the sheet carried one. */
  generatedOn: string | null
  employees: AttendanceImportEmployeePreview[]
  /** Fingerprint codes in the file that match no employee. Importing goes
   *  ahead without them — the fix is to fill in the missing รหัสลายนิ้วมือ and
   *  upload the same file again, which skips everything already loaded. */
  unmatchedCodes: string[]
  /** Recoverable oddities in the sheet, phrased for HR. */
  warnings: string[]
  totalNewCount: number
  totalDuplicateCount: number
}

export type AttendanceImportPreviewResponse = { preview: AttendanceImportPreview }

/** POST /api/attendance/import */
export type AttendanceImportResult = {
  batchId: number
  importedCount: number
  skippedDuplicateCount: number
  employeeCount: number
  unmatchedCodes: string[]
  /** False when the daily report could not be rebuilt because the attendance
   *  job already held its lock — the import itself still committed, and the
   *  next scheduled run picks the dates up. */
  recomputed: boolean
}

export type AttendanceImportResponse = { result: AttendanceImportResult }

/** A row of attendance_import_batches — the import history. Read-only: there
 *  is no undo, because attendance_events has no delete path at all. A wrong
 *  punch is corrected the way every other wrong punch is. */
export type AttendanceImportBatch = {
  id: number
  fileName: string
  fileSizeBytes: number
  rangeFrom: string
  rangeTo: string
  generatedOn: string | null
  employeeCount: number
  eventCount: number
  skippedDuplicateCount: number
  unmatchedCodes: string[]
  /** Display name of whoever uploaded it. */
  importedByName: string | null
  /** ISO 8601. */
  importedAt: string
}

/** GET /api/attendance/import/batches */
export type AttendanceImportBatchListResponse = { batches: AttendanceImportBatch[] }

/* Employee Import/Export -----------------------------------------------------
 *
 * Both directions share one worksheet layout — server/templates/employee-template.xlsx
 * — one row per employee, columns matching the Thai labels this type's own
 * comments use. Import only ever touches the fields the sheet carries: status,
 * endWorkingDate, terminationReason, the English name fields and the finance
 * tab all stay whatever they already were, changed only through their own
 * dedicated screens. overtimeGroupId and supervisorEmployeeId ARE carried by
 * the sheet (as กลุ่ม OT / หัวหน้างาน, both optional) and are plain overwrites
 * on update like holidayGroupId/payrollGroupId — a blank cell clears the
 * field rather than leaving the existing value alone.
 */

export type EmployeeImportRowAction = 'create' | 'update' | 'blocked' | 'skip'

/** Which of the two templates the uploaded file matched, by the plain-text
 *  code in cell A1 — 'EMP-IMP' (the standard sheet) or 'TEMP-EMP-IMP'
 *  (temporary daily workers: fingerprint code, no employee code, no ID
 *  card). See employeeImportParse.ts's own comment for the fallback when A1
 *  doesn't match either. */
export type EmployeeImportTemplateCode = 'EMP-IMP' | 'TEMP-EMP-IMP'

/** One data row of the uploaded sheet, after validation and matching against
 *  the database. `reasons` explains why a skip/blocked row didn't go through,
 *  or carries a heads-up for a create/update row — e.g. that it is about to
 *  change someone's shift. */
export type EmployeeImportRowPreview = {
  /** 1-based row number in the sheet, so HR can find it in Excel. */
  rowNumber: number
  action: EmployeeImportRowAction
  employeeCode: string | null
  /** The temp-worker template has no employeeCode column at all — a `create`
   *  row's code isn't decided until commit (see employeeCodeGenerator.ts), so
   *  fingerprintCode is what identifies the row on screen instead. Null for
   *  the standard template. */
  fingerprintCode: string | null
  /** Set only when the code matched an existing employee (update/blocked). */
  employeeId: number | null
  /** firstNameTh + lastNameTh as read from the sheet, for display. */
  name: string | null
  reasons: string[]
}

/** POST /api/employees/import/preview */
export type EmployeeImportPreview = {
  fileName: string
  templateCode: EmployeeImportTemplateCode
  rows: EmployeeImportRowPreview[]
  createCount: number
  updateCount: number
  blockedCount: number
  skipCount: number
}

export type EmployeeImportPreviewResponse = { preview: EmployeeImportPreview }

/** POST /api/employees/import */
export type EmployeeImportResult = {
  createdCount: number
  updatedCount: number
  blockedCount: number
  skippedCount: number
}

export type EmployeeImportResponse = { result: EmployeeImportResult }

/* Attendance Daily -----------------------------------------------------------
 *
 * The computed daily verdict, one row per employee per work-date — what the
 * attendance:compute batch job writes into attendance_daily. Derived data:
 * every field here is recomputable from attendance_events plus the
 * assignment/holiday/leave/swap ledgers, so this is a report to read, never a
 * record to edit. There is no POST/PUT/PATCH counterpart for that reason.
 */

/**
 * Whether work was expected on a date, and whether it happened.
 *
 * Late and early departure are deliberately absent: they're magnitudes
 * (lateMinutes / earlyLeaveMinutes), not statuses, so a day that is both late
 * and cut short needs no combinatorial status of its own. The UI composes its
 * badges from this value plus those minute counts.
 */
export const ATTENDANCE_DAY_STATUSES = [
  /** Work expected, both punches matched. */
  'present',
  /** Work expected, exactly one punch matched — usually a forgotten clock-out. */
  'incomplete',
  /** Work expected, no punches at all. */
  'absent',
  /** No work expected, and none happened. */
  'day_off',
  /** No work expected, but punches exist — a day off worked. */
  'unscheduled_work',
] as const
export type AttendanceDayStatus = (typeof ATTENDANCE_DAY_STATUSES)[number]

/** A row in attendance_daily, with the employee and shift joined in for
 *  display — same reasoning as AttendanceListItem. */
export type AttendanceDailyItem = {
  id: number
  employeeId: number
  employeeCode: string
  employeeName: string
  /** Calendar date, `YYYY-MM-DD`. For an overnight shift this is the day the
   *  shift STARTED, so a 22:00–07:00 shift beginning on the 14th is the 14th. */
  workDate: string
  shiftId: number | null
  shiftCode: string | null
  shiftName: string | null
  /** How the calendar classified the date, before attendance was considered. */
  dayStatus: CalendarDayStatus
  attendanceStatus: AttendanceDayStatus
  /** ISO 8601. The shift's own window. Both null when no shift applied. */
  expectedCheckInAt: string | null
  expectedCheckOutAt: string | null
  /** ISO 8601. When the employee was really due in and out, after approved
   *  leave was carved out of the shift window — equal to the expected pair on
   *  an ordinary day, narrower on a partial-leave day, both null when nothing
   *  was owed. This, not the expected pair, is what lateness was measured
   *  against, and what a timesheet should show. */
  effectiveCheckInAt: string | null
  effectiveCheckOutAt: string | null
  /** ISO 8601. The matched punches, or null where none was found. */
  actualCheckInAt: string | null
  actualCheckOutAt: string | null
  /** Minutes past the time they were due in. 0 when within the shift's grace
   *  period — grace decides whether lateness counts, not how much of it. */
  lateMinutes: number
  earlyLeaveMinutes: number
  /** Minutes of the expected work intervals actually present for, net of the
   *  unpaid break and any leave. Null unless both punches matched. */
  workedMinutes: number | null
  /** Minutes the day owed, net of break and leave. Null when no shift applied. */
  expectedWorkMinutes: number | null
  /** Working minutes excused by approved leave. */
  leaveMinutes: number
  isOvernight: boolean
  /** ISO 8601 — when the batch job last recomputed this row. */
  computedAt: string
}

/** Counts over the whole filtered range, not just the returned page, so the
 *  figures stay right even when the list is truncated. `late` and `earlyLeave`
 *  count minute totals rather than statuses, matching how the badges read. */
export type AttendanceDailySummary = {
  total: number
  present: number
  late: number
  earlyLeave: number
  absent: number
  incomplete: number
  /** ISO 8601 — the freshest computed_at in range, or null when the range has
   *  no rows yet (the job hasn't covered these dates). */
  lastComputedAt: string | null
}

/** Filters for GET /api/attendance/daily. Mostly attendanceStatus values, plus
 *  'late'/'early_leave'/'leave', which are minute-count filters rather than
 *  statuses — they're what someone actually wants to narrow a report to. */
export const ATTENDANCE_DAILY_FILTERS = [
  'present',
  'late',
  'early_leave',
  'leave',
  'absent',
  'incomplete',
  'day_off',
  'unscheduled_work',
] as const
export type AttendanceDailyFilter = (typeof ATTENDANCE_DAILY_FILTERS)[number]

/** GET /api/attendance/daily */
export type AttendanceDailyListResponse = {
  days: AttendanceDailyItem[]
  summary: AttendanceDailySummary
  /** True when the range held more rows than were returned — the summary still
   *  counts all of them. */
  truncated: boolean
}

/** 'X ชม.' or 'X ชม. Y นาที' — shared by the shift master forms and the
 *  attendance report/export, both of which turn a minute count into the same
 *  human phrasing. */
export function formatWorkMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  return mins === 0 ? `${hours} ชม.` : `${hours} ชม. ${mins} นาที`
}

export type AttendanceBadgeTone = 'active' | 'inactive' | 'role' | 'pending' | 'danger'

export type AttendanceBadge = { label: string; tone: AttendanceBadgeTone }

/** How much of a shift the leave took, said the way a person would. Falls
 *  back to a duration when it isn't a recognisable fraction — an hour or two
 *  of leave has no name, so it just states the amount. */
function leaveLabel(day: AttendanceDailyItem): string {
  const owed = (day.expectedWorkMinutes ?? 0) + day.leaveMinutes
  if (owed > 0 && day.expectedWorkMinutes === 0) return 'ลาเต็มวัน'

  const share = owed > 0 ? day.leaveMinutes / owed : 0
  if (share >= 0.4 && share <= 0.6) return 'ลาครึ่งวัน'
  return `ลา ${formatWorkMinutes(day.leaveMinutes)}`
}

/** Which weekday-off wording fits, given how the calendar classified the day. */
function dayOffLabel(day: AttendanceDailyItem): string {
  if (day.leaveMinutes > 0) return leaveLabel(day)
  switch (day.dayStatus) {
    case 'holiday':
      return 'วันหยุดนักขัตฤกษ์'
    case 'swap_dayoff':
      return 'วันหยุดจากการสลับ'
    case 'leave':
      return 'ลาเต็มวัน'
    default:
      return 'วันหยุดประจำสัปดาห์'
  }
}

/**
 * The badges for one day, most significant first. Never empty.
 *
 * 'ปกติ' appears only when nothing else does — pairing it with 'มาสาย' would
 * contradict itself.
 *
 * Shared by the admin table (rendered as coloured badges) and the Excel
 * export (joined into one 'สถานะการลงเวลา' cell) so the two views can't drift
 * apart on what a day's status actually means.
 */
export function attendanceBadges(day: AttendanceDailyItem): AttendanceBadge[] {
  switch (day.attendanceStatus) {
    case 'absent':
      return [{ label: 'ขาดงาน', tone: 'danger' }]
    case 'incomplete': {
      // Still worth naming a late arrival on a day whose clock-out is missing:
      // the check-in that did land is enough to judge it.
      const badges: AttendanceBadge[] = [{ label: 'ลงเวลาไม่ครบ', tone: 'danger' }]
      if (day.lateMinutes > 0) badges.push({ label: `มาสาย ${day.lateMinutes} นาที`, tone: 'pending' })
      return badges
    }
    case 'day_off':
      return [{ label: dayOffLabel(day), tone: day.leaveMinutes > 0 ? 'role' : 'inactive' }]
    case 'unscheduled_work':
      return [{ label: 'ทำงานวันหยุด', tone: 'role' }]
    case 'present': {
      const badges: AttendanceBadge[] = []
      if (day.leaveMinutes > 0) badges.push({ label: leaveLabel(day), tone: 'role' })
      if (day.lateMinutes > 0) badges.push({ label: `มาสาย ${day.lateMinutes} นาที`, tone: 'pending' })
      if (day.earlyLeaveMinutes > 0) {
        badges.push({ label: `ออกก่อน ${day.earlyLeaveMinutes} นาที`, tone: 'pending' })
      }
      return badges.length > 0 ? badges : [{ label: 'ปกติ', tone: 'active' }]
    }
  }
}

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

/* Shift Change Requests -------------------------------------------------------
 *
 * The employee-initiated counterpart to ShiftChangeInput/POST
 * /api/employees/:id/shift-changes — same decision-workflow shape as
 * LeaveRequest (four statuses, one decision), but always for a single day,
 * and editable by the employee (PUT) any number of times before it's
 * decided, not just cancellable.
 */

export const SHIFT_CHANGE_REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const
export type ShiftChangeRequestStatus = (typeof SHIFT_CHANGE_REQUEST_STATUSES)[number]

/** A row in shift_change_requests: one employee asking to swap into a
 *  different shift for a single calendar day. currentShiftName/newShiftName
 *  are joined in for display, same reasoning as LeaveRequest.leaveTypeName. */
export type ShiftChangeRequest = {
  id: number
  employeeId: number
  /** Calendar date, `YYYY-MM-DD`. Always a single day — see the migration's
   *  comment on why this maps onto createShiftChange's temporary-swap case. */
  requestedDate: string
  /** Snapshot of the shift in effect on requestedDate at submission time, for
   *  display only ("changing from X"). Null if the employee had no shift
   *  assigned on that date. */
  currentShiftId: number | null
  currentShiftName: string | null
  newShiftId: number
  newShiftName: string
  reason: string
  /** R2 object key of an attached photo, or null — same pattern as
   *  Employee.photo_key. Never a URL; view it via
   *  GET /shift-change-requests/:id/attachment. */
  attachmentKey: string | null
  status: ShiftChangeRequestStatus
  /** The admin's display name at decision time. Null while pending/cancelled. */
  decidedByName: string | null
  /** ISO 8601. Null while pending/cancelled. */
  decidedAt: string | null
  /** Required when status is 'rejected', null otherwise. */
  decisionReason: string | null
  /** FK to the employee_shift_assignments row this request created. Null
   *  unless approved. */
  resultingAssignmentId: number | null
  /** ISO 8601. */
  createdAt: string
  /** ISO 8601. Bumped on every edit while pending. */
  updatedAt: string
}

/** A request as admin/ sees it: the employee joined in for display, same
 *  shape as LeaveRequestListItem. */
export type ShiftChangeRequestListItem = ShiftChangeRequest & {
  employeeCode: string
  employeeName: string
}

/** Body of POST /api/shift-change-requests and PUT
 *  /api/shift-change-requests/:id — same shape for both: an edit while
 *  pending replaces the whole request rather than patching one field.
 *  employeeId is not an input — the server derives it from the caller's
 *  employee session, never the client. attachmentKey is not here — it's set
 *  separately via the presign/complete pair below, once the file has
 *  actually landed in R2. */
export type ShiftChangeRequestInput = {
  requestedDate: string
  newShiftId: number
  reason: string
}

/** POST /api/shift-change-requests, PUT /api/shift-change-requests/:id */
export type ShiftChangeRequestResponse = { request: ShiftChangeRequest }

/** GET /api/shift-change-requests/me — an employee's own requests, no
 *  employee join needed since it's implicitly them. */
export type ShiftChangeRequestMineResponse = { requests: ShiftChangeRequest[] }

/** GET /api/shift-change-requests */
export type ShiftChangeRequestListResponse = { requests: ShiftChangeRequestListItem[] }

/** GET /api/shift-change-requests/:id, POST .../approve, POST .../reject */
export type ShiftChangeRequestDetailResponse = { request: ShiftChangeRequestListItem }

/** Body of POST /api/shift-change-requests/:id/reject — a reason is required
 *  every time, never optional. */
export type ShiftChangeRequestRejectRequest = { reason: string }

/* Shift change request attachment --------------------------------------------
 * Same R2 presign/PUT/complete flow as employee photos (see that section),
 * scoped to one request instead of one employee, and reusing the same
 * mime-type/size limits — there's no reason a swap-agreement photo needs a
 * different cap than a profile photo.
 */

/** Body of POST /api/shift-change-requests/:id/attachment/presign-upload */
export type ShiftChangeAttachmentPresignInput = {
  mimeType: EmployeePhotoMimeType
  sizeBytes: number
}
/** Response of the same — uploadUrl is a presigned PUT, good for a few minutes. */
export type ShiftChangeAttachmentPresignResponse = { uploadUrl: string; key: string }

/** Body of POST /api/shift-change-requests/:id/attachment/complete */
export type ShiftChangeAttachmentCompleteInput = { key: string }

/** GET /api/shift-change-requests/:id/attachment — url is a presigned GET, or
 *  null if the request has no attachment. Regenerated on every call, nothing
 *  to cache. */
export type ShiftChangeAttachmentResponse = { url: string | null }

/* Day Off Swap Requests --------------------------------------------------
 *
 * The employee-initiated "สลับวันหยุด" request: work on workDate (currently
 * a holiday or the employee's weekly off) in exchange for taking offDate
 * (currently a scheduled workday) off instead. Same four-state
 * pending/approved/rejected/cancelled decision-workflow shape as
 * ShiftChangeRequest, editable by the employee (PUT) any number of times
 * before it's decided — but always TWO linked dates with fixed,
 * non-interchangeable roles, never one.
 *
 * Unlike ShiftChangeRequest, approval never touches employee_shift_assignments
 * — the employee's standing shift already applies on workDate regardless of
 * its classification, so nothing needs writing there. Once approved, this
 * request row is itself the source of truth CalendarDay reads directly (see
 * CalendarDayStatus 'swap_workday'/'swap_dayoff' below).
 */

export const DAY_OFF_SWAP_REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const
export type DayOffSwapRequestStatus = (typeof DAY_OFF_SWAP_REQUEST_STATUSES)[number]

/** A row in day_off_swap_requests: one employee asking to work on workDate
 *  in exchange for taking offDate off instead. Fixed roles — never
 *  interchangeable, unlike a plain single-date request. */
export type DayOffSwapRequest = {
  id: number
  employeeId: number
  /** Calendar date, `YYYY-MM-DD`. Currently a holiday or weekly off; becomes
   *  a workday once approved. */
  workDate: string
  /** Calendar date, `YYYY-MM-DD`. Currently a scheduled workday; becomes a
   *  day off once approved. */
  offDate: string
  /** Snapshot of workDate's classification at submission time, for display
   *  only — once approved it no longer classifies this way (see
   *  CalendarDayStatus 'swap_workday'). */
  workDateOriginalStatus: 'holiday' | 'weekly_off'
  /** Holiday name, snapshotted at submission time. Null when
   *  workDateOriginalStatus is 'weekly_off'. */
  workDateOriginalLabel: string | null
  /** The shift the employee will work on workDate, resolved live from
   *  employee_shift_assignments the same way getShiftIdForDate does — no
   *  shift picker on this request, it always follows the employee's
   *  standing shift. Null exactly when they have no shift assigned on
   *  workDate. */
  workShiftId: number | null
  workShiftName: string | null
  /** Wall-clock 'HH:MM:SS'. Null exactly when workShiftId is null. */
  workShiftStartTime: string | null
  workShiftEndTime: string | null
  reason: string
  status: DayOffSwapRequestStatus
  /** The admin's display name at decision time. Null while pending/cancelled. */
  decidedByName: string | null
  /** ISO 8601. Null while pending/cancelled. */
  decidedAt: string | null
  /** Required when status is 'rejected', null otherwise. */
  decisionReason: string | null
  /** ISO 8601. */
  createdAt: string
  /** ISO 8601. Bumped on every edit while pending. */
  updatedAt: string
}

/** A request as admin/ sees it: the employee joined in for display, same
 *  shape as ShiftChangeRequestListItem. */
export type DayOffSwapRequestListItem = DayOffSwapRequest & {
  employeeCode: string
  employeeName: string
}

/** Body of POST /api/day-off-swap-requests and PUT
 *  /api/day-off-swap-requests/:id — same shape for both: an edit while
 *  pending replaces the whole request rather than patching one field.
 *  employeeId is not an input — the server derives it from the caller's
 *  employee session, never the client. */
export type DayOffSwapRequestInput = {
  workDate: string
  offDate: string
  reason: string
}

/** POST /api/day-off-swap-requests, PUT /api/day-off-swap-requests/:id */
export type DayOffSwapRequestResponse = { request: DayOffSwapRequest }

/** GET /api/day-off-swap-requests/me — an employee's own requests, no
 *  employee join needed since it's implicitly them. */
export type DayOffSwapRequestMineResponse = { requests: DayOffSwapRequest[] }

/** GET /api/day-off-swap-requests */
export type DayOffSwapRequestListResponse = { requests: DayOffSwapRequestListItem[] }

/** GET /api/day-off-swap-requests/:id, POST .../approve, POST .../reject */
export type DayOffSwapRequestDetailResponse = { request: DayOffSwapRequestListItem }

/** Body of POST /api/day-off-swap-requests/:id/reject — a reason is required
 *  every time, never optional. */
export type DayOffSwapRequestRejectRequest = { reason: string }

/* Calendar -------------------------------------------------------------- */

/**
 * One day's classification on an employee's monthly calendar, in priority
 * order (a day can only be one of these):
 * 'swap_workday' — an approved day_off_swap_requests row makes this date a
 * workday, overriding whatever it would otherwise classify as.
 * 'swap_dayoff' — an approved day_off_swap_requests row makes this date a
 * day off, overriding whatever it would otherwise classify as.
 * 'leave' — an approved leave_requests row covers this date.
 * 'holiday' — this date is in the employee's holiday group.
 * 'weekly_off' — this date is outside the employee's shift's workdays bitmask.
 * 'workday' — everything else, including every day when the employee has no
 * shift assigned yet (no bitmask to check against).
 */
export const CALENDAR_DAY_STATUSES = [
  'workday',
  'weekly_off',
  'holiday',
  'leave',
  'swap_workday',
  'swap_dayoff',
] as const
export type CalendarDayStatus = (typeof CALENDAR_DAY_STATUSES)[number]

export type CalendarDay = {
  /** Calendar date, `YYYY-MM-DD`. */
  date: string
  status: CalendarDayStatus
  /** holidayName when status is 'holiday', leaveTypeName when status is
   *  'leave', the swap's workDateOriginalLabel when status is
   *  'swap_workday' (null if it was a weekly_off, not a named holiday),
   *  null otherwise (including 'swap_dayoff'). */
  label: string | null
  /** The shift in effect on this date, resolved from
   *  employee_shift_assignments the same way getShiftIdForDate does — which
   *  already reflects an approved shift_change_requests swap on the day it
   *  applies (createShiftChange writes the swap into that same ledger), so
   *  this needs no separate lookup against shift_change_requests itself.
   *  Null exactly when the employee had no shift assigned on this date. */
  shiftId: number | null
  shiftName: string | null
  /** Wall-clock 'HH:MM:SS', same as master_shifts' own columns. Null exactly
   *  when shiftId is null. */
  shiftStartTime: string | null
  shiftEndTime: string | null
}

/** GET /api/calendar/me?year=YYYY&month=MM — one calendar month, in date order. */
export type MonthCalendarResponse = { days: CalendarDay[] }

/* Work Schedule (admin) --------------------------------------------------
 *
 * The "ตารางการทำงาน" admin grid: every Active employee's month at once,
 * reusing CalendarDayStatus (the same cascade GET /calendar/me answers with
 * for one employee) so a cell can never disagree with that employee's own
 * calendar. shiftCode is the one thing CalendarDay itself doesn't carry
 * (only shiftName) — a grid cell needs the short code (e.g. "OF1"), not the
 * full shift name.
 */

export type WorkScheduleDay = {
  date: string
  status: CalendarDayStatus
  label: string | null
  shiftCode: string | null
}

export type EmployeeWorkSchedule = {
  employeeId: number
  employeeCode: string
  fullName: string
  days: WorkScheduleDay[]
}

/** GET /api/schedule?year=YYYY&month=MM — every Active employee, in
 *  employee_code order. */
export type WorkScheduleResponse = { year: number; month: number; employees: EmployeeWorkSchedule[] }

/* Overtime Requests ------------------------------------------------------
 *
 * The employee-initiated "ขอทำงานล่วงเวลา" request: a time range on one date
 * that the employee wants paid as OT. Same four-state
 * pending/approved/rejected/cancelled decision-workflow shape as
 * DayOffSwapRequest, editable by the employee (PUT) any number of times
 * before it's decided, and — like it — approval writes nothing into any
 * other ledger: an approved row here *is* the record, and the (not-yet-built)
 * OT calculation reads it directly.
 *
 * Two things are deliberately unlike its siblings:
 *
 * - An employee may hold SEVERAL live requests for one date, unlike
 *   ShiftChangeRequest's one-per-date rule. Real OT comes in more than one
 *   block a day (before the shift and after it), so what conflicts is an
 *   overlapping *time range*, not a repeated date.
 * - The requested range must fall entirely OUTSIDE normal working hours.
 *   Hours inside the shift are already ordinary paid time, so a range that
 *   straddles the shift is rejected rather than silently trimmed — see
 *   findOvertimeShiftConflict.
 */

export const OVERTIME_REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const
export type OvertimeRequestStatus = (typeof OVERTIME_REQUEST_STATUSES)[number]

/** How far back an OT request may be dated. OT is unlike a shift change,
 *  which can never be backdated at all: some of it is planned ahead and some
 *  of it was worked last night and only written up afterwards. The window is
 *  bounded rather than open so a forgotten request can still be filed, but
 *  not one from a payroll period that has already closed. */
export const OVERTIME_BACKDATE_LIMIT_DAYS = 7

/** Bounds on one request's length. The floor keeps "I stayed five minutes
 *  late" out of the approval queue; the ceiling is a typo guard — 12 hours of
 *  OT in one block is already extreme, and anything longer is far more likely
 *  to be a mis-entered AM/PM than a real shift. */
export const OVERTIME_MIN_MINUTES = 15
export const OVERTIME_MAX_MINUTES = 720

/**
 * On a day off or a holiday, how many minutes of work are paid at the "ในเวลา"
 * rate before the rest becomes "นอกเวลา" — a normal 8-hour working day.
 *
 * A flat figure rather than the employee's own shift length: this is the
 * statutory normal working day, and an employee whose shift happens to be
 * 7 hours does not thereby earn the higher rate an hour sooner on a Sunday.
 * If that ever needs to follow the shift instead, this is the only place it
 * is decided.
 *
 * Counted across the whole day, never per request — see
 * computeOvertimeForDay. Two four-hour requests on one Sunday are eight
 * ordinary hours, not two separate four-hour ones that each stay under the
 * threshold.
 */
export const DAY_OFF_NORMAL_MINUTES = 480

/** A row in overtime_requests. The dayStatus, shift and overtimeGroup fields
 *  are snapshots taken at submission time, not live joins: employment_details
 *  keeps no history of which OT group an employee belonged to, so without a
 *  snapshot a later group change would silently reprice OT that was already
 *  approved. */
export type OvertimeRequest = {
  id: number
  employeeId: number
  /** Calendar date, `YYYY-MM-DD`. Anchors the request to the day the OT
   *  *starts*, the same convention attendance_daily.work_date uses for an
   *  overnight shift. */
  otDate: string
  /** Wall-clock 'HH:MM:SS', same as master_shifts' own columns. */
  startTime: string
  /** Wall-clock 'HH:MM:SS'. Less than or equal to startTime means the range
   *  ends the following calendar day — same convention as
   *  master_shifts.shift_end_time. */
  endTime: string
  /** Server-computed length of [startTime, endTime). Never taken from the
   *  client, which computes its own copy only to show the employee a running
   *  total while they fill the form. */
  requestedMinutes: number
  /** Derived from startTime/endTime, not stored — for display only. */
  crossesMidnight: boolean
  /** How the calendar classified otDate at submission time. */
  dayStatus: CalendarDayStatus
  /** The holiday/leave name behind dayStatus, when it has one. */
  dayLabel: string | null
  /** The shift in effect on otDate at submission time. Null exactly when the
   *  employee had no shift assigned that day. */
  shiftId: number | null
  shiftName: string | null
  /** Wall-clock 'HH:MM:SS'. Null exactly when shiftId is null. */
  shiftStartTime: string | null
  shiftEndTime: string | null
  /** The employee's OT group at submission time — which rate schedule prices
   *  this request. Never null: a request cannot be submitted without one. */
  overtimeGroupId: number
  overtimeGroupName: string
  reason: string
  status: OvertimeRequestStatus
  /** Ties this row to the other per-employee rows one "Bulk OT Request"
   *  submission created, purely for the admin UI to group and act on them
   *  as one unit — there is no batch table, and every other field on this
   *  row (including the day/shift snapshot) is independent per employee.
   *  Null for a request an employee filed for themselves, one at a time,
   *  which is every request before bulk creation existed and most after. */
  batchId: string | null
  /** Display name of whoever filed this on the employee's behalf (a
   *  supervisor, HR or Admin, via Bulk OT Request) — null when the employee
   *  filed it themselves, which is the ordinary case. */
  createdByName: string | null
  /** The admin's display name at decision time. Null while pending/cancelled. */
  decidedByName: string | null
  /** ISO 8601. Null while pending/cancelled. */
  decidedAt: string | null
  /** Required when status is 'rejected', null otherwise. */
  decisionReason: string | null
  /** ISO 8601. */
  createdAt: string
  /** ISO 8601. Bumped on every edit while pending. */
  updatedAt: string
}

/** A request as admin/ sees it: the employee joined in for display, same
 *  shape as DayOffSwapRequestListItem. */
export type OvertimeRequestListItem = OvertimeRequest & {
  employeeCode: string
  employeeName: string
}

/** Body of POST /api/overtime-requests and PUT /api/overtime-requests/:id —
 *  same shape for both: an edit while pending replaces the whole request
 *  rather than patching one field. employeeId is not an input — the server
 *  derives it from the caller's employee session. Neither are the requested
 *  minutes or any of the snapshots: the server computes and resolves all of
 *  them, so a client cannot claim hours it did not ask for. Times are
 *  'HH:MM' or 'HH:MM:SS'. */
export type OvertimeRequestInput = {
  otDate: string
  startTime: string
  endTime: string
  reason: string
}

/** POST /api/overtime-requests, PUT /api/overtime-requests/:id */
export type OvertimeRequestResponse = { request: OvertimeRequest }

/** GET /api/overtime-requests/me — an employee's own requests, no employee
 *  join needed since it's implicitly them. */
export type OvertimeRequestMineResponse = { requests: OvertimeRequest[] }

/** GET /api/overtime-requests */
export type OvertimeRequestListResponse = { requests: OvertimeRequestListItem[] }

/** GET /api/overtime-requests/:id, POST .../approve, POST .../reject */
export type OvertimeRequestDetailResponse = { request: OvertimeRequestListItem }

/** Body of POST /api/overtime-requests/:id/reject — a reason is required
 *  every time, never optional. */
export type OvertimeRequestRejectRequest = { reason: string }

/* Bulk OT Request ----------------------------------------------------------
 * A supervisor/HR/Admin filing the same OT window for several employees at
 * once from admin/ — "การขอล่วงเวลาแบบกลุ่ม". Every employee still gets a
 * normal, independent overtime_requests row (see migration 061's comment for
 * why there is no batch table); these types exist to create and act on that
 * group of rows as one unit.
 */

/** One row of the picker on the "ขอ OT แบบกลุ่ม" screen. approvedMinutesThisWeek
 *  is what GET's otDate query param resolves to — shown next to the name so
 *  the statutory 36-hour/week cap is visible before submission, not only
 *  after, on the single-request detail page's own weekly-cap check. */
export type OvertimeEligibleEmployee = {
  employeeId: number
  employeeCode: string
  employeeName: string
  departmentName: string | null
  approvedMinutesThisWeek: number
}

/** GET /api/overtime-requests/bulk/eligible-employees?date=YYYY-MM-DD
 *
 *  `scope` says why this list is what it is: 'all' for HR/Admin (every
 *  active employee), 'team' for a supervisor (their own active direct
 *  reports only, resolved server-side from entraUpn — never trust a client
 *  to say who their reports are). The caller has no bulk-OT access at all
 *  when neither applies; the server answers that with 403, not an empty
 *  'team' list, so the page can tell "no reports yet" apart from "not
 *  allowed here". */
export type OvertimeEligibleEmployeesResponse = {
  scope: 'all' | 'team'
  employees: OvertimeEligibleEmployee[]
  weekStart: string
  weekEnd: string
  capMinutes: number
}

/** Body of POST /api/overtime-requests/bulk. Same otDate/startTime/endTime/
 *  reason shape as OvertimeRequestInput, applied to every id in employeeIds —
 *  the "one set of details, many employees" the feature asked for. */
export type OvertimeBulkRequestInput = {
  otDate: string
  startTime: string
  endTime: string
  reason: string
  employeeIds: number[]
}

/** One employee's result from a bulk create. 'skipped' covers every reason
 *  validateOvertimeRequestInput could reject that employee (shift conflict,
 *  already on leave, no overtime group, ...) as well as being outside the
 *  caller's scope — the rest of the batch is created regardless, per employee,
 *  same reasoning as DailyShiftAssignmentOutcome. */
export type OvertimeBulkCreateOutcome =
  | { employeeId: number; kind: 'ok'; requestId: number }
  | { employeeId: number; kind: 'skipped'; message: string }

/** POST /api/overtime-requests/bulk */
export type OvertimeBulkCreateResponse = { batchId: string; outcomes: OvertimeBulkCreateOutcome[] }

/** GET /api/overtime-requests/batch/:batchId — every row created by one bulk
 *  submission, for the batch detail screen. Same list-item shape the queue
 *  already uses. */
export type OvertimeBatchResponse = { requests: OvertimeRequestListItem[] }

/** One request's result from a batch-wide approve/reject. 'stale' mirrors
 *  approvalStaleFail on the single-request endpoint — the request was valid
 *  when filed and no longer is (a shift changed, the backdate window closed,
 *  ...), so it is left pending for a reviewer to look at individually rather
 *  than silently decided either way. */
export type OvertimeBatchDecisionOutcome =
  | { requestId: number; employeeId: number; kind: 'ok' }
  | { requestId: number; employeeId: number; kind: 'stale'; message: string }

/** POST /api/overtime-requests/batch/:batchId/approve, .../reject */
export type OvertimeBatchActionResponse = { outcomes: OvertimeBatchDecisionOutcome[] }

/* Overtime time arithmetic ------------------------------------------------
 * Lives in shared/ rather than server/ because liff/ has to show the
 * employee the same numbers the server is about to compute. Two
 * implementations of "does 23:00-01:00 cross midnight" would drift on
 * exactly the cases that matter least often and cost the most.
 */

/** Minutes since midnight for a wall-clock 'HH:MM' or 'HH:MM:SS', or null if
 *  it is neither. Seconds are floored away: nothing in this app schedules to
 *  the second, and master_shifts' own times are always whole minutes. */
export function parseWallClockMinutes(value: string): number | null {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value)
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

/** Length of [startTime, endTime) in minutes, where an end at or before the
 *  start means the range runs into the following day (22:00-02:00 = 240).
 *  Returns null if either time is unparseable. */
export function computeOvertimeMinutes(startTime: string, endTime: string): number | null {
  const start = parseWallClockMinutes(startTime)
  const end = parseWallClockMinutes(endTime)
  if (start === null || end === null) return null
  return end <= start ? end + 1440 - start : end - start
}

/** True when the range ends on the calendar day after it started. */
export function overtimeCrossesMidnight(startTime: string, endTime: string): boolean {
  const start = parseWallClockMinutes(startTime)
  const end = parseWallClockMinutes(endTime)
  return start !== null && end !== null && end <= start
}

/** Whole days from `from` to `to`, both 'YYYY-MM-DD'. */
function dayOffsetBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`)
  const b = Date.parse(`${to}T00:00:00Z`)
  return Math.round((b - a) / 86_400_000)
}

/**
 * The first calendar day whose normal working hours overlap the requested OT
 * range, or null if the range is clear of all of them.
 *
 * `days` should hold otDate and BOTH its neighbours, not otDate alone. A
 * 22:00-06:00 shift starting the 14th occupies the morning of the 15th, so a
 * request dated the 15th for 05:00-07:00 overlaps a shift belonging to a
 * different work_date; symmetrically, a request that crosses midnight can run
 * into the next day's shift. Checking one day would miss both.
 *
 * Days the employee does not normally work are skipped rather than checked:
 * on a holiday or a weekly off there are no ordinary paid hours for OT to
 * collide with, so the whole day is open. Same for a day with no shift
 * assigned at all.
 */
export function findOvertimeShiftConflict(
  otDate: string,
  startTime: string,
  endTime: string,
  days: CalendarDay[]
): CalendarDay | null {
  const start = parseWallClockMinutes(startTime)
  const minutes = computeOvertimeMinutes(startTime, endTime)
  if (start === null || minutes === null) return null
  const end = start + minutes

  for (const day of days) {
    if (day.status !== 'workday' && day.status !== 'swap_workday') continue
    if (day.shiftStartTime === null || day.shiftEndTime === null) continue

    const offset = dayOffsetBetween(otDate, day.date)
    if (offset < -1 || offset > 1) continue

    const shiftStart = parseWallClockMinutes(day.shiftStartTime)
    const shiftLength = computeOvertimeMinutes(day.shiftStartTime, day.shiftEndTime)
    if (shiftStart === null || shiftLength === null) continue

    const windowStart = offset * 1440 + shiftStart
    const windowEnd = windowStart + shiftLength

    if (start < windowEnd && windowStart < end) return day
  }

  return null
}

/* Overtime Report ---------------------------------------------------------
 *
 * What approved overtime actually came to, per day, per employee and per
 * week, over a date range. Read entirely off attendance_daily's four OT
 * columns, which the batch job derives from approved overtime_requests
 * intersected with the punches — see 040_add_overtime_to_attendance_daily.sql.
 *
 * Hours are stored; baht is not. Every amount here is computed at read time
 * from the wage in force right now, because employee_finance keeps no history
 * and a stored figure would silently stop matching the wage it was derived
 * from. A null amount means the wage could not be derived at all (no finance
 * record, or no shift on the day to get a normal working day out of) and is
 * rendered as "—", never as zero.
 */

/** Section 24 of the Labour Protection Act: overtime plus holiday work may
 *  not exceed 36 hours in one week. Reported, not enforced — the system shows
 *  where the line is and who is near it; whether to approve past it is a
 *  human decision with its own paperwork. */
export const OVERTIME_WEEKLY_CAP_MINUTES = 36 * 60

/** One employee's overtime on one date. */
export type OvertimeReportDay = {
  employeeId: number
  employeeCode: string
  employeeName: string
  workDate: string
  dayStatus: CalendarDayStatus
  /** Minutes approved on this date, across every request covering it. */
  approvedMinutes: number
  /** Of those, the minutes the employee was actually present for, before
   *  rounding. Less than approvedMinutes means they left early or never
   *  clocked out — the rows HR needs to chase. */
  actualMinutes: number
  /** After the group's rounding rule, split at the statutory 8-hour mark.
   *  normalMinutes is always 0 on a working day. */
  normalMinutes: number
  extraMinutes: number
  /** The multipliers these two buckets are paid at, from the overtime group
   *  snapshotted on the request. */
  normalRate: number
  extraRate: number
  /** Null when the employee's hourly wage could not be derived. */
  amount: number | null
}

/** One employee's totals over the whole range, bucketed by the five rate
 *  categories master_overtime_groups defines. */
export type OvertimeReportEmployee = {
  employeeId: number
  employeeCode: string
  employeeName: string
  departmentName: string | null
  overtimeGroupName: string | null
  /** นอกเวลา วันทำงานปกติ */
  otWorkdayMinutes: number
  /** ในเวลา นอกวันทำงาน */
  normalDayoffMinutes: number
  /** นอกเวลา นอกวันทำงานปกติ */
  otDayoffMinutes: number
  /** ในเวลา วันหยุดพิเศษ */
  normalHolidayMinutes: number
  /** นอกเวลา วันหยุดพิเศษ */
  otHolidayMinutes: number
  totalMinutes: number
  /** Approved but not actually worked, across the range — surfaced so a total
   *  that looks low has a visible reason. */
  shortfallMinutes: number
  /** Null when it could not be derived, and also when it differed across the
   *  range (a shift change alters the normal working day, and therefore the
   *  hourly rate) — in that case the amount is still correct, having been
   *  summed per day. */
  hourlyWage: number | null
  amount: number | null
}

/** One employee's total in one Monday-to-Sunday week, against the statutory
 *  cap. Monday-based to match master_shifts.workdays, which is ISO order. */
export type OvertimeReportWeek = {
  employeeId: number
  employeeCode: string
  employeeName: string
  /** 'YYYY-MM-DD' of the Monday and the Sunday. May fall outside the
   *  requested range — a week is a week regardless of where the filter cuts. */
  weekStart: string
  weekEnd: string
  totalMinutes: number
  overCap: boolean
}

export type OvertimeReportSummary = {
  employees: number
  totalMinutes: number
  /** Sum of the per-day amounts that could be priced. Null when none could. */
  totalAmount: number | null
  /** Employees whose overtime could not be priced — the finance tab is blank. */
  employeesMissingWage: number
  /** Days where less overtime was worked than approved. */
  daysUnderApproved: number
  weeksOverCap: number
  /** When attendance_daily was last recomputed over this range, so the reader
   *  knows how fresh the figures are. Null when the range holds no rows. */
  lastComputedAt: string | null
}

/** GET /api/overtime-requests/:id/weekly-cap — how much of the statutory
 *  weekly allowance this employee has already committed in the week the
 *  request falls in, so the approver sees the consequence before deciding.
 *  Counts approved requests, not hours worked: the decision is about hours
 *  that have not happened yet. */
export type OvertimeWeeklyCapResponse = {
  /** Monday and Sunday of the week containing the request's otDate. */
  weekStart: string
  weekEnd: string
  /** Already approved in that week, this request excluded. */
  approvedMinutes: number
  /** What this request would add. */
  requestMinutes: number
  capMinutes: number
}

/** GET /api/overtime-report?from=&to=&employeeId=&departmentId= */
export type OvertimeReportResponse = {
  byEmployee: OvertimeReportEmployee[]
  byDay: OvertimeReportDay[]
  byWeek: OvertimeReportWeek[]
  summary: OvertimeReportSummary
}

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
