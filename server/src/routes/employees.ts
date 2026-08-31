import { Router } from 'express'
import type { Request, Response } from 'express'
import {
  EMPLOYEE_STATUSES,
  EMPLOYMENT_TYPES,
  FINGERPRINT_CODE_MAX_LENGTH,
  GENDERS,
  ROLES,
  SOCIAL_SECURITY_TYPES,
  TAX_TYPES,
  TERMINATION_REASONS,
  TITLES,
  WAGE_TYPES,
  PAYMENT_METHODS,
  WORK_LOCATIONS,
  type EmployeeInput,
  type EmployeeListResponse,
  type EmployeeSearchResponse,
  type AuthUser,
  type DailyShiftAssignmentEligibleResponse,
  type DailyShiftAssignmentInput,
  type DailyShiftAssignmentOutcome,
  type DailyShiftAssignmentResponse,
  type EmployeeBasicInput,
  type EmployeeFinanceInput,
  type EmployeeFinanceResponse,
  type EmploymentInput,
  type EmployeePhotoPresignResponse,
  type EmployeePhotoResponse,
  type EmployeeResponse,
  type LinkCodeResponse,
  type SocialSecurityType,
  type TaxType,
  type ShiftChangeInput,
  type ShiftChangeResponse,
  type ShiftHistoryResponse,
  type TerminationReason,
  type WageChangeInput,
  type WageChangeResponse,
  type WageHistoryResponse,
  type WageType,
} from '@hrm/shared'
import { LINK_CODE_TTL_MS, generateLinkCode, hashLinkCode } from '../auth/linkCode.js'
import { pool, withTransaction } from '../db.js'
import { requireRole } from '../auth/middleware.js'
import { recordAudit } from '../audit.js'
import { fail, handleUnexpected, parseOptionalPositiveInt } from '../http.js'
import {
  SELECT_EMPLOYEE,
  findEmployeeById,
  rowToEmployee,
  searchEmployees,
  type EmployeeRow,
} from '../employeeQueries.js'
import {
  findEmployeeFinanceById,
  rowToEmployeeFinance,
  type EmployeeFinanceRow,
} from '../employeeFinanceQueries.js'
import {
  assignShiftForDateRange,
  createShiftChange,
  listShiftAssignments,
  toThailandDateString,
} from '../shiftAssignmentQueries.js'
import { createWageChange, listWageAssignments } from '../wageAssignmentQueries.js'
import {
  deletePhotoObject,
  headPhoto,
  presignPhotoUpload,
  presignPhotoView,
} from '../storage/employeePhotos.js'
import { insertWithGeneratedEmployeeCode, isEmployeeCodeConflict } from '../employeeCodeGenerator.js'
import { resolveSupervisorScope, scopeAllows } from '../supervisorScope.js'

export const employeesRouter = Router()

// Reading the staff list is what every HRM role is for, so any of them will do.
// Changing it is not: Viewer stops here. Both sit in front of the handlers
// rather than inside them so that a new route cannot forget to ask.
const canRead = requireRole(...ROLES)
const canWrite = requireRole('HRM.HR', 'HRM.Admin')

// employee_finance is salary/bank data, not a scheduling detail — narrower
// than canRead/canWrite above (which let Viewer read), same reasoning as
// locations.ts' canWrite. Both read and write require HR/Admin.
const canReadWriteFinance = requireRole('HRM.HR', 'HRM.Admin')

/**
 * The caller, for the audit log. canWrite has already established that they are
 * an admin — this narrows the type and turns a wiring mistake into a 500 rather
 * than an audit entry attributed to nobody.
 */
function actorOf(req: Request): AuthUser | null {
  return req.auth ?? null
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string }

