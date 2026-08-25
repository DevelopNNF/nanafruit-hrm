// Reading employees out of the database, shared by the routes that serve them
// and the auth routes that need to know whose record a LINE account claims.

import type pg from 'pg'
import type { Employee } from '@hrm/shared'
import { pool } from './db.js'
import { currentShiftJoinSql } from './shiftAssignmentQueries.js'

/** Anything that can run a query: the pool, or one client inside a transaction. */
type Queryable = Pick<pg.Pool, 'query'>

// Shape of a row from the employees ⋈ employment_details ⋈ master_jobs
// ⋈ master_shifts join. Every employment/job column is nullable here only
// because the LEFT JOINs say so — see rowToEmployee. shift_id/shift_name stay
// genuinely nullable even past that check: unlike job_id, an employee can
// legitimately have no shift assigned.
export type EmployeeRow = {
  id: string // bigint: pg hands these back as strings to avoid precision loss
  employee_code: string
  id_card_number: string | null
  fingerprint_code: string | null
  entra_upn: string | null
  title: string
  first_name_th: string
  last_name_th: string
  first_name_en: string | null
  last_name_en: string | null
  nickname: string | null
  gender: string | null
  status: string | null
  hire_date: string | null // 'YYYY-MM-DD' — see the DATE type parser in db.ts
  start_working_date: string | null // 'YYYY-MM-DD'
  end_working_date: string | null // 'YYYY-MM-DD'
  termination_reason: string | null
  employment_type: string | null
  work_location: string | null
  job_id: string | null // bigint, as a string for the same reason as id
  job_title: string | null
  department_id: string | null
  department_name: string | null
  shift_id: string | null
  shift_name: string | null
  shift_start_time: string | null
  shift_end_time: string | null
  holiday_group_id: string | null
  holiday_group_name: string | null
  overtime_group_id: string | null
  overtime_group_name: string | null
  payroll_group_id: string | null
  payroll_group_name: string | null
  supervisor_employee_id: string | null
  supervisor_employee_code: string | null
  supervisor_employee_name: string | null
}

// shift_id/shift_name/shift_start_time/shift_end_time come from
// employee_shift_assignments (the shift in effect *today*), not
// employment_details.shift_id — see that migration's comment for why the
// column stopped being a safe "current shift" source the moment a change
// could be scheduled for a future date with no job to flip it on arrival.
export const SELECT_EMPLOYEE = `
  SELECT e.id, e.employee_code, e.id_card_number, e.fingerprint_code, e.entra_upn, e.title,
         e.first_name_th, e.last_name_th, e.first_name_en, e.last_name_en,
         e.nickname, e.gender,
         d.status, d.hire_date, d.start_working_date, d.end_working_date,
         d.termination_reason, d.employment_type, d.work_location,
         d.job_id, mj.job_title,
         d.department_id, md.dept_name AS department_name,
         current_shift.shift_id, ms.shift_name, ms.shift_start_time, ms.shift_end_time,
         d.holiday_group_id, mhg.group_name AS holiday_group_name,
         d.overtime_group_id, mog.group_name AS overtime_group_name,
         d.payroll_group_id, mpg.group_name AS payroll_group_name,
         d.supervisor_employee_id, sup.employee_code AS supervisor_employee_code,
         (sup.title || sup.first_name_th || ' ' || sup.last_name_th) AS supervisor_employee_name
  FROM employees e
  LEFT JOIN employment_details d ON d.employee_id = e.id
  LEFT JOIN master_jobs mj ON mj.id = d.job_id
  LEFT JOIN master_departments md ON md.id = d.department_id
  ${currentShiftJoinSql('e.id')}
  LEFT JOIN master_shifts ms ON ms.id = current_shift.shift_id
  LEFT JOIN master_holiday_groups mhg ON mhg.id = d.holiday_group_id
  LEFT JOIN master_overtime_groups mog ON mog.id = d.overtime_group_id
  LEFT JOIN master_payroll_groups mpg ON mpg.id = d.payroll_group_id
  LEFT JOIN employees sup ON sup.id = d.supervisor_employee_id
`

