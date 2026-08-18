// Reading finance items out of master_finance_items. A single flat table with
// no join, same shape of module as overtimeGroupQueries.ts.

import type pg from 'pg'
import type { FinanceItem, FinanceItemType } from '@hrm/shared'
import { pool } from './db.js'

type Queryable = Pick<pg.Pool, 'query'>

export type FinanceItemRow = {
  id: string // bigint: pg hands these back as strings to avoid precision loss
  item_code: string
  item_name: string
  item_type: string
  description: string | null
  sort_order: number
  is_active: boolean
}

export const SELECT_FINANCE_ITEM = `
  SELECT id, item_code, item_name, item_type, description, sort_order, is_active
  FROM master_finance_items
`

export function rowToFinanceItem(row: FinanceItemRow): FinanceItem {
  return {
    id: Number(row.id),
    itemCode: row.item_code,
    itemName: row.item_name,
    itemType: row.item_type as FinanceItemType,
    description: row.description,
    sortOrder: row.sort_order,
    isActive: row.is_active,
  }
}

export async function findFinanceItemById(
  id: number,
  db: Queryable = pool
): Promise<FinanceItem | null> {
  const { rows } = await db.query<FinanceItemRow>(
    `${SELECT_FINANCE_ITEM} WHERE id = $1`,
    [id]
  )
  const row = rows[0]
  return row ? rowToFinanceItem(row) : null
}
