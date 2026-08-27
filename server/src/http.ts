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
