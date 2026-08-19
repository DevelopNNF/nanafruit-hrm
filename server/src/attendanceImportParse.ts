// Reading a fingerprint terminal's attendance export into plain wall-clock
// punches. Pure: bytes in, punches out, no database and no timezone maths —
// deciding which punch is a check-in and which is a check-out needs the
// employee's shift, and that lives in attendanceImportClassify.ts.
//
// The layout this understands, as produced by the terminal in use (see the
// example sheet in the repo's fixtures):
//
//     A1:AE2  merged report title
//     C3      "2026-07-26 ~ 2026-08-04"   the period the export covers
//     L3      "2026-08-04"                the day it was generated
//     row 4   26 27 28 29 30 31 1 2 3 4   one column per day, starting at A
//     row 5   ID: _ 3042 ... ชื่อ: ... แผนก: ... บริษัท
//     row 6   punches for 3042, one cell per day, aligned to row 4
//     row 7   ID: for the next employee, and so on in pairs
//
// Two details are easy to get wrong and are worth stating plainly. First, the
// day columns begin at column A, not at column C where the ID happens to sit —
// C only looks like the first data column because the sample's employees have
// nothing on the first two days. Second, a cell holds its punches concatenated
// with no separator ("07:4712:0112:4517:03"), and the count is not fixed: four
// on a normal day, three when the export ran before someone clocked out, two
// when they left mid-morning.

import readXlsxFile from 'read-excel-file/node'

/** One punch as the sheet states it: a calendar date and a wall-clock time,
 *  both in Thailand local terms. Not an instant — see the module comment. */
export type ParsedPunch = {
  /** 'YYYY-MM-DD', resolved from the row-4 header against the C3 period. */
  date: string
  /** 'HH:MM', 24-hour. */
  time: string
}

export type ParsedImportEmployee = {
  fingerprintCode: string
  /** The ชื่อ: cell, when the terminal filled it in. Never used to identify
   *  anyone — the fingerprint code is the join key — but shown in the preview
   *  so HR can sanity-check the match against a name they recognise. */
  nameInFile: string | null
  /** 1-based row of the ID: cell, so a warning can point at the sheet. */
  rowNumber: number
  /** Chronological, deduplicated. Empty for an employee the terminal listed
   *  but recorded nothing for. */
  punches: ParsedPunch[]
}

export type ParsedImportSheet = {
  /** Inclusive period from C3, 'YYYY-MM-DD'. */
  rangeFrom: string
  rangeTo: string
  /** The export's own generation date from L3, when present. */
  generatedOn: string | null
  employees: ParsedImportEmployee[]
  /** Recoverable oddities: a malformed cell, a repeated code, a stray row.
   *  Shown in the preview so HR decides whether to go on. Anything that makes
   *  the sheet unreadable is a failure instead. */
  warnings: string[]
}

export type ParseImportResult =
  | { ok: true; value: ParsedImportSheet }
  | { ok: false; message: string }

/** Cell coordinates are 0-based indices into the row arrays below; these name
 *  the fixed ones so the code reads as the sheet does. */
const PERIOD_ROW = 2 // sheet row 3
const PERIOD_COL = 2 // column C
const GENERATED_COL = 11 // column L
const HEADER_ROW = 3 // sheet row 4 — the day-of-month header
const FIRST_ID_ROW = 4 // sheet row 5 — first "ID:" block

const ID_LABEL = 'ID:'
const NAME_LABEL = 'ชื่อ:'

