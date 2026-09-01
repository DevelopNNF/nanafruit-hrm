// Bulk updating employee_finance (and, where ค่าจ้าง/ประเภทค่าจ้าง are set,
// employee_wage_assignments) from an uploaded copy of
// server/templates/employee-finance-template.xlsx. Same two-endpoint shape as
// employeeImport.ts: POST .../preview builds a plan and answers with it, POST
// .../import builds the same plan and writes it, re-parsing the uploaded file
// rather than trusting the preview's rows echoed back by the browser. Also
// the same "build the plan inside the commit's own transaction" choice as
// employeeImport.ts, for the same reason — the employee/current-wage snapshot
// the plan resolved against has to be the one the writes land against.
//
// HRM.Payroll/HRM.Admin only — narrower than the finance tab's own PATCH
// endpoint (HRM.HR/HRM.Admin), since a bulk change to everyone's bank/tax/
// social-security settings is scoped to Payroll specifically. See
// EmployeeFinanceImportRowAction's own comment in shared/src/index.ts for why
// there is no 'create' action here.

import express, { Router } from 'express'
import type { Request, Response } from 'express'
import type pg from 'pg'
import {
  type AuthUser,
  type EmployeeFinanceImportPreview,
  type EmployeeFinanceImportResponse,
  type EmployeeFinanceImportRowAction,
  type EmployeeFinanceImportRowPreview,
} from '@hrm/shared'
import { pool, withTransaction } from '../db.js'
import { requireRole } from '../auth/middleware.js'
import { recordAudit } from '../audit.js'
import { fail, handleUnexpected } from '../http.js'
import {
  parseEmployeeFinanceImport,
  type ParsedFinanceImportRow,
} from '../employeeFinanceImportParse.js'
import {
  findEmployeesForFinanceImport,
  type EmployeeFinanceImportMatch,
} from '../employeeFinanceImportQueries.js'
import { createWageChange } from '../wageAssignmentQueries.js'
import { toThailandDateString } from '../shiftAssignmentQueries.js'
import type { EmployeeFinanceRow } from '../employeeFinanceQueries.js'

export const employeeFinanceImportRouter = Router()

type Queryable = Pick<pg.Pool, 'query'>

const canImport = requireRole('HRM.Payroll', 'HRM.Admin')

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
/** Same reasoning as employeeImport.ts's own ceiling — this sheet is at most
 *  a few hundred rows, so 5 MB is a ceiling on nonsense, not a working limit. */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024

const uploadBody = express.raw({
  type: [XLSX_MIME, 'application/vnd.ms-excel', 'application/octet-stream'],
  limit: MAX_UPLOAD_BYTES,
})

function adminActor(req: Request): Extract<AuthUser, { kind: 'admin' }> | null {
  const auth = req.auth
  return auth && auth.kind === 'admin' ? auth : null
}

type PlannedRow = {
  rowNumber: number
  action: EmployeeFinanceImportRowAction
  employeeCode: string | null
  employeeId: number | null
  name: string | null
  reasons: string[]
  /** Present only for 'update' rows. */
  parsed: ParsedFinanceImportRow | null
  match: EmployeeFinanceImportMatch | null
  wageChangeNeeded: boolean
}

type ImportPlan = { rows: PlannedRow[] }
type PlanResult = { ok: true; plan: ImportPlan } | { ok: false; status: number; message: string }

function countBy(rows: ParsedFinanceImportRow[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const row of rows) {
    if (row.employeeCode === null) continue
    counts.set(row.employeeCode, (counts.get(row.employeeCode) ?? 0) + 1)
  }
  return counts
}

/**
 * Everything the import decides, without writing any of it. Runs against
 * whatever `db` is given: the pool for a preview, the transaction's own
 * client for the commit step.
 */
