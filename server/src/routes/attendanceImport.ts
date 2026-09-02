// Loading a fingerprint terminal's Excel export into attendance_events.
//
// Two endpoints over one plan. POST /attendance/import/preview builds the plan
// and answers with it; POST /attendance/import builds the same plan and writes
// it. The confirm step re-parses the uploaded file rather than accepting the
// preview's rows back from the browser, so what lands in the ledger is what the
// file says and not what a round-trip claims it said.
//
// The upload is multipart/form-data: a `file` part (the .xlsx) plus an
// optional `overrides` text part — HR's manual corrections to punches the
// classifier's shift-window buffer read the wrong way round (an OT departure
// that runs past MATCH_BUFFER_MINUTES gets attributed to the wrong work-date
// or the wrong in/out). overrides used to ride as a query parameter, but that
// put it under Node's ~16KB request-header ceiling — a handful of corrections
// fit, but nothing stopped the list from growing past it, and once it did the
// request failed as 431 before it ever reached this file. A body has no such
// ceiling.
//
// overrides is re-applied to a freshly classified plan on every call —
// preview and confirm alike — rather than trusted as a finished answer, for
// the same reason the file itself is re-parsed on confirm: what lands in the
// ledger has to be re-derived from scratch each time, never accepted as a
// browser's claim about an earlier response.

import { Router } from 'express'
import type { NextFunction, Request, Response } from 'express'
import multer, { MulterError } from 'multer'
import {
  ROLES,
  type AttendanceEventType,
  type AttendanceImportBatchListResponse,
  type AttendanceImportEmployeePreview,
  type AttendanceImportOverride,
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

/** 10 MB. A month of punches for a few hundred people is well under a
 *  megabyte; this is a ceiling on nonsense, not a working limit. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

/** Buffered in memory, same as the old raw-body parser — nothing here is big
 *  enough to earn disk staging. No fileFilter: same reasoning as before,
 *  the parser downstream (not the browser-supplied mimetype) decides whether
 *  the `file` part is really a workbook. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 1,
    // Only `overrides` is expected besides the file. Its own default 1MB
    // fieldSize is already far more than any realistic correction list.
    fields: 1,
  },
})

/** Wraps multer's single-file parser so a malformed or oversized upload comes
 *  back as this API's usual JSON error shape instead of multer's default
 *  Express error page. */
function uploadFile(req: Request, res: Response, next: NextFunction) {
  upload.single('file')(req, res, (err: unknown) => {
    if (!err) return next()
    if (err instanceof MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return fail(res, 413, 'ไฟล์ใหญ่เกินไป — จำกัดไม่เกิน 10 MB')
    }
    return fail(res, 400, 'อัปโหลดไฟล์ไม่สำเร็จ — กรุณาลองใหม่อีกครั้ง')
  })
}

/** An admin actor, which is what a batch row records. Employee tokens never
 *  reach here — requireRole already refuses them — but the type is a union and
 *  the oid only exists on one arm. */
function adminActor(req: Request): Extract<AuthUser, { kind: 'admin' }> | null {
  const auth = req.auth
  return auth && auth.kind === 'admin' ? auth : null
}

type PlannedPunch = ClassifiedPunch & {
  duplicate: boolean
  overridden: boolean
  /** The classifier's own reading, before the override — only set when
   *  overridden, so the UI can show "read as…" and offer to undo. */
  original: { eventType: AttendanceEventType; workDate: string } | null
}

type PlannedEmployee = {
  fingerprintCode: string
  nameInFile: string | null
  match: ImportEmployeeMatch | null
  punches: PlannedPunch[]
}

type ImportPlan = {
  rangeFrom: string
  rangeTo: string
  generatedOn: string | null
  /** The dates the daily report has to be rebuilt over: a day either side of
   *  the file's own period (since an overnight shift's punches straddle it),
   *  widened further to cover any work-date an override moved a punch to. */
  recomputeFrom: string
  recomputeTo: string
  employees: PlannedEmployee[]
  unmatchedCodes: string[]
  warnings: string[]
  overriddenCount: number
}

type PlanResult = { ok: true; plan: ImportPlan } | { ok: false; status: number; message: string }

/** fingerprintCode + eventTime is what stays stable for the same punch across
 *  a preview → confirm round trip that re-parses the file from scratch — see
 *  the module comment. */
function overrideKey(fingerprintCode: string, eventTime: string): string {
  return `${fingerprintCode}|${eventTime}`
}

/** How far an override may move a punch from the calendar date it actually
 *  happened on. See its one call site. */
const REJECTED_OVERRIDE_MAX_DAYS = 7

function daysBetween(fromDate: string, toDate: string): number {
  const msPerDay = 24 * 60 * 60 * 1000
  return Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / msPerDay)
}

