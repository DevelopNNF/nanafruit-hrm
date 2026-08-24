// Master data by name rather than by id — what the employee import/export
// sheet needs and none of the id-keyed *Queries.ts modules provide.
//
// Only active rows: a dropdown offering a disabled department, or an import
// silently assigning one, would both undo the point of deactivating it. Same
// reasoning as findEmployeesByFingerprintCodes only matching Active employees
// in attendanceImportQueries.ts.
//
// Matching is by display name, and only dept_name/shift_name/group_name (on
// holiday and payroll groups) are *not* unique at the database level — only
// their *_code is. resolveByName's 'ambiguous' case exists for exactly that:
// two active rows sharing a name is a real possibility here, not a
// hypothetical.

import type pg from 'pg'
import { pool } from './db.js'

type Queryable = Pick<pg.Pool, 'query'>

export type NamedMasterRow = { id: number; name: string }

async function listActiveNamed(sql: string, db: Queryable): Promise<NamedMasterRow[]> {
  const { rows } = await db.query<{ id: string; name: string }>(sql)
  return rows.map((row) => ({ id: Number(row.id), name: row.name }))
}

export function listActiveDepartments(db: Queryable = pool): Promise<NamedMasterRow[]> {
  return listActiveNamed(
    `SELECT id, dept_name AS name FROM master_departments WHERE is_active = true ORDER BY dept_name`,
    db
  )
}

export function listActiveJobs(db: Queryable = pool): Promise<NamedMasterRow[]> {
  return listActiveNamed(
    `SELECT id, job_title AS name FROM master_jobs WHERE is_active = true ORDER BY job_title`,
    db
  )
}

export function listActiveShifts(db: Queryable = pool): Promise<NamedMasterRow[]> {
  return listActiveNamed(
    `SELECT id, shift_name AS name FROM master_shifts WHERE is_active = true ORDER BY shift_name`,
    db
  )
}

export function listActiveHolidayGroups(db: Queryable = pool): Promise<NamedMasterRow[]> {
  return listActiveNamed(
    `SELECT id, group_name AS name FROM master_holiday_groups WHERE is_active = true ORDER BY group_name`,
    db
  )
}

export function listActivePayrollGroups(db: Queryable = pool): Promise<NamedMasterRow[]> {
  return listActiveNamed(
    `SELECT id, group_name AS name FROM master_payroll_groups WHERE is_active = true ORDER BY group_name`,
    db
  )
}

export function listActiveOvertimeGroups(db: Queryable = pool): Promise<NamedMasterRow[]> {
  return listActiveNamed(
    `SELECT id, group_name AS name FROM master_overtime_groups WHERE is_active = true ORDER BY group_name`,
    db
  )
}

export type EmployeeImportMasterData = {
  departments: NamedMasterRow[]
  jobs: NamedMasterRow[]
  shifts: NamedMasterRow[]
  holidayGroups: NamedMasterRow[]
  payrollGroups: NamedMasterRow[]
  overtimeGroups: NamedMasterRow[]
}

/** All six active lists in one round trip of queries — used by both the
 *  export workbook's dropdown sheet and the import plan's name resolution, so
 *  a value HR picks from the dropdown always resolves on the way back in. */
export async function loadEmployeeImportMasterData(
  db: Queryable = pool
): Promise<EmployeeImportMasterData> {
  const [departments, jobs, shifts, holidayGroups, payrollGroups, overtimeGroups] =
    await Promise.all([
      listActiveDepartments(db),
      listActiveJobs(db),
      listActiveShifts(db),
      listActiveHolidayGroups(db),
      listActivePayrollGroups(db),
      listActiveOvertimeGroups(db),
    ])
  return { departments, jobs, shifts, holidayGroups, payrollGroups, overtimeGroups }
}

export type NameResolution =
  | { kind: 'unique'; id: number }
  | { kind: 'ambiguous' }
  | { kind: 'not_found' }

/** `name` against a list already known to hold only active rows. A blank
 *  name is always 'not_found' — callers decide separately whether blank is
 *  allowed for that column. */
export function resolveByName(rows: NamedMasterRow[], name: string): NameResolution {
  const matches = rows.filter((row) => row.name === name)
  if (matches.length === 0) return { kind: 'not_found' }
  if (matches.length > 1) return { kind: 'ambiguous' }
  return { kind: 'unique', id: matches[0]!.id }
}

export function nameById(rows: NamedMasterRow[], id: number | null): string | null {
  if (id === null) return null
  return rows.find((row) => row.id === id)?.name ?? null
}

/* Employee lookups used by the import plan --------------------------------- */

export type EmployeeCodeMatch = {
  employeeId: number
  employeeCode: string
  employeeName: string
  idCardNumber: string | null
  fingerprintCode: string | null
  /** Not null means this employee has already left — see the leaver rule in
   *  routes/employeeImport.ts. Independent of `status`; see employment
   *  details' own comment on why the two can disagree. */
  endWorkingDate: string | null
  /** The shift in effect today, resolved the same way currentShiftJoinSql
   *  does — null if none is assigned. Used to tell whether an update row's
   *  shift actually changes anything. */
  currentShiftId: number | null
}

/** Every employee whose code is in `codes`, regardless of status — an import
 *  has to see a leaver's row to block re-using their code, unlike
 *  findEmployeesByFingerprintCodes which only ever wants an Active match. */
