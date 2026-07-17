// Verifying an Entra ID access token from admin/.
//
// Everything here is signature-verified. The one place that reads a token
// without verifying it is the issuer peek in middleware.ts, which is documented
// there and decides nothing but which verifier to call.

import { createRemoteJWKSet, errors, jwtVerify } from 'jose'
import { ROLES, type Role } from '@hrm/shared'
import { authConfig } from './config.js'
import { TokenError } from './errors.js'
import type { AdminUser } from './types.js'

/**
 * The `iss` every token from our tenant carries. Two things depend on the exact
 * string: the verify below, and the routing peek in middleware.ts.
 *
 * The tenant ID is baked in, which is what makes this single-tenant — a token
 * minted for any other tenant fails on the issuer before anything else is read.
 * That only holds for v2 tokens; v1 issues from `sts.windows.net` and will not
 * match, which is why the app registration must set accessTokenAcceptedVersion: 2.
 */
export const ENTRA_ISSUER = `https://login.microsoftonline.com/${authConfig.entraTenantId}/v2.0`

// jose caches the fetched keys and refetches only on an unknown `kid`, so this
// costs one request at first use rather than one per token.
const jwks = createRemoteJWKSet(
  new URL(
    `https://login.microsoftonline.com/${authConfig.entraTenantId}/discovery/v2.0/keys`
  )
)

/** The scope admin/ asks for. Its presence is what proves a user is behind the token. */
const REQUIRED_SCOPE = 'access_as_user'

function stringClaim(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key]
  return typeof value === 'string' && value !== '' ? value : null
}

export async function verifyEntraToken(token: string): Promise<AdminUser> {
  let payload: Record<string, unknown>
  try {
    const result = await jwtVerify(token, jwks, {
      issuer: ENTRA_ISSUER,
      audience: authConfig.entraClientId,
      // Signed clocks drift. 60s is what Entra itself allows for.
      clockTolerance: 60,
    })
    payload = result.payload as Record<string, unknown>
  } catch (err) {
    // Only a JOSEError means the *token* is wrong. Everything else is us failing
    // to reach Microsoft's keys — a timeout, or the TypeError fetch throws when
    // DNS is down — and answering 401 to a valid token would log every user out
    // over our own outage. The two JWKS_ cases are JOSEErrors that are also
    // about the fetch rather than the token, so they go out with the rest.
    const tokenIsBad =
      err instanceof errors.JOSEError &&
      !(err instanceof errors.JWKSTimeout) &&
      !(err instanceof errors.JWKSInvalid)
    if (!tokenIsBad) throw err

    // jose distinguishes expired from malformed from wrong-audience. The client
    // does the same thing in every case — get a new token — and a verifier that
    // explains exactly why it said no helps an attacker tune.
    throw new TokenError('token is not valid')
  }

  // `scp` is only present on delegated tokens — the kind a signed-in user gets.
  // An app-only token (client credentials) has `roles` but no `scp`, so this
  // check is what stops a daemon token from being read as a person.
  const scopes = stringClaim(payload, 'scp')?.split(' ') ?? []
  if (!scopes.includes(REQUIRED_SCOPE)) {
    throw new TokenError(`token is missing the ${REQUIRED_SCOPE} scope`)
  }

  const oid = stringClaim(payload, 'oid')
  if (oid === null) throw new TokenError('token has no oid claim')

  // Unknown values are dropped rather than passed through: a role this build
  // does not know about can never be one it meant to allow. An empty list is a
  // legitimate outcome (a signed-in user with no role assignment) and becomes a
  // 403 at requireRole, not a 401 here — they authenticated fine.
  const claimed = payload['roles']
  const claimedRoles = (Array.isArray(claimed) ? claimed : []).filter(
    (role): role is string => typeof role === 'string'
  )
  const roles = claimedRoles.filter((role): role is Role =>
    (ROLES as readonly string[]).includes(role)
  )

  // Dropping silently would turn "the Value field in Entra has a typo" into a
  // user who is told they have no role while their token plainly says they do,
  // and there is nothing on this side to see. Say it out loud instead.
  const unknown = claimedRoles.filter((role) => !(ROLES as readonly string[]).includes(role))
  if (unknown.length > 0) {
    console.warn(
      `ignoring app roles ${JSON.stringify(unknown)} on ${stringClaim(payload, 'preferred_username') ?? oid}: ` +
        `an App role's Value in Entra must match one of ${ROLES.join(', ')} exactly`
    )
  }

  return {
    kind: 'admin',
    oid,
    name: stringClaim(payload, 'name') ?? '',
    upn: stringClaim(payload, 'preferred_username') ?? '',
    roles,
  }
}
