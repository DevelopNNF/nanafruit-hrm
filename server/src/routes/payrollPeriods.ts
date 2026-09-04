import { Router } from 'express'
import type { Request, Response } from 'express'
import {
  PAYROLL_PERIOD_STATUSES,
  ROLES,
  type AuthUser,
  type PayrollCalculateResponse,
  type PayrollPeriodApproveInput,
  type PayrollPeriodListResponse,
  type PayrollPeriodPreviewResponse,
  type PayrollPeriodResponse,
  type PayrollPeriodStatus,
} from '@hrm/shared'
import { pool, withTransaction } from '../db.js'
import { requireRole } from '../auth/middleware.js'
import { recordAudit } from '../audit.js'
import { fail, handleUnexpected } from '../http.js'
import { cycleOf, findPayrollGroupById } from '../payrollGroupQueries.js'
import {
  SELECT_PAYROLL_PERIOD,
  findPayrollPeriodById,
  listPayrollPeriods,
  rowToPayrollPeriod,
  type PayrollPeriodRow,
} from '../payrollPeriodQueries.js'
import { calculatePayrollEntries } from '../payrollEntryQueries.js'
import { buildPayrollPeriodReportWorkbook } from '../payrollReportExport.js'
import {
  canTransition,
  derivePeriodWindow,
  isEditableStatus,
  windowDayCount,
} from '../payrollPeriod.js'

export const payrollPeriodsRouter = Router()

// Same split as payrollGroups.ts, and for the same reason: any role may look
// at the calendar of pay runs, only payroll may change it.
const canRead = requireRole(...ROLES)
const canWritePayroll = requireRole('HRM.Payroll', 'HRM.Admin')

function actorOf(req: Request): AuthUser | null {
  return req.auth ?? null
}

function actorColumns(actor: AuthUser): [string, string] {
  return actor.kind === 'admin' ? ['admin', actor.oid] : ['employee', String(actor.employeeId)]
}

function parseId(value: string | string[] | undefined): number | null {
  if (typeof value !== 'string') return null
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

function optionalDate(source: Record<string, unknown>, key: string): string | null | 'invalid' {
  const value = source[key]
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'invalid'
  return value
}

/** 23P01, raised by payroll_periods_no_overlap. */
function isExclusionViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23P01'
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505'
}

const OVERLAP_MESSAGE =
  'ช่วงวันที่ของงวดนี้ทับซ้อนกับงวดอื่นของกลุ่มเดียวกัน — วันเดียวกันจะถูกจ่ายสองรอบ'

const DUPLICATE_CODE_MESSAGE = 'งวดนี้ถูกสร้างไว้แล้วสำหรับกลุ่มนี้'

/** The window a period would get. Also used by POST when the caller sends only
 *  a group and a code, so the derivation lives in exactly one place. */
async function windowFor(
  groupId: number,
  periodCode: string
): Promise<
  | { kind: 'ok'; periodStart: string; periodEnd: string; payDate: string }
  | { kind: 'no_group' }
  | { kind: 'bad_code' }
> {
  const group = await findPayrollGroupById(groupId)
  if (!group) return { kind: 'no_group' }

  const window = derivePeriodWindow(periodCode, cycleOf(group))
  if (!window) return { kind: 'bad_code' }

  return { kind: 'ok', ...window }
}