/**
 * Everything the import decides, without writing any of it.
 *
 * Runs against whatever `db` is given: the pool for a preview, the transaction's
 * own client for the confirm step, so the plan that gets written is derived
 * inside the same transaction that writes it.
 */
async function buildImportPlan(
  file: Buffer,
  db: Queryable,
  overrides: AttendanceImportOverride[]
): Promise<PlanResult> {
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

  const overrideByKey = new Map(
    overrides.map((o) => [overrideKey(o.fingerprintCode, o.eventTime), o] as const)
  )
  const matchedOverrideKeys = new Set<string>()
  let rejectedOverrideCount = 0

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
    const punches: PlannedPunch[] = classified.map((punch) => {
      const key = overrideKey(parsedEmployee.fingerprintCode, punch.eventTime)
      const override = overrideByKey.get(key)
      if (!override) return { ...punch, duplicate: false, overridden: false, original: null }
      matchedOverrideKeys.add(key)

      // The editor's own UI never offers anything this far away — this is a
      // backstop against a stale client or a direct API call, not a limit
      // real HR usage should ever brush up against.
      const calendarDate = toThailandDateString(new Date(punch.eventTime))
      if (Math.abs(daysBetween(calendarDate, override.workDate)) > REJECTED_OVERRIDE_MAX_DAYS) {
        rejectedOverrideCount++
        return { ...punch, duplicate: false, overridden: false, original: null }
      }

      return {
        ...punch,
        eventType: override.eventType,
        workDate: override.workDate,
        duplicate: false,
        overridden: true,
        original: { eventType: punch.eventType, workDate: punch.workDate },
      }
    })
    employees.push({
      fingerprintCode: parsedEmployee.fingerprintCode,
      nameInFile: parsedEmployee.nameInFile,
      match,
      punches,
    })
  }

  const warnings = [...sheet.warnings]
  if (rejectedOverrideCount > 0) {
    warnings.push(
      `การแก้ไข ${rejectedOverrideCount} รายการถูกข้าม เพราะย้ายวันที่ห่างจากวันที่ปั๊มจริงเกิน ${REJECTED_OVERRIDE_MAX_DAYS} วัน`
    )
  }
  const unmatchedOverrideCount = overrides.length - matchedOverrideKeys.size
  if (unmatchedOverrideCount > 0) {
    warnings.push(
      `การแก้ไข ${unmatchedOverrideCount} รายการที่ส่งมาไม่ตรงกับรายการในไฟล์นี้แล้ว — ` +
        'อาจเป็นเพราะเลือกไฟล์ใหม่ตั้งแต่แก้ไขครั้งล่าสุด จึงถูกข้ามไป'
    )
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

  // An override can move a punch's work-date further than the ±1 day the
  // classifier itself ever reaches for (see `dates` above) — that is the
  // whole point of the "เลือกวันที่อื่น" escape hatch in the editor. Widen the
  // recompute range to cover wherever HR actually sent a punch, not just
  // where the classifier would have looked on its own.
  let finalRecomputeFrom = recomputeFrom
  let finalRecomputeTo = recomputeTo
  let overriddenCount = 0
  for (const employee of employees) {
    for (const punch of employee.punches) {
      if (punch.overridden) overriddenCount++
      if (punch.workDate < finalRecomputeFrom) finalRecomputeFrom = punch.workDate
      if (punch.workDate > finalRecomputeTo) finalRecomputeTo = punch.workDate
    }
  }

  return {
    ok: true,
    plan: {
      rangeFrom: sheet.rangeFrom,
      rangeTo: sheet.rangeTo,
      generatedOn: sheet.generatedOn,
      recomputeFrom: finalRecomputeFrom,
      recomputeTo: finalRecomputeTo,
      employees,
      unmatchedCodes,
      warnings,
      overriddenCount,
    },
  }
}

