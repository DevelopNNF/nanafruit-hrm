import { Router } from 'express'
import type { Request, Response } from 'express'
import type { AuthUser, EmploymentType } from '@hrm/shared'
import { pool } from '../db.js'
import { requireRole } from '../auth/middleware.js'
import { recordAudit } from '../audit.js'
import { fail, handleUnexpected } from '../http.js'
import { buildProductionTrackingFile, type ProductionTrackingExportRow } from '../productionTrackingExport.js'

export const productionTrackingExportRouter = Router()

// HRM.Payroll/HRM.Admin only — same scoping reason as
// employeeFinanceExport.ts: this hands out every active employee's wage.
const canRead = requireRole('HRM.Payroll', 'HRM.Admin')

const TXT_CONTENT_TYPE = 'text/plain; charset=utf-8'

function actorOf(req: Request): AuthUser | null {
  return req.auth ?? null
}

type ProductionTrackingRow = {
  employee_code: string
  first_name_th: string
  last_name_th: string
  employment_type: EmploymentType
  wage_amount: string | null
}

// Active employees only — Production Tracking has no use for anyone no
// longer working — with the wage in effect today, same LATERAL join
// employeeFinanceExport.ts's loadFinanceByEmployeeId uses for its own
// "current wage" column.
async function loadExportRows(): Promise<ProductionTrackingExportRow[]> {
  const { rows } = await pool.query<ProductionTrackingRow>(
    `SELECT e.employee_code, e.first_name_th, e.last_name_th, d.employment_type,
            current_wage.wage_amount
     FROM employees e
     JOIN employment_details d ON d.employee_id = e.id
     LEFT JOIN LATERAL (
       SELECT wage_amount FROM employee_wage_assignments ewa
       WHERE ewa.employee_id = e.id
         AND ewa.effective_from <= (now() AT TIME ZONE 'Asia/Bangkok')::date
         AND (ewa.effective_to IS NULL OR ewa.effective_to >= (now() AT TIME ZONE 'Asia/Bangkok')::date)
     ) current_wage ON true
     WHERE d.status = 'Active'
     ORDER BY e.employee_code`
  )

  return rows.map((row) => ({
    employeeCode: row.employee_code,
    firstNameTh: row.first_name_th,
    lastNameTh: row.last_name_th,
    employmentType: row.employment_type,
    wageAmount: row.wage_amount === null ? null : Number(row.wage_amount),
  }))
}

productionTrackingExportRouter.get(
  '/employees/export-production-tracking',
  canRead,
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor) return fail(res, 500, 'server misconfigured')

    try {
      const rows = await loadExportRows()
      const content = buildProductionTrackingFile(rows)

      await recordAudit(pool, {
        actor,
        action: 'employee.export_production_tracking',
        entityId: null,
        detail: { employeeCount: rows.length },
      })

      const today = new Date().toISOString().slice(0, 10)
      const filename = `production-tracking-${today}.txt`
      res.setHeader('Content-Type', TXT_CONTENT_TYPE)
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
      )
      res.send(content)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)
