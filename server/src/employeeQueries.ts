// Reading employees out of the database, shared by the routes that serve them
// and the auth routes that need to know whose record a LINE account claims.

import type pg from 'pg'
import type { Employee } from '@hrm/shared'
import { pool } from './db.js'

/** Anything that can run a query: the pool, or one client inside a transaction. */
type Queryable = Pick<pg.Pool, 'query'>

// Shape of a row from the employees ⋈ employment_details ⋈ master_jobs join.
// Every employment/job column is nullable here only because the LEFT JOINs say
// so — see rowToEmployee.
export type EmployeeRow = {
  id: string // bigint: pg hands these back as strings to avoid precision loss
  employee_code: string
  title: string
  first_name_th: string
  last_name_th: string
  first_name_en: string
  last_name_en: string
  nickname: string | null
  status: string | null
  hire_date: string | null // 'YYYY-MM-DD' — see the DATE type parser in db.ts
  employment_type: string | null
  job_id: string | null // bigint, as a string for the same reason as id
  job_title: string | null
}

export const SELECT_EMPLOYEE = `
  SELECT e.id, e.employee_code, e.title,
         e.first_name_th, e.last_name_th, e.first_name_en, e.last_name_en,
         e.nickname,
         d.status, d.hire_date, d.employment_type,
         d.job_id, mj.job_title
  FROM employees e
  LEFT JOIN employment_details d ON d.employee_id = e.id
  LEFT JOIN master_jobs mj ON mj.id = d.job_id
`

export function rowToEmployee(row: EmployeeRow): Employee {
  // The LEFT JOINs type these as nullable, but every write goes through a
  // transaction that inserts both halves, employment_details.job_id is itself
  // NOT NULL, and its FK guarantees a master_jobs row exists. A null here means
  // the data was tampered with outside the API, so fail loudly rather than
  // invent an employment record.
  if (
    row.status === null ||
    row.hire_date === null ||
    row.employment_type === null ||
    row.job_id === null ||
    row.job_title === null
  ) {
    throw new Error(`employee ${row.id} has no employment_details row`)
  }

  return {
    id: Number(row.id),
    employeeCode: row.employee_code,
    title: row.title as Employee['title'],
    firstNameTh: row.first_name_th,
    lastNameTh: row.last_name_th,
    firstNameEn: row.first_name_en,
    lastNameEn: row.last_name_en,
    nickname: row.nickname,
    employment: {
      status: row.status as Employee['employment']['status'],
      hireDate: row.hire_date,
      employmentType: row.employment_type as Employee['employment']['employmentType'],
      jobId: Number(row.job_id),
      jobTitle: row.job_title,
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
