import { Router } from 'express'
import type { Request, Response } from 'express'
import {
  ROLES,
  type AuthUser,
  type DashboardOnLeaveTodayResponse,
  type DashboardPendingApprovalsSummaryResponse,
} from '@hrm/shared'
import { requireRole } from '../auth/middleware.js'
import { fail, handleUnexpected } from '../http.js'
import { resolveSupervisorScope } from '../supervisorScope.js'
import { countLeaveRequestsPending, listEmployeesOnLeaveToday, listLeaveRequestsPendingApproval } from '../leaveRequestQueries.js'
import { countOffSiteWorkRequestsPending, listOffSiteWorkRequestsPendingApproval } from '../offSiteRequestQueries.js'
import { countOvertimeRequestsPending, listOvertimeRequestsPendingApproval } from '../overtimeRequestQueries.js'
import { countShiftChangeRequestsPending, listShiftChangeRequestsPendingApproval } from '../shiftChangeRequestQueries.js'
import { countDayOffSwapRequestsPending, listDayOffSwapRequestsPendingApproval } from '../dayOffSwapRequestQueries.js'
import { countTimeCorrectionsPending, listTimeCorrectionsPendingApproval } from '../timeCorrectionQueries.js'
import { countCompTimeOffRequestsPending, listCompTimeOffRequestsPendingApproval } from '../compTimeOffRequestQueries.js'

export const dashboardRouter = Router()

// Any HRM role may read the dashboard — same gate as every other admin/
// review queue (leaveRequests.ts's canReadAdmin etc).
const canRead = requireRole(...ROLES)

function actorOf(req: Request): AuthUser | null {
  return req.auth ?? null
}

/** 'Today' in Thailand, regardless of the server's own timezone — same
 *  helper as leaveRequests.ts's thailandToday. */
function thailandToday(): string {
  const bangkokNow = new Date(Date.now() + 7 * 60 * 60 * 1000)
  return bangkokNow.toISOString().slice(0, 10)
}

dashboardRouter.get('/dashboard/on-leave-today', canRead, async (_req: Request, res: Response) => {
  try {
    const employees = await listEmployeesOnLeaveToday(thailandToday())
    const body: DashboardOnLeaveTodayResponse = { employees }
    res.json(body)
  } catch (err) {
    handleUnexpected(res, err)
  }
})

dashboardRouter.get(
  '/dashboard/pending-approvals-summary',
  canRead,
  async (req: Request, res: Response) => {
    const auth = actorOf(req)
    if (!auth) return fail(res, 500, 'server misconfigured')

    try {
      const scope = await resolveSupervisorScope(auth)

      if (scope.kind === 'none') {
        const body: DashboardPendingApprovalsSummaryResponse = {
          scope: 'none',
          leave: 0,
          offSite: 0,
          overtime: 0,
          shiftChange: 0,
          dayOffSwap: 0,
          timeCorrection: 0,
          compTimeOff: 0,
        }
        return res.json(body)
      }

      // HR/Admin ('all') counts every pending request regardless of stage —
      // they may decide at either one. A team-scoped supervisor's count is
      // only what's currently waiting on them specifically, which is what
      // each listXRequestsPendingApproval already narrows to
      // (current_stage='supervisor').
      const [leave, offSite, overtime, shiftChange, dayOffSwap, timeCorrection, compTimeOff] =
        scope.kind === 'all'
          ? await Promise.all([
              countLeaveRequestsPending(),
              countOffSiteWorkRequestsPending(),
              countOvertimeRequestsPending(),
              countShiftChangeRequestsPending(),
              countDayOffSwapRequestsPending(),
              countTimeCorrectionsPending(),
              countCompTimeOffRequestsPending(),
            ])
          : await Promise.all([
              listLeaveRequestsPendingApproval(scope.supervisorEmployeeId).then((r) => r.length),
              listOffSiteWorkRequestsPendingApproval(scope.supervisorEmployeeId).then((r) => r.length),
              listOvertimeRequestsPendingApproval(scope.supervisorEmployeeId).then((r) => r.length),
              listShiftChangeRequestsPendingApproval(scope.supervisorEmployeeId).then((r) => r.length),
              listDayOffSwapRequestsPendingApproval(scope.supervisorEmployeeId).then((r) => r.length),
              listTimeCorrectionsPendingApproval(scope.supervisorEmployeeId).then((r) => r.length),
              listCompTimeOffRequestsPendingApproval(scope.supervisorEmployeeId).then((r) => r.length),
            ])

      const body: DashboardPendingApprovalsSummaryResponse = {
        scope: scope.kind,
        leave,
        offSite,
        overtime,
        shiftChange,
        dayOffSwap,
        timeCorrection,
        compTimeOff,
      }
      res.json(body)
    } catch (err) {
      handleUnexpected(res, err)
    }
  }
)
