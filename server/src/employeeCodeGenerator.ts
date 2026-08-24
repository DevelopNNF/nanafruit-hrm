// Auto-generated employee codes for temporary daily workers, who arrive with
// no employee code of their own (fingerprint code is their real identity —
// see employees.fingerprint_code). Format TEMP-XXXX, a 4-digit running
// number, same convention as the EMP9999/FP9999 sample codes already used
// elsewhere in this codebase.
//
// There is no counter table, so "next number" is derived from the highest
// existing TEMP-XXXX code each time — safe under concurrency only because
// callers retry through insertWithGeneratedEmployeeCode below, which re-reads
// and re-generates inside a SAVEPOINT on every attempt.

import type pg from 'pg'

const TEMP_CODE_PREFIX = 'TEMP-'
const TEMP_CODE_DIGITS = 4

/** True only for a `23505` on employees_employee_code_key specifically — a
 *  real duplicate on idCardNumber/fingerprintCode must never be swallowed by
 *  the retry loop below, only a collision on the generated code itself. */
export function isEmployeeCodeConflict(err: unknown): boolean {
  const pgErr = err as { code?: unknown; constraint?: unknown } | null
  return (
    typeof pgErr === 'object' &&
    pgErr !== null &&
    pgErr.code === '23505' &&
    pgErr.constraint === 'employees_employee_code_key'
  )
}

export async function nextTempEmployeeCode(client: pg.PoolClient): Promise<string> {
  const { rows } = await client.query<{ employee_code: string }>(
    `SELECT employee_code FROM employees
     WHERE employee_code ~ '^TEMP-[0-9]+$'
     ORDER BY (substring(employee_code from 6))::int DESC
     LIMIT 1`
  )
  const last = rows[0]?.employee_code
  const lastNum = last ? Number(last.slice(TEMP_CODE_PREFIX.length)) : 0
  const next = Number.isFinite(lastNum) ? lastNum + 1 : 1
  return `${TEMP_CODE_PREFIX}${String(next).padStart(TEMP_CODE_DIGITS, '0')}`
}

/**
 * Runs `attemptInsert` inside a SAVEPOINT, retrying with a freshly generated
 * TEMP-XXXX code whenever `employeeCodeGiven` is blank and the insert fails
 * on an employee_code collision (two concurrent auto-generates racing for the
 * same number). A collision on a *given* (non-blank) code, or any other
 * error, is never retried — it's a real problem the caller's own error
 * handling needs to see.
 */
export async function insertWithGeneratedEmployeeCode<T>(
  client: pg.PoolClient,
  employeeCodeGiven: string,
  attemptInsert: (employeeCode: string) => Promise<T>,
  isEmployeeCodeConflict: (err: unknown) => boolean,
  maxAttempts = 5
): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const employeeCode = employeeCodeGiven || (await nextTempEmployeeCode(client))
    await client.query('SAVEPOINT employee_code_attempt')
    try {
      const result = await attemptInsert(employeeCode)
      await client.query('RELEASE SAVEPOINT employee_code_attempt')
      return result
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT employee_code_attempt')
      if (employeeCodeGiven || !isEmployeeCodeConflict(err)) throw err
    }
  }
  throw new Error('could not generate a unique employee code after several attempts')
}
