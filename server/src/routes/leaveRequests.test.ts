// resolveLeaveApprover's employee-kind branch is the authorization boundary
// that lets a LIFF supervisor decide a request at all — get it wrong and
// either nobody can approve from LIFF, or someone can approve a request that
// isn't theirs to decide. It never touches the DB (actor.employeeId is
// already the identity, unlike the admin branch's UPN lookup), so a stub
// that throws on any query proves that directly rather than by omission.

// Importing the route module pulls in auth/entra.js, which reads
// ENTRA_TENANT_ID/ENTRA_API_CLIENT_ID at module scope — load .env first, the
// same way index.ts does, since the test runner doesn't do this on its own.
import 'dotenv/config'
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import type pg from 'pg'
import { resolveLeaveApprover } from './leaveRequests.js'

type Queryable = Pick<pg.Pool, 'query'>

const neverQuery: Queryable = {
  query: () => {
    throw new Error('resolveLeaveApprover should not query the DB for an employee-kind actor')
  },
}

describe('resolveLeaveApprover — employee-kind actor', () => {
  it('may decide as supervisor when pending, at the supervisor stage, and they are the snapshotted supervisor', async () => {
    const kind = await resolveLeaveApprover(
      { kind: 'employee', employeeId: 5 },
      { status: 'pending', currentStage: 'supervisor', supervisorEmployeeId: 5 },
      neverQuery
    )
    assert.equal(kind, 'supervisor')
  })

  it('may not decide a request snapshotted to a different supervisor', async () => {
    const kind = await resolveLeaveApprover(
      { kind: 'employee', employeeId: 5 },
      { status: 'pending', currentStage: 'supervisor', supervisorEmployeeId: 6 },
      neverQuery
    )
    assert.equal(kind, null)
  })

  it('never gets the HR override once the request has moved to the hr stage', async () => {
    const kind = await resolveLeaveApprover(
      { kind: 'employee', employeeId: 5 },
      { status: 'pending', currentStage: 'hr', supervisorEmployeeId: 5 },
      neverQuery
    )
    assert.equal(kind, null)
  })

  it('may not decide a request that is no longer pending', async () => {
    const kind = await resolveLeaveApprover(
      { kind: 'employee', employeeId: 5 },
      { status: 'approved', currentStage: null, supervisorEmployeeId: 5 },
      neverQuery
    )
    assert.equal(kind, null)
  })

  it('may not decide a request with no snapshotted supervisor at all', async () => {
    const kind = await resolveLeaveApprover(
      { kind: 'employee', employeeId: 5 },
      { status: 'pending', currentStage: 'supervisor', supervisorEmployeeId: null },
      neverQuery
    )
    assert.equal(kind, null)
  })
})
