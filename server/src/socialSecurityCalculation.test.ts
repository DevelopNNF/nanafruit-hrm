// Pure, so pinned down without a database — same reasoning as
// overtimeCalculation.test.ts and wageRate.test.ts. The rounding rule (round
// half up to a whole baht, not to satang) came from HR directly with two
// worked examples, both pinned below verbatim.

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import {
  SOCIAL_SECURITY_WAGE_CEILING,
  SOCIAL_SECURITY_WAGE_FLOOR,
  roundHalfUpToBaht,
  socialSecurityContribution,
} from './socialSecurityCalculation.js'

describe('roundHalfUpToBaht', () => {
  it('matches HR\'s two worked examples', () => {
    // เศษ 0.25 < 0.50 → ปัดลง
    assert.equal(roundHalfUpToBaht(8.25), 8)
    // เศษ 0.45 < 0.50 → ปัดลง
    assert.equal(roundHalfUpToBaht(500.45), 500)
  })

  it('rounds a remainder of exactly 0.50 up', () => {
    assert.equal(roundHalfUpToBaht(8.5), 9)
    assert.equal(roundHalfUpToBaht(82.5), 83)
  })

  it('rounds a remainder just under 0.50 down', () => {
    assert.equal(roundHalfUpToBaht(82.49), 82)
  })
})

describe('socialSecurityContribution', () => {
  it('clamps a wage below the floor up to 1,650 before applying 5%', () => {
    // ฐาน 1650 × 5% = 82.5 → ปัดขึ้น 83
    assert.equal(socialSecurityContribution(1000), 83)
  })

  it('prices a wage exactly at the floor the same as one below it', () => {
    assert.equal(socialSecurityContribution(SOCIAL_SECURITY_WAGE_FLOOR), 83)
  })

  it('prices an ordinary mid-range wage at a plain 5%', () => {
    assert.equal(socialSecurityContribution(10_000), 500)
  })

  it('caps contribution at 875 baht once wage reaches the 17,500 ceiling', () => {
    assert.equal(socialSecurityContribution(SOCIAL_SECURITY_WAGE_CEILING), 875)
    assert.equal(socialSecurityContribution(20_000), 875)
  })

  it('returns 0 without clamping up to the floor when wage is zero or negative', () => {
    assert.equal(socialSecurityContribution(0), 0)
    assert.equal(socialSecurityContribution(-500), 0)
  })
})
