// Loading a fingerprint terminal's Excel export into attendance_events.
//
// Two endpoints over one plan. POST /attendance/import/preview builds the plan
// and answers with it; POST /attendance/import builds the same plan and writes
// it. The confirm step re-parses the uploaded file rather than accepting the
// preview's rows back from the browser, so what lands in the ledger is what the
// file says and not what a round-trip claims it said.
//
// The upload is the raw .xlsx bytes with the name in a query parameter, rather
// than multipart: nothing else in this API takes a file inline (photos and
// attachments go straight to R2 via a presigned PUT), and a body parser mounted
// on two routes is a smaller thing to own than a multipart dependency for a
// single spreadsheet.

import express, { Router } from 'express'
import type { Request, Response } from 'express'
import {
  ROLES,
  type AttendanceImportBatchListResponse,
  type AttendanceImportEmployeePreview,
  type AttendanceImportPreviewResponse,
  type AttendanceImportPunchPreview,
  type AttendanceImportResponse,
  type AuthUser,
} from '@hrm/shared'
import type pg from 'pg'
import { pool, withTransaction } from '../db.js'
import { requireRole } from '../auth/middleware.js'
import { recordAudit } from '../audit.js'
import { fail, handleUnexpected } from '../http.js'
import { parseAttendanceImport } from '../attendanceImportParse.js'
import { classifyImportedPunches, type ClassifiedPunch } from '../attendanceImportClassify.js'
import {
  createImportBatch,
  eventKey,
  findEmployeesByFingerprintCodes,
  findExistingEventKeys,
  listImportBatches,
  type ImportEmployeeMatch,
} from '../attendanceImportQueries.js'
import { resolveExpectedShiftWindows } from '../attendanceMatchingQueries.js'
import { addDays, getShiftIdForDate, toThailandDateString } from '../shiftAssignmentQueries.js'
import { recomputeAttendanceDaily } from '../attendanceDailyQueries.js'
import { withAttendanceJobLock } from '../attendanceDailyJob.js'

export const attendanceImportRouter = Router()

type Queryable = Pick<pg.Pool, 'query'>

// Import is a write, and a bulk one: HR and Admin only, matching every other
// write in this API. Deliberately narrower than the attendance list beside it,
// which any role may read.
const canImport = requireRole('HRM.HR', 'HRM.Admin')
// Reading the history is a read like any other — same roles as the attendance
// list beside it.
const canReadHistory = requireRole(...ROLES)

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
/** 10 MB. A month of punches for a few hundred people is well under a
 *  megabyte; this is a ceiling on nonsense, not a working limit. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

/** Some browsers send a generic type for a file picked off disk, so the parser
 *  — not the Content-Type — is what actually decides whether this is a
 *  workbook. Anything that is not really one fails there with a message. */
const uploadBody = express.raw({
  type: [XLSX_MIME, 'application/vnd.ms-excel', 'application/octet-stream'],
  limit: MAX_UPLOAD_BYTES,
})

/** An admin actor, which is what a batch row records. Employee tokens never
 *  reach here — requireRole already refuses them — but the type is a union and
 *  the oid only exists on one arm. */
function adminActor(req: Request): Extract<AuthUser, { kind: 'admin' }> | null {
  const auth = req.auth
  return auth && auth.kind === 'admin' ? auth : null
}

type PlannedEmployee = {
  fingerprintCode: string
  nameInFile: string | null
  match: ImportEmployeeMatch | null
  punches: (ClassifiedPunch & { duplicate: boolean })[]
}

type ImportPlan = {
  rangeFrom: string
  rangeTo: string
  generatedOn: string | null
  /** The dates the daily report has to be rebuilt over: a day either side of
   *  the file's own period, since an overnight shift's punches straddle it. */
  recomputeFrom: string
  recomputeTo: string
  employees: PlannedEmployee[]
  unmatchedCodes: string[]
  warnings: string[]
}

type PlanResult = { ok: true; plan: ImportPlan } | { ok: false; status: number; message: string }

