// Verifying a LINE ID token from liff/.
//
// Unlike the Entra token, this is checked by asking LINE rather than by
// validating a signature locally. Two reasons: LINE signs ID tokens with ES256
// or HS256 depending on how the channel is set up, and their endpoint checks the
// audience against our channel ID for us. The round trip is affordable because
// this runs once per session — the token liff/ carries afterwards is our own.

import { authConfig } from './config.js'
import { TokenError } from './errors.js'

const VERIFY_URL = 'https://api.line.me/oauth2/v2.1/verify'

/**
 * Returns the LINE user id (`sub`) the token belongs to.
 *
 * The `sub` is scoped to our Login channel: the same person opening a different
 * company's LIFF app gets a different one. It is an identifier, not a secret,
 * and it is the only thing here worth trusting — the display name and picture
 * LINE also returns are decoration a client could have made up anyway.
 */
export async function verifyLineIdToken(idToken: string): Promise<string> {
  const res = await fetch(VERIFY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    // client_id is what makes LINE check `aud`: a token minted for someone
    // else's channel is rejected here rather than trusted as one of ours.
    body: new URLSearchParams({
      id_token: idToken,
      client_id: authConfig.lineChannelId,
    }),
  })

  // 400 is LINE's answer for every way a token can be wrong — expired, tampered,
  // issued for another channel. Anything else is an outage on one side or the
  // other, and must not be reported to the caller as "your token is bad".
  if (res.status === 400) {
    throw new TokenError('LINE ID token is not valid')
  }
  if (!res.ok) {
    throw new Error(`LINE verify endpoint returned ${res.status}`)
  }

  const body = (await res.json()) as { sub?: unknown }
  if (typeof body.sub !== 'string' || body.sub === '') {
    throw new Error('LINE verify returned no sub')
  }
  return body.sub
}
