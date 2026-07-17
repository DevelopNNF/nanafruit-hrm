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