/** The uploaded bytes, or an answer already sent. */
function uploadedFile(req: Request, res: Response): Buffer | null {
  if (!req.file || req.file.buffer.length === 0) {
    fail(res, 415, 'กรุณาแนบไฟล์ Excel (.xlsx) ของรายงานการลงเวลา')
    return null
  }
  return req.file.buffer
}

/** multer captures the part's own filename, so this no longer needs its own
 *  query parameter — call after uploadedFile has confirmed req.file exists. */
function uploadedFileName(req: Request): string {
  const name = (req.file?.originalname ?? '').trim()
  return (name === '' ? 'attendance.xlsx' : name).slice(0, 255)
}

const EVENT_TYPES: readonly AttendanceEventType[] = ['check_in', 'check_out']
const WORK_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isOverride(value: unknown): value is AttendanceImportOverride {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v['fingerprintCode'] === 'string' &&
    v['fingerprintCode'] !== '' &&
    typeof v['eventTime'] === 'string' &&
    !Number.isNaN(Date.parse(v['eventTime'])) &&
    typeof v['eventType'] === 'string' &&
    EVENT_TYPES.includes(v['eventType'] as AttendanceEventType) &&
    typeof v['workDate'] === 'string' &&
    WORK_DATE_RE.test(v['workDate'])
  )
}

/** The `overrides` form field, or an answer already sent. Absent or empty
 *  parses to an empty list — most imports have none. */
function uploadedOverrides(req: Request, res: Response): AttendanceImportOverride[] | null {
  const raw: unknown = req.body?.overrides
  if (raw === undefined || raw === '') return []
  if (typeof raw !== 'string') {
    fail(res, 400, 'ฟิลด์ overrides มีรูปแบบไม่ถูกต้อง')
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    fail(res, 400, 'พารามิเตอร์ overrides ไม่ใช่ JSON ที่ถูกต้อง')
    return null
  }
  if (!Array.isArray(parsed) || !parsed.every(isOverride)) {
    fail(res, 400, 'พารามิเตอร์ overrides มีรูปแบบไม่ถูกต้อง')
    return null
  }
  return parsed
}

function toEmployeePreview(employee: PlannedEmployee): AttendanceImportEmployeePreview {
  const punches: AttendanceImportPunchPreview[] = employee.punches.map((punch) => ({
    eventTime: punch.eventTime,
    eventType: punch.eventType,
    workDate: punch.workDate,
    matchedShift: punch.matchedShift,
    duplicate: punch.duplicate,
    overridden: punch.overridden,
    ...(punch.original ? { original: punch.original } : {}),
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
  uploadFile,
  async (req: Request, res: Response) => {
    const file = uploadedFile(req, res)
    if (file === null) return
    const overrides = uploadedOverrides(req, res)
    if (overrides === null) return

    try {
      const result = await buildImportPlan(file, pool, overrides)
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
          totalOverriddenCount: plan.overriddenCount,
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
  uploadFile,
  async (req: Request, res: Response) => {
    const actor = adminActor(req)
    if (!actor) return fail(res, 500, 'server misconfigured')

    const file = uploadedFile(req, res)
    if (file === null) return
    const overrides = uploadedOverrides(req, res)
    if (overrides === null) return

    const fileName = uploadedFileName(req)

    try {
      const outcome = await withTransaction(async (client) => {
        const result = await buildImportPlan(file, client, overrides)
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
          /** Set only for a punch HR explicitly overrode — see
           *  attendanceMatchingQueries.ts's module comment for why that earns
           *  it the matcher's trust and an auto-stamped shift_id doesn't. */
          confirmedWorkDate: string | null
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
              confirmedWorkDate: punch.overridden ? punch.workDate : null,
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
            manualOverrideCount: plan.overriddenCount,
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
            values.push(row.employeeId, row.eventType, row.eventTime, shiftId, batchId, row.confirmedWorkDate)
            tuples.push(
              `($${base + 1}, $${base + 2}, $${base + 3}, 'fingerprint_import', $${base + 4}, $${base + 5}, $${base + 6})`
            )
          }
          const { rowCount } = await client.query(
            `INSERT INTO attendance_events
               (employee_id, event_type, event_time, source, shift_id, import_batch_id, confirmed_work_date)
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
            manualOverrideCount: plan.overriddenCount,
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
          manualOverrideCount: outcome.plan.overriddenCount,
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