function requiredString(
  source: Record<string, unknown>,
  key: string
): string | null {
  const value = source[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function requiredPositiveInt(source: Record<string, unknown>, key: string): number | null {
  const value = source[key]
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

/** Unlike requiredPositiveInt, allows the fractional baht/satang that wage
 *  and social security/tax amounts are quoted in. */
function requiredPositiveNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/** Absent and null both mean "not applicable" — used for the fixed amounts
 *  that only apply under one choice of socialSecurityType/taxType. Present
 *  and not a positive finite number is a validation failure (undefined). */
function optionalPositiveNumber(
  source: Record<string, unknown>,
  key: string
): number | null | undefined {
  const value = source[key]
  if (value === null || value === undefined) return null
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** Absent and null both mean "no shift assigned". */
function optionalPositiveInt(source: Record<string, unknown>, key: string): number | null | undefined {
  const value = source[key]
  if (value === null || value === undefined) return null
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/** Standard Thai national ID checksum: the 13th digit is a weighted-sum
 *  check over the first 12 (weights 13 down to 2), so a valid-looking but
 *  mistyped number is rejected rather than merely being 13 digits. */
function isValidThaiIdCardNumber(value: string): boolean {
  if (!/^\d{13}$/.test(value)) return false
  const digits = value.split('').map(Number)
  let sum = 0
  for (let i = 0; i < 12; i++) {
    sum += (digits[i] as number) * (13 - i)
  }
  const check = (11 - (sum % 11)) % 10
  return check === digits[12]
}

/** Shared by parseEmployeeInput (POST) and PATCH /employees/:id/basic.
 *
 *  `optionalIdentity` (POST only — PATCH always leaves it off) waives
 *  employeeCode/idCardNumber from the required check: temporary daily
 *  workers are onboarded with neither (see employeeCodeGenerator.ts and the
 *  admin quick-add toggle). A blank employeeCode comes back as `''`, which
 *  the POST handler below treats as "generate one" — the guardrail against a
 *  *normal* hire accidentally skipping these fields lives entirely in the
 *  admin form's own required-fields check, not here; this endpoint is a
 *  deliberately permissive superset of what the DB itself requires. */
function parseEmployeeBasicFields(
  raw: Record<string, unknown>,
  opts: { optionalIdentity?: boolean } = {}
): ParseResult<EmployeeBasicInput> {
  const employeeCode = requiredString(raw, 'employeeCode')
  if (employeeCode === null && !opts.optionalIdentity) {
    return { ok: false, message: 'employeeCode is required' }
  }

  const fields = {
    firstNameTh: requiredString(raw, 'firstNameTh'),
    lastNameTh: requiredString(raw, 'lastNameTh'),
  }
  for (const [key, value] of Object.entries(fields)) {
    if (value === null) return { ok: false, message: `${key} is required` }
  }

  const idCardText = requiredString(raw, 'idCardNumber')
  let idCardNumber: string | null = null
  if (idCardText !== null) {
    if (!isValidThaiIdCardNumber(idCardText)) {
      return { ok: false, message: 'idCardNumber must be a valid 13-digit Thai national ID number' }
    }
    idCardNumber = idCardText
  } else if (!opts.optionalIdentity) {
    return { ok: false, message: 'idCardNumber is required' }
  }

  // Optional, and only ever set for staff enrolled on a fingerprint terminal.
  // '' is normalised to null rather than stored: the column is unique, so a
  // second blank code would collide with the first, and "not enrolled" is
  // exactly what null already means. Length-capped to match the CHECK on the
  // column — a violation there would surface as an opaque 500 instead.
  const fingerprintCodeRaw = raw['fingerprintCode']
  const fingerprintCode =
    typeof fingerprintCodeRaw === 'string' && fingerprintCodeRaw.trim() !== ''
      ? fingerprintCodeRaw.trim()
      : null
  if (fingerprintCode !== null && fingerprintCode.length > FINGERPRINT_CODE_MAX_LENGTH) {
    return {
      ok: false,
      message: `fingerprintCode must be at most ${FINGERPRINT_CODE_MAX_LENGTH} characters`,
    }
  }

  // Optional, and only ever set for the handful of employees who also sign
  // into admin/ (see 060_add_entra_upn_to_employees.sql). Lower-cased and
  // trimmed on the way in so the case-insensitive lookup in
  // findEmployeeIdByEntraUpn never has to reconcile "Someone@x.com" against
  // "someone@x.com" saved on a different day.
  const entraUpnRaw = raw['entraUpn']
  const entraUpn =
    typeof entraUpnRaw === 'string' && entraUpnRaw.trim() !== ''
      ? entraUpnRaw.trim().toLowerCase()
      : null

  const title = requiredString(raw, 'title')
  if (title === null || !(TITLES as readonly string[]).includes(title)) {
    return { ok: false, message: `title must be one of: ${TITLES.join(', ')}` }
  }

  // firstNameEn/lastNameEn are optional: HR may not have the English name on
  // file yet for every employee. Absent, null and '' all mean "none".
  const firstNameEnRaw = raw['firstNameEn']
  const firstNameEn =
    typeof firstNameEnRaw === 'string' && firstNameEnRaw.trim() !== ''
      ? firstNameEnRaw.trim()
      : null
  const lastNameEnRaw = raw['lastNameEn']
  const lastNameEn =
    typeof lastNameEnRaw === 'string' && lastNameEnRaw.trim() !== ''
      ? lastNameEnRaw.trim()
      : null

  // nickname is optional too: absent, null and '' all mean "none".
  const nicknameRaw = raw['nickname']
  const nickname =
    typeof nicknameRaw === 'string' && nicknameRaw.trim() !== ''
      ? nicknameRaw.trim()
      : null

  // gender is optional too, and for the same reason nickname is: HR may not
  // have this on file yet for an employee hired before the field existed.
  // Absent and null both mean "not recorded".
  const genderRaw = raw['gender']
  const genderProvided = genderRaw !== null && genderRaw !== undefined
  if (genderProvided && !(GENDERS as readonly string[]).includes(genderRaw as string)) {
    return { ok: false, message: `gender must be null or one of: ${GENDERS.join(', ')}` }
  }
  const gender = (genderProvided ? genderRaw : null) as EmployeeBasicInput['gender']

  return {
    ok: true,
    value: {
      employeeCode: employeeCode ?? '',
      idCardNumber,
      fingerprintCode,
      entraUpn,
      title: title as EmployeeBasicInput['title'],
      firstNameTh: fields.firstNameTh as string,
      lastNameTh: fields.lastNameTh as string,
      firstNameEn,
      lastNameEn,
      nickname,
      gender,
    },
  }
}

/** Shared by parseEmployeeInput (POST) and PATCH /employees/:id/employment. */
function parseEmploymentFields(emp: Record<string, unknown>): ParseResult<EmploymentInput> {
  const jobId = requiredPositiveInt(emp, 'jobId')
  if (jobId === null) {
    return { ok: false, message: 'employment.jobId is required and must be a positive integer' }
  }

  const departmentId = requiredPositiveInt(emp, 'departmentId')
  if (departmentId === null) {
    return {
      ok: false,
      message: 'employment.departmentId is required and must be a positive integer',
    }
  }

  const holidayGroupId = optionalPositiveInt(emp, 'holidayGroupId')
  if (holidayGroupId === undefined) {
    return {
      ok: false,
      message: 'employment.holidayGroupId must be a positive integer or null',
    }
  }

  const overtimeGroupId = optionalPositiveInt(emp, 'overtimeGroupId')
  if (overtimeGroupId === undefined) {
    return {
      ok: false,
      message: 'employment.overtimeGroupId must be a positive integer or null',
    }
  }

  // Null is a real answer here, not a blank field: it means this employee is
  // not paid by this system yet. See 049's comment.
  const payrollGroupId = optionalPositiveInt(emp, 'payrollGroupId')
  if (payrollGroupId === undefined) {
    return {
      ok: false,
      message: 'employment.payrollGroupId must be a positive integer or null',
    }
  }

  const supervisorEmployeeId = optionalPositiveInt(emp, 'supervisorEmployeeId')
  if (supervisorEmployeeId === undefined) {
    return {
      ok: false,
      message: 'employment.supervisorEmployeeId must be a positive integer or null',
    }
  }

  const status = requiredString(emp, 'status')
  if (status === null || !(EMPLOYEE_STATUSES as readonly string[]).includes(status)) {
    return {
      ok: false,
      message: `employment.status must be one of: ${EMPLOYEE_STATUSES.join(', ')}`,
    }
  }

  const employmentType = requiredString(emp, 'employmentType')
  if (
    employmentType === null ||
    !(EMPLOYMENT_TYPES as readonly string[]).includes(employmentType)
  ) {
    return {
      ok: false,
      message: `employment.employmentType must be one of: ${EMPLOYMENT_TYPES.join(', ')}`,
    }
  }

  const hireDate = requiredString(emp, 'hireDate')
  if (hireDate === null || !isCalendarDate(hireDate)) {
    return { ok: false, message: 'employment.hireDate must be a date as YYYY-MM-DD' }
  }

  const startWorkingDate = requiredString(emp, 'startWorkingDate')
  if (startWorkingDate === null || !isCalendarDate(startWorkingDate)) {
    return { ok: false, message: 'employment.startWorkingDate must be a date as YYYY-MM-DD' }
  }

  const workLocation = requiredString(emp, 'workLocation')
  if (workLocation === null || !(WORK_LOCATIONS as readonly string[]).includes(workLocation)) {
    return {
      ok: false,
      message: `employment.workLocation must be one of: ${WORK_LOCATIONS.join(', ')}`,
    }
  }

  // Optional, unlike every other date here: most employees have not left.
  const endWorkingDateRaw = emp['endWorkingDate']
  let endWorkingDate: string | null = null
  if (endWorkingDateRaw !== null && endWorkingDateRaw !== undefined) {
    if (typeof endWorkingDateRaw !== 'string' || !isCalendarDate(endWorkingDateRaw)) {
      return { ok: false, message: 'employment.endWorkingDate must be a date as YYYY-MM-DD, or null' }
    }
    endWorkingDate = endWorkingDateRaw
  }
  // Mirrors employment_details_end_after_hire, caught here so the message
  // names the two fields instead of surfacing as a constraint violation.
  if (endWorkingDate !== null && endWorkingDate < hireDate) {
    return { ok: false, message: 'employment.endWorkingDate ต้องไม่ก่อนวันที่จ้าง' }
  }

  const terminationReasonRaw = emp['terminationReason']
  let terminationReason: TerminationReason | null = null
  if (terminationReasonRaw !== null && terminationReasonRaw !== undefined) {
    if (
      typeof terminationReasonRaw !== 'string' ||
      !(TERMINATION_REASONS as readonly string[]).includes(terminationReasonRaw)
    ) {
      return {
        ok: false,
        message: `employment.terminationReason must be one of: ${TERMINATION_REASONS.join(', ')}`,
      }
    }
    terminationReason = terminationReasonRaw as TerminationReason
  }
  // Mirrors employment_details_termination_reason_needs_date. The reverse is
  // allowed on purpose: HR knows the last day before they know how สปส. will
  // categorise it.
  if (terminationReason !== null && endWorkingDate === null) {
    return {
      ok: false,
      message: 'employment.terminationReason ต้องระบุ endWorkingDate ด้วย',
    }
  }

  return {
    ok: true,
    value: {
      status: status as EmploymentInput['status'],
      hireDate,
      startWorkingDate,
      endWorkingDate,
      terminationReason,
      employmentType: employmentType as EmploymentInput['employmentType'],
      workLocation: workLocation as EmploymentInput['workLocation'],
      jobId,
      departmentId,
      holidayGroupId,
      overtimeGroupId,
      payrollGroupId,
      supervisorEmployeeId,
    },
  }
}

/** The one value of each enum that requires its companion fixed-amount field,
 *  mirroring the *_consistency CHECKs on employee_finance.
 *
 *  Annotated rather than inlined at the comparison below: the value being
 *  compared there comes back from requiredString() as a plain `string`, so
 *  `x === 'fixed_monthly'` type-checks against any spelling at all and a
 *  stale literal would fail silently — the branch would just never be taken
 *  and the API would disagree with the database's CHECK. Pinning the literal
 *  to its union here is what makes a future rename a compile error.
 *  EmployeeFinanceTab.tsx keeps the same pair for the same reason. */
const SOCIAL_SECURITY_FIXED: SocialSecurityType = 'fixed_monthly'
const TAX_FIXED: TaxType = 'fixed_monthly'

/** Shared by GET's absence of validation and PATCH /employees/:id/finance —
 *  really just the latter, but kept alongside parseEmployeeBasicFields/
 *  parseEmploymentFields for the same reason those are split out. */
// wageType/wageAmount are not read here. A wage is a dated interval as of
// 046_create_employee_wage_assignments.sql, so it arrives through POST
// /employees/:id/wage-changes with an effective date attached, never as a
// bare number on this settings payload.
function parseEmployeeFinanceFields(raw: Record<string, unknown>): ParseResult<EmployeeFinanceInput> {
  const paymentMethod = requiredString(raw, 'paymentMethod')
  if (paymentMethod === null || !(PAYMENT_METHODS as readonly string[]).includes(paymentMethod)) {
    return { ok: false, message: `paymentMethod must be one of: ${PAYMENT_METHODS.join(', ')}` }
  }

  const bankBranchCodeRaw = raw['bankBranchCode']
  const bankBranchCode =
    typeof bankBranchCodeRaw === 'string' && bankBranchCodeRaw.trim() !== ''
      ? bankBranchCodeRaw.trim()
      : null

  const bankAccountNumber = requiredString(raw, 'bankAccountNumber')
  if (bankAccountNumber === null) {
    return { ok: false, message: 'bankAccountNumber is required' }
  }

  const socialSecurityType = requiredString(raw, 'socialSecurityType')
  if (
    socialSecurityType === null ||
    !(SOCIAL_SECURITY_TYPES as readonly string[]).includes(socialSecurityType)
  ) {
    return {
      ok: false,
      message: `socialSecurityType must be one of: ${SOCIAL_SECURITY_TYPES.join(', ')}`,
    }
  }

  const socialSecurityFixedAmount = optionalPositiveNumber(raw, 'socialSecurityFixedAmount')
  if (socialSecurityFixedAmount === undefined) {
    return {
      ok: false,
      message: 'socialSecurityFixedAmount must be a positive number or null',
    }
  }
  // Mirrors the DB's social_security_fixed_amount_consistency CHECK — caught
  // here first so the error names the field rather than surfacing as a raw
  // constraint violation.
  const socialSecurityNeedsFixedAmount = socialSecurityType === SOCIAL_SECURITY_FIXED
  if (socialSecurityNeedsFixedAmount && socialSecurityFixedAmount === null) {
    return {
      ok: false,
      message: `socialSecurityFixedAmount is required when socialSecurityType is "${SOCIAL_SECURITY_FIXED}"`,
    }
  }
  if (!socialSecurityNeedsFixedAmount && socialSecurityFixedAmount !== null) {
    return {
      ok: false,
      message: `socialSecurityFixedAmount must be null unless socialSecurityType is "${SOCIAL_SECURITY_FIXED}"`,
    }
  }

  const taxType = requiredString(raw, 'taxType')
  if (taxType === null || !(TAX_TYPES as readonly string[]).includes(taxType)) {
    return { ok: false, message: `taxType must be one of: ${TAX_TYPES.join(', ')}` }
  }

  const taxFixedAmount = optionalPositiveNumber(raw, 'taxFixedAmount')
  if (taxFixedAmount === undefined) {
    return { ok: false, message: 'taxFixedAmount must be a positive number or null' }
  }
  const taxNeedsFixedAmount = taxType === TAX_FIXED
  if (taxNeedsFixedAmount && taxFixedAmount === null) {
    return {
      ok: false,
      message: `taxFixedAmount is required when taxType is "${TAX_FIXED}"`,
    }
  }
  if (!taxNeedsFixedAmount && taxFixedAmount !== null) {
    return {
      ok: false,
      message: `taxFixedAmount must be null unless taxType is "${TAX_FIXED}"`,
    }
  }

  const taxStartMonthRaw = raw['taxStartMonth']
  let taxStartMonth: string | null = null
  if (taxStartMonthRaw !== null && taxStartMonthRaw !== undefined) {
    if (
      typeof taxStartMonthRaw !== 'string' ||
      !isCalendarDate(taxStartMonthRaw) ||
      !taxStartMonthRaw.endsWith('-01')
    ) {
      return {
        ok: false,
        message: 'taxStartMonth must be the 1st of a month as YYYY-MM-01, or null',
      }
    }
    taxStartMonth = taxStartMonthRaw
  }

  return {
    ok: true,
    value: {
      paymentMethod: paymentMethod as EmployeeFinanceInput['paymentMethod'],
      bankBranchCode,
      bankAccountNumber,
      socialSecurityType: socialSecurityType as EmployeeFinanceInput['socialSecurityType'],
      socialSecurityFixedAmount,
      taxType: taxType as EmployeeFinanceInput['taxType'],
      taxFixedAmount,
      taxStartMonth,
    },
  }
}

/** Hand-rolled rather than pulling in a schema library for one route. */
function parseEmployeeInput(body: unknown): ParseResult<EmployeeInput> {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'body must be a JSON object' }
  }
  const raw = body as Record<string, unknown>
  const employmentRaw = raw['employment']
  if (typeof employmentRaw !== 'object' || employmentRaw === null) {
    return { ok: false, message: 'employment is required and must be an object' }
  }
  const emp = employmentRaw as Record<string, unknown>

  // optionalIdentity: temporary daily workers have neither an employee code
  // nor an ID card at onboarding — see parseEmployeeBasicFields' own comment.
  const basic = parseEmployeeBasicFields(raw, { optionalIdentity: true })
  if (!basic.ok) return basic

  const employment = parseEmploymentFields(emp)
  if (!employment.ok) return employment

  // shiftId is only settable here — the employee's first assignment at
  // creation. PATCH /employees/:id/employment has no shiftId at all; shift
  // changes after creation go through POST /employees/:id/shift-changes.
  const shiftId = optionalPositiveInt(emp, 'shiftId')
  if (shiftId === undefined) {
    return { ok: false, message: 'employment.shiftId must be a positive integer or null' }
  }

  return {
    ok: true,
    value: {
      ...basic.value,
      employment: {
        ...employment.value,
        shiftId,
      },
    },
  }
}

/** Rejects both bad formats and real-looking-but-impossible dates like 2024-02-31. */
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number) as [number, number, number]
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  )
}