export async function findEmployeesByCodes(
  codes: string[],
  db: Queryable = pool
): Promise<Map<string, EmployeeCodeMatch>> {
  const result = new Map<string, EmployeeCodeMatch>()
  if (codes.length === 0) return result

  const { rows } = await db.query<{
    id: string
    employee_code: string
    employee_name: string
    id_card_number: string | null
    fingerprint_code: string | null
    end_working_date: string | null
    current_shift_id: string | null
  }>(
    `SELECT e.id, e.employee_code,
            (e.title || e.first_name_th || ' ' || e.last_name_th) AS employee_name,
            e.id_card_number, e.fingerprint_code,
            d.end_working_date,
            current_shift.shift_id AS current_shift_id
     FROM employees e
     LEFT JOIN employment_details d ON d.employee_id = e.id
     LEFT JOIN LATERAL (
       SELECT shift_id FROM employee_shift_assignments esa
       WHERE esa.employee_id = e.id
         AND esa.effective_from <= (now() AT TIME ZONE 'Asia/Bangkok')::date
         AND (esa.effective_to IS NULL OR esa.effective_to >= (now() AT TIME ZONE 'Asia/Bangkok')::date)
     ) current_shift ON true
     WHERE e.employee_code = ANY($1::text[])`,
    [codes]
  )

  for (const row of rows) {
    result.set(row.employee_code, {
      employeeId: Number(row.id),
      employeeCode: row.employee_code,
      employeeName: row.employee_name,
      idCardNumber: row.id_card_number,
      fingerprintCode: row.fingerprint_code,
      endWorkingDate: row.end_working_date,
      currentShiftId: row.current_shift_id === null ? null : Number(row.current_shift_id),
    })
  }
  return result
}

/** employee_code owning each of these id card numbers, anywhere in the
 *  database — not just among the codes already in the file, since a row can
 *  collide with an employee the file never mentions. */
export async function findEmployeeCodesByIdCardNumbers(
  values: string[],
  db: Queryable = pool
): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  if (values.length === 0) return result
  const { rows } = await db.query<{ id_card_number: string; employee_code: string }>(
    `SELECT id_card_number, employee_code FROM employees WHERE id_card_number = ANY($1::text[])`,
    [values]
  )
  for (const row of rows) result.set(row.id_card_number, row.employee_code)
  return result
}

export async function findEmployeeCodesByFingerprintCodes(
  values: string[],
  db: Queryable = pool
): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  if (values.length === 0) return result
  const { rows } = await db.query<{ fingerprint_code: string; employee_code: string }>(
    `SELECT fingerprint_code, employee_code FROM employees WHERE fingerprint_code = ANY($1::text[])`,
    [values]
  )
  for (const row of rows) result.set(row.fingerprint_code, row.employee_code)
  return result
}

export type EmployeeFingerprintMatch = {
  employeeId: number
  employeeCode: string
  employeeName: string
  endWorkingDate: string | null
  currentShiftId: number | null
  currentWageAmount: number | null
}

/**
 * Every employee whose fingerprint code is in `values`, regardless of
 * status — same reasoning as findEmployeesByCodes: an import has to see a
 * leaver's row to report the "recycled terminal ID" blocked case usefully
 * (see routes/employeeImport.ts), not just silently fail to match.
 *
 * NOT the same function as attendanceImportQueries.ts's
 * findEmployeesByFingerprintCodes, deliberately named differently — that one
 * only matches Active employees and returns a different shape for a
 * different caller (punch matching, not employee onboarding). Named
 * "…ForImport" so the two never get grabbed for each other by mistake.
 */
export async function findEmployeesByFingerprintCodesForImport(
  values: string[],
  db: Queryable = pool
): Promise<Map<string, EmployeeFingerprintMatch>> {
  const result = new Map<string, EmployeeFingerprintMatch>()
  if (values.length === 0) return result

  const { rows } = await db.query<{
    id: string
    employee_code: string
    employee_name: string
    fingerprint_code: string
    end_working_date: string | null
    current_shift_id: string | null
    current_wage_amount: string | null
  }>(
    `SELECT e.id, e.employee_code, e.fingerprint_code,
            (e.title || e.first_name_th || ' ' || e.last_name_th) AS employee_name,
            d.end_working_date,
            current_shift.shift_id AS current_shift_id,
            current_wage.wage_amount AS current_wage_amount
     FROM employees e
     LEFT JOIN employment_details d ON d.employee_id = e.id
     LEFT JOIN LATERAL (
       SELECT shift_id FROM employee_shift_assignments esa
       WHERE esa.employee_id = e.id
         AND esa.effective_from <= (now() AT TIME ZONE 'Asia/Bangkok')::date
         AND (esa.effective_to IS NULL OR esa.effective_to >= (now() AT TIME ZONE 'Asia/Bangkok')::date)
     ) current_shift ON true
     LEFT JOIN LATERAL (
       SELECT wage_amount FROM employee_wage_assignments ewa
       WHERE ewa.employee_id = e.id
         AND ewa.effective_from <= (now() AT TIME ZONE 'Asia/Bangkok')::date
         AND (ewa.effective_to IS NULL OR ewa.effective_to >= (now() AT TIME ZONE 'Asia/Bangkok')::date)
     ) current_wage ON true
     WHERE e.fingerprint_code = ANY($1::text[])`,
    [values]
  )

  for (const row of rows) {
    result.set(row.fingerprint_code, {
      employeeId: Number(row.id),
      employeeCode: row.employee_code,
      employeeName: row.employee_name,
      endWorkingDate: row.end_working_date,
      currentShiftId: row.current_shift_id === null ? null : Number(row.current_shift_id),
      currentWageAmount: row.current_wage_amount === null ? null : Number(row.current_wage_amount),
    })
  }
  return result
}
