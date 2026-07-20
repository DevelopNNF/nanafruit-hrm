// Reading jobs out of master_jobs. A single flat table with no join, unlike
// employees ⋈ employment_details — so this is the row-mapper alone, no SELECT-join
// helper needed.

import type pg from 'pg'
import type { Job } from '@hrm/shared'
import { pool } from './db.js'

type Queryable = Pick<pg.Pool, 'query'>

export type JobRow = {
  id: string // bigint: pg hands these back as strings to avoid precision loss
  job_title: string
  job_description: string | null
  work_instruction: string | null
  is_active: boolean
}

export const SELECT_JOB = `
  SELECT id, job_title, job_description, work_instruction, is_active
  FROM master_jobs
`

export function rowToJob(row: JobRow): Job {
  return {
    id: Number(row.id),
    jobTitle: row.job_title,
    jobDescription: row.job_description,
    workInstruction: row.work_instruction,
    isActive: row.is_active,
  }
}

export async function findJobById(id: number, db: Queryable = pool): Promise<Job | null> {
  const { rows } = await db.query<JobRow>(`${SELECT_JOB} WHERE id = $1`, [id])
  const row = rows[0]
  return row ? rowToJob(row) : null
}
