// Reading departments out of master_departments. Unlike master_jobs, this one
// self-joins to resolve the parent department's name for display — the id
// alone isn't enough for the admin UI to show "reports to: Manufacturing".

import type pg from 'pg'
import type { Department } from '@hrm/shared'
import { pool } from './db.js'

type Queryable = Pick<pg.Pool, 'query'>

export type DepartmentRow = {
  id: string // bigint: pg hands these back as strings to avoid precision loss
  dept_code: string
  dept_name: string
  parent_department_id: string | null
  parent_department_name: string | null
  is_active: boolean
}

export const SELECT_DEPARTMENT = `
  SELECT d.id, d.dept_code, d.dept_name, d.parent_department_id,
         parent.dept_name AS parent_department_name, d.is_active
  FROM master_departments d
  LEFT JOIN master_departments parent ON parent.id = d.parent_department_id
`

export function rowToDepartment(row: DepartmentRow): Department {
  return {
    id: Number(row.id),
    deptCode: row.dept_code,
    deptName: row.dept_name,
    parentDepartmentId: row.parent_department_id === null ? null : Number(row.parent_department_id),
    parentDepartmentName: row.parent_department_name,
    isActive: row.is_active,
  }
}

export async function findDepartmentById(
  id: number,
  db: Queryable = pool
): Promise<Department | null> {
  const { rows } = await db.query<DepartmentRow>(`${SELECT_DEPARTMENT} WHERE d.id = $1`, [id])
  const row = rows[0]
  return row ? rowToDepartment(row) : null
}

/**
 * Reports whether setting `targetId`'s parent to `candidateParentId` would
 * create a cycle — either directly (candidateParentId is targetId itself)
 * or through a longer chain (candidateParentId is a descendant of targetId,
 * so targetId would end up an ancestor of its own ancestor). Walks up from
 * candidateParentId collecting every id in its chain, then checks whether
 * targetId appears in that set.
 *
 * The single-row CHECK in 025_create_master_departments.sql only catches the
 * direct self-parent case; this covers the multi-row cycle it can't express.
 */
export async function wouldCreateCycle(
  targetId: number,
  candidateParentId: number,
  db: Queryable = pool
): Promise<boolean> {
  const { rows } = await db.query<{ would_cycle: boolean }>(
    `
    WITH RECURSIVE chain AS (
      SELECT id, parent_department_id FROM master_departments WHERE id = $1
      UNION ALL
      SELECT md.id, md.parent_department_id
      FROM master_departments md
      JOIN chain c ON md.id = c.parent_department_id
    )
    SELECT EXISTS (SELECT 1 FROM chain WHERE id = $2) AS would_cycle
    `,
    [candidateParentId, targetId]
  )
  return rows[0]?.would_cycle ?? false
}
