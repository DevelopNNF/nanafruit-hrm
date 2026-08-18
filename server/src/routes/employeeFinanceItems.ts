import { Router } from 'express'
import type { Request, Response } from 'express'
import type {
  AuthUser,
  EmployeeFinanceItemInput,
  EmployeeFinanceItemListResponse,
  EmployeeFinanceItemResponse,
} from '@hrm/shared'
import { withTransaction } from '../db.js'
import { requireRole } from '../auth/middleware.js'
import { recordAudit } from '../audit.js'
import { fail, handleUnexpected } from '../http.js'
import {
  findEmployeeFinanceItem,
  listEmployeeFinanceItems,
} from '../employeeFinanceItemQueries.js'

export const employeeFinanceItemsRouter = Router()

// HR and Admin only, for both reads and writes — the same rule
// routes/employees.ts applies to /employees/:id/finance, and for the same
// reason: these are salary figures, not a scheduling detail every HRM role
// needs. A Viewer never sees this tab at all (see EmployeeFormPage).
const canReadWriteFinance = requireRole('HRM.HR', 'HRM.Admin')

function actorOf(req: Request): AuthUser | null {
  return req.auth ?? null
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string }

function requiredString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** Rejects both bad formats and real-looking-but-impossible dates like 2024-02-31. */
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number) as [number, number, number]
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  )
}

function parseEmployeeFinanceItemInput(body: unknown): ParseResult<EmployeeFinanceItemInput> {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'body must be a JSON object' }
  }
  const raw = body as Record<string, unknown>

  const financeItemIdRaw = raw['financeItemId']
  if (
    typeof financeItemIdRaw !== 'number' ||
    !Number.isInteger(financeItemIdRaw) ||
    financeItemIdRaw <= 0
  ) {
    return { ok: false, message: 'financeItemId must be a positive integer' }
  }

  const amountRaw = raw['amount']
  if (typeof amountRaw !== 'number' || !Number.isFinite(amountRaw) || amountRaw <= 0) {
    return { ok: false, message: 'amount must be a positive number' }
  }

  const effectiveFrom = requiredString(raw, 'effectiveFrom')
  if (effectiveFrom === null || !isCalendarDate(effectiveFrom)) {
    return { ok: false, message: 'effectiveFrom must be a date as YYYY-MM-DD' }
  }

  const effectiveToRaw = raw['effectiveTo']
  let effectiveTo: string | null = null
  if (effectiveToRaw !== undefined && effectiveToRaw !== null) {
    if (typeof effectiveToRaw !== 'string' || !isCalendarDate(effectiveToRaw)) {
      return { ok: false, message: 'effectiveTo must be a date as YYYY-MM-DD, or null' }
    }
    effectiveTo = effectiveToRaw
  }
  if (effectiveTo !== null && effectiveTo < effectiveFrom) {
    return { ok: false, message: 'effectiveTo must be on or after effectiveFrom' }
  }

  const noteRaw = raw['note']
  const note = typeof noteRaw === 'string' && noteRaw.trim() !== '' ? noteRaw.trim() : null

  return {
    ok: true,
    value: { financeItemId: financeItemIdRaw, amount: amountRaw, effectiveFrom, effectiveTo, note },
  }
}

function parseId(value: string | string[] | undefined): number | null {
  if (typeof value !== 'string') return null
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

function isForeignKeyViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23503'
}

/** 23P01, raised by employee_finance_items_no_overlap. The one rejection HR
 *  is likely to hit by accident, so it gets a sentence rather than an SQLSTATE. */
function isExclusionViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23P01'
}

const OVERLAP_MESSAGE =
  'ช่วงวันที่ทับซ้อนกับรายการเดิมของรายการนี้ — ปิดช่วงเดิมก่อน หรือเลือกวันที่ที่ไม่ทับกัน'