const PERIOD_RE = /^(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
/** Deliberately strict two-digit groups. A terminal emitting "7:47" would slip
 *  past a \d{1,2} version by silently re-cutting the whole concatenated run in
 *  the wrong places; with this, the reconstruction check below catches it and
 *  says so instead. */
const TIME_RE = /(\d{2}):(\d{2})/g

type Cell = string | number | boolean | Date | null

/**
 * read-excel-file@9 answers with one entry per sheet rather than the bare row
 * array older versions returned. Narrowed here, once, so a future bump that
 * changes it back fails with a sentence instead of a TypeError three functions
 * deep.
 */
function firstSheetRows(parsed: unknown): Cell[][] {
  if (!Array.isArray(parsed)) throw new Error('unexpected shape from read-excel-file')
  const first = parsed[0]
  if (Array.isArray(first)) return parsed as Cell[][]
  if (first && typeof first === 'object' && Array.isArray((first as { data?: unknown }).data)) {
    return (first as { data: Cell[][] }).data
  }
  throw new Error('unexpected shape from read-excel-file')
}

function cellAt(rows: Cell[][], row: number, col: number): Cell {
  return rows[row]?.[col] ?? null
}

function textAt(rows: Cell[][], row: number, col: number): string | null {
  const value = cellAt(rows, row, col)
  if (value === null) return null
  const text = value instanceof Date ? toDateString(value) : String(value).trim()
  return text === '' ? null : text
}

/** Local calendar date of a Date, as 'YYYY-MM-DD'. read-excel-file hands back
 *  UTC-midnight Dates for date-formatted cells, so this reads them back the
 *  way they were written rather than shifting a day west. */
function toDateString(value: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`
}

/** `dateStr` shifted by whole days, staying a pure calendar operation — noon
 *  UTC so no DST or offset rounding can move the day. */
function addDays(dateStr: string, days: number): string {
  const base = new Date(`${dateStr}T12:00:00Z`)
  base.setUTCDate(base.getUTCDate() + days)
  return toDateString(base)
}

function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)
  return Math.round(ms / 86_400_000)
}

function isRowEmpty(row: Cell[] | undefined): boolean {
  return !row || row.every((cell) => cell === null || String(cell).trim() === '')
}

/** The value of a labelled cell: the first non-empty cell to the right of the
 *  label. The terminal pads its labels with a variable number of blank columns
 *  (ID: sits in A with its value in C), so the offset is found, not assumed. */
function valueAfterLabel(row: Cell[], label: string): string | null {
  const labelIndex = row.findIndex((cell) => typeof cell === 'string' && cell.trim() === label)
  if (labelIndex === -1) return null
  for (let col = labelIndex + 1; col < row.length; col++) {
    const cell = row[col]
    if (cell === null || cell === undefined) continue
    const text = String(cell).trim()
    if (text !== '') return text
  }
  return null
}

/**
 * The day-of-month header in row 4, resolved to full dates.
 *
 * The header carries only a day number, so a period crossing a month boundary
 * (26..31 then 1..4) is ambiguous on its own. Rather than guess a rollover,
 * each column is checked against the date the period says it must be: column i
 * is `rangeFrom + i` days, and its header must agree on the day of month. A
 * mismatch means the two halves of the sheet disagree about what it covers,
 * which is not something to paper over.
 */
function resolveDateColumns(
  rows: Cell[][],
  rangeFrom: string,
  rangeTo: string
): { ok: true; dates: string[] } | { ok: false; message: string } {
  const header = rows[HEADER_ROW] ?? []
  const dayNumbers: number[] = []
  for (const cell of header) {
    if (cell === null || String(cell).trim() === '') break // headers are contiguous from column A
    const day = Number(String(cell).trim())
    if (!Number.isInteger(day) || day < 1 || day > 31) {
      return {
        ok: false,
        message: `แถวที่ 4 มีหัวคอลัมน์วันที่ไม่ถูกต้อง: "${String(cell)}"`,
      }
    }
    dayNumbers.push(day)
  }

  const expectedLength = daysBetween(rangeFrom, rangeTo) + 1
  if (dayNumbers.length !== expectedLength) {
    return {
      ok: false,
      message: `ช่วงวันที่ใน C3 (${rangeFrom} ~ ${rangeTo}) มี ${expectedLength} วัน แต่แถวที่ 4 มีหัวคอลัมน์ ${dayNumbers.length} คอลัมน์`,
    }
  }

  const dates: string[] = []
  for (let i = 0; i < dayNumbers.length; i++) {
    const date = addDays(rangeFrom, i)
    const dayOfMonth = Number(date.slice(8, 10))
    if (dayOfMonth !== dayNumbers[i]) {
      return {
        ok: false,
        message: `หัวคอลัมน์วันที่ในแถวที่ 4 ไม่ตรงกับช่วงใน C3 — คอลัมน์ที่ ${i + 1} ควรเป็นวันที่ ${dayOfMonth} แต่ระบุ ${dayNumbers[i]}`,
      }
    }
    dates.push(date)
  }
  return { ok: true, dates }
}

/**
 * The times concatenated into one day's cell, split apart.
 *
 * Returns null when the cell holds anything the strict HH:MM reading cannot
 * account for — the caller turns that into a warning naming the cell rather
 * than importing a half-understood value.
 */
export function splitPunchTimes(raw: string): string[] | null {
  const text = raw.replace(/\s+/g, '')
  if (text === '') return []

  const times: string[] = []
  for (const match of text.matchAll(TIME_RE)) {
    const hours = Number(match[1])
    const minutes = Number(match[2])
    if (hours > 23 || minutes > 59) return null
    times.push(`${match[1]}:${match[2]}`)
  }
  // Every character has to be accounted for. Without this a cell like
  // "07:47x12:01" or "7:4712:01" would quietly import whichever fragments
  // happened to match.
  if (times.join('') !== text) return null
  return times
}

/**
 * Parses one uploaded workbook.
 *
 * Structural problems fail the whole sheet (there is nothing useful to import
 * from a file whose period or day columns cannot be read). Per-employee and
 * per-cell problems become warnings and skip only what they touch, so one bad
 * cell does not cost HR the other twelve people in the file.
 */
export async function parseAttendanceImport(file: Buffer): Promise<ParseImportResult> {
  let rows: Cell[][]
  try {
    rows = firstSheetRows(await readXlsxFile(file))
  } catch (err) {
    return {
      ok: false,
      message: `อ่านไฟล์ Excel ไม่สำเร็จ: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  const period = textAt(rows, PERIOD_ROW, PERIOD_COL)
  if (period === null) {
    return { ok: false, message: 'ไม่พบช่วงวันที่ในเซลล์ C3 — ไฟล์อาจไม่ใช่รายงานการลงเวลาจากเครื่องสแกน' }
  }
  const periodMatch = PERIOD_RE.exec(period)
  if (!periodMatch) {
    return { ok: false, message: `รูปแบบช่วงวันที่ในเซลล์ C3 ไม่ถูกต้อง: "${period}" (ต้องเป็น YYYY-MM-DD ~ YYYY-MM-DD)` }
  }
  const rangeFrom = periodMatch[1] as string
  const rangeTo = periodMatch[2] as string
  if (Number.isNaN(Date.parse(`${rangeFrom}T00:00:00Z`)) || Number.isNaN(Date.parse(`${rangeTo}T00:00:00Z`))) {
    return { ok: false, message: `ช่วงวันที่ในเซลล์ C3 ไม่ใช่วันที่ที่มีอยู่จริง: "${period}"` }
  }
  if (rangeTo < rangeFrom) {
    return { ok: false, message: `ช่วงวันที่ในเซลล์ C3 กลับด้าน: "${period}"` }
  }

  const columns = resolveDateColumns(rows, rangeFrom, rangeTo)
  if (!columns.ok) return { ok: false, message: columns.message }

  const generatedRaw = textAt(rows, PERIOD_ROW, GENERATED_COL)
  const generatedOn = generatedRaw !== null && DATE_RE.test(generatedRaw) ? generatedRaw : null

  const warnings: string[] = []
  const byCode = new Map<string, ParsedImportEmployee>()

  // Employee blocks are pairs from row 5 down: the odd row identifies who, the
  // even row below it holds their punches.
  for (let row = FIRST_ID_ROW; row < rows.length; row += 2) {
    const idRow = rows[row]
    if (isRowEmpty(idRow) && isRowEmpty(rows[row + 1])) continue
    if (!idRow) continue

    const fingerprintCode = valueAfterLabel(idRow, ID_LABEL)
    if (fingerprintCode === null) {
      warnings.push(`แถวที่ ${row + 1}: ไม่พบรหัสลายนิ้วมือหลังป้าย "${ID_LABEL}" — ข้ามแถวนี้`)
      continue
    }

    const nameInFile = valueAfterLabel(idRow, NAME_LABEL)
    const punches: ParsedPunch[] = []
    const dataRow = rows[row + 1] ?? []

    for (let col = 0; col < columns.dates.length; col++) {
      const cell = dataRow[col]
      if (cell === null || cell === undefined) continue
      const rawText = String(cell).trim()
      if (rawText === '') continue

      const times = splitPunchTimes(rawText)
      if (times === null) {
        warnings.push(
          `รหัส ${fingerprintCode} วันที่ ${columns.dates[col]}: อ่านเวลาไม่ได้ "${rawText}" — ข้ามเซลล์นี้`
        )
        continue
      }
      for (const time of times) punches.push({ date: columns.dates[col] as string, time })
    }

    // A code repeated in one file is malformed rather than fatal — the two
    // blocks are the same person either way, so their punches are merged and
    // the duplicate is called out rather than silently letting the second
    // block replace the first.
    const existing = byCode.get(fingerprintCode)
    if (existing) {
      warnings.push(
        `รหัส ${fingerprintCode} ปรากฏซ้ำในไฟล์ (แถวที่ ${existing.rowNumber} และ ${row + 1}) — รวมข้อมูลเข้าด้วยกัน`
      )
      existing.punches.push(...punches)
      if (existing.nameInFile === null) existing.nameInFile = nameInFile
      continue
    }

    byCode.set(fingerprintCode, { fingerprintCode, nameInFile, rowNumber: row + 1, punches })
  }

  if (byCode.size === 0) {
    return { ok: false, message: 'ไม่พบข้อมูลพนักงานในไฟล์ (ไม่พบป้าย "ID:" ตั้งแต่แถวที่ 5 เป็นต้นไป)' }
  }

  // Chronological and deduplicated per employee: the classifier walks punches
  // in order, and a terminal that recorded the same minute twice should not
  // produce two events.
  for (const employee of byCode.values()) {
    const seen = new Set<string>()
    employee.punches = employee.punches
      .sort((a, b) => (a.date === b.date ? a.time.localeCompare(b.time) : a.date.localeCompare(b.date)))
      .filter((punch) => {
        const key = `${punch.date}T${punch.time}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
  }

  return {
    ok: true,
    value: { rangeFrom, rangeTo, generatedOn, employees: [...byCode.values()], warnings },
  }
}
