// The one door out to the API, as in admin/ — but the token here is one the
// server minted for us, not one from an identity provider, so there is nothing
// to renew silently. When it lapses the app re-exchanges the LINE ID token on
// its next boot, which is the only time a LIFF app reliably has one.

import type { ApiError, ApiErrorCode } from '@hrm/shared'

/** A non-2xx from the API, carrying the server's own message, code and status. */
export class ApiRequestError extends Error {
  code: ApiErrorCode | undefined
  status: number

  constructor(message: string, status: number, code?: ApiErrorCode) {
    super(message)
    this.name = 'ApiRequestError'
    this.status = status
    this.code = code
  }
}

// Memory, not sessionStorage: every boot has a fresh LINE ID token to exchange,
// so persisting this would only add a way for a stale token to outlive the
// session it belongs to.
let sessionToken: string | null = null

export function setSessionToken(token: string): void {
  sessionToken = token
}

export const jsonHeaders = { 'Content-Type': 'application/json' }

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  if (sessionToken !== null) headers.set('Authorization', `Bearer ${sessionToken}`)
  return fetch(path, { ...init, headers })
}

export async function unwrap<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T

  let message = `HTTP ${res.status}`
  let code: ApiErrorCode | undefined
  try {
    const body = (await res.json()) as ApiError
    if (body.message) message = body.message
    code = body.code
  } catch {
    // Non-JSON error body (a proxy error page, say) — the status is all we have.
  }
  throw new ApiRequestError(message, res.status, code)
}
