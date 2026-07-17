import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { decodeJwt } from 'jose'
import type { AuthUser, Role } from '@hrm/shared'
import { fail, handleUnexpected } from '../http.js'
import { ENTRA_ISSUER, verifyEntraToken } from './entra.js'
import { TokenError } from './errors.js'
import { HRM_ISSUER, verifySession } from './session.js'

/**
 * Pulls the token out of `Authorization: Bearer <token>`.
 *
 * Rejects a header with extra whitespace-separated parts rather than reading
 * the second one and ignoring the rest.
 */
function bearerToken(req: Request): string | null {
  const header = req.headers.authorization
  if (typeof header !== 'string') return null

  const parts = header.split(' ')
  if (parts.length !== 2) return null

  const [scheme, token] = parts
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null
  return token
}

/**
 * Picks a verifier by issuer, then hands the token to it whole.
 *
 * `decodeJwt` does not check the signature — this reads an untrusted claim. It
 * is safe because it decides nothing except which verifier runs, and every
 * verifier re-checks the issuer against its own constant as part of verifying.
 * A token with a forged `iss` therefore reaches a verifier that rejects it,
 * and a token with an `iss` we do not know reaches none at all.
 */
async function verifyToken(token: string): Promise<AuthUser> {
  let issuer: string | undefined
  try {
    issuer = decodeJwt(token).iss
  } catch {
    throw new TokenError('token is not a JWT')
  }

  if (issuer === ENTRA_ISSUER) return verifyEntraToken(token)
  if (issuer === HRM_ISSUER) return verifySession(token)
  throw new TokenError('token issuer is not recognised')
}

/**
 * Requires a valid token and attaches the caller to `req.auth`. Says nothing
 * about what they may do — that is requireRole's job.
 */
export const authenticate: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const token = bearerToken(req)
  if (token === null) {
    return fail(res, 401, 'Authorization: Bearer <token> is required', 'UNAUTHENTICATED')
  }

  verifyToken(token).then(
    (auth) => {
      req.auth = auth
      next()
    },
    (err: unknown) => {
      if (err instanceof TokenError) {
        return fail(res, 401, err.message, 'UNAUTHENTICATED')
      }
      // Anything else is ours — a JWKS fetch that timed out, say. Telling a
      // valid token it is invalid would log the user out over our own outage.
      handleUnexpected(res, err)
    }
  )
}

/**
 * Requires the caller to hold at least one of `allowed`. Mount behind
 * `authenticate` — it reads what that middleware attached.
 */
export function requireRole(...allowed: Role[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const auth = req.auth
    if (!auth) {
      console.error('requireRole is mounted without authenticate in front of it')
      return fail(res, 500, 'server misconfigured')
    }

    if (auth.kind !== 'admin') {
      return fail(res, 403, 'this endpoint is for admin users', 'FORBIDDEN')
    }

    if (!auth.roles.some((role) => allowed.includes(role))) {
      // An account with no role at all is the common case on day one — someone
      // signed in before IT assigned them anything. Say so, rather than listing
      // roles they cannot give themselves.
      const message =
        auth.roles.length === 0
          ? 'this account has no HRM role assigned — contact IT'
          : `requires one of these roles: ${allowed.join(', ')}`
      return fail(res, 403, message, 'FORBIDDEN')
    }

    next()
  }
}
