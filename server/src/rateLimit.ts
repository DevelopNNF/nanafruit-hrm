import rateLimit from 'express-rate-limit'

// Limits on the two routes that answer before anyone has proved who they are.
// Everything else is behind `authenticate`, where a token is already the cost of
// entry and the caller is a name rather than an address.
//
// These are not what stops someone guessing a link code — 39 bits of CSPRNG is,
// and no rate at all gets through that this century. They are here so that a
// script cannot sit on /auth/line/session all day making us call LINE.
//
// The keys are IP addresses, which is the only thing available before a token,
// and IP addresses are a blunt instrument here: an office shares one, and mobile
// carriers put thousands of phones behind a handful. So the numbers are set to
// be generous enough that a real office never notices, rather than as tight as
// the maths would allow.

const WINDOW_MS = 15 * 60 * 1000

/** An employee opens the LIFF app; every open costs one. */
export const sessionLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { status: 'error', message: 'too many requests — try again shortly' },
})

/** Redeeming a code. A person does this once, ever, and mistypes it twice. */
export const linkLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { status: 'error', message: 'too many attempts — try again shortly' },
})