payrollPeriodsRouter.get('/payroll-periods', canRead, async (req: Request, res: Response) => {
  const groupIdRaw = req.query['groupId']
  const statusRaw = req.query['status']

  const filter: { groupId?: number; status?: PayrollPeriodStatus } = {}

  if (typeof groupIdRaw === 'string' && groupIdRaw !== '') {
    const groupId = parseId(groupIdRaw)
    if (groupId === null) return fail(res, 400, 'groupId must be a positive integer')
    filter.groupId = groupId
  }

  if (typeof statusRaw === 'string' && statusRaw !== '') {
    if (!(PAYROLL_PERIOD_STATUSES as readonly string[]).includes(statusRaw)) {
      return fail(res, 400, `status must be one of: ${PAYROLL_PERIOD_STATUSES.join(', ')}`)
    }
    filter.status = statusRaw as PayrollPeriodStatus
  }

  try {
    const payrollPeriods = await listPayrollPeriods(filter)
    const body: PayrollPeriodListResponse = { payrollPeriods }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

// Declared before '/payroll-periods/:id' on purpose: Express matches in order,
// so the other way round this reads as a period with the id "preview".
payrollPeriodsRouter.get(
  '/payroll-periods/preview',
  canRead,
  async (req: Request, res: Response) => {
    const groupIdRaw = req.query['groupId']
    const periodCode = req.query['periodCode']

    const groupId = typeof groupIdRaw === 'string' ? parseId(groupIdRaw) : null
    if (groupId === null) return fail(res, 400, 'groupId must be a positive integer')
    if (typeof periodCode !== 'string') return fail(res, 400, 'periodCode is required')

    try {
      const window = await windowFor(groupId, periodCode)
      if (window.kind === 'no_group') return fail(res, 400, `no payroll group with id ${groupId}`)
      if (window.kind === 'bad_code') return fail(res, 400, 'periodCode must look like 2026-08')

      const body: PayrollPeriodPreviewResponse = {
        periodStart: window.periodStart,
        periodEnd: window.periodEnd,
        payDate: window.payDate,
        dayCount: windowDayCount(window),
      }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

payrollPeriodsRouter.get('/payroll-periods/:id', canRead, async (req: Request, res: Response) => {
  const id = parseId(req.params['id'])
  if (id === null) return fail(res, 400, 'id must be a positive integer')

  try {
    const payrollPeriod = await findPayrollPeriodById(id)
    if (!payrollPeriod) return fail(res, 404, `no payroll period with id ${id}`)

    const body: PayrollPeriodResponse = { payrollPeriod }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

// A management report of every entry in the period, as .xlsx — draft and
// voided are excluded because calculate has either never run (draft) or the
// figures were abandoned (voided); everything from 'calculating' onward has
// real entries worth exporting.
payrollPeriodsRouter.get(
  '/payroll-periods/:id/export',
  canRead,
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor) return fail(res, 500, 'server misconfigured')

    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    try {
      const payrollPeriod = await findPayrollPeriodById(id)
      if (!payrollPeriod) return fail(res, 404, `no payroll period with id ${id}`)
      if (payrollPeriod.status === 'draft' || payrollPeriod.status === 'voided') {
        return fail(res, 409, 'งวดนี้ยังไม่ได้เริ่มคำนวณ หรือถูกยกเลิกไปแล้ว ส่งออกไม่ได้')
      }

      const { buffer, entryCount } = await buildPayrollPeriodReportWorkbook(id, payrollPeriod.periodCode)

      await recordAudit(pool, {
        actor,
        action: 'payroll_period.export',
        entityId: id,
        detail: { periodCode: payrollPeriod.periodCode, entryCount },
      })

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      )
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="payroll-${payrollPeriod.periodCode}-${payrollPeriod.payrollGroupId}.xlsx"`
      )
      res.send(buffer)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

// The window is derived from the group's cut-off day unless the caller sends
// one, which is what the form does after HR edits the derived dates. Storing it
// rather than deriving it on every read is deliberate: a group's cutoff_day can
// change, and a period that has already been paid must not move underneath the
// figures calculated against it.
payrollPeriodsRouter.post('/payroll-periods', canWritePayroll, async (req: Request, res: Response) => {
  const actor = actorOf(req)
  if (!actor) return fail(res, 500, 'server misconfigured')

  if (typeof req.body !== 'object' || req.body === null) {
    return fail(res, 400, 'body must be a JSON object')
  }
  const raw = req.body as Record<string, unknown>

  const payrollGroupId = typeof raw['payrollGroupId'] === 'number' ? raw['payrollGroupId'] : null
  if (payrollGroupId === null || !Number.isInteger(payrollGroupId) || payrollGroupId <= 0) {
    return fail(res, 400, 'payrollGroupId is required and must be a positive integer')
  }

  const periodCode = raw['periodCode']
  if (typeof periodCode !== 'string') return fail(res, 400, 'periodCode is required')

  const note = typeof raw['note'] === 'string' && raw['note'].trim() !== '' ? raw['note'].trim() : null

  const startInput = optionalDate(raw, 'periodStart')
  const endInput = optionalDate(raw, 'periodEnd')
  const payInput = optionalDate(raw, 'payDate')
  if (startInput === 'invalid' || endInput === 'invalid' || payInput === 'invalid') {
    return fail(res, 400, 'periodStart, periodEnd and payDate must be YYYY-MM-DD when given')
  }

  try {
    const derived = await windowFor(payrollGroupId, periodCode)
    if (derived.kind === 'no_group') {
      return fail(res, 400, `no payroll group with id ${payrollGroupId}`)
    }
    if (derived.kind === 'bad_code') return fail(res, 400, 'periodCode must look like 2026-08')

    const periodStart = startInput ?? derived.periodStart
    const periodEnd = endInput ?? derived.periodEnd
    const payDate = payInput ?? derived.payDate

    // Checked here as well as by the table's CHECKs so an edited window comes
    // back as a sentence rather than a 500.
    if (periodEnd <= periodStart) {
      return fail(res, 400, 'วันสิ้นสุดงวดต้องอยู่หลังวันเริ่มงวด')
    }
    if (payDate < periodEnd) {
      return fail(res, 400, 'วันจ่ายเงินต้องไม่อยู่ก่อนวันสิ้นสุดงวด')
    }

    const [actorKind, actorId] = actorColumns(actor)

    const payrollPeriod = await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO payroll_periods
           (payroll_group_id, period_code, period_start, period_end, pay_date,
            note, created_by_kind, created_by_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [payrollGroupId, periodCode, periodStart, periodEnd, payDate, note, actorKind, actorId]
      )
      const created = rows[0]
      if (!created) throw new Error('insert into payroll_periods returned no id')

      await recordAudit(client, {
        actor,
        action: 'payroll_period.create',
        entityId: Number(created.id),
        detail: { periodCode, periodStart, periodEnd, payDate },
      })

      const { rows: readBack } = await client.query<PayrollPeriodRow>(
        `${SELECT_PAYROLL_PERIOD} WHERE p.id = $1`,
        [Number(created.id)]
      )
      const row = readBack[0]
      if (!row) throw new Error('payroll period vanished inside its own transaction')
      return rowToPayrollPeriod(row)
    })

    const body: PayrollPeriodResponse = { payrollPeriod }
    res.status(201).json(body)
  } catch (err) {
    if (isExclusionViolation(err)) return fail(res, 409, OVERLAP_MESSAGE)
    if (isUniqueViolation(err)) return fail(res, 409, DUPLICATE_CODE_MESSAGE)
    handleUnexpected(res, err)
  }
})

// Dates and note only. The group and the period code are not editable: changing
// either is creating a different period, and the row it would overwrite has
// already been referred to by everything downstream of it.
payrollPeriodsRouter.patch(
  '/payroll-periods/:id',
  canWritePayroll,
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor) return fail(res, 500, 'server misconfigured')

    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    if (typeof req.body !== 'object' || req.body === null) {
      return fail(res, 400, 'body must be a JSON object')
    }
    const raw = req.body as Record<string, unknown>

    const periodStart = optionalDate(raw, 'periodStart')
    const periodEnd = optionalDate(raw, 'periodEnd')
    const payDate = optionalDate(raw, 'payDate')
    if (
      periodStart === 'invalid' ||
      periodEnd === 'invalid' ||
      payDate === 'invalid' ||
      periodStart === null ||
      periodEnd === null ||
      payDate === null
    ) {
      return fail(res, 400, 'periodStart, periodEnd and payDate are required, as YYYY-MM-DD')
    }
    if (periodEnd <= periodStart) return fail(res, 400, 'วันสิ้นสุดงวดต้องอยู่หลังวันเริ่มงวด')
    if (payDate < periodEnd) return fail(res, 400, 'วันจ่ายเงินต้องไม่อยู่ก่อนวันสิ้นสุดงวด')

    const note =
      typeof raw['note'] === 'string' && raw['note'].trim() !== '' ? raw['note'].trim() : null

    try {
      const result = await withTransaction(async (client) => {
        // FOR UPDATE, then check the status — the same guard
        // POST /leave-requests/:id/approve uses, and for the same reason: two
        // people acting at once would otherwise both read 'draft'.
        const { rows } = await client.query<{ status: string }>(
          `SELECT status FROM payroll_periods WHERE id = $1 FOR UPDATE`,
          [id]
        )
        const row = rows[0]
        if (!row) return { kind: 'not_found' as const }
        if (!isEditableStatus(row.status as PayrollPeriodStatus)) {
          return {
            kind: 'conflict' as const,
            message: 'งวดนี้พ้นสถานะร่างแล้ว แก้ช่วงวันที่ไม่ได้',
          }
        }

        await client.query(
          `UPDATE payroll_periods
           SET period_start = $2, period_end = $3, pay_date = $4, note = $5, updated_at = now()
           WHERE id = $1`,
          [id, periodStart, periodEnd, payDate, note]
        )

        await recordAudit(client, {
          actor,
          action: 'payroll_period.update',
          entityId: id,
          detail: { periodStart, periodEnd, payDate },
        })

        const { rows: readBack } = await client.query<PayrollPeriodRow>(
          `${SELECT_PAYROLL_PERIOD} WHERE p.id = $1`,
          [id]
        )
        const updated = readBack[0]
        if (!updated) throw new Error('payroll period vanished inside its own transaction')
        return { kind: 'ok' as const, payrollPeriod: rowToPayrollPeriod(updated) }
      })

      if (result.kind === 'not_found') return fail(res, 404, `no payroll period with id ${id}`)
      if (result.kind === 'conflict') return fail(res, 409, result.message)

      const body: PayrollPeriodResponse = { payrollPeriod: result.payrollPeriod }
      res.json(body)
    } catch (err) {
      if (isExclusionViolation(err)) return fail(res, 409, OVERLAP_MESSAGE)
      handleUnexpected(res, err)
    }
  }
)

// Voiding, not deleting. The row stays, its window stops blocking the month it
// occupied (both the EXCLUDE constraint and the unique index skip voided rows),
// and the reason stays readable next to it.
payrollPeriodsRouter.post(
  '/payroll-periods/:id/void',
  canWritePayroll,
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor) return fail(res, 500, 'server misconfigured')

    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    const raw = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<
      string,
      unknown
    >
    const voidReason = typeof raw['voidReason'] === 'string' ? raw['voidReason'].trim() : ''
    if (voidReason === '') return fail(res, 400, 'กรุณาระบุเหตุผลในการยกเลิกงวด')

    try {
      const result = await withTransaction(async (client) => {
        const { rows } = await client.query<{ status: string }>(
          `SELECT status FROM payroll_periods WHERE id = $1 FOR UPDATE`,
          [id]
        )
        const row = rows[0]
        if (!row) return { kind: 'not_found' as const }

        const status = row.status as PayrollPeriodStatus
        if (!canTransition(status, 'voided')) {
          return {
            kind: 'conflict' as const,
            message:
              status === 'voided'
                ? 'งวดนี้ถูกยกเลิกไปแล้ว'
                : 'งวดนี้จ่ายเงินไปแล้ว ยกเลิกไม่ได้ — ต้องแก้ด้วยรายการปรับปรุงในงวดถัดไป',
          }
        }

        await client.query(
          `UPDATE payroll_periods
           SET status = 'voided', voided_at = now(), void_reason = $2, updated_at = now()
           WHERE id = $1`,
          [id, voidReason]
        )

        await recordAudit(client, {
          actor,
          action: 'payroll_period.void',
          entityId: id,
          detail: { from: status, voidReason },
        })

        const { rows: readBack } = await client.query<PayrollPeriodRow>(
          `${SELECT_PAYROLL_PERIOD} WHERE p.id = $1`,
          [id]
        )
        const updated = readBack[0]
        if (!updated) throw new Error('payroll period vanished inside its own transaction')
        return { kind: 'ok' as const, payrollPeriod: rowToPayrollPeriod(updated) }
      })

      if (result.kind === 'not_found') return fail(res, 404, `no payroll period with id ${id}`)
      if (result.kind === 'conflict') return fail(res, 409, result.message)

      const body: PayrollPeriodResponse = { payrollPeriod: result.payrollPeriod }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

// Basic-wage calculation (Phase 2). Rebuilds every payroll_entries row for
// the period from scratch, so calling this again on a still-draft/calculating
// period is how HR re-runs it after fixing an attendance record or a wage —
// not a separate "recalculate" endpoint. Blocked once the period has moved
// past review: those figures are what got approved, and calculate silently
// changing them underneath an approval would defeat the point of having one.
payrollPeriodsRouter.post(
  '/payroll-periods/:id/calculate',
  canWritePayroll,
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor) return fail(res, 500, 'server misconfigured')

    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    try {
      const result = await withTransaction((client) => calculatePayrollEntries(id, actor, client))

      if (result.kind === 'not_found') return fail(res, 404, `no payroll period with id ${id}`)
      if (result.kind === 'conflict') return fail(res, 409, result.message)

      const payrollPeriod = await findPayrollPeriodById(id)
      if (!payrollPeriod) throw new Error('payroll period vanished after its own calculation')

      const body: PayrollCalculateResponse = {
        payrollPeriod,
        entryCount: result.entryCount,
        needsReviewCount: result.needsReviewCount,
      }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

// Freezes the entries calculate built: past this point calculate refuses to
// run again (it only accepts 'draft'/'calculating'), so nobody's numbers can
// shift out from under whoever is reviewing them. Reopening is the way back.
payrollPeriodsRouter.post(
  '/payroll-periods/:id/submit-for-review',
  canWritePayroll,
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor) return fail(res, 500, 'server misconfigured')

    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    try {
      const result = await withTransaction(async (client) => {
        const { rows } = await client.query<{ status: string }>(
          `SELECT status FROM payroll_periods WHERE id = $1 FOR UPDATE`,
          [id]
        )
        const row = rows[0]
        if (!row) return { kind: 'not_found' as const }

        const status = row.status as PayrollPeriodStatus
        if (status !== 'calculating') {
          return {
            kind: 'conflict' as const,
            message: 'ส่งตรวจสอบได้เฉพาะงวดที่คำนวณแล้วเท่านั้น',
          }
        }

        await client.query(
          `UPDATE payroll_periods SET status = 'review', updated_at = now() WHERE id = $1`,
          [id]
        )

        await recordAudit(client, {
          actor,
          action: 'payroll_period.submit_for_review',
          entityId: id,
          detail: { from: status },
        })

        const { rows: readBack } = await client.query<PayrollPeriodRow>(
          `${SELECT_PAYROLL_PERIOD} WHERE p.id = $1`,
          [id]
        )
        const updated = readBack[0]
        if (!updated) throw new Error('payroll period vanished inside its own transaction')
        return { kind: 'ok' as const, payrollPeriod: rowToPayrollPeriod(updated) }
      })

      if (result.kind === 'not_found') return fail(res, 404, `no payroll period with id ${id}`)
      if (result.kind === 'conflict') return fail(res, 409, result.message)

      const body: PayrollPeriodResponse = { payrollPeriod: result.payrollPeriod }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

// The way back out of review to fix something: HR found a problem while
// checking entries, so this drops the period to 'draft', where calculate is
// legal again. It does not touch payroll_entries — the next calculate call
// deletes and reinserts them anyway, which also clears every reviewed_at.
payrollPeriodsRouter.post(
  '/payroll-periods/:id/reopen',
  canWritePayroll,
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor) return fail(res, 500, 'server misconfigured')

    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    try {
      const result = await withTransaction(async (client) => {
        const { rows } = await client.query<{ status: string }>(
          `SELECT status FROM payroll_periods WHERE id = $1 FOR UPDATE`,
          [id]
        )
        const row = rows[0]
        if (!row) return { kind: 'not_found' as const }

        const status = row.status as PayrollPeriodStatus
        if (status !== 'review') {
          return {
            kind: 'conflict' as const,
            message: 'เปิดกลับไปแก้ไขได้เฉพาะงวดที่อยู่ในขั้นตอนตรวจสอบเท่านั้น',
          }
        }

        await client.query(
          `UPDATE payroll_periods SET status = 'draft', updated_at = now() WHERE id = $1`,
          [id]
        )

        await recordAudit(client, {
          actor,
          action: 'payroll_period.reopen',
          entityId: id,
          detail: { from: status },
        })

        const { rows: readBack } = await client.query<PayrollPeriodRow>(
          `${SELECT_PAYROLL_PERIOD} WHERE p.id = $1`,
          [id]
        )
        const updated = readBack[0]
        if (!updated) throw new Error('payroll period vanished inside its own transaction')
        return { kind: 'ok' as const, payrollPeriod: rowToPayrollPeriod(updated) }
      })

      if (result.kind === 'not_found') return fail(res, 404, `no payroll period with id ${id}`)
      if (result.kind === 'conflict') return fail(res, 409, result.message)

      const body: PayrollPeriodResponse = { payrollPeriod: result.payrollPeriod }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

// The sign-off. Blocked while any needs_review entry still has
// reviewed_at === null unless the caller explicitly says to proceed anyway —
// acknowledgeUnreviewed is checked server-side, not just disabled in the UI,
// because this is the step that says "pay these people" and a direct API
// call must not skip it. Entries the system did not flag never enter this
// count at all, matching setEntryReviewed's own needs_review guard.
payrollPeriodsRouter.post(
  '/payroll-periods/:id/approve',
  canWritePayroll,
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor) return fail(res, 500, 'server misconfigured')

    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    const raw = (
      typeof req.body === 'object' && req.body !== null ? req.body : {}
    ) as PayrollPeriodApproveInput
    const acknowledgeUnreviewed = raw.acknowledgeUnreviewed === true

    try {
      const result = await withTransaction(async (client) => {
        const { rows } = await client.query<{ status: string }>(
          `SELECT status FROM payroll_periods WHERE id = $1 FOR UPDATE`,
          [id]
        )
        const row = rows[0]
        if (!row) return { kind: 'not_found' as const }

        const status = row.status as PayrollPeriodStatus
        if (status !== 'review') {
          return {
            kind: 'conflict' as const,
            message: 'อนุมัติได้เฉพาะงวดที่อยู่ในขั้นตอนตรวจสอบเท่านั้น',
          }
        }

        const { rows: countRows } = await client.query<{ count: string }>(
          `SELECT count(*) FROM payroll_entries
           WHERE payroll_period_id = $1 AND needs_review AND reviewed_at IS NULL`,
          [id]
        )
        const unreviewedCount = Number(countRows[0]?.count ?? 0)
        if (unreviewedCount > 0 && !acknowledgeUnreviewed) {
          return {
            kind: 'conflict' as const,
            message: `ยังมี ${unreviewedCount} คนที่ยังไม่ได้ทำเครื่องหมายว่าตรวจสอบแล้ว`,
          }
        }

        await client.query(
          `UPDATE payroll_periods SET status = 'approved', updated_at = now() WHERE id = $1`,
          [id]
        )

        await recordAudit(client, {
          actor,
          action: 'payroll_period.approve',
          entityId: id,
          detail: unreviewedCount > 0 ? { approvedWithUnreviewed: unreviewedCount } : {},
        })

        const { rows: readBack } = await client.query<PayrollPeriodRow>(
          `${SELECT_PAYROLL_PERIOD} WHERE p.id = $1`,
          [id]
        )
        const updated = readBack[0]
        if (!updated) throw new Error('payroll period vanished inside its own transaction')
        return { kind: 'ok' as const, payrollPeriod: rowToPayrollPeriod(updated) }
      })

      if (result.kind === 'not_found') return fail(res, 404, `no payroll period with id ${id}`)
      if (result.kind === 'conflict') return fail(res, 409, result.message)

      const body: PayrollPeriodResponse = { payrollPeriod: result.payrollPeriod }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

// Undoes an approval before Phase 8's payment file ever turns it into 'paid'
// — HR spotted a problem after signing off. Drops back to 'review'; every
// entry keeps whatever reviewed_at it already had, since the numbers behind
// it have not changed.
payrollPeriodsRouter.post(
  '/payroll-periods/:id/unapprove',
  canWritePayroll,
  async (req: Request, res: Response) => {
    const actor = actorOf(req)
    if (!actor) return fail(res, 500, 'server misconfigured')

    const id = parseId(req.params['id'])
    if (id === null) return fail(res, 400, 'id must be a positive integer')

    try {
      const result = await withTransaction(async (client) => {
        const { rows } = await client.query<{ status: string }>(
          `SELECT status FROM payroll_periods WHERE id = $1 FOR UPDATE`,
          [id]
        )
        const row = rows[0]
        if (!row) return { kind: 'not_found' as const }

        const status = row.status as PayrollPeriodStatus
        if (status !== 'approved') {
          return {
            kind: 'conflict' as const,
            message: 'ถอนการอนุมัติได้เฉพาะงวดที่อนุมัติแล้วเท่านั้น',
          }
        }

        await client.query(
          `UPDATE payroll_periods SET status = 'review', updated_at = now() WHERE id = $1`,
          [id]
        )

        await recordAudit(client, {
          actor,
          action: 'payroll_period.unapprove',
          entityId: id,
          detail: { from: status },
        })

        const { rows: readBack } = await client.query<PayrollPeriodRow>(
          `${SELECT_PAYROLL_PERIOD} WHERE p.id = $1`,
          [id]
        )
        const updated = readBack[0]
        if (!updated) throw new Error('payroll period vanished inside its own transaction')
        return { kind: 'ok' as const, payrollPeriod: rowToPayrollPeriod(updated) }
      })

      if (result.kind === 'not_found') return fail(res, 404, `no payroll period with id ${id}`)
      if (result.kind === 'conflict') return fail(res, 409, result.message)

      const body: PayrollPeriodResponse = { payrollPeriod: result.payrollPeriod }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)