// Express types params as string | string[] | undefined (repeated params yield an
// array). Only a single numeric segment is a valid id.
function parseId(value: string | string[] | undefined): number | null {
  if (typeof value !== 'string') return null
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505'
  )
}

/** employees has four unique columns now — the constraint name says which one
 *  actually failed rather than assuming it's always employee_code. */
function uniqueViolationField(
  err: unknown
): 'employeeCode' | 'idCardNumber' | 'fingerprintCode' | 'entraUpn' | null {
  const constraint =
    typeof err === 'object' && err !== null ? (err as { constraint?: unknown }).constraint : null
  if (constraint === 'employees_employee_code_key') return 'employeeCode'
  if (constraint === 'employees_id_card_number_key') return 'idCardNumber'
  if (constraint === 'employees_fingerprint_code_key') return 'fingerprintCode'
  if (constraint === 'employees_entra_upn_key') return 'entraUpn'
  return null
}

function isForeignKeyViolation(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23503'
  )
}

/**
 * job_id, shift_id, holiday_group_id, overtime_group_id, payroll_group_id and
 * supervisor_employee_id are all FKs on
 * employment_details, so a 23503 needs the constraint name to say which one
 * actually failed rather than guessing. Postgres auto-names a column-level
 * REFERENCES as `<table>_<column>_fkey`.
 */
function fkViolationField(
  err: unknown
):
  | 'job'
  | 'department'
  | 'shift'
  | 'holidayGroup'
  | 'overtimeGroup'
  | 'payrollGroup'
  | 'supervisor'
  | null {
  const constraint =
    typeof err === 'object' && err !== null ? (err as { constraint?: unknown }).constraint : null
  if (constraint === 'employment_details_job_id_fkey') return 'job'
  if (constraint === 'employment_details_department_id_fkey') return 'department'
  if (constraint === 'employment_details_shift_id_fkey') return 'shift'
  if (constraint === 'employment_details_holiday_group_id_fkey') return 'holidayGroup'
  if (constraint === 'employment_details_overtime_group_id_fkey') return 'overtimeGroup'
  if (constraint === 'employment_details_payroll_group_id_fkey') return 'payrollGroup'
  if (constraint === 'employment_details_supervisor_employee_id_fkey') return 'supervisor'
  if (constraint === 'employee_shift_assignments_shift_id_fkey') return 'shift'
  return null
}

