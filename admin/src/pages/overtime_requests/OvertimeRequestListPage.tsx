import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { OvertimeRequestListItem, OvertimeRequestStage, OvertimeRequestStatus } from '@hrm/shared'
import { listOvertimeRequests, listOvertimeRequestsPendingApproval } from '../../api/overtimeRequests'
import { Pagination } from '../../components/Pagination'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs'
import {
  DAY_STATUS_LABEL,
  formatOvertimeDate,
  formatOvertimeHours,
  hhmm,
} from '../../overtimeFormat'
import {
  alert,
  alertDetail,
  alertTitle,
  badge,
  button,
  cardEmpty,
  eyebrow,
  muted,
  pageHead,
  subtitle,
} from '../../styles'

type State =
  | { phase: 'loading' }
  | { phase: 'ok'; requests: OvertimeRequestListItem[]; total: number }
  | { phase: 'error'; message: string }

/** Matches the server's own default in overtimeRequestQueries.ts. */
const DEFAULT_PAGE_SIZE = 50

// 'mine' is not an OvertimeRequestStatus — it's the caller's own supervisor
// inbox, fetched from a different endpoint (see the effect below). It stays
// unpaginated — see LeaveRequestListPage's comment on the same tab.
type TabValue = OvertimeRequestStatus | 'all' | 'mine'

/** One row of the table — either a normal self-filed request, or every
 *  member of one Bulk OT Request submission collapsed into a single row
 *  (batchId is shared, see migration 061's comment for why there is no
 *  batch table to query this from directly). Grouped client-side rather
 *  than by the list endpoint: the endpoint's shape and sorting stay useful
 *  for every other caller (the employee-facing history, exports, ...). */
type DisplayRow =
  | { kind: 'single'; request: OvertimeRequestListItem }
  | { kind: 'batch'; batchId: string; requests: OvertimeRequestListItem[] }

function groupByBatch(requests: OvertimeRequestListItem[]): DisplayRow[] {
  const seenBatchIds = new Set<string>()
  const rows: DisplayRow[] = []
  for (const request of requests) {
    if (request.batchId === null) {
      rows.push({ kind: 'single', request })
      continue
    }
    if (seenBatchIds.has(request.batchId)) continue
    seenBatchIds.add(request.batchId)
    rows.push({
      kind: 'batch',
      batchId: request.batchId,
      requests: requests.filter((r) => r.batchId === request.batchId),
    })
  }
  return rows
}

const TABS: { value: TabValue; label: string }[] = [
  { value: 'mine', label: 'รอฉันอนุมัติ' },
  { value: 'pending', label: 'รอดำเนินการ' },
  { value: 'approved', label: 'อนุมัติแล้ว' },
  { value: 'rejected', label: 'ปฏิเสธแล้ว' },
  { value: 'cancelled', label: 'ยกเลิกแล้ว' },
  { value: 'all', label: 'ทั้งหมด' },
]

const STATUS_LABEL: Record<OvertimeRequestStatus, string> = {
  pending: 'รอดำเนินการ',
  approved: 'อนุมัติแล้ว',
  rejected: 'ปฏิเสธแล้ว',
  cancelled: 'ยกเลิกแล้ว',
}

const STAGE_LABEL: Record<OvertimeRequestStage, string> = {
  supervisor: 'รอหัวหน้างาน',
  hr: 'รอ HR/Admin',
}

function statusBadgeTone(
  status: OvertimeRequestStatus
): 'pending' | 'active' | 'danger' | 'inactive' {
  if (status === 'approved') return 'active'
  if (status === 'rejected') return 'danger'
  if (status === 'cancelled') return 'inactive'
  return 'pending'
}

