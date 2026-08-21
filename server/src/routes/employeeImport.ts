// Bulk creating/updating employees from an uploaded copy of
// server/templates/employee-template.xlsx.
//
// Same two-endpoint shape as attendanceImport.ts: POST .../preview builds a
// plan and answers with it, POST .../import builds the same plan and writes
// it, re-parsing the uploaded file rather than trusting the preview's rows
// echoed back by the browser. Unlike attendance, the plan-building step here
// runs *inside* the commit's own transaction (both preview and commit pass
// their own `db` through, but commit's is the transaction client) so the
// master-data snapshot the plan resolved against is the same one the writes
// land against — no separate race window beyond a genuinely concurrent write
// from another request, which a unique-constraint failure and a rolled-back
// transaction is an acceptable answer to for a bulk HR upload.
//
// A row's fate is one of four things, decided entirely during planning and
// never revisited while writing: 'create' (code not seen before), 'update'
// (code belongs to someone still employed), 'blocked' (code belongs to
// someone who has already left — see endWorkingDate below), or 'skip' (the
// row itself has a problem: a blank required cell, a value that doesn't
// parse, a name that doesn't resolve against master data, or a duplicate
// within the file or against another employee). Only create/update rows get
// written; skip/blocked rows are reported, not silently dropped.

import express, { Router } from 'express'
import type { Request, Response } from 'express'
import type pg from 'pg'
import {
  ROLES,
  type AuthUser,
  type EmployeeImportPreview,
  type EmployeeImportResponse,
  type EmployeeImportRowAction,
  type EmployeeImportRowPreview,
  type EmploymentType,
  type Gender,
  type Title,
  type WorkLocation,
} from '@hrm/shared'
import { pool, withTransaction } from '../db.js'
import { requireRole } from '../auth/middleware.js'
import { recordAudit } from '../audit.js'
import { fail, handleUnexpected } from '../http.js'
import { parseEmployeeImport, type ParsedImportRow } from '../employeeImportParse.js'
import {
  findEmployeeCodesByFingerprintCodes,
  findEmployeeCodesByIdCardNumbers,
  findEmployeesByCodes,
  loadEmployeeImportMasterData,
  nameById,
  resolveByName,
  type NamedMasterRow,
} from '../employeeMasterDataQueries.js'
import { createShiftChange, toThailandDateString } from '../shiftAssignmentQueries.js'

export const employeeImportRouter = Router()

type Queryable = Pick<pg.Pool, 'query'>

// Import is a write, and a bulk one — HR and Admin only, matching every other
// write in this API.
const canImport = requireRole('HRM.HR', 'HRM.Admin')

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
/** A staff sheet is at most a few hundred rows — 5 MB is a ceiling on
 *  nonsense, not a working limit, same reasoning as attendanceImport.ts's
 *  10 MB (this file has no punch data to bulk up the row count). */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024

/** Some browsers send a generic type for a file picked off disk, so the
 *  parser — not the Content-Type — decides whether this is really a
 *  workbook. */
const uploadBody = express.raw({
  type: [XLSX_MIME, 'application/vnd.ms-excel', 'application/octet-stream'],
  limit: MAX_UPLOAD_BYTES,
})

function adminActor(req: Request): Extract<AuthUser, { kind: 'admin' }> | null {
  const auth = req.auth
  return auth && auth.kind === 'admin' ? auth : null
}

/** Resolved, ready-to-write fields for a create/update row — present only
 *  when every required field parsed and every name resolved. */
type ResolvedRow = {
  employeeCode: string
  fingerprintCode: string | null
  title: Title
  firstNameTh: string
  lastNameTh: string
  nickname: string | null
  idCardNumber: string
  gender: Gender | null
  hireDate: string
  startWorkingDate: string
  workLocation: WorkLocation
  employmentType: EmploymentType
  departmentId: number
  jobId: number
  shiftId: number
  holidayGroupId: number | null
  payrollGroupId: number | null
}

