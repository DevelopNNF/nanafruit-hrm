import { createHash, randomInt } from 'node:crypto'

/**
 * 30 symbols: digits and letters, minus every pair that gets confused when a
 * code is read down a phone or copied off a sticky note — 0/O, 1/I/L, and U,
 * which people hear as V. Eight of them is about 39 bits.
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'
const LENGTH = 8

/** Long enough for HR to reach someone, short enough that a leaked code rots. */
export const LINK_CODE_TTL_MS = 24 * 60 * 60 * 1000

export function generateLinkCode(): string {
  let code = ''
  for (let i = 0; i < LENGTH; i++) {
    // randomInt is the CSPRNG, and it rejects rather than folding the range, so
    // no symbol is likelier than another. Math.random() would be neither.
    code += ALPHABET[randomInt(ALPHABET.length)]
  }
  // Grouped for reading aloud. normalizeLinkCode strips the dash back out, so
  // the employee can type it either way.
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

/** Lets someone type "abcd efgh", "ABCD-EFGH" or "abcdefgh" and be right. */
function normalizeLinkCode(input: string): string {
  return input.toUpperCase().replace(/[^0-9A-Z]/g, '')
}

/**
 * What goes in the database. SHA-256 with no salt is right here and would be
 * wrong for a password: the input is 39 bits of CSPRNG output rather than
 * something a human chose, so there is no dictionary to run and nothing for a
 * slow hash to buy. Unsalted also means the lookup is a plain primary-key hit.
 */
export function hashLinkCode(code: string): string {
  return createHash('sha256').update(normalizeLinkCode(code)).digest('hex')
}