export function OvertimeRequestListPage() {
  const [tab, setTab] = useState<TabValue>('pending')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE)
  const [state, setState] = useState<State>({ phase: 'loading' })
  // True while a tab/page/page-size request is in flight — used to disable
  // <Pagination> rather than resetting `state` to 'loading'.
  const [fetching, setFetching] = useState(true)
  const navigate = useNavigate()

  // No setState({ phase: 'loading' }) at the top: switching tabs leaves the
  // old table in place until the new one is ready, rather than flashing
  // blank — same reasoning as the other request queues' filter effects.
  useEffect(() => {
    const controller = new AbortController()

    const fetchRequests =
      tab === 'mine'
        ? listOvertimeRequestsPendingApproval(controller.signal).then((requests) => ({
            requests,
            total: requests.length,
          }))
        : listOvertimeRequests(tab === 'all' ? undefined : tab, { page, pageSize }, controller.signal)

    fetchRequests
      .then((body) => {
        setState({ phase: 'ok', requests: body.requests, total: body.total })
        setFetching(false)
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'request failed',
        })
        setFetching(false)
      })

    return () => controller.abort()
  }, [tab, page, pageSize])

  function handleTabChange(next: string) {
    setFetching(true)
    setTab(next as TabValue)
    setPage(1)
  }

  function goToPage(next: number) {
    setFetching(true)
    setPage(next)
  }

  function handlePageSizeChange(next: number) {
    setFetching(true)
    setPageSize(next)
    setPage(1)
  }

  const displayRows = useMemo(
    () => (state.phase === 'ok' ? groupByBatch(state.requests) : []),
    [state]
  )

  return (
    <>
      <header className={pageHead}>
        <div>
          <p className={eyebrow}>Overtime</p>
          <h1>คำขอทำงานล่วงเวลา</h1>
          <p className={subtitle}>คำขอ OT จากพนักงาน รออนุมัติหรือปฏิเสธ</p>
        </div>
        <Link className={button('primary')} to="/overtime-requests/bulk-request">
          ขอ OT แบบกลุ่ม
        </Link>
      </header>

      <Tabs value={tab} onValueChange={handleTabChange}>
        <TabsList>
          {TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value={tab}>
          {state.phase === 'loading' && <p className={muted}>กำลังโหลด…</p>}

          {state.phase === 'error' && (
            <div className={alert('danger')}>
              <p className={alertTitle('danger')}>โหลดข้อมูลไม่สำเร็จ</p>
              <p className={alertDetail}>{state.message}</p>
            </div>
          )}

          {state.phase === 'ok' && state.requests.length === 0 && (
            <div className={`rounded-lg border border-slate-200 bg-white shadow-sm ${cardEmpty}`}>
              <p className="mb-1.5 font-semibold text-slate-900">ไม่พบคำขอในหมวดนี้</p>
              <p className={muted}>ลองเปลี่ยนแท็บด้านบน</p>
            </div>
          )}

          {state.phase === 'ok' && state.requests.length > 0 && (
            <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
              <div className="flex items-center justify-between gap-4 border-b border-slate-200 bg-slate-50 px-4 py-3.5">
                <p className="text-[0.775rem] whitespace-nowrap text-slate-500 tabular-nums">{state.total} รายการ</p>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[0.825rem] [&_tbody_tr:last-child_td]:border-b-0">
                  <thead>
                    <tr>
                      {[
                        '#',
                        'รหัสพนักงาน',
                        'ชื่อพนักงาน',
                        'วันที่ขอ OT',
                        'ช่วงเวลา',
                        'ชั่วโมง',
                        'ประเภทวัน',
                        'เหตุผล',
                        'สถานะ',
                        'ขั้นตอน',
                      ].map((h) => (
                        <th
                          key={h}
                          className="border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-left text-[0.675rem] font-semibold tracking-wider text-slate-500 uppercase whitespace-nowrap"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {displayRows.map((row, index) => {
                      if (row.kind === 'single') {
                        const { request } = row
                        return (
                          <tr
                            key={request.id}
                            onClick={() => void navigate(`/overtime-requests/${request.id}`)}
                            className="cursor-pointer hover:bg-slate-50"
                          >
                            <td className="w-12 border-b border-slate-200 px-4 py-2.5 align-middle text-slate-500">
                              {index + 1}
                            </td>
                            <td className="border-b border-slate-200 px-4 py-2.5 align-middle font-medium text-slate-900">
                              {request.employeeCode}
                            </td>
                            <td className="border-b border-slate-200 px-4 py-2.5 align-middle text-slate-600">
                              {request.employeeName}
                            </td>
                            <td className="border-b border-slate-200 px-4 py-2.5 align-middle whitespace-nowrap text-slate-600 tabular-nums">
                              {formatOvertimeDate(request.otDate)}
                            </td>
                            <td className="border-b border-slate-200 px-4 py-2.5 align-middle whitespace-nowrap text-slate-600 tabular-nums">
                              {hhmm(request.startTime)}-{hhmm(request.endTime)}
                              {request.crossesMidnight && (
                                <span className="ml-1 text-[0.7rem] text-slate-400">(+1)</span>
                              )}
                            </td>
                            <td className="border-b border-slate-200 px-4 py-2.5 align-middle whitespace-nowrap text-slate-600 tabular-nums">
                              {formatOvertimeHours(request.requestedMinutes)}
                            </td>
                            <td className="border-b border-slate-200 px-4 py-2.5 align-middle whitespace-nowrap text-slate-600">
                              {DAY_STATUS_LABEL[request.dayStatus]}
                            </td>
                            <td className="max-w-64 truncate border-b border-slate-200 px-4 py-2.5 align-middle text-slate-600">
                              {request.reason}
                            </td>
                            <td className="border-b border-slate-200 px-4 py-2.5 align-middle">
                              <span className={badge(statusBadgeTone(request.status))}>
                                {STATUS_LABEL[request.status]}
                              </span>
                            </td>
                            <td className="border-b border-slate-200 px-4 py-2.5 align-middle whitespace-nowrap text-slate-600">
                              {request.status === 'pending' && request.currentStage
                                ? STAGE_LABEL[request.currentStage]
                                : '—'}
                            </td>
                          </tr>
                        )
                      }

                      // A batch row: every member shares otDate/startTime/
                      // endTime/reason (one bulk submission, one set of
                      // details), so the first member stands in for them.
                      // Status can differ per member once a batch decision
                      // leaves some rows 'stale' — every distinct status
                      // present gets its own badge rather than picking one.
                      const first = row.requests[0]
                      if (!first) return null
                      const statusesPresent = [...new Set(row.requests.map((r) => r.status))]
                      return (
                        <tr
                          key={row.batchId}
                          onClick={() => void navigate(`/overtime-requests/batch/${row.batchId}`)}
                          className="cursor-pointer bg-slate-50/60 hover:bg-slate-100"
                        >
                          <td className="w-12 border-b border-slate-200 px-4 py-2.5 align-middle text-slate-500">
                            {index + 1}
                          </td>
                          <td
                            colSpan={2}
                            className="border-b border-slate-200 px-4 py-2.5 align-middle font-medium text-slate-900"
                          >
                            คำขอกลุ่ม ({row.requests.length} คน)
                          </td>
                          <td className="border-b border-slate-200 px-4 py-2.5 align-middle whitespace-nowrap text-slate-600 tabular-nums">
                            {formatOvertimeDate(first.otDate)}
                          </td>
                          <td className="border-b border-slate-200 px-4 py-2.5 align-middle whitespace-nowrap text-slate-600 tabular-nums">
                            {hhmm(first.startTime)}-{hhmm(first.endTime)}
                            {first.crossesMidnight && (
                              <span className="ml-1 text-[0.7rem] text-slate-400">(+1)</span>
                            )}
                          </td>
                          <td className="border-b border-slate-200 px-4 py-2.5 align-middle whitespace-nowrap text-slate-600 tabular-nums">
                            {formatOvertimeHours(first.requestedMinutes)}
                          </td>
                          <td className="border-b border-slate-200 px-4 py-2.5 align-middle whitespace-nowrap text-slate-600">
                            —
                          </td>
                          <td className="max-w-64 truncate border-b border-slate-200 px-4 py-2.5 align-middle text-slate-600">
                            {first.reason}
                          </td>
                          <td className="border-b border-slate-200 px-4 py-2.5 align-middle">
                            <div className="flex flex-wrap gap-1">
                              {statusesPresent.map((status) => (
                                <span key={status} className={badge(statusBadgeTone(status))}>
                                  {STATUS_LABEL[status]}
                                </span>
                              ))}
                            </div>
                          </td>
                          <td className="border-b border-slate-200 px-4 py-2.5 align-middle whitespace-nowrap text-slate-600">
                            {first.status === 'pending' && first.currentStage
                              ? STAGE_LABEL[first.currentStage]
                              : '—'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {tab !== 'mine' && (
                <Pagination
                  page={page}
                  pageSize={pageSize}
                  totalItems={state.total}
                  onPageChange={goToPage}
                  onPageSizeChange={handlePageSizeChange}
                  disabled={fetching}
                />
              )}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </>
  )
}
