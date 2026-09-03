// One place that decides what an error looks like on the wire, so every route
// and every middleware answers in the same shape.

import type { Response } from 'express'
import type { ApiError, ApiErrorCode } from '@hrm/shared'

export function fail(
  res: Response,
  status: number,
  message: string,
  code?: ApiErrorCode
): void {
  const body: ApiError = code ? { status: 'error', message, code } : { status: 'error', message }
  res.status(status).json(body)
}

/** Every route funnels its unexpected errors here so none of them leak a stack trace. */
export function handleUnexpected(res: Response, err: unknown): void {
  console.error(err)
  fail(res, 500, err instanceof Error ? err.message : 'unexpected database error')
}

/** A query param that's either absent or a positive integer — `page`/`pageSize`,
 *  same shape as an id. undefined means "reject with 400", null means "absent,
 *  use the caller's default". */
export function parseOptionalPositiveInt(value: unknown): number | null | undefined {
  if (value === undefined) return null
  if (typeof value !== 'string') return undefined
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

/** A repeated query param (?x=1&x=2) or a single value — express's qs parser
 *  hands back string | string[] | undefined depending on how many were
 *  given. Same undefined/null convention as parseOptionalPositiveInt: absent
 *  means "use the caller's default", undefined means "reject with 400". */
export function parseOptionalPositiveIntArray(value: unknown): number[] | null | undefined {
  if (value === undefined) return null
  const values = Array.isArray(value) ? value : [value]
  const ids: number[] = []
  for (const v of values) {
    if (typeof v !== 'string') return undefined
    const n = Number(v)
    if (!Number.isInteger(n) || n <= 0) return undefined
    ids.push(n)
  }
  return ids
}

/** Same shape as parseOptionalPositiveIntArray, but validates each value
 *  against a fixed set of allowed strings (an EMPLOYMENT_TYPES/WORK_LOCATIONS
 *  -style const array) instead of parsing it as a number. */
export function parseOptionalEnumArray<T extends string>(
  value: unknown,
  allowed: readonly T[]
): T[] | null | undefined {
  if (value === undefined) return null
  const values = Array.isArray(value) ? value : [value]
  const result: T[] = []
  for (const v of values) {
    if (typeof v !== 'string' || !allowed.includes(v as T)) return undefined
    result.push(v as T)
  }
  return result
}