type PlannedRow = {
  rowNumber: number
  action: EmployeeImportRowAction
  employeeCode: string | null
  employeeId: number | null
  name: string | null
  reasons: string[]
  resolved: ResolvedRow | null
  shiftChangeNeeded: boolean
}

type ImportPlan = { rows: PlannedRow[] }
type PlanResult = { ok: true; plan: ImportPlan } | { ok: false; status: number; message: string }

function fullName(row: ParsedImportRow): string | null {
  if (row.firstNameTh === null && row.lastNameTh === null) return null
  return `${row.title ?? ''}${row.firstNameTh ?? ''} ${row.lastNameTh ?? ''}`.trim()
}

function countBy(rows: ParsedImportRow[], key: (row: ParsedImportRow) => string | null): Map<string, number> {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const value = key(row)
    if (value === null) continue
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return counts
}

/** `name` against a list already known to hold only active rows. Null
 *  (column blank) resolves to null without complaint — a required column
 *  left blank already carries its own "ไม่ระบุ..." error from
 *  employeeImportParse.ts, and a blank optional column (holiday group)
 *  legitimately means "none". */
function resolveMasterName(
  rows: NamedMasterRow[],
  name: string | null,
  label: string,
  reasons: string[]
): number | null {
  if (name === null) return null
  const result = resolveByName(rows, name)
  if (result.kind === 'unique') return result.id
  if (result.kind === 'ambiguous') {
    reasons.push(`ชื่อ${label} "${name}" ซ้ำกันในระบบ ระบุไม่ได้ว่าหมายถึงรายการใด`)
  } else {
    reasons.push(`ไม่พบ${label} "${name}" ในระบบ (หรือถูกปิดใช้งานแล้ว)`)
  }
  return null
}

/**
 * Everything the import decides, without writing any of it. Runs against
 * whatever `db` is given: the pool for a preview, the transaction's own
 * client for the commit step.
 */