employeeFinanceItemsRouter.get(
  '/employees/:id/finance-items',
  canReadWriteFinance,
  async (req: Request, res: Response) => {
    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    try {
      const employeeFinanceItems = await listEmployeeFinanceItems(id)
      const body: EmployeeFinanceItemListResponse = { employeeFinanceItems }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

employeeFinanceItemsRouter.post(
  '/employees/:id/finance-items',
  canReadWriteFinance,
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor) return fail(res, 500, 'server misconfigured')

    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    const parsed = parseEmployeeFinanceItemInput(req.body)
    if (!parsed.ok) return fail(res, 400, parsed.message)
    const input = parsed.value

    try {
      const result = await withTransaction(async (client) => {
        const { rowCount: employeeExists } = await client.query(
          'SELECT 1 FROM employees WHERE id = $1',
          [id]
        )
        if (employeeExists === 0) return 'not-found' as const

        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO employee_finance_items
             (employee_id, finance_item_id, amount, effective_from, effective_to, note)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          [id, input.financeItemId, input.amount, input.effectiveFrom, input.effectiveTo, input.note]
        )
        const created = rows[0]
        if (!created) throw new Error('insert into employee_finance_items returned no id')

        await recordAudit(client, {
          actor,
          // entityId is the employee, not the line: this belongs in the same
          // trail as the rest of that person's changes, which is where anyone
          // asking "who changed their pay?" will look.
          action: 'employee.finance_item_add',
          entityId: id,
          detail: {
            lineId: Number(created.id),
            financeItemId: input.financeItemId,
            amount: input.amount,
            effectiveFrom: input.effectiveFrom,
          },
        })

        // Re-read rather than assembling from the input: the response carries
        // the joined item code/name/type, which the insert never saw.
        const line = await findEmployeeFinanceItem(id, Number(created.id), client)
        if (!line) throw new Error('inserted employee finance item could not be read back')
        return line
      })

      if (result === 'not-found') return fail(res, 404, `no employee with id ${id}`)

      const body: EmployeeFinanceItemResponse = { employeeFinanceItem: result }
      res.status(201).json(body)
    } catch (err) {
      if (isExclusionViolation(err)) return fail(res, 409, OVERLAP_MESSAGE)
      if (isForeignKeyViolation(err)) {
        return fail(res, 400, `no finance item with id ${input.financeItemId}`)
      }
      handleUnexpected(res, err)
    }
  }
)

// PUT, not PATCH: the body is a complete line, matching the rest of the app.
// No DELETE — by decision, a mis-entered line is corrected, not removed.
employeeFinanceItemsRouter.put(
  '/employees/:id/finance-items/:lineId',
  canReadWriteFinance,
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor) return fail(res, 500, 'server misconfigured')

    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    const lineId = parseId(req.params['lineId'])
    if (lineId === null) return fail(res, 400, 'lineId must be a positive integer')

    const parsed = parseEmployeeFinanceItemInput(req.body)
    if (!parsed.ok) return fail(res, 400, parsed.message)
    const input = parsed.value

    try {
      const result = await withTransaction(async (client) => {
        // employee_id in the WHERE, so a line id belonging to someone else is
        // a 404 here rather than an edit of another employee's pay.
        const { rowCount } = await client.query(
          `UPDATE employee_finance_items SET
             finance_item_id = $3, amount = $4, effective_from = $5,
             effective_to = $6, note = $7, updated_at = now()
           WHERE employee_id = $1 AND id = $2`,
          [
            id,
            lineId,
            input.financeItemId,
            input.amount,
            input.effectiveFrom,
            input.effectiveTo,
            input.note,
          ]
        )
        if (rowCount === 0) return 'not-found' as const

        await recordAudit(client, {
          actor,
          action: 'employee.finance_item_update',
          entityId: id,
          detail: {
            lineId,
            financeItemId: input.financeItemId,
            amount: input.amount,
            effectiveFrom: input.effectiveFrom,
          },
        })

        const line = await findEmployeeFinanceItem(id, lineId, client)
        if (!line) throw new Error('updated employee finance item could not be read back')
        return line
      })

      if (result === 'not-found') {
        return fail(res, 404, `no finance item line ${lineId} for employee ${id}`)
      }

      const body: EmployeeFinanceItemResponse = { employeeFinanceItem: result }
      res.json(body)
    } catch (err) {
      if (isExclusionViolation(err)) return fail(res, 409, OVERLAP_MESSAGE)
      if (isForeignKeyViolation(err)) {
        return fail(res, 400, `no finance item with id ${input.financeItemId}`)
      }
      handleUnexpected(res, err)
    }
  }
)
