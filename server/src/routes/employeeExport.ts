import { Router } from 'express'
import type { Request, Response } from 'express'
import type ExcelJS from 'exceljs'
import { ROLES, type AuthUser } from '@hrm/shared'
import { pool } from '../db.js'
import { requireRole } from '../auth/middleware.js'
import { recordAudit } from '../audit.js'
import { fail, handleUnexpected } from '../http.js'
import { SELECT_EMPLOYEE, rowToEmployee, type EmployeeRow } from '../employeeQueries.js'
import { buildEmployeeWorkbook, buildTempWorkerEmployeeWorkbook } from '../employeeExport.js'

export const employeeExportRouter = Router()

// A read like the employee list itself — any HRM role may export it or grab
// a blank template, same as GET /employees.
const canRead = requireRole(...ROLES)

const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

function actorOf(req: Request): AuthUser | null {
  return req.auth ?? null
}

function sendWorkbook(res: Response, buffer: ExcelJS.Buffer, filename: string): void {
  res.setHeader('Content-Type', XLSX_CONTENT_TYPE)
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
  )
  res.send(Buffer.from(buffer))
}

// Logged separately from the blank template below (employee.export vs
// employee.export_template) since the two mean very different things for
// data handling: this one hands out every employee's personal data, the
// other hands out an empty sheet and a list of department/job/shift names.
employeeExportRouter.get('/employees/export', canRead, async (req: Request, res: Response) => {
  const actor = actorOf(req)
  if (!actor) return fail(res, 500, 'server misconfigured')

  try {
    const { rows } = await pool.query<EmployeeRow>(`${SELECT_EMPLOYEE} ORDER BY e.employee_code`)
    const employees = rows.map(rowToEmployee)
    const buffer = await buildEmployeeWorkbook(employees)

    await recordAudit(pool, {
      actor,
      action: 'employee.export',
      entityId: null,
      detail: { employeeCount: employees.length },
    })

    const today = new Date().toISOString().slice(0, 10)
    sendWorkbook(res, buffer, `employees-${today}.xlsx`)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

// Same idea as /employees/export above, but only employment_type =
// 'ชั่วคราว' rows, written into the temp-worker template's columns — the
// export counterpart to the TEMP-EMP-IMP import template, for HR to review/
// re-import the temporary-daily-worker roster on its own.
employeeExportRouter.get(
  '/employees/export-temp-worker',
  canRead,
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor) return fail(res, 500, 'server misconfigured')

    try {
      const { rows } = await pool.query<EmployeeRow>(
        `${SELECT_EMPLOYEE} WHERE d.employment_type = $1 ORDER BY e.employee_code`,
        ['ชั่วคราว']
      )
      const employees = rows.map(rowToEmployee)
      const buffer = await buildTempWorkerEmployeeWorkbook(employees)

      await recordAudit(pool, {
        actor,
        action: 'employee.export',
        entityId: null,
        detail: { employeeCount: employees.length, templateCode: 'TEMP-EMP-IMP' },
      })

      const today = new Date().toISOString().slice(0, 10)
      sendWorkbook(res, buffer, `employees-temp-worker-${today}.xlsx`)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

// A blank copy of the template, with a dropdown for department/job/shift/
// holiday group/payroll group/employment type built fresh from whatever is
// active right now — never the static file in server/templates directly,
// since that would go stale the moment master data changes.
employeeExportRouter.get(
  '/employees/export-template',
  canRead,
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor) return fail(res, 500, 'server misconfigured')

    try {
      const buffer = await buildEmployeeWorkbook([])

      await recordAudit(pool, {
        actor,
        action: 'employee.export_template',
        entityId: null,
      })

      sendWorkbook(res, buffer, 'employee-import-template.xlsx')
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

// A blank copy of the temp-worker template (fingerprint code, name,
// department, ค่าจ้าง — no employee code, no ID card, no shift) — see
// buildTempWorkerEmployeeWorkbook's own comment for why this is a
// separate route rather than a query param on the one above: the two
// templates map to entirely different columns/required fields on the way
// back in (see employeeImportParse.ts's per-template config).
employeeExportRouter.get(
  '/employees/export-template-temp-worker',
  canRead,
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor) return fail(res, 500, 'server misconfigured')

    try {
      const buffer = await buildTempWorkerEmployeeWorkbook()

      await recordAudit(pool, {
        actor,
        action: 'employee.export_template',
        entityId: null,
      })

      sendWorkbook(res, buffer, 'employee-temporary-import-template.xlsx')
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)
