import { Router } from 'express'
import type { Request, Response } from 'express'
import type ExcelJS from 'exceljs'
import { ROLES, type AuthUser } from '@hrm/shared'
import { pool } from '../db.js'
import { requireRole } from '../auth/middleware.js'
import { recordAudit } from '../audit.js'
import { fail, handleUnexpected } from '../http.js'
import { SELECT_EMPLOYEE, rowToEmployee, type EmployeeRow } from '../employeeQueries.js'
import { buildEmployeeWorkbook } from '../employeeExport.js'

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