async function buildFinanceImportPlan(file: Buffer, db: Queryable): Promise<PlanResult> {
  const parsed = await parseEmployeeFinanceImport(file)
  if (!parsed.ok) return { ok: false, status: 400, message: parsed.message }
  const { rows } = parsed

  const codes = [...new Set(rows.map((r) => r.employeeCode).filter((v): v is string => v !== null))]
  const matches = await findEmployeesForFinanceImport(codes, db)
  const codeCounts = countBy(rows)

  const planned: PlannedRow[] = rows.map((row) => {
    const reasons = [...row.errors]

    // A code repeated in the file would try to write employee_finance twice
    // and record two wage changes for the same employee in one transaction —
    // the second wage change would then read as a same-day 'overlap' against
    // the first. Caught here, before the database even enters the picture,
    // same as employeeImport.ts's in-file duplicate checks.
    if (row.employeeCode !== null && (codeCounts.get(row.employeeCode) ?? 0) > 1) {
      reasons.push('รหัสพนักงานซ้ำกันในไฟล์นี้')
    }

    if (reasons.length > 0) {
      return {
        rowNumber: row.rowNumber,
        action: 'skip',
        employeeCode: row.employeeCode,
        employeeId: null,
        name: row.displayName,
        reasons,
        parsed: null,
        match: null,
        wageChangeNeeded: false,
      }
    }

    // row.employeeCode is non-null here: a blank รหัสพนักงาน already produced
    // an 'ไม่ระบุรหัสพนักงาน' error in row.errors, which the branch above
    // already returned on.
    const match = matches.get(row.employeeCode as string)
    if (match === undefined) {
      return {
        rowNumber: row.rowNumber,
        action: 'not_found',
        employeeCode: row.employeeCode,
        employeeId: null,
        name: row.displayName,
        reasons: [`ไม่พบพนักงานรหัส "${row.employeeCode}" ในระบบ`],
        parsed: null,
        match: null,
        wageChangeNeeded: false,
      }
    }

    const wageChangeNeeded = row.wageAmount !== null && row.wageAmount !== match.currentWageAmount
    if (wageChangeNeeded) {
      const today = toThailandDateString(new Date())
      reasons.push(`จะปรับค่าจ้างเป็น ${row.wageAmount} บาท มีผลตั้งแต่วันนี้ (${today})`)
    }
    if (match.finance === null) {
      reasons.push('ยังไม่มีข้อมูลการเงินอยู่ก่อน จะบันทึกเป็นครั้งแรก')
    }

    return {
      rowNumber: row.rowNumber,
      action: 'update',
      employeeCode: row.employeeCode,
      employeeId: match.employeeId,
      name: match.employeeName,
      reasons,
      parsed: row,
      match,
      wageChangeNeeded,
    }
  })

  return { ok: true, plan: { rows: planned } }
}

async function applyFinanceImportRow(
  client: pg.PoolClient,
  actor: Extract<AuthUser, { kind: 'admin' }>,
  row: PlannedRow
): Promise<void> {
  const r = row.parsed
  if (!r || row.employeeId === null) {
    throw new Error('applyFinanceImportRow called on a row with no resolved data')
  }

  // Upsert, same shape and same reasoning as PATCH /employees/:id/finance's
  // own upsert: employee_finance may not have a row for this employee yet.
  // Every field the sheet carries is a plain overwrite, including the
  // optional ones (bankBranchCode/taxStartMonth) — the sheet is a full
  // settings form, same as that PATCH body, so a blank cell there means
  // "clear this field", not "leave it alone".
  await client.query<EmployeeFinanceRow>(
    `INSERT INTO employee_finance
       (employee_id, payment_method, bank_branch_code,
        bank_account_number, social_security_type, social_security_fixed_amount,
        tax_type, tax_fixed_amount, tax_percent, tax_start_month)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (employee_id) DO UPDATE SET
       payment_method = EXCLUDED.payment_method,
       bank_branch_code = EXCLUDED.bank_branch_code,
       bank_account_number = EXCLUDED.bank_account_number,
       social_security_type = EXCLUDED.social_security_type,
       social_security_fixed_amount = EXCLUDED.social_security_fixed_amount,
       tax_type = EXCLUDED.tax_type,
       tax_fixed_amount = EXCLUDED.tax_fixed_amount,
       tax_percent = EXCLUDED.tax_percent,
       tax_start_month = EXCLUDED.tax_start_month,
       updated_at = now()`,
    [
      row.employeeId,
      r.paymentMethod,
      r.bankBranchCode,
      r.bankAccountNumber ?? '',
      r.socialSecurityType,
      r.socialSecurityFixedAmount,
      r.taxType,
      r.taxFixedAmount,
      r.taxPercent,
      r.taxStartMonth,
    ]
  )

  // Only when ประเภทค่าจ้าง/ค่าจ้าง are both set and actually differ from the
  // employee's current wage — same diff-before-writing restraint as
  // employeeImport.ts's temp-worker wage handling, so re-importing an
  // unchanged file doesn't create a no-op wage-history entry every time.
  // 'overlap' (someone already recorded a wage change today through the
  // Finance tab) is left alone, same tolerance employeeImport.ts extends to
  // its own shift/wage changes.
  if (row.wageChangeNeeded && r.wageAmount !== null && r.wageType !== null) {
    const today = toThailandDateString(new Date())
    await createWageChange(client, {
      employeeId: row.employeeId,
      wageType: r.wageType,
      wageAmount: r.wageAmount,
      effectiveFrom: today,
      note: 'ปรับค่าจ้างจากการนำเข้าไฟล์ Excel (ข้อมูลการเงินพนักงาน)',
      createdByKind: actor.kind,
      createdById: actor.oid,
    })
  }

  await recordAudit(client, {
    actor,
    action: 'employee_finance.import_update',
    entityId: row.employeeId,
    detail: { employeeCode: row.employeeCode, wageChangeNeeded: row.wageChangeNeeded },
  })
}

