import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { parseAttendanceImport, splitPunchTimes } from './attendanceImportParse.js'

// The real export from the terminal in use, kept as a fixture: the layout is
// the whole contract here, and a hand-written workbook would only prove that
// the parser agrees with itself. It carries fingerprint codes and clock times
// and no names — the ชื่อ: cells the terminal writes are empty.
const EXAMPLE = fileURLToPath(new URL('./fixtures/attendance-import-example.xlsx', import.meta.url))

async function parseExample() {
  const result = await parseAttendanceImport(await readFile(EXAMPLE))
  assert.equal(result.ok, true, result.ok ? '' : `parse failed: ${result.message}`)
  if (!result.ok) throw new Error('unreachable')
  return result.value
}

describe('splitPunchTimes', () => {
  it('cuts a full day of four punches out of one run of digits', () => {
    assert.deepEqual(splitPunchTimes('07:4712:0112:4517:03'), ['07:47', '12:01', '12:45', '17:03'])
  })

  it('accepts a day the export caught mid-shift, with no clock-out yet', () => {
    assert.deepEqual(splitPunchTimes('07:5112:0312:47'), ['07:51', '12:03', '12:47'])
  })

  it('reads an empty cell as no punches rather than as a problem', () => {
    assert.deepEqual(splitPunchTimes(''), [])
    assert.deepEqual(splitPunchTimes('   '), [])
  })

  it('refuses a single-digit hour instead of re-cutting the run in the wrong places', () => {
    // '7:4712:01' would otherwise yield 7:47 then 12:01 by luck on this input
    // and silent nonsense on the next one.
    assert.equal(splitPunchTimes('7:4712:01'), null)
  })

  it('refuses a cell with anything else in it', () => {
    assert.equal(splitPunchTimes('07:47x12:01'), null)
    assert.equal(splitPunchTimes('OFF'), null)
  })

  it('refuses an impossible clock time', () => {
    assert.equal(splitPunchTimes('25:0012:01'), null)
    assert.equal(splitPunchTimes('12:6012:01'), null)
  })
})

describe('parseAttendanceImport', () => {
  it('reads the period out of C3', async () => {
    const sheet = await parseExample()
    assert.equal(sheet.rangeFrom, '2026-07-26')
    assert.equal(sheet.rangeTo, '2026-08-04')
    assert.equal(sheet.generatedOn, '2026-08-04')
  })

  it('finds every employee block in the sheet', async () => {
    const sheet = await parseExample()
    assert.deepEqual(
      sheet.employees.map((employee) => employee.fingerprintCode),
      ['3042', '3041', '3051', '2020', '3047', '3043', '3056', '3048', '2037', '3004', '3005', '3006', '3038']
    )
  })

  it('reads a clean file with nothing to warn about', async () => {
    const sheet = await parseExample()
    assert.deepEqual(sheet.warnings, [])
  })

  it('maps day columns across a month boundary using the C3 period', async () => {
    // Row 4 reads 26 27 28 29 30 31 1 2 3 4 — the day numbers alone cannot say
    // which month the 1st belongs to.
    const sheet = await parseExample()
    const dates = [...new Set(sheet.employees.flatMap((e) => e.punches.map((p) => p.date)))].sort()
    assert.ok(dates.includes('2026-07-31'), 'expected the last day of July')
    assert.ok(dates.includes('2026-08-01'), 'expected the first day of August')
    assert.equal(dates.at(-1), '2026-08-04')
  })

  it('aligns the first data column to the first day of the period, not to column C', async () => {
    // Employee 3042's first punch sits in column C, which is the third column
    // and therefore the 28th — reading it as the period's first day would slide
    // every punch in the file two days early.
    const sheet = await parseExample()
    const employee = sheet.employees.find((e) => e.fingerprintCode === '3042')
    assert.ok(employee)
    assert.deepEqual(employee.punches[0], { date: '2026-07-28', time: '07:47' })
  })

  it('reads a full day as four punches, in order', async () => {
    const sheet = await parseExample()
    const employee = sheet.employees.find((e) => e.fingerprintCode === '3042')
    assert.ok(employee)
    const day = employee.punches.filter((punch) => punch.date === '2026-07-28')
    assert.deepEqual(
      day.map((punch) => punch.time),
      ['07:47', '12:01', '12:45', '17:03']
    )
  })

  it('keeps the three punches of the day the export was generated on', async () => {
    // 2026-08-04 is the generation date: everyone is clocked in and back from
    // lunch, and nobody has gone home yet.
    const sheet = await parseExample()
    for (const code of ['3042', '3041', '3051']) {
      const employee = sheet.employees.find((e) => e.fingerprintCode === code)
      assert.ok(employee, `expected employee ${code}`)
      const lastDay = employee.punches.filter((punch) => punch.date === '2026-08-04')
      assert.equal(lastDay.length, 3, `expected 3 punches on the export date for ${code}`)
    }
  })

  it('keeps an employee the terminal listed but recorded nothing for', async () => {
    const sheet = await parseExample()
    for (const code of ['2020', '2037']) {
      const employee = sheet.employees.find((e) => e.fingerprintCode === code)
      assert.ok(employee, `expected employee ${code}`)
      assert.deepEqual(employee.punches, [], `expected no punches for ${code}`)
    }
  })

  it('rejects a file that is not a workbook at all', async () => {
    const result = await parseAttendanceImport(Buffer.from('not a spreadsheet'))
    assert.equal(result.ok, false)
  })
})
