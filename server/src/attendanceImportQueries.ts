// Database work for the attendance import: resolving fingerprint codes to
// employees, spotting punches already in the ledger, and the batch history.
//
// The route above this owns the orchestration (parse, classify, decide) so
// that the parts worth unit-testing stay pure; what is left here is the part
// that genuinely needs a connection.

import type pg from 'pg'
import type { AttendanceImportBatch } from '@hrm/shared'
import { pool } from './db.js'

type Queryable = Pick<pg.Pool, 'query'>

export type ImportEmployeeMatch = {
  employeeId: number
  employeeCode: string
  employeeName: string
}

/**
 * Which employee each fingerprint code belongs to.
 *
 * Only Active employees: a leaver's terminal enrolment is often still on the
 * machine and still exporting, and quietly writing attendance for someone who
 * no longer works here is worse than reporting the code as unmatched. It also
 * keeps the import consistent with the daily job, which only ever recomputes
 * active employees — punches written for anyone else would never be reported
 * on at all.
 */
export async function findEmployeesByFingerprintCodes(
  codes: string[],
  db: Queryable = pool
): Promise<Map<string, ImportEmployeeMatch>> {
  const result = new Map<string, ImportEmployeeMatch>()
  if (codes.length === 0) return result

  const { rows } = await db.query<{
    fingerprint_code: string
    id: string
    employee_code: string
    employee_name: string
  }>(
    `SELECT e.fingerprint_code, e.id, e.employee_code,
            (e.title || e.first_name_th || ' ' || e.last_name_th) AS employee_name
     FROM employees e
     JOIN employment_details d ON d.employee_id = e.id
     WHERE e.fingerprint_code = ANY($1::text[]) AND d.status = 'Active'`,
    [codes]
  )

  for (const row of rows) {
    result.set(row.fingerprint_code, {
      employeeId: Number(row.id),
      employeeCode: row.employee_code,
      employeeName: row.employee_name,
    })
  }
  return result
}

/**
 * The punches already recorded for these employees over an instant range, as
 * `employeeId|ISO instant|eventType` keys.
 *
 * Deliberately spans every source, not just previous imports. Re-uploading an
 * overlapping period is the documented way to close an overnight shift whose
 * check-out landed in the next export, so the same punch arriving twice is
 * routine — but so is an employee who clocked through LINE that morning and
 * also appears on the terminal's sheet. Both are the same event; neither
 * should be written a second time.
 */
export async function findExistingEventKeys(
  employeeIds: number[],
  fromInstant: Date,
  toInstant: Date,
  db: Queryable = pool
): Promise<Set<string>> {
  const keys = new Set<string>()
  if (employeeIds.length === 0) return keys

  const { rows } = await db.query<{ employee_id: string; event_time: string; event_type: string }>(
    `SELECT employee_id, event_time, event_type FROM attendance_events
     WHERE employee_id = ANY($1::bigint[]) AND event_time BETWEEN $2 AND $3`,
    [employeeIds, fromInstant.toISOString(), toInstant.toISOString()]
  )

  for (const row of rows) {
    keys.add(eventKey(Number(row.employee_id), new Date(row.event_time).toISOString(), row.event_type))
  }
  return keys
}

export function eventKey(employeeId: number, eventTimeIso: string, eventType: string): string {
  return `${employeeId}|${eventTimeIso}|${eventType}`
}

type BatchRow = {
  id: string
  file_name: string
  file_size_bytes: number
  range_from: string
  range_to: string
  generated_on: string | null
  employee_count: number
  event_count: number
  skipped_duplicate_count: number
  unmatched_codes: string[]
  imported_by_name: string | null
  imported_at: string
}

function rowToBatch(row: BatchRow): AttendanceImportBatch {
  return {
    id: Number(row.id),
    fileName: row.file_name,
    fileSizeBytes: row.file_size_bytes,
    rangeFrom: row.range_from,
    rangeTo: row.range_to,
    generatedOn: row.generated_on,
    employeeCount: row.employee_count,
    eventCount: row.event_count,
    skippedDuplicateCount: row.skipped_duplicate_count,
    unmatchedCodes: row.unmatched_codes,
    importedByName: row.imported_by_name,
    importedAt: new Date(row.imported_at).toISOString(),
  }
}

export type CreateImportBatchParams = {
  fileName: string
  fileSizeBytes: number
  rangeFrom: string
  rangeTo: string
  generatedOn: string | null
  employeeCount: number
  eventCount: number
  skippedDuplicateCount: number
  unmatchedCodes: string[]
  importedByOid: string
  importedByName: string | null
}

export async function createImportBatch(
  params: CreateImportBatchParams,
  db: Queryable
): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO attendance_import_batches
       (file_name, file_size_bytes, range_from, range_to, generated_on,
        employee_count, event_count, skipped_duplicate_count, unmatched_codes,
        imported_by_oid, imported_by_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      params.fileName,
      params.fileSizeBytes,
      params.rangeFrom,
      params.rangeTo,
      params.generatedOn,
      params.employeeCount,
      params.eventCount,
      params.skippedDuplicateCount,
      params.unmatchedCodes,
      params.importedByOid,
      params.importedByName,
    ]
  )
  const id = rows[0]?.id
  if (id === undefined) throw new Error('insert into attendance_import_batches returned no id')
  return Number(id)
}

const BATCH_LIST_LIMIT = 200

export async function listImportBatches(db: Queryable = pool): Promise<AttendanceImportBatch[]> {
  const { rows } = await db.query<BatchRow>(
    `SELECT id, file_name, file_size_bytes, range_from, range_to, generated_on,
            employee_count, event_count, skipped_duplicate_count, unmatched_codes,
            imported_by_name, imported_at
     FROM attendance_import_batches
     ORDER BY imported_at DESC
     LIMIT ${BATCH_LIST_LIMIT}`
  )
  return rows.map(rowToBatch)
}
