import { Router } from 'express'
import type { Request, Response } from 'express'
import {
  ATTENDANCE_DAILY_FILTERS,
  ATTENDANCE_EVENT_TYPES,
  OFF_SITE_DEFAULT_RADIUS_METERS,
  ROLES,
  WORK_LOCATIONS,
  type AttendanceCandidatePunchesResponse,
  type AttendanceClockResponse,
  type AttendanceDailyFilter,
  type AttendanceDailyListResponse,
  type AttendanceEventType,
  type AttendanceListResponse,
  type AttendanceStatusResponse,
  type AttendanceTodayStatus,
  type ConfirmAttendancePunchResponse,
  type WorkLocation,
} from '@hrm/shared'
import { pool, withTransaction } from '../db.js'
import { requireRole } from '../auth/middleware.js'
import { fail, handleUnexpected } from '../http.js'
import { recordAudit } from '../audit.js'
import { findEmployeeById } from '../employeeQueries.js'
import { findActiveLocations } from '../locationQueries.js'
import { findApprovedOffSiteRequestForDate } from '../offSiteRequestQueries.js'
import { distanceMeters, nearestLocation } from '../geo.js'
import {
  findLastAttendanceEvent,
  listAttendanceEvents,
  rowToAttendanceEvent,
  type AttendanceRow,
} from '../attendanceQueries.js'
import { listAttendanceDaily, recomputeAttendanceDaily } from '../attendanceDailyQueries.js'
import { buildAttendanceReportWorkbook } from '../attendanceReportExport.js'
import { chooseAttendanceWindow, matchAttendanceForDates, resolveMatchWindow } from '../attendanceMatchingQueries.js'
import {
  findCandidatePunches,
  isPeriodLockedForEdit,
  resolvePayrollPeriodStatus,
} from '../attendancePunchConfirmQueries.js'
import { addDays, toThailandDateString } from '../shiftAssignmentQueries.js'

export const attendanceRouter = Router()

// Same read split as shifts/jobs: any HRM role may look at the admin list.
// There is no write role here — nothing under /api/attendance/clock or
// /api/attendance/me is admin-writable, an employee can only ever record
// their own events.
const canReadAdmin = requireRole(...ROLES)

// Confirming a punch (and clearing that confirmation) changes what payroll
// sees as a day's worked hours — same write bar as attendanceImport.ts's
// canImport, stricter than canReadAdmin above which every HRM role passes.
const canConfirmPunch = requireRole('HRM.HR', 'HRM.Admin')

/** Both /clock and /me are for the employee arm of AuthUser only — an admin
 *  token has no employeeId to act as, and cannot clock in for someone else. */
function requireEmployeeId(req: Request, res: Response): number | null {
  const auth = req.auth
  if (!auth) {
    fail(res, 500, 'server misconfigured')
    return null
  }
  if (auth.kind !== 'employee') {
    fail(res, 403, 'this endpoint is for employee accounts', 'FORBIDDEN')
    return null
  }
  return auth.employeeId
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string }

/** The wire shape (AttendanceClockRequest) makes coordinates optional, since a
 *  client with no geolocation support may omit them rather than send null —
 *  but once parsed, this code always has a definite number-or-null to reason
 *  about, so the parsed shape drops the "or absent" that only ever mattered
 *  on the wire. */
type ParsedClockInput = {
  eventType: AttendanceEventType
  latitude: number | null
  longitude: number | null
  accuracyMeters: number | null
  deviceInfo: string | null
}

/** A finite number in range, or null/undefined passed through — see
 *  AttendanceClockRequest: coordinates are optional, not just nullable, since
 *  a client with no geolocation support omits them rather than sending null. */
function optionalCoordinate(
  source: Record<string, unknown>,
  key: string,
  min: number,
  max: number
): number | null | undefined {
  const value = source[key]
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    return undefined
  }
  return value
}