/** Hand-rolled, same style as parseEmployeeInput. */
function parseShiftChangeInput(body: unknown): ParseResult<ShiftChangeInput> {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'body must be a JSON object' }
  }
  const raw = body as Record<string, unknown>

  const shiftId = optionalPositiveInt(raw, 'shiftId')
  if (shiftId === undefined) {
    return { ok: false, message: 'shiftId must be a positive integer or null' }
  }

  const effectiveFrom = requiredString(raw, 'effectiveFrom')
  if (effectiveFrom === null || !isCalendarDate(effectiveFrom)) {
    return { ok: false, message: 'effectiveFrom must be a date as YYYY-MM-DD' }
  }

  const effectiveToRaw = raw['effectiveTo']
  let effectiveTo: string | null = null
  if (effectiveToRaw !== undefined && effectiveToRaw !== null) {
    if (typeof effectiveToRaw !== 'string' || !isCalendarDate(effectiveToRaw)) {
      return { ok: false, message: 'effectiveTo must be a date as YYYY-MM-DD, or null' }
    }
    effectiveTo = effectiveToRaw
  }
  if (effectiveTo !== null && effectiveTo < effectiveFrom) {
    return { ok: false, message: 'effectiveTo must be on or after effectiveFrom' }
  }

  const noteRaw = raw['note']
  const note = typeof noteRaw === 'string' && noteRaw.trim() !== '' ? noteRaw.trim() : null

  return { ok: true, value: { shiftId, effectiveFrom, effectiveTo, note } }
}