async function buildImportPlan(file: Buffer, db: Queryable): Promise<PlanResult> {
  const parsed = await parseEmployeeImport(file)
  if (!parsed.ok) return { ok: false, status: 400, message: parsed.message }
  const { rows } = parsed.value

  const masterData = await loadEmployeeImportMasterData(db)

  const codes = [...new Set(rows.map((r) => r.employeeCode).filter((v): v is string => v !== null))]
  const existingByCode = await findEmployeesByCodes(codes, db)

  const idCardNumbers = [
    ...new Set(rows.map((r) => r.idCardNumber).filter((v): v is string => v !== null)),
  ]
  const fingerprintCodes = [
    ...new Set(rows.map((r) => r.fingerprintCode).filter((v): v is string => v !== null)),
  ]
  const idCardOwners = await findEmployeeCodesByIdCardNumbers(idCardNumbers, db)
  const fingerprintOwners = await findEmployeeCodesByFingerprintCodes(fingerprintCodes, db)

  // In-file duplicates: a value on more than one row is a conflict before
  // the database even enters the picture — two rows cannot both become "the"
  // employee with that code/id card/fingerprint.
  const codeCounts = countBy(rows, (r) => r.employeeCode)
  const idCardCounts = countBy(rows, (r) => r.idCardNumber)
  const fingerprintCounts = countBy(rows, (r) => r.fingerprintCode)

  const today = toThailandDateString(new Date())

  const planned: PlannedRow[] = rows.map((row) => {
    const reasons = [...row.errors]
    const name = fullName(row)
    const existing = row.employeeCode !== null ? existingByCode.get(row.employeeCode) : undefined

    if (row.employeeCode !== null && (codeCounts.get(row.employeeCode) ?? 0) > 1) {
      reasons.push('รหัสพนักงานซ้ำกันในไฟล์นี้')
    }
    if (row.idCardNumber !== null && (idCardCounts.get(row.idCardNumber) ?? 0) > 1) {
      reasons.push('เลขบัตรประชาชนซ้ำกันในไฟล์นี้')
    }
    if (row.fingerprintCode !== null && (fingerprintCounts.get(row.fingerprintCode) ?? 0) > 1) {
      reasons.push('รหัสลายนิ้วมือซ้ำกันในไฟล์นี้')
    }
    if (row.idCardNumber !== null) {
      const owner = idCardOwners.get(row.idCardNumber)
      if (owner !== undefined && owner !== row.employeeCode) {
        reasons.push(`เลขบัตรประชาชนนี้ถูกใช้กับพนักงานรหัส ${owner} อยู่แล้ว`)
      }
    }
    if (row.fingerprintCode !== null) {
      const owner = fingerprintOwners.get(row.fingerprintCode)
      if (owner !== undefined && owner !== row.employeeCode) {
        reasons.push(`รหัสลายนิ้วมือนี้ถูกใช้กับพนักงานรหัส ${owner} อยู่แล้ว`)
      }
    }

    const departmentId = resolveMasterName(masterData.departments, row.departmentName, 'แผนก', reasons)
    const jobId = resolveMasterName(masterData.jobs, row.jobTitle, 'ตำแหน่ง', reasons)
    const shiftId = resolveMasterName(masterData.shifts, row.shiftName, 'กะงาน', reasons)
    const holidayGroupId = resolveMasterName(
      masterData.holidayGroups,
      row.holidayGroupName,
      'กลุ่มวันหยุด',
      reasons
    )
    const payrollGroupId = resolveMasterName(
      masterData.payrollGroups,
      row.payrollGroupName,
      'กลุ่มเงินเดือน',
      reasons
    )

    if (reasons.length > 0) {
      return {
        rowNumber: row.rowNumber,
        action: 'skip',
        employeeCode: row.employeeCode,
        employeeId: existing?.employeeId ?? null,
        name,
        reasons,
        resolved: null,
        shiftChangeNeeded: false,
      }
    }

    // Every required field parsed clean and every name resolved (reasons is
    // empty), so every field below is genuinely non-null — this check is
    // defensive bookkeeping, not something a valid file can trigger.
    if (
      row.employeeCode === null ||
      row.title === null ||
      row.firstNameTh === null ||
      row.lastNameTh === null ||
      row.idCardNumber === null ||
      row.hireDate === null ||
      row.startWorkingDate === null ||
      row.workLocation === null ||
      row.employmentType === null ||
      departmentId === null ||
      jobId === null ||
      shiftId === null ||
      payrollGroupId === null
    ) {
      return {
        rowNumber: row.rowNumber,
        action: 'skip',
        employeeCode: row.employeeCode,
        employeeId: existing?.employeeId ?? null,
        name,
        reasons: ['ข้อมูลแถวนี้ไม่ครบถ้วน'],
        resolved: null,
        shiftChangeNeeded: false,
      }
    }

    const resolved: ResolvedRow = {
      employeeCode: row.employeeCode,
      fingerprintCode: row.fingerprintCode,
      title: row.title,
      firstNameTh: row.firstNameTh,
      lastNameTh: row.lastNameTh,
      nickname: row.nickname,
      idCardNumber: row.idCardNumber,
      gender: row.gender,
      hireDate: row.hireDate,
      startWorkingDate: row.startWorkingDate,
      workLocation: row.workLocation,
      employmentType: row.employmentType,
      departmentId,
      jobId,
      shiftId,
      holidayGroupId,
      payrollGroupId,
    }

    if (existing === undefined) {
      return {
        rowNumber: row.rowNumber,
        action: 'create',
        employeeCode: row.employeeCode,
        employeeId: null,
        name,
        reasons,
        resolved,
        shiftChangeNeeded: false,
      }
    }

    // The leaver rule: a code already used by someone with an end-working
    // date on file is blocked, independent of their `status` — see the
    // conversation this came out of for why endWorkingDate and not status.
    if (existing.endWorkingDate !== null) {
      reasons.push(
        `รหัสพนักงานนี้ซ้ำกับพนักงานที่ลาออกไปแล้ว (${existing.employeeName}, สิ้นสุดงานวันที่ ${existing.endWorkingDate})`
      )
      return {
        rowNumber: row.rowNumber,
        action: 'blocked',
        employeeCode: row.employeeCode,
        employeeId: existing.employeeId,
        name,
        reasons,
        resolved: null,
        shiftChangeNeeded: false,
      }
    }

    const shiftChangeNeeded = existing.currentShiftId !== resolved.shiftId
    if (shiftChangeNeeded) {
      const fromName = nameById(masterData.shifts, existing.currentShiftId) ?? 'ไม่มีกะ'
      const toName = row.shiftName ?? ''
      reasons.push(`จะเปลี่ยนกะจาก "${fromName}" เป็น "${toName}" มีผลตั้งแต่วันนี้ (${today})`)
    }

    return {
      rowNumber: row.rowNumber,
      action: 'update',
      employeeCode: row.employeeCode,
      employeeId: existing.employeeId,
      name,
      reasons,
      resolved,
      shiftChangeNeeded,
    }
  })

  return { ok: true, plan: { rows: planned } }
}