function uploadedFile(req: Request, res: Response): Buffer | null {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    fail(res, 415, 'กรุณาแนบไฟล์ Excel (.xlsx) ของข้อมูลการเงินพนักงาน')
    return null
  }
  return req.body
}

function uploadedFileName(req: Request): string {
  const raw = req.query['fileName']
  const name = typeof raw === 'string' ? raw.trim() : ''
  return (name === '' ? 'employee-finance.xlsx' : name).slice(0, 255)
}

function toRowPreview(row: PlannedRow): EmployeeFinanceImportRowPreview {
  return {
    rowNumber: row.rowNumber,
    action: row.action,
    employeeCode: row.employeeCode,
    employeeId: row.employeeId,
    name: row.name,
    reasons: row.reasons,
  }
}

function countAction(rows: PlannedRow[], action: EmployeeFinanceImportRowAction): number {
  return rows.filter((row) => row.action === action).length
}

employeeFinanceImportRouter.post(
  '/employee-finance/import/preview',
  canImport,
  uploadBody,
  async (req: Request, res: Response) => {
    const file = uploadedFile(req, res)
    if (file === null) return

    try {
      const result = await buildFinanceImportPlan(file, pool)
      if (!result.ok) return fail(res, result.status, result.message)
      const { rows } = result.plan

      const preview: EmployeeFinanceImportPreview = {
        fileName: uploadedFileName(req),
        rows: rows.map(toRowPreview),
        updateCount: countAction(rows, 'update'),
        notFoundCount: countAction(rows, 'not_found'),
        skipCount: countAction(rows, 'skip'),
      }
      res.json({ preview })
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

employeeFinanceImportRouter.post(
  '/employee-finance/import',
  canImport,
  uploadBody,
  async (req: Request, res: Response) => {
    const actor = adminActor(req)
    if (!actor) return fail(res, 500, 'server misconfigured')

    const file = uploadedFile(req, res)
    if (file === null) return

    try {
      const outcome = await withTransaction(async (client) => {
        const result = await buildFinanceImportPlan(file, client)
        if (!result.ok) return result

        for (const row of result.plan.rows) {
          if (row.action === 'update') await applyFinanceImportRow(client, actor, row)
        }

        return {
          ok: true as const,
          updatedCount: countAction(result.plan.rows, 'update'),
          notFoundCount: countAction(result.plan.rows, 'not_found'),
          skippedCount: countAction(result.plan.rows, 'skip'),
        }
      })

      if (!outcome.ok) return fail(res, outcome.status, outcome.message)

      const body: EmployeeFinanceImportResponse = {
        result: {
          updatedCount: outcome.updatedCount,
          notFoundCount: outcome.notFoundCount,
          skippedCount: outcome.skippedCount,
        },
      }
      res.status(201).json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)
