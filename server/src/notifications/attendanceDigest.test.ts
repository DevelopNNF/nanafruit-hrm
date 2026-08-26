// Exercises sendAttendanceDigest's grouping (each supervisor hears about
// their own team, HR hears about everyone) end to end through notify(),
// against a fake db and a stubbed fetch — same style as dispatch.test.ts.

import { strict as assert } from 'node:assert'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type pg from 'pg'
import { sendAttendanceDigest } from './attendanceDigest.js'

type Queryable = Pick<pg.Pool, 'query'>

type IssueRow = {
  employee_id: number
  employee_name: string
  supervisor_employee_id: number | null
  attendance_status: string
  late_minutes: number
  early_leave_minutes: number
}

type LoggedRow = { event_type: string; channel: string; recipient: string | null; status: string }

function fakeDb(issueRows: IssueRow[], lineUserIdBySupervisor: Record<number, string | null>) {
  const logged: LoggedRow[] = []
  const db = {
    query: async (...args: unknown[]) => {
      const text = args[0] as string
      const params = (args[1] ?? []) as unknown[]
      if (text.includes('FROM attendance_daily')) {
        return { rows: issueRows }
      }
      if (text.includes('SELECT line_user_id')) {
        const employeeId = params[0] as number
        return { rows: [{ line_user_id: lineUserIdBySupervisor[employeeId] ?? null }] }
      }
      if (text.includes('AS name')) {
        return { rows: [{ name: null }] } // not exercised by digest events
      }
      if (text.includes('INSERT INTO notification_log')) {
        const [event_type, channel, recipient, status] = params as [string, string, string | null, string]
        logged.push({ event_type, channel, recipient, status })
        return { rows: [] }
      }
      throw new Error(`fakeDb: unexpected query: ${text}`)
    },
  }
  return { db: db as unknown as Queryable, logged }
}

const originalEnv = {
  NOTIFICATIONS_ENABLED: process.env['NOTIFICATIONS_ENABLED'],
  LINE_CHANNEL_ACCESS_TOKEN: process.env['LINE_CHANNEL_ACCESS_TOKEN'],
  POWER_AUTOMATE_WEBHOOK_URL: process.env['POWER_AUTOMATE_WEBHOOK_URL'],
}
const originalFetch = globalThis.fetch

beforeEach(() => {
  process.env['NOTIFICATIONS_ENABLED'] = 'true'
  process.env['LINE_CHANNEL_ACCESS_TOKEN'] = 'test-line-token'
  process.env['POWER_AUTOMATE_WEBHOOK_URL'] = 'https://example.test/power-automate'
})

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  globalThis.fetch = originalFetch
})

describe('sendAttendanceDigest', () => {
  it('is a no-op when nothing was flagged that day', async () => {
    let fetchCalled = false
    globalThis.fetch = (async () => {
      fetchCalled = true
      return new Response(null, { status: 200 })
    }) as typeof fetch

    const { db, logged } = fakeDb([], {})
    await sendAttendanceDigest('2026-08-24', db)

    assert.equal(fetchCalled, false)
    assert.deepEqual(logged, [])
  })

  it('sends one LINE digest per supervisor covering only their own team, plus one HR email covering everyone', async () => {
    const capturedLineBodies: unknown[] = []
    let capturedEmailBody: unknown
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      if (url.includes('line.me')) capturedLineBodies.push(body)
      else capturedEmailBody = body
      return new Response(null, { status: 200 })
    }) as typeof fetch

    const rows: IssueRow[] = [
      {
        employee_id: 1,
        employee_name: 'สมชาย ใจดี',
        supervisor_employee_id: 10,
        attendance_status: 'absent',
        late_minutes: 0,
        early_leave_minutes: 0,
      },
      {
        employee_id: 2,
        employee_name: 'สมหญิง มีสุข',
        supervisor_employee_id: 10,
        attendance_status: 'present',
        late_minutes: 15,
        early_leave_minutes: 0,
      },
      {
        employee_id: 3,
        employee_name: 'สมศักดิ์ ดีใจ',
        supervisor_employee_id: 20,
        attendance_status: 'present',
        late_minutes: 0,
        early_leave_minutes: 30,
      },
      // No supervisor at all — should still reach HR, just no LINE digest.
      {
        employee_id: 4,
        employee_name: 'สมปอง สุขใจ',
        supervisor_employee_id: null,
        attendance_status: 'absent',
        late_minutes: 0,
        early_leave_minutes: 0,
      },
    ]

    const { db, logged } = fakeDb(rows, { 10: 'U_SUP_10', 20: 'U_SUP_20' })
    await sendAttendanceDigest('2026-08-24', db)

    // Two supervisor LINE pushes.
    assert.equal(capturedLineBodies.length, 2)
    const sup10Text = (capturedLineBodies.find((b) => (b as { to: string }).to === 'U_SUP_10') as {
      messages: { text: string }[]
    }).messages[0]?.text
    assert.match(sup10Text ?? '', /สมชาย ใจดี/)
    assert.match(sup10Text ?? '', /สมหญิง มีสุข/)
    assert.doesNotMatch(sup10Text ?? '', /สมศักดิ์/)

    const sup20Text = (capturedLineBodies.find((b) => (b as { to: string }).to === 'U_SUP_20') as {
      messages: { text: string }[]
    }).messages[0]?.text
    assert.match(sup20Text ?? '', /สมศักดิ์ ดีใจ/)

    // One HR email covering all four, including the supervisor-less one.
    const subject = (capturedEmailBody as { subject: string }).subject
    assert.match(subject, /4 คน/)
    const hrBody = (capturedEmailBody as { bodyHtml: string }).bodyHtml
    for (const name of ['สมชาย ใจดี', 'สมหญิง มีสุข', 'สมศักดิ์ ดีใจ', 'สมปอง สุขใจ']) {
      assert.match(hrBody, new RegExp(name))
    }

    assert.equal(logged.filter((l) => l.channel === 'line' && l.status === 'sent').length, 2)
    assert.equal(logged.filter((l) => l.channel === 'email' && l.status === 'sent').length, 1)
  })
})