export function rowToEmployee(row: EmployeeRow): Employee {
  // The LEFT JOINs type these as nullable, but every write goes through a
  // transaction that inserts both halves, employment_details.job_id is itself
  // NOT NULL, and its FK guarantees a master_jobs row exists. A null here means
  // the data was tampered with outside the API, so fail loudly rather than
  // invent an employment record. shift_id/shift_name are excluded from this
  // check — employment_details.shift_id is itself nullable, so null there is
  // a real "no shift assigned yet", not a sign of a broken row.
  if (
    row.status === null ||
    row.hire_date === null ||
    row.employment_type === null ||
    row.job_id === null ||
    row.job_title === null ||
    row.department_id === null ||
    row.department_name === null
  ) {
    throw new Error(`employee ${row.id} has no employment_details row`)
  }

  return {
    id: Number(row.id),
    employeeCode: row.employee_code,
    idCardNumber: row.id_card_number,
    fingerprintCode: row.fingerprint_code,
    entraUpn: row.entra_upn,
    title: row.title as Employee['title'],
    firstNameTh: row.first_name_th,
    lastNameTh: row.last_name_th,
    firstNameEn: row.first_name_en,
    lastNameEn: row.last_name_en,
    nickname: row.nickname,
    gender: row.gender as Employee['gender'],
    employment: {
      status: row.status as Employee['employment']['status'],
      hireDate: row.hire_date,
      startWorkingDate: row.start_working_date,
      endWorkingDate: row.end_working_date,
      terminationReason: row.termination_reason as Employee['employment']['terminationReason'],
      employmentType: row.employment_type as Employee['employment']['employmentType'],
      workLocation: row.work_location as Employee['employment']['workLocation'],
      jobId: Number(row.job_id),
      jobTitle: row.job_title,
      departmentId: Number(row.department_id),
      departmentName: row.department_name,
      shiftId: row.shift_id === null ? null : Number(row.shift_id),
      shiftName: row.shift_name,
      shiftStartTime: row.shift_start_time,
      shiftEndTime: row.shift_end_time,
      holidayGroupId: row.holiday_group_id === null ? null : Number(row.holiday_group_id),
      holidayGroupName: row.holiday_group_name,
      overtimeGroupId: row.overtime_group_id === null ? null : Number(row.overtime_group_id),
      overtimeGroupName: row.overtime_group_name,
      payrollGroupId: row.payroll_group_id === null ? null : Number(row.payroll_group_id),
      payrollGroupName: row.payroll_group_name,
      supervisorEmployeeId:
        row.supervisor_employee_id === null ? null : Number(row.supervisor_employee_id),
      supervisorEmployeeCode: row.supervisor_employee_code,
      supervisorEmployeeName: row.supervisor_employee_name,
    },
  }
}

export async function findEmployeeById(
  id: number,
  db: Queryable = pool
): Promise<Employee | null> {
  const { rows } = await db.query<EmployeeRow>(`${SELECT_EMPLOYEE} WHERE e.id = $1`, [id])
  const row = rows[0]
  return row ? rowToEmployee(row) : null
}

export async function findEmployeeByLineUserId(
  lineUserId: string,
  db: Queryable = pool
): Promise<Employee | null> {
  const { rows } = await db.query<EmployeeRow>(
    `${SELECT_EMPLOYEE} WHERE e.line_user_id = $1`,
    [lineUserId]
  )
  const row = rows[0]
  return row ? rowToEmployee(row) : null
}

/** Resolves an Entra session back to the employee record it belongs to, for
 *  features that need to know "which employee is this admin/ user" rather
 *  than just what role they hold — currently only resolveBulkOtScope in
 *  routes/overtimeRequests.ts. Case-insensitive: see 060's comment on why the
 *  column itself stays a plain unique index instead of a lower() one. */
export async function findEmployeeIdByEntraUpn(
  upn: string,
  db: Queryable = pool
): Promise<number | null> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM employees WHERE lower(entra_upn) = lower($1)`,
    [upn]
  )
  const row = rows[0]
  return row ? Number(row.id) : null
}

/** Active employees this employee supervises, for the Bulk OT Request
 *  picker's 'team' scope. Inactive direct reports are excluded for the same
 *  reason every other employee dropdown in this codebase filters to Active —
 *  there is nothing left to request OT for once someone has left. */
export async function listActiveDirectReportIds(
  supervisorEmployeeId: number,
  db: Queryable = pool
): Promise<number[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT e.id
     FROM employees e
     JOIN employment_details d ON d.employee_id = e.id
     WHERE d.supervisor_employee_id = $1 AND d.status = 'Active'
     ORDER BY e.employee_code`,
    [supervisorEmployeeId]
  )
  return rows.map((row) => Number(row.id))
}

export type EmployeeBulkOtCandidate = {
  id: number
  employeeCode: string
  employeeName: string
  departmentName: string | null
}

/** Active employees for the Bulk OT Request picker — just enough to render
 *  and search a TransferList row, not the full Employee join (jobTitle,
 *  shift, ... are never shown there). `employeeIds` narrows to a specific
 *  set — a supervisor's own direct reports; null means every active
 *  employee, HR/Admin's 'all' scope. */
export async function listActiveEmployeesForBulkOt(
  employeeIds: number[] | null,
  db: Queryable = pool
): Promise<EmployeeBulkOtCandidate[]> {
  const where = employeeIds === null ? '' : 'AND e.id = ANY($1::bigint[])'
  const params = employeeIds === null ? [] : [employeeIds]
  const { rows } = await db.query<{
    id: string
    employee_code: string
    employee_name: string
    department_name: string | null
  }>(
    `SELECT e.id, e.employee_code,
            (e.title || e.first_name_th || ' ' || e.last_name_th) AS employee_name,
            md.dept_name AS department_name
     FROM employees e
     JOIN employment_details d ON d.employee_id = e.id
     LEFT JOIN master_departments md ON md.id = d.department_id
     WHERE d.status = 'Active' ${where}
     ORDER BY e.employee_code`,
    params
  )
  return rows.map((row) => ({
    id: Number(row.id),
    employeeCode: row.employee_code,
    employeeName: row.employee_name,
    departmentName: row.department_name,
  }))
}