function parseClockInput(body: unknown): ParseResult<ParsedClockInput> {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'body must be a JSON object' }
  }
  const raw = body as Record<string, unknown>

  const eventType = raw['eventType']
  if (
    typeof eventType !== 'string' ||
    !ATTENDANCE_EVENT_TYPES.includes(eventType as AttendanceEventType)
  ) {
    return { ok: false, message: `eventType must be one of: ${ATTENDANCE_EVENT_TYPES.join(', ')}` }
  }

  const latitude = optionalCoordinate(raw, 'latitude', -90, 90)
  if (latitude === undefined) return { ok: false, message: 'latitude must be a number between -90 and 90, or null' }

  const longitude = optionalCoordinate(raw, 'longitude', -180, 180)
  if (longitude === undefined) return { ok: false, message: 'longitude must be a number between -180 and 180, or null' }

  if ((latitude === null) !== (longitude === null)) {
    return { ok: false, message: 'latitude and longitude must both be set, or both be empty' }
  }

  const accuracyMeters = optionalCoordinate(raw, 'accuracyMeters', 0, 1_000_000)
  if (accuracyMeters === undefined) {
    return { ok: false, message: 'accuracyMeters must be a non-negative number, or null' }
  }

  // Debugging data, not something a clock event should ever fail over — a
  // wrong type is silently dropped rather than rejected, same reasoning as
  // GPS being optional.
  const deviceInfoRaw = raw['deviceInfo']
  const deviceInfo = typeof deviceInfoRaw === 'string' ? deviceInfoRaw.trim().slice(0, 500) || null : null

  return {
    ok: true,
    value: { eventType: eventType as AttendanceEventType, latitude, longitude, accuracyMeters, deviceInfo },
  }
}