async function createEmployeeFromImport(
  client: pg.PoolClient,
  actor: Extract<AuthUser, { kind: 'admin' }>,
  row: PlannedRow
): Promise<void> {
  const r = row.resolved
  if (!r) throw new Error('createEmployeeFromImport called on a row with no resolved data')

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO employees (employee_code, id_card_number, fingerprint_code, title, first_name_th, last_name_th, nickname, gender)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [r.employeeCode, r.idCardNumber, r.fingerprintCode, r.title, r.firstNameTh, r.lastNameTh, r.nickname, r.gender]
  )
  const created = rows[0]
  if (!created) throw new Error('insert into employees returned no id')
  const employeeId = Number(created.id)

  // status is always Active and endWorkingDate/terminationReason/
  // overtimeGroupId stay null — a freshly imported employee is, by
  // definition, someone about to start, not someone already leaving.
  await client.query(
    `INSERT INTO employment_details
       (employee_id, status, hire_date, start_working_date, employment_type, work_location,
        job_id, department_id, shift_id, holiday_group_id, payroll_group_id)
     VALUES ($1, 'Active', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      employeeId,
      r.hireDate,
      r.startWorkingDate,
      r.employmentType,
      r.workLocation,
      r.jobId,
      r.departmentId,
      r.shiftId,
      r.holidayGroupId,
      r.payrollGroupId,
    ]
  )

  // The employee's first shift assignment, effective from their hire date —
  // same as POST /employees does for a shift chosen at creation.
  await client.query(
    `INSERT INTO employee_shift_assignments (employee_id, shift_id, effective_from, created_by_kind, created_by_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [employeeId, r.shiftId, r.hireDate, actor.kind, actor.oid]
  )

  await recordAudit(client, {
    actor,
    action: 'employee.import_create',
    entityId: employeeId,
    detail: { employeeCode: r.employeeCode },
  })
}

async function updateEmployeeFromImport(
  client: pg.PoolClient,
  actor: Extract<AuthUser, { kind: 'admin' }>,
  row: PlannedRow
): Promise<void> {
  const r = row.resolved
  if (!r || row.employeeId === null) {
    throw new Error('updateEmployeeFromImport called on a row with no resolved data or employeeId')
  }

  await client.query(
    `UPDATE employees SET
       id_card_number = $2, fingerprint_code = $3, title = $4,
       first_name_th = $5, last_name_th = $6, nickname = $7, gender = $8, updated_at = now()
     WHERE id = $1`,
    [row.employeeId, r.idCardNumber, r.fingerprintCode, r.title, r.firstNameTh, r.lastNameTh, r.nickname, r.gender]
  )

  // status/end_working_date/termination_reason/overtime_group_id are
  // deliberately absent — import only ever touches the fields the sheet
  // carries, leaving offboarding and the OT rate schedule to their own
  // screens.
  await client.query(
    `UPDATE employment_details SET
       hire_date = $2, start_working_date = $3, employment_type = $4, work_location = $5,
       job_id = $6, department_id = $7, holiday_group_id = $8, payroll_group_id = $9, updated_at = now()
     WHERE employee_id = $1`,
    [
      row.employeeId,
      r.hireDate,
      r.startWorkingDate,
      r.employmentType,
      r.workLocation,
      r.jobId,
      r.departmentId,
      r.holidayGroupId,
      r.payrollGroupId,
    ]
  )

  if (row.shiftChangeNeeded) {
    const today = toThailandDateString(new Date())
    // 'overlap' — a future-dated shift change already queued for today — is
    // left alone rather than failing the row: the rest of the update still
    // lands, and the shift simply stays whatever it already was. No
    // 'no_baseline' case here: that only fires for a temporary swap
    // (effectiveTo set), and this is always a permanent change.
    await createShiftChange(client, {
      employeeId: row.employeeId,
      shiftId: r.shiftId,
      effectiveFrom: today,
      effectiveTo: null,
      note: 'เปลี่ยนกะจากการนำเข้าไฟล์ Excel',
      createdByKind: actor.kind,
      createdById: actor.oid,
    })
  }

  await recordAudit(client, {
    actor,
    action: 'employee.import_update',
    entityId: row.employeeId,
    detail: { employeeCode: r.employeeCode, shiftChangeNeeded: row.shiftChangeNeeded },
  })
}

