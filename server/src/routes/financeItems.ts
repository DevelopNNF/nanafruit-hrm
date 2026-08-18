import { Router } from 'express'
import type { Request, Response } from 'express'
import {
  FINANCE_ITEM_TYPES,
  ROLES,
  type AuthUser,
  type FinanceItemInput,
  type FinanceItemListResponse,
  type FinanceItemResponse,
} from '@hrm/shared'
import { pool, withTransaction } from '../db.js'
import { requireRole } from '../auth/middleware.js'
import { recordAudit } from '../audit.js'
import { fail, handleUnexpected } from '../http.js'
import {
  SELECT_FINANCE_ITEM,
  findFinanceItemById,
  rowToFinanceItem,
  type FinanceItemRow,
} from '../financeItemQueries.js'

export const financeItemsRouter = Router()

// Same split as the other masters: any HRM role can read the item list, only
// HR and Admin can change it. Reading is not restricted further because this
// table holds no amounts — the per-employee figures a later phase adds are
// what needs the tighter rule employee_finance already has.
const canRead = requireRole(...ROLES)
const canWrite = requireRole('HRM.HR', 'HRM.Admin')

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

/** Absent, null and blank all mean "no note". */
function optionalString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function parseFinanceItemInput(body: unknown): ParseResult<FinanceItemInput> {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'body must be a JSON object' }
  }
  const raw = body as Record<string, unknown>

  const itemCode = requiredString(raw, 'itemCode')
  if (itemCode === null) return { ok: false, message: 'itemCode is required' }

  const itemName = requiredString(raw, 'itemName')
  if (itemName === null) return { ok: false, message: 'itemName is required' }

  const itemTypeRaw = raw['itemType']
  if (
    typeof itemTypeRaw !== 'string' ||
    !(FINANCE_ITEM_TYPES as readonly string[]).includes(itemTypeRaw)
  ) {
    return { ok: false, message: `itemType must be one of: ${FINANCE_ITEM_TYPES.join(', ')}` }
  }

  const sortOrderRaw = raw['sortOrder']
  if (typeof sortOrderRaw !== 'number' || !Number.isInteger(sortOrderRaw)) {
    return { ok: false, message: 'sortOrder must be an integer' }
  }

  const isActiveRaw = raw['isActive']
  if (typeof isActiveRaw !== 'boolean') {
    return { ok: false, message: 'isActive must be a boolean' }
  }

  return {
    ok: true,
    value: {
      itemCode,
      itemName,
      itemType: itemTypeRaw as FinanceItemInput['itemType'],
      description: optionalString(raw, 'description'),
      sortOrder: sortOrderRaw,
      isActive: isActiveRaw,
    },
  }
}

function parseId(value: string | string[] | undefined): number | null {
  if (typeof value !== 'string') return null
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505'
  )
}

financeItemsRouter.get('/finance-items', canRead, async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query<FinanceItemRow>(
      `${SELECT_FINANCE_ITEM} ORDER BY sort_order, item_code`
    )
    const body: FinanceItemListResponse = { financeItems: rows.map(rowToFinanceItem) }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

financeItemsRouter.get('/finance-items/:id', canRead, async (req: Request, res: Response) => {
  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  try {
    const financeItem = await findFinanceItemById(id)
    if (!financeItem) return fail(res, 404, `no finance item with id ${id}`)

    const body: FinanceItemResponse = { financeItem }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

financeItemsRouter.post('/finance-items', canWrite, async (req: Request, res: Response) => {
  const actor = actorOf(req)
  if (!actor) return fail(res, 500, 'server misconfigured')

  const parsed = parseFinanceItemInput(req.body)
  if (!parsed.ok) return fail(res, 400, parsed.message)
  const input = parsed.value

  try {
    const financeItem = await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO master_finance_items
           (item_code, item_name, item_type, description, sort_order, is_active)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          input.itemCode,
          input.itemName,
          input.itemType,
          input.description,
          input.sortOrder,
          input.isActive,
        ]
      )
      const created = rows[0]
      if (!created) throw new Error('insert into master_finance_items returned no id')

      await recordAudit(client, {
        actor,
        action: 'finance_item.create',
        entityId: Number(created.id),
        detail: { itemCode: input.itemCode, itemType: input.itemType },
      })

      return { ...input, id: Number(created.id) } satisfies FinanceItemResponse['financeItem']
    })

    const body: FinanceItemResponse = { financeItem }
    res.status(201).json(body)
  } catch (err) {
    if (isUniqueViolation(err)) {
      return fail(res, 409, `item code "${input.itemCode}" is already taken`)
    }
    handleUnexpected(res, err)
  }
})

// PUT, not PATCH: the body is a complete item, matching every other master.
financeItemsRouter.put('/finance-items/:id', canWrite, async (req: Request, res: Response) => {
  const actor = actorOf(req)
  if (!actor) return fail(res, 500, 'server misconfigured')

  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  const parsed = parseFinanceItemInput(req.body)
  if (!parsed.ok) return fail(res, 400, parsed.message)
  const input = parsed.value

  try {
    const updated = await withTransaction(async (client) => {
      const { rowCount } = await client.query(
        `UPDATE master_finance_items SET
           item_code = $2, item_name = $3, item_type = $4, description = $5,
           sort_order = $6, is_active = $7, updated_at = now()
         WHERE id = $1`,
        [
          id,
          input.itemCode,
          input.itemName,
          input.itemType,
          input.description,
          input.sortOrder,
          input.isActive,
        ]
      )
      if (rowCount === 0) return false

      await recordAudit(client, {
        actor,
        action: 'finance_item.update',
        entityId: id,
        detail: { itemCode: input.itemCode, itemType: input.itemType },
      })
      return true
    })

    if (!updated) return fail(res, 404, `no finance item with id ${id}`)

    const body: FinanceItemResponse = { financeItem: { ...input, id } }
    res.json(body)
  } catch (err) {
    if (isUniqueViolation(err)) {
      return fail(res, 409, `item code "${input.itemCode}" is already taken`)
    }
    handleUnexpected(res, err)
  }
})
