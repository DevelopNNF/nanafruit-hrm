// The one door out to the API. Everything that talks to the server goes through
// apiFetch, so attaching the token is not something a new call can forget.

import { InteractionRequiredAuthError } from '@azure/msal-browser'
import type { ApiError, ApiErrorCode } from '@hrm/shared'
import { apiRequest, getMsalInstance, getSignedInAccount } from '../auth/msal'

/** A non-2xx from the API, carrying the server's own message and reason. */
export class ApiRequestError extends Error {
  code: ApiErrorCode | undefined

  constructor(message: string, code?: ApiErrorCode) {
    super(message)
    this.name = 'ApiRequestError'
    this.code = code
  }
}

/**
 * A token for our API scope.
 *
 * acquireTokenSilent serves it from cache and renews it in the background when
 * it is close to expiring, so this is cheap on the common path. When it says
 * interaction is required — the refresh token expired, or Conditional Access
 * wants MFA again — only a trip to Microsoft can fix it.
 */
async function accessToken(): Promise<string> {
  const msal = getMsalInstance()
  const account = getSignedInAccount()

  // AuthGate means a signed-in account exists by the time any of this runs.
  // Reaching here without one is a bug, not a logged-out user.
  if (!account) throw new Error('no signed-in account — AuthGate should have redirected')

  // Passing the account explicitly, rather than letting MSAL fall back to the
  // active one, is what keeps this working on the render right after sign-in.
  try {
    const result = await msal.acquireTokenSilent({ ...apiRequest, account })
    return result.accessToken
  } catch (err) {
    if (err instanceof InteractionRequiredAuthError) {
      // Navigates away; the promise below never settles. Throwing keeps the
      // signature honest rather than returning a token we do not have.
      await msal.acquireTokenRedirect({ ...apiRequest, account })
      throw new ApiRequestError('กำลังพาไปเข้าสู่ระบบใหม่', 'UNAUTHENTICATED')
    }
    throw err
  }
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await accessToken()
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  return fetch(path, { ...init, headers })
}

/**
 * Unwraps a response, turning any non-2xx into a thrown ApiRequestError carrying
 * the server's own message so callers can show it verbatim.
 */
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

  // A 401 here is not an expired session: MSAL only ever hands over a token it
  // believes is live. It means the server disagrees about the audience, the
  // issuer, or the clock — a configuration problem that signing in again would
  // not touch, so we surface it rather than bouncing the user in a loop.
  throw new ApiRequestError(message, code)
}

export const jsonHeaders = { 'Content-Type': 'application/json' }