function uploadedFile(req: Request, res: Response): Buffer | null {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    fail(res, 415, 'กรุณาแนบไฟล์ Excel (.xlsx) ของข้อมูลพนักงาน')
    return null
  }
  return req.body
}

function uploadedFileName(req: Request): string {
  const raw = req.query['fileName']
  const name = typeof raw === 'string' ? raw.trim() : ''
  return (name === '' ? 'employees.xlsx' : name).slice(0, 255)
}

function toRowPreview(row: PlannedRow): EmployeeImportRowPreview {
  return {
    rowNumber: row.rowNumber,
    action: row.action,
    employeeCode: row.employeeCode,
    employeeId: row.employeeId,
    name: row.name,
    reasons: row.reasons,
  }
}

function countAction(rows: PlannedRow[], action: EmployeeImportRowAction): number {
  return rows.filter((row) => row.action === action).length
}

employeeImportRouter.post(
  '/employees/import/preview',
  canImport,
  uploadBody,
  async (req: Request, res: Response) => {
    const file = uploadedFile(req, res)
    if (file === null) return

    try {
      const result = await buildImportPlan(file, pool)
      if (!result.ok) return fail(res, result.status, result.message)
      const { rows } = result.plan

      const preview: EmployeeImportPreview = {
        fileName: uploadedFileName(req),
        rows: rows.map(toRowPreview),
        createCount: countAction(rows, 'create'),
        updateCount: countAction(rows, 'update'),
        blockedCount: countAction(rows, 'blocked'),
        skipCount: countAction(rows, 'skip'),
      }
      res.json({ preview })
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

employeeImportRouter.post(
  '/employees/import',
  canImport,
  uploadBody,
  async (req: Request, res: Response) => {
    const actor = adminActor(req)
    if (!actor) return fail(res, 500, 'server misconfigured')

    const file = uploadedFile(req, res)
    if (file === null) return

    try {
      const outcome = await withTransaction(async (client) => {
        const result = await buildImportPlan(file, client)
        if (!result.ok) return result

        for (const row of result.plan.rows) {
          if (row.action === 'create') await createEmployeeFromImport(client, actor, row)
          else if (row.action === 'update') await updateEmployeeFromImport(client, actor, row)
        }

        return {
          ok: true as const,
          createdCount: countAction(result.plan.rows, 'create'),
          updatedCount: countAction(result.plan.rows, 'update'),
          blockedCount: countAction(result.plan.rows, 'blocked'),
          skippedCount: countAction(result.plan.rows, 'skip'),
        }
      })

      if (!outcome.ok) return fail(res, outcome.status, outcome.message)

      const body: EmployeeImportResponse = {
        result: {
          createdCount: outcome.createdCount,
          updatedCount: outcome.updatedCount,
          blockedCount: outcome.blockedCount,
          skippedCount: outcome.skippedCount,
        },
      }
      res.status(201).json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)