/**
 * Everything the import decides, without writing any of it.
 *
 * Runs against whatever `db` is given: the pool for a preview, the transaction's
 * own client for the confirm step, so the plan that gets written is derived
 * inside the same transaction that writes it.
 */
async function buildImportPlan(file: Buffer, db: Queryable): Promise<PlanResult> {
  const parsed = await parseAttendanceImport(file)
  if (!parsed.ok) return { ok: false, status: 400, message: parsed.message }
  const sheet = parsed.value

  const today = toThailandDateString(new Date())
  if (sheet.rangeFrom > today) {
    return {
      ok: false,
      status: 400,
      message: `ช่วงวันที่ในไฟล์ (${sheet.rangeFrom} ~ ${sheet.rangeTo}) เริ่มต้นในอนาคต — ตรวจสอบไฟล์อีกครั้ง`,
    }
  }

  const matches = await findEmployeesByFingerprintCodes(
    sheet.employees.map((employee) => employee.fingerprintCode),
    db
  )

  // A day either side of the declared period. The first day's cell can open
  // with the previous work-date's overnight check-out, and a shift starting
  // just after midnight reaches back for a punch late on the last day — the
  // classifier needs both windows to attribute those correctly.
  const recomputeFrom = addDays(sheet.rangeFrom, -1)
  const recomputeTo = addDays(sheet.rangeTo, 1)
  const dates: string[] = []
  for (let date = recomputeFrom; date <= recomputeTo; date = addDays(date, 1)) dates.push(date)

  const employees: PlannedEmployee[] = []
  const unmatchedCodes: string[] = []

  for (const parsedEmployee of sheet.employees) {
    const match = matches.get(parsedEmployee.fingerprintCode) ?? null
    if (match === null) {
      unmatchedCodes.push(parsedEmployee.fingerprintCode)
      employees.push({ ...parsedEmployee, match: null, punches: [] })
      continue
    }

    // Sequential by necessity, not oversight: `db` may be one transaction
    // client, and a client cannot run two queries at once.
    const windows = await resolveExpectedShiftWindows(match.employeeId, dates, db)
    const classified = classifyImportedPunches(parsedEmployee.punches, windows)
    employees.push({
      fingerprintCode: parsedEmployee.fingerprintCode,
      nameInFile: parsedEmployee.nameInFile,
      match,
      punches: classified.map((punch) => ({ ...punch, duplicate: false })),
    })
  }

  // One query for every employee's existing punches, then flag in memory —
  // rather than a round trip per punch.
  const matchedIds = employees
    .map((employee) => employee.match?.employeeId)
    .filter((id): id is number => id !== undefined)
  const allInstants = employees.flatMap((employee) => employee.punches.map((p) => Date.parse(p.eventTime)))
  if (matchedIds.length > 0 && allInstants.length > 0) {
    const existing = await findExistingEventKeys(
      matchedIds,
      new Date(Math.min(...allInstants)),
      new Date(Math.max(...allInstants)),
      db
    )
    for (const employee of employees) {
      const employeeId = employee.match?.employeeId
      if (employeeId === undefined) continue
      for (const punch of employee.punches) {
        punch.duplicate = existing.has(eventKey(employeeId, punch.eventTime, punch.eventType))
      }
    }
  }

  return {
    ok: true,
    plan: {
      rangeFrom: sheet.rangeFrom,
      rangeTo: sheet.rangeTo,
      generatedOn: sheet.generatedOn,
      recomputeFrom,
      recomputeTo,
      employees,
      unmatchedCodes,
      warnings: sheet.warnings,
    },
  }
}

/** The uploaded bytes, or an answer already sent. */
function uploadedFile(req: Request, res: Response): Buffer | null {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    fail(res, 415, 'กรุณาแนบไฟล์ Excel (.xlsx) ของรายงานการลงเวลา')
    return null
  }
  return req.body
}

function uploadedFileName(req: Request): string {
  const raw = req.query['fileName']
  const name = typeof raw === 'string' ? raw.trim() : ''
  return (name === '' ? 'attendance.xlsx' : name).slice(0, 255)
}

