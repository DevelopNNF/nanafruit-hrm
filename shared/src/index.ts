// The API contract, shared by server (producer) and admin/liff (consumers).
//
// This package emits runtime code, so it must be built before server can start
// and before admin/liff can typecheck. `prepare` covers the fresh-clone case;
// while editing this file, run `npm run dev -w shared` to rebuild on save.

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
  jobTitle: string
}

/** Body of POST /api/employees and PATCH /api/employees/:id */
export type EmployeeInput = Omit<Employee, 'id'>

/** GET /api/employees */
export type EmployeeListResponse = { employees: Employee[] }

/** GET /api/employees/:id, POST, PATCH */
export type EmployeeResponse = { employee: Employee }

/** Any 4xx/5xx from the employees routes. */
export type ApiError = { status: 'error'; message: string }

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
