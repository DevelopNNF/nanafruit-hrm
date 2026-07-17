/**
 * A token we refuse. Carries no detail we would not say out loud to the caller.
 *
 * The distinction that matters: a TokenError becomes a 401, anything else
 * thrown by a verifier becomes a 500. Only throw this when the *token* is the
 * problem — never when we could not reach the service that vouches for it.
 */
export class TokenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TokenError'
  }
}