function toEmployeePreview(employee: PlannedEmployee): AttendanceImportEmployeePreview {
  const punches: AttendanceImportPunchPreview[] = employee.punches.map((punch) => ({
    eventTime: punch.eventTime,
    eventType: punch.eventType,
    workDate: punch.workDate,
    matchedShift: punch.matchedShift,
    duplicate: punch.duplicate,
  }))
  return {
    fingerprintCode: employee.fingerprintCode,
    nameInFile: employee.nameInFile,
    employeeId: employee.match?.employeeId ?? null,
    employeeCode: employee.match?.employeeCode ?? null,
    employeeName: employee.match?.employeeName ?? null,
    punches,
    newCount: punches.filter((punch) => !punch.duplicate).length,
    duplicateCount: punches.filter((punch) => punch.duplicate).length,
    unmatchedShiftCount: punches.filter((punch) => !punch.matchedShift).length,
  }
}

attendanceImportRouter.post(
  '/attendance/import/preview',
  canImport,
  uploadBody,
  async (req: Request, res: Response) => {
    const file = uploadedFile(req, res)
    if (file === null) return

    try {
      const result = await buildImportPlan(file, pool)
      if (!result.ok) return fail(res, result.status, result.message)
      const { plan } = result

      const employees = plan.employees.map(toEmployeePreview)
      const body: AttendanceImportPreviewResponse = {
        preview: {
          fileName: uploadedFileName(req),
          rangeFrom: plan.rangeFrom,
          rangeTo: plan.rangeTo,
          generatedOn: plan.generatedOn,
          employees,
          unmatchedCodes: plan.unmatchedCodes,
          warnings: plan.warnings,
          totalNewCount: employees.reduce((sum, employee) => sum + employee.newCount, 0),
          totalDuplicateCount: employees.reduce((sum, employee) => sum + employee.duplicateCount, 0),
        },
      }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

/** Rows per INSERT. Six parameters each, so this stays an order of magnitude
 *  under Postgres' 65535-parameter ceiling however large a file gets. */
const INSERT_CHUNK_ROWS = 500

attendanceImportRouter.post(
  '/attendance/import',
  canImport,
  uploadBody,
  async (req: Request, res: Response) => {
    const actor = adminActor(req)
    if (!actor) return fail(res, 500, 'server misconfigured')

    const file = uploadedFile(req, res)
    if (file === null) return

    const fileName = uploadedFileName(req)

    try {
      const outcome = await withTransaction(async (client) => {
        const result = await buildImportPlan(file, client)
        if (!result.ok) return result
        const { plan } = result

        // Only what is genuinely new. A duplicate is not an error here — see
        // findExistingEventKeys — it is the expected cost of re-uploading an
        // overlapping period to close an overnight shift.
        const toInsert: {
          employeeId: number
          eventType: string
          eventTime: string
          workDate: string
        }[] = []
        let skippedDuplicateCount = 0

        for (const employee of plan.employees) {
          const employeeId = employee.match?.employeeId
          if (employeeId === undefined) continue
          for (const punch of employee.punches) {
            if (punch.duplicate) {
              skippedDuplicateCount += 1
              continue
            }
            toInsert.push({
              employeeId,
              eventType: punch.eventType,
              eventTime: punch.eventTime,
              workDate: punch.workDate,
            })
          }
        }

        const touchedEmployeeIds = [...new Set(toInsert.map((row) => row.employeeId))]

        const batchId = await createImportBatch(
          {
            fileName,
            fileSizeBytes: file.length,
            rangeFrom: plan.rangeFrom,
            rangeTo: plan.rangeTo,
            generatedOn: plan.generatedOn,
            employeeCount: touchedEmployeeIds.length,
            eventCount: toInsert.length,
            skippedDuplicateCount,
            unmatchedCodes: plan.unmatchedCodes,
            importedByOid: actor.oid,
            importedByName: actor.name,
          },
          client
        )

        // shift_id snapshots the shift that applied on the punch's own
        // work-date, not the employee's current one — an import is backdated
        // by definition, and by now they may be on a different shift. Same
        // reasoning as an approved time correction. Cached per employee/date
        // because four punches a day would otherwise ask four times.
        const shiftIdCache = new Map<string, number | null>()
        async function shiftIdFor(employeeId: number, workDate: string): Promise<number | null> {
          const key = `${employeeId}|${workDate}`
          const cached = shiftIdCache.get(key)
          if (cached !== undefined) return cached
          const shiftId = await getShiftIdForDate(employeeId, workDate, client)
          shiftIdCache.set(key, shiftId)
          return shiftId
        }

        let importedCount = 0
        for (let start = 0; start < toInsert.length; start += INSERT_CHUNK_ROWS) {
          const chunk = toInsert.slice(start, start + INSERT_CHUNK_ROWS)
          const values: unknown[] = []
          const tuples: string[] = []
          for (const row of chunk) {
            const shiftId = await shiftIdFor(row.employeeId, row.workDate)
            const base = values.length
            values.push(row.employeeId, row.eventType, row.eventTime, shiftId, batchId)
            tuples.push(
              `($${base + 1}, $${base + 2}, $${base + 3}, 'fingerprint_import', $${base + 4}, $${base + 5})`
            )
          }
          const { rowCount } = await client.query(
            `INSERT INTO attendance_events
               (employee_id, event_type, event_time, source, shift_id, import_batch_id)
             VALUES ${tuples.join(', ')}
             ON CONFLICT (employee_id, event_time, event_type)
               WHERE source = 'fingerprint_import'
             DO NOTHING`,
            values
          )
          importedCount += rowCount ?? 0
        }

        // Anything the unique index rejected was a duplicate this request's
        // own pre-check could not see — a second upload racing this one. It is
        // still a skipped duplicate as far as the batch record goes.
        const racedDuplicates = toInsert.length - importedCount
        if (racedDuplicates > 0) {
          skippedDuplicateCount += racedDuplicates
          await client.query(
            `UPDATE attendance_import_batches
             SET event_count = $2, skipped_duplicate_count = $3
             WHERE id = $1`,
            [batchId, importedCount, skippedDuplicateCount]
          )
        }

        await recordAudit(client, {
          actor,
          action: 'attendance.import',
          entityId: batchId,
          detail: {
            fileName,
            rangeFrom: plan.rangeFrom,
            rangeTo: plan.rangeTo,
            importedCount,
            skippedDuplicateCount,
            employeeIds: touchedEmployeeIds,
            unmatchedCodes: plan.unmatchedCodes,
          },
        })

        return {
          ok: true as const,
          batchId,
          importedCount,
          skippedDuplicateCount,
          touchedEmployeeIds,
          plan,
        }
      })

      if (!outcome.ok) return fail(res, outcome.status, outcome.message)

      // Outside the transaction: attendance_daily is derived data, and holding
      // the import's transaction open while it rebuilds would keep a lock over
      // work that can safely be redone later. If the batch job already holds
      // the advisory lock, the events are still committed and its next run
      // covers these dates — the response says which happened.
      let recomputed = false
      if (outcome.touchedEmployeeIds.length > 0) {
        const ran = await withAttendanceJobLock(async () => {
          for (const employeeId of outcome.touchedEmployeeIds) {
            await withTransaction((client) =>
              recomputeAttendanceDaily(
                employeeId,
                outcome.plan.recomputeFrom,
                outcome.plan.recomputeTo,
                client
              )
            )
          }
        })
        recomputed = ran !== null
      }

      const body: AttendanceImportResponse = {
        result: {
          batchId: outcome.batchId,
          importedCount: outcome.importedCount,
          skippedDuplicateCount: outcome.skippedDuplicateCount,
          employeeCount: outcome.touchedEmployeeIds.length,
          unmatchedCodes: outcome.plan.unmatchedCodes,
          recomputed,
        },
      }
      res.status(201).json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

attendanceImportRouter.get(
  '/attendance/import/batches',
  canReadHistory,
  async (_req: Request, res: Response) => {
    try {
      const body: AttendanceImportBatchListResponse = { batches: await listImportBatches() }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)