attendanceRouter.post('/attendance/clock', async (req: Request, res: Response) => {
  const employeeId = requireEmployeeId(req, res)
  if (employeeId === null) return

  const parsed = parseClockInput(req.body)
  if (!parsed.ok) return fail(res, 400, parsed.message)
  const input = parsed.value

  try {
    // Bounded to yesterday's and today's buffered match windows (same
    // windows /attendance/me uses to decide what the button should say) so a
    // check_in left dangling from days ago can't masquerade as an open
    // session today, and an overnight shift's post-midnight check_out is
    // still found even though it lands on the next calendar date.
    const now = new Date()
    const todayDate = toThailandDateString(now)
    const yesterdayDate = addDays(todayDate, -1)
    const [yesterdayWindow, todayWindow] = await Promise.all([
      resolveMatchWindow(employeeId, yesterdayDate),
      resolveMatchWindow(employeeId, todayDate),
    ])
    const bound = {
      from: yesterdayWindow.startAt < todayWindow.startAt ? yesterdayWindow.startAt : todayWindow.startAt,
      to: yesterdayWindow.endAt > todayWindow.endAt ? yesterdayWindow.endAt : todayWindow.endAt,
    }

    const last = await findLastAttendanceEvent(employeeId, pool, bound)
    if (input.eventType === 'check_in' && last?.eventType === 'check_in') {
      return fail(res, 409, 'ลงเวลาเข้างานไปแล้ว กรุณาลงเวลาออกก่อน')
    }
    if (input.eventType === 'check_out' && last?.eventType !== 'check_in') {
      return fail(res, 409, 'ยังไม่ได้ลงเวลาเข้างาน')
    }

    // Geofencing is unconditional — there is no "not configured yet" grace
    // period. An empty master_locations table blocks every clock event, same
    // as being genuinely out of range: this repo's earlier stance ("a missing
    // GPS fix must never block a clock event") was explicitly overridden for
    // this feature, so an empty-table fallthrough would quietly reinstate the
    // behaviour that was just turned off. Until admin/ has at least one
    // location active, no one can clock in — a manual time correction is the
    // documented workaround for that gap, not a code path here.
    if (input.latitude === null || input.longitude === null) {
      return fail(res, 409, 'ไม่พบพิกัด GPS กรุณาเปิดสิทธิ์ตำแหน่งที่ตั้งแล้วลองลงเวลาอีกครั้ง')
    }

    // An approved off-site request for today takes priority over
    // master_locations entirely — checked first, not merged into
    // nearestLocation's candidate set, since HR confirmed a single system-wide
    // radius (OFF_SITE_DEFAULT_RADIUS_METERS) applies here, not each
    // location's own radiusMeters.
    const offSitePoint = await findApprovedOffSiteRequestForDate(employeeId, todayDate)
    let matched: { locationId: number | null; offSiteRequestId: number | null; distanceMeters: number }
    if (offSitePoint !== null) {
      const distance = distanceMeters(input.latitude, input.longitude, offSitePoint.latitude, offSitePoint.longitude)
      if (distance > OFF_SITE_DEFAULT_RADIUS_METERS) {
        return fail(
          res,
          409,
          `อยู่นอกพื้นที่ทำงานนอกสถานที่ที่ได้รับอนุมัติ (ห่างจาก "${offSitePoint.placeName}" ประมาณ ${Math.round(distance)} ม. ขอบเขตที่อนุญาต ${OFF_SITE_DEFAULT_RADIUS_METERS} ม.)`
        )
      }
      matched = { locationId: null, offSiteRequestId: offSitePoint.id, distanceMeters: distance }
    } else {
      const activeLocations = await findActiveLocations()
      const nearest = nearestLocation(input.latitude, input.longitude, activeLocations)
      if (nearest === null || nearest.distanceMeters > nearest.location.radiusMeters) {
        const message =
          nearest === null
            ? 'ยังไม่มีการตั้งค่าพิกัดที่อนุญาตให้ลงเวลาในระบบ กรุณาติดต่อฝ่ายบุคคล'
            : `อยู่นอกพื้นที่ที่อนุญาตให้ลงเวลา (ห่างจาก "${nearest.location.locationName}" ประมาณ ${Math.round(nearest.distanceMeters)} ม. ขอบเขตที่อนุญาต ${nearest.location.radiusMeters} ม.)`
        return fail(res, 409, message)
      }
      matched = { locationId: nearest.location.id, offSiteRequestId: null, distanceMeters: nearest.distanceMeters }
    }

    const employee = await findEmployeeById(employeeId)
    if (!employee) return fail(res, 404, 'employee record not found')

    const { rows } = await pool.query<AttendanceRow>(
      `WITH inserted AS (
         INSERT INTO attendance_events
           (employee_id, event_type, source, latitude, longitude, accuracy_meters, shift_id,
            device_info, matched_location_id, matched_off_site_request_id, distance_meters)
         VALUES ($1, $2, 'liff_gps', $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, employee_id, event_type, event_time, source,
                   latitude, longitude, accuracy_meters, shift_id, device_info,
                   matched_location_id, matched_off_site_request_id, distance_meters
       )
       SELECT inserted.*, ms.shift_name, ml.location_name AS matched_location_name,
              osr.place_name AS matched_off_site_place_name
       FROM inserted
       LEFT JOIN master_shifts ms ON ms.id = inserted.shift_id
       LEFT JOIN master_locations ml ON ml.id = inserted.matched_location_id
       LEFT JOIN off_site_work_requests osr ON osr.id = inserted.matched_off_site_request_id`,
      [
        employeeId,
        input.eventType,
        input.latitude,
        input.longitude,
        input.accuracyMeters,
        employee.employment.shiftId,
        input.deviceInfo,
        matched.locationId,
        matched.offSiteRequestId,
        matched.distanceMeters,
      ]
    )
    const row = rows[0]
    if (!row) throw new Error('insert into attendance_events returned no row')

    const body: AttendanceClockResponse = { event: rowToAttendanceEvent(row) }
    res.status(201).json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

attendanceRouter.get('/attendance/me', async (req: Request, res: Response) => {
  const employeeId = requireEmployeeId(req, res)
  if (employeeId === null) return

  try {
    const now = new Date()
    const todayDate = toThailandDateString(now)
    const yesterdayDate = addDays(todayDate, -1)
    // Same buffered yesterday/today bound POST /attendance/clock uses for its
    // clock-order check, so this reports the identical "what's next" the
    // server would actually accept — see findLastAttendanceEvent's doc.
    const [yesterdayWindow, todayWindow] = await Promise.all([
      resolveMatchWindow(employeeId, yesterdayDate),
      resolveMatchWindow(employeeId, todayDate),
    ])
    const bound = {
      from: yesterdayWindow.startAt < todayWindow.startAt ? yesterdayWindow.startAt : todayWindow.startAt,
      to: yesterdayWindow.endAt > todayWindow.endAt ? yesterdayWindow.endAt : todayWindow.endAt,
    }
    const [yesterday, today] = await matchAttendanceForDates(employeeId, [yesterdayDate, todayDate])
    if (!yesterday || !today) throw new Error('matchAttendanceForDates returned fewer rows than dates requested')
    const lastEvent = await findLastAttendanceEvent(employeeId, pool, bound)

    const chosen = chooseAttendanceWindow(yesterday, today, now)
    const status: AttendanceTodayStatus = {
      workDate: chosen.workDate,
      shiftId: chosen.shiftId,
      shiftName: chosen.shiftName,
      shiftStartAt: chosen.expectedCheckInAt,
      shiftEndAt: chosen.expectedCheckOutAt,
      isOvernight: chosen.isOvernight,
      checkInAt: chosen.actualCheckInAt,
      checkInEventId: chosen.actualCheckInEventId,
      checkOutAt: chosen.actualCheckOutAt,
      checkOutEventId: chosen.actualCheckOutEventId,
      lastEventType: lastEvent?.eventType ?? null,
    }
    const body: AttendanceStatusResponse = { today: status }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

function parseOptionalId(value: unknown): number | null | undefined {
  if (value === undefined) return null
  if (typeof value !== 'string') return undefined
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : undefined
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function parseOptionalDate(value: unknown): string | null | undefined {
  if (value === undefined) return null
  if (typeof value !== 'string' || !DATE_RE.test(value)) return undefined
  return value
}

function parseOptionalWorkLocation(value: unknown): WorkLocation | null | undefined {
  if (value === undefined) return null
  if (typeof value !== 'string' || !WORK_LOCATIONS.includes(value as WorkLocation)) return undefined
  return value as WorkLocation
}

attendanceRouter.get('/attendance', canReadAdmin, async (req: Request, res: Response) => {
  const employeeId = parseOptionalId(req.query['employeeId'])
  if (employeeId === undefined) return fail(res, 400, 'employeeId must be a positive integer')

  const fromDate = parseOptionalDate(req.query['fromDate'])
  if (fromDate === undefined) return fail(res, 400, 'fromDate must be YYYY-MM-DD')

  const toDate = parseOptionalDate(req.query['toDate'])
  if (toDate === undefined) return fail(res, 400, 'toDate must be YYYY-MM-DD')

  const page = parseOptionalId(req.query['page'])
  if (page === undefined) return fail(res, 400, 'page must be a positive integer')

  const pageSize = parseOptionalId(req.query['pageSize'])
  if (pageSize === undefined) return fail(res, 400, 'pageSize must be a positive integer')

  try {
    const result = await listAttendanceEvents(
      {
        ...(employeeId !== null && { employeeId }),
        ...(fromDate !== null && { fromDate }),
        ...(toDate !== null && { toDate }),
      },
      { ...(page !== null && { page }), ...(pageSize !== null && { pageSize }) }
    )
    const body: AttendanceListResponse = result
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

// The computed daily report. attendance_daily itself is still never written
// directly here — it's derived data the attendance:compute job (and the
// confirm-punch route further down) rebuilt via recomputeAttendanceDaily. A
// wrong day is fixed by correcting its source (a time correction, a shift
// change, an approved leave, or now, confirming which raw punch belongs to
// it), not by editing the report row itself.
attendanceRouter.get('/attendance/daily', canReadAdmin, async (req: Request, res: Response) => {
  const employeeId = parseOptionalId(req.query['employeeId'])
  if (employeeId === undefined) return fail(res, 400, 'employeeId must be a positive integer')

  const departmentId = parseOptionalId(req.query['departmentId'])
  if (departmentId === undefined) return fail(res, 400, 'departmentId must be a positive integer')

  const fromDate = parseOptionalDate(req.query['fromDate'])
  if (fromDate === undefined) return fail(res, 400, 'fromDate must be YYYY-MM-DD')

  const toDate = parseOptionalDate(req.query['toDate'])
  if (toDate === undefined) return fail(res, 400, 'toDate must be YYYY-MM-DD')

  const statusRaw = req.query['status']
  if (statusRaw !== undefined && (typeof statusRaw !== 'string' || !ATTENDANCE_DAILY_FILTERS.includes(statusRaw as AttendanceDailyFilter))) {
    return fail(res, 400, `status must be one of: ${ATTENDANCE_DAILY_FILTERS.join(', ')}`)
  }

  const workLocation = parseOptionalWorkLocation(req.query['workLocation'])
  if (workLocation === undefined) {
    return fail(res, 400, `workLocation must be one of: ${WORK_LOCATIONS.join(', ')}`)
  }

  const search = req.query['search']
  if (search !== undefined && typeof search !== 'string') return fail(res, 400, 'search must be a string')

  const page = parseOptionalId(req.query['page'])
  if (page === undefined) return fail(res, 400, 'page must be a positive integer')

  const pageSize = parseOptionalId(req.query['pageSize'])
  if (pageSize === undefined) return fail(res, 400, 'pageSize must be a positive integer')

  try {
    const result = await listAttendanceDaily(
      {
        ...(employeeId !== null && { employeeId }),
        ...(departmentId !== null && { departmentId }),
        ...(fromDate !== null && { fromDate }),
        ...(toDate !== null && { toDate }),
        ...(statusRaw !== undefined && { status: statusRaw as AttendanceDailyFilter }),
        ...(workLocation !== null && { workLocation }),
        ...(search !== undefined && search !== '' && { search }),
      },
      {
        ...(page !== null && { page }),
        ...(pageSize !== null && { pageSize }),
      }
    )
    const body: AttendanceDailyListResponse = result
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

// The Excel export — same filters as /attendance/daily, but unlimited rows
// (see LIST_LIMIT in attendanceDailyQueries.ts) and read from the report
// template, not the JSON contract. Placed after /attendance/daily so the
// route table reads filter-then-export, but registered independently since
// it answers with a file, not an AttendanceDailyListResponse.
attendanceRouter.get('/attendance/daily/export', canReadAdmin, async (req: Request, res: Response) => {
  const employeeId = parseOptionalId(req.query['employeeId'])
  if (employeeId === undefined) return fail(res, 400, 'employeeId must be a positive integer')

  const departmentId = parseOptionalId(req.query['departmentId'])
  if (departmentId === undefined) return fail(res, 400, 'departmentId must be a positive integer')

  const fromDate = parseOptionalDate(req.query['fromDate'])
  if (fromDate === undefined) return fail(res, 400, 'fromDate must be YYYY-MM-DD')

  const toDate = parseOptionalDate(req.query['toDate'])
  if (toDate === undefined) return fail(res, 400, 'toDate must be YYYY-MM-DD')

  const statusRaw = req.query['status']
  if (statusRaw !== undefined && (typeof statusRaw !== 'string' || !ATTENDANCE_DAILY_FILTERS.includes(statusRaw as AttendanceDailyFilter))) {
    return fail(res, 400, `status must be one of: ${ATTENDANCE_DAILY_FILTERS.join(', ')}`)
  }

  const workLocation = parseOptionalWorkLocation(req.query['workLocation'])
  if (workLocation === undefined) {
    return fail(res, 400, `workLocation must be one of: ${WORK_LOCATIONS.join(', ')}`)
  }

  const search = req.query['search']
  if (search !== undefined && typeof search !== 'string') return fail(res, 400, 'search must be a string')

  try {
    const buffer = await buildAttendanceReportWorkbook({
      ...(employeeId !== null && { employeeId }),
      ...(departmentId !== null && { departmentId }),
      ...(fromDate !== null && { fromDate }),
      ...(toDate !== null && { toDate }),
      ...(statusRaw !== undefined && { status: statusRaw as AttendanceDailyFilter }),
      ...(workLocation !== null && { workLocation }),
      ...(search !== undefined && search !== '' && { search }),
    })

    const filename = `attendance-${fromDate ?? 'all'}-to-${toDate ?? 'all'}.xlsx`
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`)
    res.send(Buffer.from(buffer))
  } catch (err) {
    handleUnexpected(res, err)
  }
})

function parseRequiredId(value: string | string[] | undefined): number | null {
  if (typeof value !== 'string') return null
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

/** Candidate punches for the confirm-punch popover — see
 *  findCandidatePunches for what "candidate" means (unclaimed by ordinary
 *  buffer matching on this date or either neighbour, and not confirmed to a
 *  different date already). */
attendanceRouter.get(
  '/attendance/daily/:employeeId/:workDate/candidate-punches',
  canConfirmPunch,
  async (req: Request, res: Response) => {
    const employeeId = parseRequiredId(req.params['employeeId'])
    if (employeeId === null) return fail(res, 400, 'employeeId must be a positive integer')

    const workDate = req.params['workDate']
    if (typeof workDate !== 'string' || !DATE_RE.test(workDate)) return fail(res, 400, 'workDate must be YYYY-MM-DD')

    try {
      const candidates = await findCandidatePunches(employeeId, workDate)
      const body: AttendanceCandidatePunchesResponse = { candidates }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)

type ParsedConfirmInput = { eventId: number | null }

function parseConfirmPunchInput(body: unknown): ParseResult<ParsedConfirmInput> {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'body must be a JSON object' }
  }
  const raw = body as Record<string, unknown>
  const eventId = raw['eventId']
  if (eventId === null) return { ok: true, value: { eventId: null } }
  if (typeof eventId !== 'number' || !Number.isInteger(eventId) || eventId <= 0) {
    return { ok: false, message: 'eventId must be a positive integer, or null to clear the confirmation' }
  }
  return { ok: true, value: { eventId } }
}

/**
 * Sets (eventId given) or clears (eventId null) confirmed_work_date on one
 * attendance_events row for this employee+workDate, then recomputes just the
 * affected days and hands back the fresh attendance_daily row.
 *
 * Blocked once the covering payroll period has moved past draft/calculating
 * (isPeriodLockedForEdit) — same boundary calculatePayrollEntries enforces
 * before letting a period recalculate (payrollEntryQueries.ts) — so a
 * confirmed slip's numbers can never shift under it without HR deliberately
 * reopening the period first.
 */
attendanceRouter.post(
  '/attendance/daily/:employeeId/:workDate/confirm-punch',
  canConfirmPunch,
  async (req: Request, res: Response) => {
    const actor = req.auth
    if (!actor) return fail(res, 500, 'server misconfigured')

    const employeeId = parseRequiredId(req.params['employeeId'])
    if (employeeId === null) return fail(res, 400, 'employeeId must be a positive integer')

    const workDate = req.params['workDate']
    if (typeof workDate !== 'string' || !DATE_RE.test(workDate)) return fail(res, 400, 'workDate must be YYYY-MM-DD')

    const parsed = parseConfirmPunchInput(req.body)
    if (!parsed.ok) return fail(res, 400, parsed.message)
    const { eventId } = parsed.value

    try {
      const periodStatus = await resolvePayrollPeriodStatus(employeeId, workDate)
      if (isPeriodLockedForEdit(periodStatus)) {
        return fail(
          res,
          409,
          `งวดเงินเดือนของวันที่นี้พ้นขั้นตอนคำนวณไปแล้ว (สถานะ: ${periodStatus}) กรุณาย้อนสถานะงวดก่อนแก้ไขเวลา`
        )
      }

      const result = await withTransaction(async (client) => {
        if (eventId !== null) {
          // Re-validated inside the same transaction/client that will make
          // the write, not trusted from whatever the browser had open —
          // same reasoning as validateOvertimeRequestInput's re-check before
          // an approval decides anything.
          const candidates = await findCandidatePunches(employeeId, workDate, client)
          const match = candidates.find((c) => c.id === eventId)
          if (!match) {
            return {
              kind: 'conflict' as const,
              message: 'รายการลงเวลานี้ไม่สามารถยืนยันเป็นวันที่นี้ได้แล้ว กรุณารีเฟรชแล้วลองใหม่',
            }
          }

          await client.query(`UPDATE attendance_events SET confirmed_work_date = $2 WHERE id = $1`, [
            eventId,
            workDate,
          ])

          await recordAudit(client, {
            actor,
            action: 'attendance.confirm_punch',
            entityId: eventId,
            detail: { employeeId, workDate, eventType: match.eventType, eventTime: match.eventTime },
          })
        } else {
          const { rows } = await client.query<{ id: string; event_type: string; event_time: string }>(
            `UPDATE attendance_events SET confirmed_work_date = NULL
             WHERE employee_id = $1 AND confirmed_work_date = $2
             RETURNING id, event_type, event_time`,
            [employeeId, workDate]
          )
          const cleared = rows[0]
          if (cleared) {
            await recordAudit(client, {
              actor,
              action: 'attendance.unconfirm_punch',
              entityId: Number(cleared.id),
              detail: { employeeId, workDate, eventType: cleared.event_type, eventTime: cleared.event_time },
            })
          }
        }

        // ±1 day, same as time-correction approvals: an overnight shift's
        // window reaches into both neighbours, so confirming a punch here can
        // change the verdict of the adjacent work-date too.
        await recomputeAttendanceDaily(employeeId, addDays(workDate, -1), addDays(workDate, 1), client)

        const { days } = await listAttendanceDaily(
          { employeeId, fromDate: workDate, toDate: workDate },
          { page: 1, pageSize: 1 },
          client
        )
        const day = days[0]
        if (!day) throw new Error(`attendance_daily has no row for employee ${employeeId} on ${workDate}`)
        return { kind: 'ok' as const, day }
      })

      if (result.kind === 'conflict') return fail(res, 409, result.message)

      const body: ConfirmAttendancePunchResponse = { day: result.day }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)