employeesRouter.get('/employees', canRead, async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query<EmployeeRow>(
      `${SELECT_EMPLOYEE} ORDER BY e.employee_code`
    )
    const body: EmployeeListResponse = { employees: rows.map(rowToEmployee) }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

/** A parsed and validated q/payrollGroupId/page/pageSize for
 *  GET /employees/search — see searchEmployees' own doc for what each of
 *  these does. Mounted ahead of GET /employees/:id so 'search' is never
 *  parsed as an id. */
function parseOptionalPayrollGroupFilter(
  value: string | string[] | undefined
): number | 'none' | null | undefined {
  if (value === undefined) return null
  if (typeof value !== 'string') return undefined
  if (value === 'none') return 'none'
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : undefined
}

employeesRouter.get('/employees/search', canRead, async (req: Request, res: Response) => {
  const q = req.query['q']
  if (q !== undefined && typeof q !== 'string') return fail(res, 400, 'q must be a string')

  const payrollGroupId = parseOptionalPayrollGroupFilter(
    req.query['payrollGroupId'] as string | string[] | undefined
  )
  if (payrollGroupId === undefined) {
    return fail(res, 400, `payrollGroupId must be 'none' or a positive integer`)
  }

  const page = parseOptionalPositiveInt(req.query['page'])
  if (page === undefined) return fail(res, 400, 'page must be a positive integer')

  const pageSize = parseOptionalPositiveInt(req.query['pageSize'])
  if (pageSize === undefined) return fail(res, 400, 'pageSize must be a positive integer')

  try {
    const result = await searchEmployees(
      { ...(q !== undefined && q !== '' && { query: q }), ...(payrollGroupId !== null && { payrollGroupId }) },
      { ...(page !== null && { page }), ...(pageSize !== null && { pageSize }) }
    )
    const body: EmployeeSearchResponse = result
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

employeesRouter.get('/employees/:id', canRead, async (req: Request, res: Response) => {
  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  try {
    const employee = await findEmployeeById(id)
    if (!employee) return fail(res, 404, `no employee with id ${id}`)

    const body: EmployeeResponse = { employee }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

employeesRouter.post('/employees', canWrite, async (req: Request, res: Response) => {
  const actor = actorOf(req)
  if (!actor) return fail(res, 500, 'server misconfigured')

  const parsed = parseEmployeeInput(req.body)
  if (!parsed.ok) return fail(res, 400, parsed.message)
  const input = parsed.value

  // Filled in inside the transaction below — input.employeeCode may be blank
  // (auto-generate), so this is what actually ended up in the row, for the
  // audit entry and the response.
  let insertedEmployeeCode = input.employeeCode

  try {
    const employee = await withTransaction(async (client) => {
      const created = await insertWithGeneratedEmployeeCode(
        client,
        input.employeeCode,
        async (employeeCode) => {
          const { rows } = await client.query<{ id: string }>(
            `INSERT INTO employees
               (employee_code, id_card_number, fingerprint_code, entra_upn, title,
                first_name_th, last_name_th,
                first_name_en, last_name_en, nickname, gender)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             RETURNING id`,
            [
              employeeCode,
              input.idCardNumber,
              input.fingerprintCode,
              input.entraUpn,
              input.title,
              input.firstNameTh,
              input.lastNameTh,
              input.firstNameEn,
              input.lastNameEn,
              input.nickname,
              input.gender,
            ]
          )
          const row = rows[0]
          if (!row) throw new Error('insert into employees returned no id')
          insertedEmployeeCode = employeeCode
          return row
        },
        isEmployeeCodeConflict
      )

      await client.query(
        `INSERT INTO employment_details
           (employee_id, status, hire_date, start_working_date, end_working_date,
            termination_reason, employment_type, work_location,
            job_id, department_id, shift_id, holiday_group_id, overtime_group_id,
            payroll_group_id, supervisor_employee_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          created.id,
          input.employment.status,
          input.employment.hireDate,
          input.employment.startWorkingDate,
          input.employment.endWorkingDate,
          input.employment.terminationReason,
          input.employment.employmentType,
          input.employment.workLocation,
          input.employment.jobId,
          input.employment.departmentId,
          input.employment.shiftId,
          input.employment.holidayGroupId,
          input.employment.overtimeGroupId,
          input.employment.payrollGroupId,
          input.employment.supervisorEmployeeId,
        ]
      )

      // The employee's first shift assignment, if given one at creation —
      // employment_details.shift_id above is written too (existing columns
      // aren't dropped yet) but nothing reads it as "current" any more; this
      // row is what getShiftIdForDate/currentShiftJoinSql actually resolve.
      if (input.employment.shiftId !== null) {
        await client.query(
          `INSERT INTO employee_shift_assignments
             (employee_id, shift_id, effective_from, created_by_kind, created_by_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            created.id,
            input.employment.shiftId,
            input.employment.hireDate,
            actor.kind,
            actor.kind === 'admin' ? actor.oid : String(actor.employeeId),
          ]
        )
      }

      await recordAudit(client, {
        actor,
        action: 'employee.create',
        entityId: Number(created.id),
        detail: { employeeCode: insertedEmployeeCode },
      })

      // Re-read through the join rather than assembling the response from
      // input: input no longer carries jobTitle, only the jobId it was traded
      // in for, and this is the one place that resolves it.
      const employee = await findEmployeeById(Number(created.id), client)
      if (!employee) throw new Error('employee vanished between insert and read-back')
      return employee
    })

    const body: EmployeeResponse = { employee }
    res.status(201).json(body)
  } catch (err) {
    if (isUniqueViolation(err)) {
      const field = uniqueViolationField(err)
      if (field === 'idCardNumber') {
        return fail(res, 409, `เลขบัตรประชาชน ${input.idCardNumber} ถูกใช้งานแล้ว`)
      }
      if (field === 'fingerprintCode') {
        return fail(res, 409, `รหัสลายนิ้วมือ ${input.fingerprintCode} ถูกใช้งานแล้ว`)
      }
      if (field === 'entraUpn') {
        return fail(res, 409, `Entra UPN ${input.entraUpn} ถูกใช้งานกับพนักงานคนอื่นแล้ว`)
      }
      return fail(res, 409, `employee code ${insertedEmployeeCode} is already taken`)
    }
    const fkField = fkViolationField(err)
    if (fkField === 'job') return fail(res, 400, `no job with id ${input.employment.jobId}`)
    if (fkField === 'department') {
      return fail(res, 400, `no department with id ${input.employment.departmentId}`)
    }
    if (fkField === 'shift') return fail(res, 400, `no shift with id ${input.employment.shiftId}`)
    if (fkField === 'holidayGroup') {
      return fail(res, 400, `no holiday group with id ${input.employment.holidayGroupId}`)
    }
    if (fkField === 'overtimeGroup') {
      return fail(res, 400, `no overtime group with id ${input.employment.overtimeGroupId}`)
    }
    if (fkField === 'payrollGroup') {
      return fail(res, 400, `no payroll group with id ${input.employment.payrollGroupId}`)
    }
    if (fkField === 'supervisor') {
      return fail(res, 400, `no employee with id ${input.employment.supervisorEmployeeId}`)
    }
    if (isForeignKeyViolation(err)) return fail(res, 400, 'invalid reference in employment')
    handleUnexpected(res, err)
  }
})

// Two independent PATCHes rather than one full-replace PUT: the admin edit
// screen has separate forms (and separate Save buttons) for basic info and
// employment info, and neither should need to know the other's current
// draft to save.
employeesRouter.patch('/employees/:id/basic', canWrite, async (req: Request, res: Response) => {
  const actor = actorOf(req)
  if (!actor) return fail(res, 500, 'server misconfigured')

  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  if (typeof req.body !== 'object' || req.body === null) {
    return fail(res, 400, 'body must be a JSON object')
  }
  const parsed = parseEmployeeBasicFields(req.body as Record<string, unknown>)
  if (!parsed.ok) return fail(res, 400, parsed.message)
  const input: EmployeeBasicInput = parsed.value

  try {
    const result = await withTransaction(async (client) => {
      const { rowCount } = await client.query(
        `UPDATE employees SET
           employee_code = $2, id_card_number = $3, fingerprint_code = $4, entra_upn = $5,
           title = $6,
           first_name_th = $7, last_name_th = $8,
           first_name_en = $9, last_name_en = $10,
           nickname = $11, gender = $12, updated_at = now()
         WHERE id = $1`,
        [
          id,
          input.employeeCode,
          input.idCardNumber,
          input.fingerprintCode,
          input.entraUpn,
          input.title,
          input.firstNameTh,
          input.lastNameTh,
          input.firstNameEn,
          input.lastNameEn,
          input.nickname,
          input.gender,
        ]
      )
      if (rowCount === 0) return 'not-found' as const

      await recordAudit(client, {
        actor,
        action: 'employee.basic_update',
        entityId: id,
        detail: { employeeCode: input.employeeCode },
      })

      // Re-read through the join for the same reason POST does: the response
      // needs jobTitle/shiftName/holidayGroupName, which input never carries.
      const employee = await findEmployeeById(id, client)
      if (!employee) throw new Error('employee vanished during update')
      return employee
    })

    if (result === 'not-found') return fail(res, 404, `no employee with id ${id}`)

    const body: EmployeeResponse = { employee: result }
    res.json(body)
  } catch (err) {
    if (isUniqueViolation(err)) {
      const field = uniqueViolationField(err)
      if (field === 'idCardNumber') {
        return fail(res, 409, `เลขบัตรประชาชน ${input.idCardNumber} ถูกใช้งานแล้ว`)
      }
      if (field === 'fingerprintCode') {
        return fail(res, 409, `รหัสลายนิ้วมือ ${input.fingerprintCode} ถูกใช้งานแล้ว`)
      }
      if (field === 'entraUpn') {
        return fail(res, 409, `Entra UPN ${input.entraUpn} ถูกใช้งานกับพนักงานคนอื่นแล้ว`)
      }
      return fail(res, 409, `employee code ${input.employeeCode} is already taken`)
    }
    handleUnexpected(res, err)
  }
})

employeesRouter.patch(
  '/employees/:id/employment',
  canWrite,
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor) return fail(res, 500, 'server misconfigured')

    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    if (typeof req.body !== 'object' || req.body === null) {
      return fail(res, 400, 'body must be a JSON object')
    }
    const parsed = parseEmploymentFields(req.body as Record<string, unknown>)
    if (!parsed.ok) return fail(res, 400, parsed.message)
    const input: EmploymentInput = parsed.value

    // Not a DB constraint (see migration 059's comment) — checked here so an
    // employee can never be saved as their own supervisor.
    if (input.supervisorEmployeeId === id) {
      return fail(res, 400, 'employment.supervisorEmployeeId ต้องไม่ใช่พนักงานคนเดียวกัน')
    }

    try {
      const result = await withTransaction(async (client) => {
        // shift_id is deliberately absent here — shift changes need an
        // effective date and go through POST /employees/:id/shift-changes
        // instead, which is the only writer of employee_shift_assignments
        // (and, since 023, the only thing any read path trusts for "current
        // shift").
        const { rowCount } = await client.query(
          `UPDATE employment_details SET
             status = $2, hire_date = $3, start_working_date = $4,
             end_working_date = $5, termination_reason = $6,
             employment_type = $7, work_location = $8,
             job_id = $9, department_id = $10, holiday_group_id = $11, overtime_group_id = $12,
             payroll_group_id = $13, supervisor_employee_id = $14, updated_at = now()
           WHERE employee_id = $1`,
          [
            id,
            input.status,
            input.hireDate,
            input.startWorkingDate,
            input.endWorkingDate,
            input.terminationReason,
            input.employmentType,
            input.workLocation,
            input.jobId,
            input.departmentId,
            input.holidayGroupId,
            input.overtimeGroupId,
            input.payrollGroupId,
            input.supervisorEmployeeId,
          ]
        )
        if (rowCount === 0) return 'not-found' as const

        await recordAudit(client, {
          actor,
          action: 'employee.employment_update',
          entityId: id,
          detail: { jobId: input.jobId },
        })

        const employee = await findEmployeeById(id, client)
        if (!employee) throw new Error('employee vanished during update')
        return employee
      })

      if (result === 'not-found') return fail(res, 404, `no employee with id ${id}`)

      const body: EmployeeResponse = { employee: result }
      res.json(body)
    } catch (err) {
      const fkField = fkViolationField(err)
      if (fkField === 'job') return fail(res, 400, `no job with id ${input.jobId}`)
      if (fkField === 'department') {
        return fail(res, 400, `no department with id ${input.departmentId}`)
      }
      if (fkField === 'holidayGroup') {
        return fail(res, 400, `no holiday group with id ${input.holidayGroupId}`)
      }
      if (fkField === 'overtimeGroup') {
        return fail(res, 400, `no overtime group with id ${input.overtimeGroupId}`)
      }
      if (fkField === 'payrollGroup') {
        return fail(res, 400, `no payroll group with id ${input.payrollGroupId}`)
      }
      if (fkField === 'supervisor') {
        return fail(res, 400, `no employee with id ${input.supervisorEmployeeId}`)
      }
      if (isForeignKeyViolation(err)) return fail(res, 400, 'invalid reference in employment')
      handleUnexpected(res, err)
    }
  }
)

employeesRouter.get(
  '/employees/:id/finance',
  canReadWriteFinance,
  async (req: Request, res: Response) => {
    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    try {
      const employee = await findEmployeeById(id)
      if (!employee) return fail(res, 404, `no employee with id ${id}`)

      // null is a real answer, not an error: most existing employees have no
      // employee_finance row yet, since this tab is new.
      const finance = await findEmployeeFinanceById(id)
      const body: EmployeeFinanceResponse = { finance }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

// Upsert rather than plain UPDATE: employment_details is guaranteed to exist
// (created alongside the employee), but employee_finance is not — this may be
// the first save for an employee who predates the Finance tab.
employeesRouter.patch(
  '/employees/:id/finance',
  canReadWriteFinance,
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor) return fail(res, 500, 'server misconfigured')

    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    if (typeof req.body !== 'object' || req.body === null) {
      return fail(res, 400, 'body must be a JSON object')
    }
    const parsed = parseEmployeeFinanceFields(req.body as Record<string, unknown>)
    if (!parsed.ok) return fail(res, 400, parsed.message)
    const input: EmployeeFinanceInput = parsed.value

    try {
      const result = await withTransaction(async (client) => {
        const { rowCount: employeeExists } = await client.query(
          'SELECT 1 FROM employees WHERE id = $1',
          [id]
        )
        if (employeeExists === 0) return 'not-found' as const

        const { rows } = await client.query<EmployeeFinanceRow>(
          `INSERT INTO employee_finance
             (employee_id, payment_method, bank_branch_code,
              bank_account_number, social_security_type, social_security_fixed_amount,
              tax_type, tax_fixed_amount, tax_start_month)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (employee_id) DO UPDATE SET
             payment_method = EXCLUDED.payment_method,
             bank_branch_code = EXCLUDED.bank_branch_code,
             bank_account_number = EXCLUDED.bank_account_number,
             social_security_type = EXCLUDED.social_security_type,
             social_security_fixed_amount = EXCLUDED.social_security_fixed_amount,
             tax_type = EXCLUDED.tax_type,
             tax_fixed_amount = EXCLUDED.tax_fixed_amount,
             tax_start_month = EXCLUDED.tax_start_month,
             updated_at = now()
           RETURNING payment_method, bank_name, bank_branch_code,
                     bank_account_number, social_security_type, social_security_fixed_amount,
                     tax_type, tax_fixed_amount, tax_start_month`,
          [
            id,
            input.paymentMethod,
            input.bankBranchCode,
            input.bankAccountNumber,
            input.socialSecurityType,
            input.socialSecurityFixedAmount,
            input.taxType,
            input.taxFixedAmount,
            input.taxStartMonth,
          ]
        )
        const row = rows[0]
        if (!row) throw new Error('upsert into employee_finance returned no row')

        await recordAudit(client, {
          actor,
          action: 'employee.finance_update',
          entityId: id,
          detail: { paymentMethod: input.paymentMethod },
        })

        return rowToEmployeeFinance(row)
      })

      if (result === 'not-found') return fail(res, 404, `no employee with id ${id}`)

      const body: EmployeeFinanceResponse = { finance: result }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

employeesRouter.post(
  '/employees/:id/shift-changes',
  canWrite,
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor || actor.kind !== 'admin') return fail(res, 500, 'server misconfigured')

    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    const parsed = parseShiftChangeInput(req.body)
    if (!parsed.ok) return fail(res, 400, parsed.message)
    const input = parsed.value

    // No backdating: attendance already snapshots the shift that applied at
    // clock-in time (see attendance_events' shift_id), so there is nothing
    // for a backdated shift change to correct, only history to rewrite.
    const today = toThailandDateString(new Date())
    if (input.effectiveFrom < today) {
      return fail(
        res,
        400,
        'effectiveFrom ต้องเป็นวันนี้หรือวันในอนาคตเท่านั้น ไม่สามารถเปลี่ยนกะย้อนหลังได้'
      )
    }

    try {
      const result = await withTransaction(async (client) => {
        const employee = await findEmployeeById(id, client)
        if (!employee) return { kind: 'not-found' as const }
        if (input.effectiveFrom < employee.employment.hireDate) {
          return { kind: 'before-hire' as const }
        }

        const outcome = await createShiftChange(client, {
          employeeId: id,
          shiftId: input.shiftId,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo ?? null,
          note: input.note ?? null,
          createdByKind: actor.kind,
          createdById: actor.oid,
        })
        if (outcome.kind !== 'ok') return outcome

        await recordAudit(client, {
          actor,
          action: 'employee.shift_change',
          entityId: id,
          detail: {
            employeeCode: employee.employeeCode,
            shiftId: outcome.assignment.shiftId,
            previousShiftId: outcome.previousShiftId,
            effectiveFrom: outcome.assignment.effectiveFrom,
            effectiveTo: outcome.assignment.effectiveTo,
            note: outcome.assignment.note,
          },
        })
        return outcome
      })

      if (result.kind === 'not-found') return fail(res, 404, `no employee with id ${id}`)
      if (result.kind === 'before-hire') {
        return fail(res, 400, 'effectiveFrom ต้องไม่ก่อนวันที่เริ่มงานของพนักงาน')
      }
      if (result.kind === 'no_baseline') {
        return fail(
          res,
          400,
          'พนักงานคนนี้ยังไม่มีกะถาวรที่กำหนดไว้ ไม่สามารถสลับกะชั่วคราวได้ กรุณากำหนดกะถาวรก่อน'
        )
      }
      if (result.kind === 'overlap') {
        return fail(
          res,
          409,
          'ช่วงเวลาที่ระบุทับกับการเปลี่ยนกะที่ตั้งไว้ล่วงหน้าแล้ว กรุณาตรวจสอบประวัติการเปลี่ยนกะ'
        )
      }

      const body: ShiftChangeResponse = { assignment: result.assignment }
      res.status(201).json(body)
    } catch (err) {
      const fkField = fkViolationField(err)
      if (fkField === 'shift') return fail(res, 400, `no shift with id ${input.shiftId}`)
      if (isForeignKeyViolation(err)) return fail(res, 400, 'invalid reference in shift change')
      handleUnexpected(res, err)
    }
  }
)

/** Upper bound on the [dateFrom, dateTo] span POST daily-bulk accepts —
 *  guards against a fat-fingered year turning one request into thousands of
 *  per-date writes per employee. Same style as overtimeReport.ts's
 *  MAX_RANGE_DAYS. */
const DAILY_SHIFT_ASSIGNMENT_MAX_RANGE_DAYS = 62

/** Body of POST /employees/shift-assignments/daily-bulk. */
function parseDailyShiftAssignmentInput(body: unknown): ParseResult<DailyShiftAssignmentInput> {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'body must be a JSON object' }
  }
  const raw = body as Record<string, unknown>

  const dateFrom = requiredString(raw, 'dateFrom')
  if (dateFrom === null || !isCalendarDate(dateFrom)) {
    return { ok: false, message: 'dateFrom must be a date as YYYY-MM-DD' }
  }
  const dateToRaw = raw['dateTo']
  let dateTo: string | null = null
  if (dateToRaw !== null && dateToRaw !== undefined) {
    if (typeof dateToRaw !== 'string' || !isCalendarDate(dateToRaw)) {
      return { ok: false, message: 'dateTo must be a date as YYYY-MM-DD, or null' }
    }
    dateTo = dateToRaw
  }
  if (dateTo !== null && dateTo < dateFrom) {
    return { ok: false, message: 'dateTo must not be before dateFrom' }
  }
  const toUtcMillis = (value: string) => {
    const [year, month, day] = value.split('-').map(Number) as [number, number, number]
    return Date.UTC(year, month - 1, day)
  }
  const rangeDays = Math.round((toUtcMillis(dateTo ?? dateFrom) - toUtcMillis(dateFrom)) / 86_400_000) + 1
  if (rangeDays > DAILY_SHIFT_ASSIGNMENT_MAX_RANGE_DAYS) {
    return { ok: false, message: `ช่วงวันที่ต้องไม่เกิน ${DAILY_SHIFT_ASSIGNMENT_MAX_RANGE_DAYS} วัน` }
  }

  const assignmentsRaw = raw['assignments']
  if (!Array.isArray(assignmentsRaw) || assignmentsRaw.length === 0) {
    return { ok: false, message: 'assignments must be a non-empty array' }
  }

  const assignments: { employeeId: number; shiftId: number | null }[] = []
  for (const item of assignmentsRaw) {
    if (typeof item !== 'object' || item === null) {
      return { ok: false, message: 'each assignment must be an object' }
    }
    const row = item as Record<string, unknown>
    const employeeId = requiredPositiveInt(row, 'employeeId')
    if (employeeId === null) {
      return { ok: false, message: 'each assignment needs a positive employeeId' }
    }
    // null means "ลบกะ" — clear whatever shift is assigned on the date(s)
    // instead of assigning one.
    const shiftId = optionalPositiveInt(row, 'shiftId')
    if (shiftId === undefined) {
      return { ok: false, message: 'each assignment needs shiftId as a positive integer or null' }
    }
    assignments.push({ employeeId, shiftId })
  }

  return { ok: true, value: { dateFrom, dateTo, assignments } }
}

// Employees a supervisor/HR/Admin may assign a daily shift to — same scope
// as Bulk OT Request (resolveSupervisorScope in supervisorScope.ts): every
// active employee for HR/Admin, only the caller's own active direct reports
// for a resolved supervisor. Not gated by canRead/canWrite — those are
// role-based, and a supervisor reaching this page typically holds neither HR
// nor Admin, only enough of an Entra role to get past MeProvider's "no role"
// gate in admin/ (see supervisorScope.ts's comment for why that is a
// separate, unrelated requirement).
employeesRouter.get(
  '/employees/shift-assignments/daily-bulk/eligible-employees',
  async (req: Request, res: Response) => {
    const auth = actorOf(req)
    if (!auth) return fail(res, 500, 'server misconfigured')

    try {
      const scope = await resolveSupervisorScope(auth)
      if (scope.kind === 'none') {
        return fail(res, 403, 'บัญชีนี้ไม่มีสิทธิ์มอบหมายกะ', 'FORBIDDEN')
      }

      const { rows } = await pool.query<EmployeeRow>(
        scope.kind === 'all'
          ? `${SELECT_EMPLOYEE} ORDER BY e.employee_code`
          : `${SELECT_EMPLOYEE} WHERE e.id = ANY($1::bigint[]) ORDER BY e.employee_code`,
        scope.kind === 'all' ? [] : [scope.employeeIds]
      )

      const body: DailyShiftAssignmentEligibleResponse = {
        scope: scope.kind === 'all' ? 'all' : 'team',
        employees: rows.map(rowToEmployee),
      }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

// Assigns a shift to several employees for every date in [dateFrom, dateTo]
// at once — the admin "มอบหมายกะรายวัน" screen for temporary daily workers,
// who have no fixed shift (see assignSingleDayShift's own comment for why
// this can't reuse createShiftChange/POST /employees/:id/shift-changes).
// Each employee runs in its own SAVEPOINT (covering every date in the range
// for that employee) so one bad employee (or a genuine conflict) can't roll
// back the rest of an otherwise-successful batch. Guarded by
// resolveSupervisorScope rather than canWrite for the same reason the GET
// above is — see its comment.
employeesRouter.post(
  '/employees/shift-assignments/daily-bulk',
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor || actor.kind !== 'admin') return fail(res, 500, 'server misconfigured')

    const parsed = parseDailyShiftAssignmentInput(req.body)
    if (!parsed.ok) return fail(res, 400, parsed.message)
    const input = parsed.value

    try {
      const scope = await resolveSupervisorScope(actor)
      if (scope.kind === 'none') {
        return fail(res, 403, 'บัญชีนี้ไม่มีสิทธิ์มอบหมายกะ', 'FORBIDDEN')
      }

      const outcomes = await withTransaction(async (client) => {
        const results: DailyShiftAssignmentOutcome[] = []
        for (const assignment of input.assignments) {
          // Re-checked against the server-resolved scope, not the client's
          // say-so — same reasoning as the Bulk OT Request create endpoint.
          if (!scopeAllows(scope, assignment.employeeId)) {
            results.push({
              employeeId: assignment.employeeId,
              kind: 'error',
              message: 'พนักงานคนนี้ไม่อยู่ในสิทธิ์ของผู้ขอ',
            })
            continue
          }

          await client.query('SAVEPOINT daily_shift_assignment')
          try {
            const dateTo = input.dateTo ?? input.dateFrom
            const outcome = await assignShiftForDateRange(client, {
              employeeId: assignment.employeeId,
              shiftId: assignment.shiftId,
              dateFrom: input.dateFrom,
              dateTo,
              note: assignment.shiftId === null ? 'ลบกะรายวัน' : 'มอบหมายกะรายวัน',
              createdByKind: actor.kind,
              createdById: actor.oid,
            })
            if (outcome.kind === 'ok') {
              await recordAudit(client, {
                actor,
                action: 'employee.daily_shift_assign',
                entityId: assignment.employeeId,
                detail: { dateFrom: input.dateFrom, dateTo, shiftId: assignment.shiftId },
              })
              results.push({ employeeId: assignment.employeeId, kind: 'ok' })
            } else {
              results.push({
                employeeId: assignment.employeeId,
                kind: 'conflict',
                conflicts: outcome.conflicts,
              })
            }
            await client.query('RELEASE SAVEPOINT daily_shift_assignment')
          } catch (err) {
            await client.query('ROLLBACK TO SAVEPOINT daily_shift_assignment')
            results.push({
              employeeId: assignment.employeeId,
              kind: 'error',
              message: err instanceof Error ? err.message : 'unexpected error',
            })
          }
        }
        return results
      })

      const body: DailyShiftAssignmentResponse = { outcomes }
      res.status(201).json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

/** Body of POST /employees/:id/wage-changes. Shaped like
 *  parseShiftChangeInput, minus effectiveTo — a wage runs until the next one
 *  supersedes it, so there is no end date to supply. */
function parseWageChangeInput(body: unknown): ParseResult<WageChangeInput> {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'body must be a JSON object' }
  }
  const raw = body as Record<string, unknown>

  const wageType = requiredString(raw, 'wageType')
  if (wageType === null || !(WAGE_TYPES as readonly string[]).includes(wageType)) {
    return { ok: false, message: `wageType must be one of: ${WAGE_TYPES.join(', ')}` }
  }

  const wageAmount = requiredPositiveNumber(raw, 'wageAmount')
  if (wageAmount === null) {
    return { ok: false, message: 'wageAmount is required and must be a positive number' }
  }

  const effectiveFrom = requiredString(raw, 'effectiveFrom')
  if (effectiveFrom === null || !isCalendarDate(effectiveFrom)) {
    return { ok: false, message: 'effectiveFrom must be a date as YYYY-MM-DD' }
  }

  const noteRaw = raw['note']
  const note = typeof noteRaw === 'string' && noteRaw.trim() !== '' ? noteRaw.trim() : null

  return { ok: true, value: { wageType: wageType as WageType, wageAmount, effectiveFrom, note } }
}

// canReadWriteFinance, not the canWrite that /shift-changes uses: a wage is
// salary data and follows the same rule as the rest of the Finance tab, so a
// Viewer cannot read it either.
employeesRouter.get(
  '/employees/:id/wage-assignments',
  canReadWriteFinance,
  async (req: Request, res: Response) => {
    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    try {
      const employee = await findEmployeeById(id)
      if (!employee) return fail(res, 404, `no employee with id ${id}`)

      const assignments = await listWageAssignments(id)
      const body: WageHistoryResponse = { assignments }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

// Deliberately no equivalent of /shift-changes' "no backdating" guard. A raise
// agreed in April and effective from 1 March is ordinary, and pricing March
// correctly afterwards is the entire reason employee_wage_assignments exists.
// The bound that does apply is the employee's own start date: there is no such
// thing as a wage for a day before they worked here.
employeesRouter.post(
  '/employees/:id/wage-changes',
  canReadWriteFinance,
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor || actor.kind !== 'admin') return fail(res, 500, 'server misconfigured')

    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    const parsed = parseWageChangeInput(req.body)
    if (!parsed.ok) return fail(res, 400, parsed.message)
    const input = parsed.value

    try {
      const result = await withTransaction(async (client) => {
        const employee = await findEmployeeById(id, client)
        if (!employee) return { kind: 'not-found' as const }

        // The backfill in 046 dates the first row from start_working_date
        // where it exists, so the same date is the floor here — otherwise a
        // change dated earlier would sit before the row it is meant to
        // supersede and read as an overlap for no obvious reason.
        const employmentStart =
          employee.employment.startWorkingDate ?? employee.employment.hireDate
        if (input.effectiveFrom < employmentStart) {
          return { kind: 'before-start' as const }
        }

        const outcome = await createWageChange(client, {
          employeeId: id,
          wageType: input.wageType,
          wageAmount: input.wageAmount,
          effectiveFrom: input.effectiveFrom,
          note: input.note ?? null,
          createdByKind: actor.kind,
          createdById: actor.oid,
        })
        if (outcome.kind !== 'ok') return outcome

        await recordAudit(client, {
          actor,
          action: 'employee.wage_change',
          entityId: id,
          detail: {
            employeeCode: employee.employeeCode,
            wageType: outcome.assignment.wageType,
            wageAmount: outcome.assignment.wageAmount,
            effectiveFrom: outcome.assignment.effectiveFrom,
            note: outcome.assignment.note,
          },
        })
        return outcome
      })

      if (result.kind === 'not-found') return fail(res, 404, `no employee with id ${id}`)
      if (result.kind === 'before-start') {
        return fail(res, 400, 'วันที่มีผลต้องไม่ก่อนวันที่เริ่มงานของพนักงาน')
      }
      if (result.kind === 'overlap') {
        return fail(
          res,
          409,
          'วันที่มีผลทับกับช่วงค่าจ้างที่บันทึกไว้แล้ว — ค่าจ้างที่ปิดช่วงไปแล้วแก้ย้อนหลังไม่ได้ กรุณาตรวจสอบประวัติค่าจ้าง'
        )
      }

      const body: WageChangeResponse = { assignment: result.assignment }
      res.status(201).json(body)
    } catch (err) {
      // 23P01, raised by employee_wage_assignments_no_overlap when two admins
      // record a raise at the same instant and both pass the pre-check above.
      if (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23P01') {
        return fail(res, 409, 'มีการบันทึกค่าจ้างของพนักงานคนนี้พร้อมกัน กรุณาลองใหม่อีกครั้ง')
      }
      handleUnexpected(res, err)
    }
  }
)

employeesRouter.get(
  '/employees/:id/shift-history',
  canRead,
  async (req: Request, res: Response) => {
    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    try {
      const employee = await findEmployeeById(id)
      if (!employee) return fail(res, 404, `no employee with id ${id}`)

      const assignments = await listShiftAssignments(id)
      const body: ShiftHistoryResponse = { assignments }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

// Step 1 of the upload: hand out a presigned PUT URL. Nothing is written to
// the database here — the employee row only changes once /complete confirms
// the browser's direct-to-R2 upload actually landed, so an abandoned upload
// (tab closed mid-PUT) leaves no bookkeeping behind, just an unreferenced
// object in R2.
employeesRouter.post(
  '/employees/:id/photo/presign-upload',
  canWrite,
  async (req: Request, res: Response) => {
    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    const raw = req.body as Record<string, unknown>
    const mimeType = typeof raw['mimeType'] === 'string' ? raw['mimeType'] : null
    const sizeBytes = typeof raw['sizeBytes'] === 'number' ? raw['sizeBytes'] : null
    if (mimeType === null || sizeBytes === null) {
      return fail(res, 400, 'mimeType (string) and sizeBytes (number) are required')
    }

    try {
      const employee = await findEmployeeById(id)
      if (!employee) return fail(res, 404, `no employee with id ${id}`)

      const presigned = await presignPhotoUpload(id, mimeType, sizeBytes)
      if (!presigned.ok) return fail(res, 400, presigned.message)

      const body: EmployeePhotoPresignResponse = {
        uploadUrl: presigned.uploadUrl,
        key: presigned.key,
      }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

// Step 2: the browser tells us its PUT to R2 finished. headPhoto confirms the
// object is actually there before we trust the key — the browser is telling
// the truth as far as it knows, but its PUT could still have failed
// mid-flight without the JS ever seeing an error.
employeesRouter.post(
  '/employees/:id/photo/complete',
  canWrite,
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor) return fail(res, 500, 'server misconfigured')

    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    const raw = req.body as Record<string, unknown>
    const key = typeof raw['key'] === 'string' ? raw['key'] : null
    if (key === null || !key.startsWith(`employees/${id}/photo/`)) {
      return fail(res, 400, `key must be a string under employees/${id}/photo/`)
    }

    try {
      const exists = await headPhoto(key)
      if (!exists) {
        return fail(res, 400, 'no object found at that key — the upload may not have finished')
      }

      const result = await withTransaction(async (client) => {
        const { rows } = await client.query<{ photo_key: string | null }>(
          'SELECT photo_key FROM employees WHERE id = $1 FOR UPDATE',
          [id]
        )
        const row = rows[0]
        if (!row) return 'not-found' as const

        await client.query('UPDATE employees SET photo_key = $2 WHERE id = $1', [id, key])

        await recordAudit(client, {
          actor,
          action: 'employee.photo_update',
          entityId: id,
          detail: { key },
        })

        return { previousKey: row.photo_key }
      })

      if (result === 'not-found') return fail(res, 404, `no employee with id ${id}`)

      // Old object is only worth removing once the new one is committed —
      // best-effort, and never lets R2 cleanup fail a request that otherwise
      // succeeded.
      if (result.previousKey !== null && result.previousKey !== key) {
        await deletePhotoObject(result.previousKey)
      }

      const employee = await findEmployeeById(id)
      if (!employee) throw new Error('employee vanished after photo update')

      const body: EmployeeResponse = { employee }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

// Regenerated on every call rather than cached anywhere: the URL is only
// good for a few minutes, so there is nothing worth storing.
employeesRouter.get(
  '/employees/:id/photo',
  canRead,
  async (req: Request, res: Response) => {
    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    try {
      const { rows } = await pool.query<{ photo_key: string | null }>(
        'SELECT photo_key FROM employees WHERE id = $1',
        [id]
      )
      const row = rows[0]
      if (!row) return fail(res, 404, `no employee with id ${id}`)

      const url = row.photo_key === null ? null : await presignPhotoView(row.photo_key)
      const body: EmployeePhotoResponse = { url }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

employeesRouter.delete(
  '/employees/:id/photo',
  canWrite,
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor) return fail(res, 500, 'server misconfigured')

    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    try {
      const result = await withTransaction(async (client) => {
        const { rows } = await client.query<{ photo_key: string | null }>(
          'SELECT photo_key FROM employees WHERE id = $1 FOR UPDATE',
          [id]
        )
        const row = rows[0]
        if (!row) return 'not-found' as const
        if (row.photo_key === null) return 'no-photo' as const

        await client.query('UPDATE employees SET photo_key = NULL WHERE id = $1', [id])

        await recordAudit(client, {
          actor,
          action: 'employee.photo_delete',
          entityId: id,
          detail: { key: row.photo_key },
        })

        return { deletedKey: row.photo_key }
      })

      if (result === 'not-found') return fail(res, 404, `no employee with id ${id}`)
      if (result === 'no-photo') return res.status(204).end()

      await deletePhotoObject(result.deletedKey)
      res.status(204).end()
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

// Issues a one-time code the employee types into liff/ to claim their record.
// A write, and an identity-granting one, so canWrite rather than canRead.
employeesRouter.post(
  '/employees/:id/link-code',
  canWrite,
  async (req: Request, res: Response) => {
    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    const actor = actorOf(req)
    if (actor?.kind !== 'admin') return fail(res, 500, 'server misconfigured')

    const code = generateLinkCode()
    const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS)

    try {
      const result = await withTransaction(async (client) => {
        // FOR UPDATE: two HR users issuing at once would otherwise both read
        // "not linked" and both hand out a code for the same person.
        const { rows } = await client.query<{ line_user_id: string | null }>(
          'SELECT line_user_id FROM employees WHERE id = $1 FOR UPDATE',
          [id]
        )
        const employee = rows[0]
        if (!employee) return 'not-found' as const
        // Handing out a code for an employee who already has a LINE account
        // would only ever be the first half of taking their record away from
        // them. Unlinking is a deliberate act and does not have a route yet.
        if (employee.line_user_id !== null) return 'already-linked' as const

        await client.query(
          `INSERT INTO employee_link_codes (code_hash, employee_id, expires_at, created_by)
           VALUES ($1, $2, $3, $4)`,
          [hashLinkCode(code), id, expiresAt, actor.upn]
        )

        // No code in the detail — the audit log would then be holding a live
        // credential in plaintext, which is the thing the hash above avoids.
        await recordAudit(client, {
          actor,
          action: 'employee.link_code_issued',
          entityId: id,
          detail: { expiresAt: expiresAt.toISOString() },
        })
        return 'issued' as const
      })

      if (result === 'not-found') return fail(res, 404, `no employee with id ${id}`)
      if (result === 'already-linked') {
        return fail(res, 409, `employee ${id} is already linked to a LINE account`)
      }

      // The only time the plaintext code exists outside HR's screen. The row
      // holds a hash, so a second GET could not reproduce this if it wanted to.
      const body: LinkCodeResponse = { code, expiresAt: expiresAt.toISOString() }
      res.status(201).json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

employeesRouter.delete('/employees/:id', canWrite, async (req: Request, res: Response) => {
  const actor = actorOf(req)
  if (!actor) return fail(res, 500, 'server misconfigured')

  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  try {
    const deleted = await withTransaction(async (client) => {
      // employment_details and any link codes go with it via ON DELETE CASCADE.
      // RETURNING catches the employee code on its way out: a moment later there
      // is nowhere left to read it from, and it is the only thing that makes the
      // audit entry mean anything to whoever reads it.
      const { rows } = await client.query<{ employee_code: string }>(
        'DELETE FROM employees WHERE id = $1 RETURNING employee_code',
        [id]
      )
      const row = rows[0]
      if (!row) return false

      await recordAudit(client, {
        actor,
        action: 'employee.delete',
        entityId: id,
        detail: { employeeCode: row.employee_code },
      })
      return true
    })

    if (!deleted) return fail(res, 404, `no employee with id ${id}`)
    res.status(204).end()
  } catch (err) {
    handleUnexpected(res, err)
  }
})
