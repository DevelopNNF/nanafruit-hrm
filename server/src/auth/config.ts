// Auth settings, read once at startup.
//
// These are required, not optional-with-a-default: a default tenant or audience
// would mean a misconfigured deploy quietly accepts tokens it should reject.
// Reading them at module load turns that into a crash on boot instead of a
// surprise on the first request.

function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`${name} is not set — see server/.env.example`)
  }
  return value
}

/**
 * Same, plus a length floor. A signing key short enough to be guessed is worse
 * than a missing one, because a missing one stops the deploy and a weak one
 * looks like it works.
 */
function requireSecret(name: string, minLength: number): string {
  const value = requireEnv(name)
  if (value.length < minLength) {
    throw new Error(
      `${name} must be at least ${minLength} characters — generate one with: openssl rand -base64 32`
    )
  }
  return value
}

export const authConfig = {
  /** Directory (tenant) ID of the Entra app registration. */
  entraTenantId: requireEnv('ENTRA_TENANT_ID'),
  /**
   * Application (client) ID. Doubles as the expected `aud`: a v2 access token
   * issued for this app's own API scope carries the client ID as its audience.
   */
  entraClientId: requireEnv('ENTRA_API_CLIENT_ID'),

  /**
   * Channel ID of the LINE Login channel behind the LIFF app. Sent to LINE when
   * verifying an ID token, which is what makes LINE check that the token was
   * minted for us and not for some other app the same user signed into.
   */
  lineChannelId: requireEnv('LINE_CHANNEL_ID'),

  /**
   * Signing key for the sessions we issue to liff/. Unlike everything above it,
   * this one is a real secret: whoever holds it can mint a session for any
   * employee. Never let it near a VITE_ prefix.
   */
  sessionSecret: requireSecret('SESSION_JWT_SECRET', 32),
} as const
